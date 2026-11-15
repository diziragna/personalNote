#[path = "../src/shared.rs"]
mod shared;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;
use vercel_runtime::{run, service_fn, Error, Request, Response, ResponseBody};
use shared::*;

const MAX_CHANGES: usize = 500;

#[derive(Deserialize)]
struct SyncInput { #[serde(default)] changes: Vec<Change>, #[serde(default)] pull: bool }

/// One note edited on a device. `base_updated_at` is the cloud version the device last saw (absent for a
/// note that has never been synced); the change only applies while the cloud copy is still at that version.
#[derive(Deserialize)]
struct Change { id: Uuid, base_updated_at: Option<DateTime<Utc>>, #[serde(default)] deleted: bool, note: Option<SyncedNote> }

/// The full state of a note on the device.
#[derive(Deserialize)]
struct SyncedNote {
    #[serde(default)] title: String, #[serde(default)] content: String, #[serde(default = "default_color")] color: String,
    #[serde(default)] completed: bool, due_date: Option<NaiveDate>, pos_x: Option<i32>, pos_y: Option<i32>,
    #[serde(default)] z_index: i32, #[serde(default)] collapsed: bool, width: Option<i32>, height: Option<i32>,
    created_at: Option<DateTime<Utc>>
}

fn default_color() -> String { "yellow".into() }

fn invalid_note(n: &SyncedNote) -> Option<&'static str> {
    if let Some(message) = invalid_fields(Some(&n.title), Some(&n.content), Some(&n.color), &[n.pos_x, n.pos_y]) { return Some(message) }
    if n.z_index < 0 { return Some("That note layer is out of range.") }
    if n.width.is_some_and(|w| !valid_width(w)) || n.height.is_some_and(|h| !valid_height(h)) { return Some("That note size is out of range.") }
    None
}

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
    if req.method().as_str() != "POST" { return error(405, "Method not allowed.") }
    let input: SyncInput = match body(req).await { Ok(v) => v, Err(_) => return error(400, "Invalid request body.") };
    if input.changes.len() > MAX_CHANGES { return error(400, "Sync at most 500 notes at a time.") }

    let mut tx = db.begin().await?;
    let mut results = Vec::with_capacity(input.changes.len());
    for change in input.changes { results.push(apply(&mut tx, uid, change).await?); }
    tx.commit().await?;

    let mut payload = json!({"results": results});
    if input.pull {
        let rows = sqlx::query(&format!("SELECT {NOTE_COLUMNS} FROM notes WHERE user_id=$1 ORDER BY created_at DESC")).bind(uid).fetch_all(&db).await?;
        payload["notes"] = rows.iter().map(note_json).collect();
    }
    response(200, payload)
}

/// Apply one change and describe the outcome: `created`, `updated`, `deleted`, `conflict` (with the
/// cloud copy, or null when it was deleted), or `invalid` (with an error message).
async fn apply(tx: &mut PgConnection, uid: Uuid, change: Change) -> Result<Value, sqlx::Error> {
    let id = change.id;
    let invalid = |message: &str| json!({"id": id, "status": "invalid", "error": message});
    let current = sqlx::query(&format!("SELECT user_id, {NOTE_COLUMNS} FROM notes WHERE id=$1 FOR UPDATE")).bind(id).fetch_optional(&mut *tx).await?;
    if current.as_ref().is_some_and(|row| row.get::<Uuid, _>("user_id") != uid) { return Ok(invalid("That note id is already in use.")) }

    let cloud_version = current.as_ref().map(|row| row.get::<DateTime<Utc>, _>("updated_at"));
    if cloud_version != change.base_updated_at {
        // Deleting a note that is already gone needs no decision.
        if change.deleted && current.is_none() { return Ok(json!({"id": id, "status": "deleted"})) }
        return Ok(json!({"id": id, "status": "conflict", "note": current.as_ref().map(note_json)}));
    }

    if change.deleted {
        if current.is_some() { sqlx::query("DELETE FROM notes WHERE id=$1").bind(id).execute(&mut *tx).await?; }
        return Ok(json!({"id": id, "status": "deleted"}));
    }
    let Some(note) = change.note else { return Ok(invalid("The note is missing.")) };
    if let Some(message) = invalid_note(&note) { return Ok(invalid(message)) }

    // clock_timestamp() rather than now(): every change in the batch must get a version later than any it replaced.
    let created = current.is_none();
    let sql = if created {
        format!("INSERT INTO notes (id, user_id, title, content, color, completed, due_date, pos_x, pos_y, z_index, collapsed, width, height, created_at, updated_at) \
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,LEAST(COALESCE($14, clock_timestamp()), clock_timestamp()),clock_timestamp()) RETURNING {NOTE_COLUMNS}")
    } else {
        format!("UPDATE notes SET title=$3, content=$4, color=$5, completed=$6, due_date=$7, pos_x=$8, pos_y=$9, z_index=$10, collapsed=$11, \
            width=$12, height=$13, updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING {NOTE_COLUMNS}")
    };
    let query = sqlx::query(&sql)
        .bind(id).bind(uid).bind(note.title.trim()).bind(note.content.trim()).bind(&note.color).bind(note.completed).bind(note.due_date)
        .bind(note.pos_x).bind(note.pos_y).bind(note.z_index).bind(note.collapsed).bind(note.width).bind(note.height);
    let query = if created { query.bind(note.created_at) } else { query };
    let row = query.fetch_one(&mut *tx).await?;
    Ok(json!({"id": id, "status": if created { "created" } else { "updated" }, "note": note_json(&row)}))
}
