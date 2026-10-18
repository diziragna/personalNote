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
            let rows = sqlx::query("SELECT c.id, c.note_id, c.content, c.created_at FROM note_comments c JOIN notes n ON n.id=c.note_id WHERE n.user_id=$1 ORDER BY c.created_at ASC")
                .bind(uid).fetch_all(&db).await?;
            let comments: Vec<_> = rows.iter().map(|r| json!({
                "id": r.get::<uuid::Uuid,_>("id"), "note_id": r.get::<uuid::Uuid,_>("note_id"),
                "content": r.get::<String,_>("content"), "created_at": r.get::<chrono::DateTime<chrono::Utc>,_>("created_at")
            })).collect();
            response(200, json!({"comments": comments}))
        }
        "POST" => {
            let input: NewComment = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            let content = input.content.trim();
            if content.is_empty() || content.chars().count() > 2000 { return error(400, "A comment must contain 1-2,000 characters.") }
            let row = sqlx::query("INSERT INTO note_comments (note_id, content) SELECT id, $3 FROM notes WHERE id=$1 AND user_id=$2 RETURNING id, note_id, content, created_at")
                .bind(input.note_id).bind(uid).bind(content).fetch_optional(&db).await?;
            let Some(row) = row else { return error(404, "Note not found.") };
            response(201, json!({"comment": {
                "id": row.get::<uuid::Uuid,_>("id"), "note_id": row.get::<uuid::Uuid,_>("note_id"),
                "content": row.get::<String,_>("content"), "created_at": row.get::<chrono::DateTime<chrono::Utc>,_>("created_at")
            }}))
        }
        "PATCH" => {
            let input: UpdateComment = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            let content = input.content.trim();
            if content.is_empty() || content.chars().count() > 2000 { return error(400, "A comment must contain 1-2,000 characters.") }
            let row = sqlx::query("UPDATE note_comments c SET content=$1 WHERE c.id=$2 AND EXISTS (SELECT 1 FROM notes n WHERE n.id=c.note_id AND n.user_id=$3) RETURNING c.id, c.note_id, c.content, c.created_at")
                .bind(content).bind(input.id).bind(uid).fetch_optional(&db).await?;
            let Some(row) = row else { return error(404, "Comment not found.") };
            response(200, json!({"comment": {
                "id": row.get::<uuid::Uuid,_>("id"), "note_id": row.get::<uuid::Uuid,_>("note_id"),
                "content": row.get::<String,_>("content"), "created_at": row.get::<chrono::DateTime<chrono::Utc>,_>("created_at")
            }}))
        }
        "DELETE" => {
            let input: DeleteComment = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            let result = sqlx::query("DELETE FROM note_comments c WHERE c.id=$1 AND EXISTS (SELECT 1 FROM notes n WHERE n.id=c.note_id AND n.user_id=$2)")
                .bind(input.id).bind(uid).execute(&db).await?;
            if result.rows_affected() == 0 { return error(404, "Comment not found.") }
            response(200, json!({"ok": true}))
        }
        _ => error(405, "Method not allowed.")
    }
}
