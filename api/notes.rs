mod shared;
use serde_json::json;
use sqlx::Row;
use vercel_runtime::{run, service_fn, Error, Request, Response, ResponseBody};
use shared::*;

#[tokio::main]
async fn main() -> Result<(), Error> { run(service_fn(handler)).await }

async fn handler(req: Request) -> Result<Response<ResponseBody>, Error> {
    let db = match pool().await { Ok(db) => db, Err(e) => { eprintln!("database connection failed: {e}"); return error(503, "The database is unavailable.") } };
    match enforce_ip_limit(&db, &req).await {
        Ok(true) => return error(429, "Requests from this IP have been blocked."),
        Ok(false) => {},
        Err(e) => { eprintln!("IP rate limit failed: {e}"); return error(503, "Request protection is unavailable.") }
    }
    let Some(uid) = user_id(&db, &req).await? else { return unauthorized() };
    match req.method().as_str() {
        "GET" => {
            let rows = sqlx::query("SELECT id, content, completed, created_at, updated_at FROM notes WHERE user_id=$1 ORDER BY created_at DESC")
                .bind(uid).fetch_all(&db).await?;
            let notes: Vec<_> = rows.iter().map(|r| json!({
                "id": r.get::<uuid::Uuid,_>("id"), "content": r.get::<String,_>("content"),
                "completed": r.get::<bool,_>("completed"), "created_at": r.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")
            })).collect();
            response(200, json!({"notes": notes}))
        }
        "POST" => {
            let input: NewNote = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            let content = input.content.trim();
            if content.is_empty() || content.chars().count() > 2000 { return error(400, "A note must contain 1-2,000 characters.") }
            let row = sqlx::query("INSERT INTO notes (user_id, content) VALUES ($1,$2) RETURNING id, content, completed, created_at, updated_at")
                .bind(uid).bind(content).fetch_one(&db).await?;
            response(201, json!({"note": {"id":row.get::<uuid::Uuid,_>("id"),"content":row.get::<String,_>("content"),"completed":false,"created_at":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"updated_at":row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")}}))
        }
        "PATCH" => {
            let input: UpdateNote = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            if let Some(content) = &input.content { if content.trim().is_empty() || content.chars().count() > 2000 { return error(400, "A note must contain 1-2,000 characters.") } }
            let row = sqlx::query("UPDATE notes SET content=COALESCE($1,content), completed=COALESCE($2,completed), updated_at=now() WHERE id=$3 AND user_id=$4 RETURNING id,content,completed,created_at,updated_at")
                .bind(input.content.as_deref().map(str::trim)).bind(input.completed).bind(input.id).bind(uid).fetch_optional(&db).await?;
            let Some(row) = row else { return error(404, "Note not found.") };
            response(200, json!({"note":{"id":row.get::<uuid::Uuid,_>("id"),"content":row.get::<String,_>("content"),"completed":row.get::<bool,_>("completed"),"created_at":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"updated_at":row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")}}))
        }
        "DELETE" => {
            let input: DeleteNote = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            let result = sqlx::query("DELETE FROM notes WHERE id=$1 AND user_id=$2").bind(input.id).bind(uid).execute(&db).await?;
            if result.rows_affected() == 0 { return error(404, "Note not found.") }
            response(200, json!({"ok":true}))
        }
        _ => error(405, "Method not allowed.")
    }
}
