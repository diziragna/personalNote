use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use http_body_util::BodyExt;
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::env;
use vercel_runtime::{Error, Request, Response, ResponseBody};
use uuid::Uuid;

pub async fn pool() -> Result<PgPool, Error> {
    let url = env::var("DATABASE_URL").map_err(|_| std::io::Error::new(std::io::ErrorKind::NotFound, "DATABASE_URL is not configured"))?;
    Ok(PgPoolOptions::new().max_connections(3).connect(&url).await?)
}

/// Apply a shared per-IP request limit. A sixth request in the same second
/// blocks that IP for 24 hours; doing it again after that block has ended
/// blocks it permanently. The block is shared by all API functions.
pub async fn enforce_ip_limit(pool: &PgPool, req: &Request) -> Result<bool, Error> {
    let raw_ip = req.headers().get("x-real-ip").and_then(|v| v.to_str().ok())
        .or_else(|| req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()))
        .map(str::trim)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Client IP header is missing"))?;
    let ip: std::net::IpAddr = raw_ip.parse()?;
    let blocked: bool = sqlx::query_scalar(
        "INSERT INTO rate_limit_ips (ip, window_started_at, request_count) VALUES ($1::inet, date_trunc('second', now()), 1) \
         ON CONFLICT (ip) DO UPDATE SET \
           blocked_until = CASE WHEN rate_limit_ips.blocked_until > now() THEN rate_limit_ips.blocked_until \
             WHEN rate_limit_ips.window_started_at = date_trunc('second', now()) AND rate_limit_ips.request_count >= 5 THEN \
               CASE WHEN rate_limit_ips.strike_count > 0 THEN 'infinity'::timestamptz ELSE now() + interval '24 hours' END \
             ELSE rate_limit_ips.blocked_until END, \
           strike_count = CASE WHEN rate_limit_ips.blocked_until > now() THEN rate_limit_ips.strike_count \
             WHEN rate_limit_ips.window_started_at = date_trunc('second', now()) AND rate_limit_ips.request_count >= 5 THEN rate_limit_ips.strike_count + 1 \
             ELSE rate_limit_ips.strike_count END, \
           request_count = CASE WHEN rate_limit_ips.window_started_at = date_trunc('second', now()) THEN rate_limit_ips.request_count + 1 ELSE 1 END, \
           window_started_at = date_trunc('second', now()) \
         RETURNING COALESCE(blocked_until > now(), false)")
        .bind(ip.to_string()).fetch_one(pool).await?;
    Ok(blocked)
}

pub async fn body<T: for<'de> Deserialize<'de>>(req: Request) -> Result<T, Error> {
    let bytes = req.into_body().collect().await?.to_bytes();
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn response(status: u16, payload: Value) -> Result<Response<ResponseBody>, Error> {
    Ok(Response::builder().status(status).header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store").body(ResponseBody::from(payload.to_string()))?)
}

pub fn error(status: u16, message: &str) -> Result<Response<ResponseBody>, Error> {
    response(status, json!({"error": message}))
}

pub fn hash_password(password: &str) -> Result<String, Error> {
    let salt = argon2::password_hash::SaltString::generate(&mut rand::thread_rng());
    Argon2::default().hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()).into())
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|hash| Argon2::default().verify_password(password.as_bytes(), &hash).is_ok())
}

pub fn token() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(64).map(char::from).collect()
}

// Store only a digest of the bearer token in the database.
pub fn token_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn cookie_header(token: &str) -> String {
    format!("note_session={token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000")
}

pub fn clear_cookie_header() -> &'static str {
    "note_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
}

/// The session token from an `Authorization: Bearer` header (browser extension
/// and desktop app) or, failing that, from the session cookie (web app).
pub fn request_token(req: &Request) -> Option<String> {
    let bearer = req.headers().get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if let Some(bearer) = bearer { return Some(bearer.trim().to_owned()) }
    req.headers().get("cookie")?.to_str().ok()?.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == "note_session").then(|| value.to_owned())
    })
}

pub async fn user_id(pool: &PgPool, req: &Request) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(raw) = request_token(req) else { return Ok(None) };
    sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()")
        .bind(token_hash(&raw)).fetch_optional(pool).await
}

pub fn valid_username(name: &str) -> bool {
    (3..=24).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn valid_password(password: &str) -> bool { (8..=128).contains(&password.len()) }

pub fn parse_due_date(value: Option<&str>) -> Result<Option<chrono::NaiveDate>, ()> {
    match value {
        None | Some("") => Ok(None),
        Some(value) => chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map(Some).map_err(|_| ()),
    }
}

pub const NOTE_COLORS: [&str; 6] = ["yellow", "pink", "blue", "green", "purple", "orange"];

pub fn valid_color(color: &str) -> bool { NOTE_COLORS.contains(&color) }

pub fn valid_position(value: i32) -> bool { (0..=100_000).contains(&value) }

pub fn valid_width(value: i32) -> bool { (180..=1200).contains(&value) }

pub fn valid_height(value: i32) -> bool { (120..=1200).contains(&value) }

pub fn unauthorized() -> Result<Response<ResponseBody>, Error> { error(401, "Please sign in to continue.") }

pub fn session_cookie_response(status: u16, payload: Value, token: &str) -> Result<Response<ResponseBody>, Error> {
    Ok(Response::builder().status(status).header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store").header("set-cookie", cookie_header(token))
        .body(ResponseBody::from(payload.to_string()))?)
}

#[derive(Deserialize)]
pub struct ChangeCredentials { pub current_password: String, pub username: String, pub new_password: Option<String> }
#[derive(Deserialize)]
pub struct NewNote {
    #[serde(default)] pub title: String, #[serde(default)] pub content: String, pub color: Option<String>,
    pub pos_x: Option<i32>, pub pos_y: Option<i32>, pub due_date: Option<String>
}
#[derive(Deserialize)]
pub struct UpdateNote {
    pub id: Uuid, pub title: Option<String>, pub content: Option<String>, pub color: Option<String>, pub completed: Option<bool>,
    pub due_date: Option<String>, pub pos_x: Option<i32>, pub pos_y: Option<i32>, pub z_index: Option<i32>,
    pub collapsed: Option<bool>, pub width: Option<i32>, pub height: Option<i32>
}
#[derive(Deserialize)]
pub struct DeleteNote { pub id: Uuid }
#[derive(Deserialize)]
pub struct NewComment { pub note_id: Uuid, pub content: String, pub due_date: Option<String> }
#[derive(Deserialize)]
pub struct UpdateComment { pub id: Uuid, pub content: String, pub due_date: Option<String> }
#[derive(Deserialize)]
pub struct DeleteComment { pub id: Uuid }
