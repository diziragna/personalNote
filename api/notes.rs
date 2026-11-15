#[path = "../src/shared.rs"]
mod shared;
use serde_json::json;
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
            let rows = sqlx::query(&format!("SELECT {NOTE_COLUMNS} FROM notes WHERE user_id=$1 ORDER BY created_at DESC"))
                .bind(uid).fetch_all(&db).await?;
            let notes: Vec<_> = rows.iter().map(note_json).collect();
            response(200, json!({"notes": notes}))
        }
        "POST" => {
            let input: NewNote = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            let color = input.color.as_deref().unwrap_or("yellow");
            if let Some(message) = invalid_fields(Some(&input.title), Some(&input.content), Some(color), &[input.pos_x, input.pos_y]) { return error(400, message) }
            let due_date = match parse_due_date(input.due_date.as_deref()) { Ok(v) => v, Err(_) => return error(400, "Use a valid deadline date.") };
            // New notes land on top of every existing note.
            let row = sqlx::query(&format!("INSERT INTO notes (user_id, title, content, color, pos_x, pos_y, due_date, z_index) \
                VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(z_index),0)+1 FROM notes WHERE user_id=$1)) RETURNING {NOTE_COLUMNS}"))
                .bind(uid).bind(input.title.trim()).bind(input.content.trim()).bind(color).bind(input.pos_x).bind(input.pos_y).bind(due_date)
                .fetch_one(&db).await?;
            response(201, json!({"note": note_json(&row)}))
        }
        "PATCH" => {
            let input: UpdateNote = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
            if let Some(message) = invalid_fields(input.title.as_deref(), input.content.as_deref(), input.color.as_deref(), &[input.pos_x, input.pos_y]) { return error(400, message) }
            if input.z_index.is_some_and(|z| z < 0) { return error(400, "That note layer is out of range.") }
            if input.width.is_some_and(|w| !valid_width(w)) || input.height.is_some_and(|h| !valid_height(h)) { return error(400, "That note size is out of range.") }
            let due_date = match parse_due_date(input.due_date.as_deref()) { Ok(v) => v, Err(_) => return error(400, "Use a valid deadline date.") };
            let row = sqlx::query(&format!("UPDATE notes SET title=COALESCE($1,title), content=COALESCE($2,content), color=COALESCE($3,color), \
                completed=COALESCE($4,completed), due_date=CASE WHEN $5 THEN $6 ELSE due_date END, pos_x=COALESCE($7,pos_x), pos_y=COALESCE($8,pos_y), \
                z_index=COALESCE($9,z_index), collapsed=COALESCE($10,collapsed), width=COALESCE($11,width), height=COALESCE($12,height), \
                updated_at=now() WHERE id=$13 AND user_id=$14 RETURNING {NOTE_COLUMNS}"))
                .bind(input.title.as_deref().map(str::trim)).bind(input.content.as_deref().map(str::trim)).bind(input.color.as_deref())
                .bind(input.completed).bind(input.due_date.is_some()).bind(due_date).bind(input.pos_x).bind(input.pos_y).bind(input.z_index)
                .bind(input.collapsed).bind(input.width).bind(input.height).bind(input.id).bind(uid).fetch_optional(&db).await?;
            let Some(row) = row else { return error(404, "Note not found.") };
            response(200, json!({"note": note_json(&row)}))
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
