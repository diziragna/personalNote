#[path = "../src/shared.rs"]
mod shared;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use vercel_runtime::{run, service_fn, Error, Request, Response, ResponseBody};
use shared::*;

#[derive(Deserialize)]
struct AuthInput { action: String, username: Option<String>, password: Option<String>, current_password: Option<String>, new_password: Option<String> }

#[tokio::main]
async fn main() -> Result<(), Error> { run(service_fn(handler)).await }

async fn handler(req: Request) -> Result<Response<ResponseBody>, Error> {
    let db = match pool().await { Ok(db) => db, Err(e) => { eprintln!("database connection failed: {e}"); return error(503, "The database is unavailable.") } };
    match enforce_ip_limit(&db, &req).await {
        Ok(true) => return error(429, "Requests from this IP have been blocked."),
        Ok(false) => {},
        Err(e) => { eprintln!("IP rate limit failed: {e}"); return error(503, "Request protection is unavailable.") }
    }
    let method = req.method().clone();
    let old_token = request_token(&req);
    if method.as_str() == "POST" {
        let input: AuthInput = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
        match input.action.as_str() {
            "signup" => {
                let name = input.username.unwrap_or_default().trim().to_ascii_lowercase();
                let password = input.password.unwrap_or_default();
                if !valid_username(&name) { return error(400, "Use 3-24 letters, numbers, underscores, or hyphens for your username.") }
                if !valid_password(&password) { return error(400, "Your password must be at least 8 characters.") }
                let hashed = match hash_password(&password) { Ok(v) => v, Err(_) => return error(500, "Could not create your account.") };
                if let Err(e) = sqlx::query("INSERT INTO users (username, password_hash) VALUES ($1, $2)").bind(&name).bind(hashed).execute(&db).await {
                    if e.as_database_error().is_some_and(|e| e.is_unique_violation()) { return error(409, "That username is already taken.") }
                    return Err(e.into());
                }
                create_session(&db, name).await
            }
            "signin" => {
                let name = input.username.unwrap_or_default().trim().to_ascii_lowercase();
                let password = input.password.unwrap_or_default();
                let row = sqlx::query("SELECT id, username, password_hash, locked_at FROM users WHERE lower(username) = lower($1)").bind(&name).fetch_optional(&db).await?;
                let Some(row) = row else { return error(401, "Username or password is incorrect.") };
                if row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("locked_at").is_some() { return error(401, "Username or password is incorrect.") }
                let hash: String = row.get("password_hash");
                if !verify_password(&password, &hash) {
                    sqlx::query("UPDATE users SET failed_login_attempts = failed_login_attempts + 1, locked_at = CASE WHEN failed_login_attempts + 1 >= 3 THEN now() ELSE locked_at END WHERE id = $1 AND locked_at IS NULL")
                        .bind(row.get::<uuid::Uuid, _>("id")).execute(&db).await?;
                    return error(401, "Username or password is incorrect.")
                }
                sqlx::query("UPDATE users SET failed_login_attempts = 0 WHERE id = $1 AND failed_login_attempts <> 0")
                    .bind(row.get::<uuid::Uuid, _>("id")).execute(&db).await?;
                create_session(&db, row.get("username")).await
            }
            _ => error(400, "Unknown action.")
        }
    } else if method.as_str() == "PATCH" {
        let Some(raw) = old_token else { return unauthorized() };
        let uid = match user_id(&db, &req).await? { Some(v) => v, None => return unauthorized() };
        let input: AuthInput = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
        let current = input.current_password.unwrap_or_default();
        let row = sqlx::query("SELECT password_hash FROM users WHERE id = $1").bind(uid).fetch_one(&db).await?;
        if !verify_password(&current, row.get::<&str, _>("password_hash")) { return error(401, "Your current password is incorrect.") }
        let new_name = input.username.unwrap_or_default().trim().to_ascii_lowercase();
        if !valid_username(&new_name) { return error(400, "Use 3-24 letters, numbers, underscores, or hyphens for your username.") }
        if let Some(new_pw) = input.new_password {
            if !valid_password(&new_pw) { return error(400, "Your new password must be at least 8 characters.") }
            let Ok(hash) = hash_password(&new_pw) else { return error(500, "Could not update your account.") };
            if let Err(e) = sqlx::query("UPDATE users SET username=$1, password_hash=$2 WHERE id=$3").bind(&new_name).bind(hash).bind(uid).execute(&db).await {
                if e.as_database_error().is_some_and(|e| e.is_unique_violation()) { return error(409, "That username is already taken.") }
                return Err(e.into());
            }
        } else if let Err(e) = sqlx::query("UPDATE users SET username=$1 WHERE id=$2").bind(&new_name).bind(uid).execute(&db).await {
            if e.as_database_error().is_some_and(|e| e.is_unique_violation()) { return error(409, "That username is already taken.") }
            return Err(e.into());
        }
        // Invalidate other sessions after changing account credentials.
        sqlx::query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2").bind(uid).bind(token_hash(&raw)).execute(&db).await?;
        response(200, json!({"username": new_name}))
    } else if method.as_str() == "GET" {
        let Some(uid) = user_id(&db, &req).await? else { return unauthorized() };
        let name: String = sqlx::query_scalar("SELECT username FROM users WHERE id=$1").bind(uid).fetch_one(&db).await?;
        response(200, json!({"username": name}))
    } else if method.as_str() == "DELETE" {
        if let Some(raw) = old_token { sqlx::query("DELETE FROM sessions WHERE token_hash=$1").bind(token_hash(&raw)).execute(&db).await?; }
        Ok(Response::builder().status(200).header("content-type", "application/json").header("cache-control", "no-store").header("set-cookie", clear_cookie_header()).body(ResponseBody::from(json!({"ok":true}).to_string()))?)
    } else { error(405, "Method not allowed.") }
}

async fn create_session(db: &sqlx::PgPool, username: String) -> Result<Response<ResponseBody>, Error> {
    let raw = token();
    sqlx::query("INSERT INTO sessions (user_id, token_hash, expires_at) SELECT id, $2, now() + interval '30 days' FROM users WHERE username=$1")
        .bind(&username).bind(token_hash(&raw)).execute(db).await?;
    session_cookie_response(200, json!({"username": username}), &raw)
}
