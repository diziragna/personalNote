//! The on-device SQLite store. Every note lives here first; the cloud only sees a note when the user syncs it.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

/// The space that holds notes made in the cave, without an account.
pub const CAVE: &str = "cave";

/// The note fields that are synced, with the same names as the API.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NoteFields {
    pub title: String,
    pub content: String,
    pub color: String,
    pub completed: bool,
    pub due_date: Option<String>,
    pub pos_x: Option<i32>,
    pub pos_y: Option<i32>,
    pub z_index: i32,
    pub collapsed: bool,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct LocalNote {
    pub id: String,
    /// `CAVE` or the id of the local account the note belongs to.
    pub space: String,
    pub fields: NoteFields,
    pub created_at: String,
    pub updated_at: String,
    /// The cloud `updated_at` this note was last synced at; `None` for a note the cloud has never seen.
    pub cloud_updated_at: Option<String>,
    /// Changed on this device since the last sync.
    pub dirty: bool,
    /// Deleted on this device; kept until the deletion is synced.
    pub deleted: bool,
    /// Bumped on every local edit, so a sync can tell whether the note changed while it was in flight.
    pub revision: i64,
    /// The cloud copy (JSON, or `null` when it was deleted) when both sides changed; waits for the user to choose.
    pub conflict: Option<String>,
}

impl LocalNote {
    pub fn sync_state(&self) -> &'static str {
        if self.space == CAVE { "cave" }
        else if self.conflict.is_some() { "conflict" }
        else if self.cloud_updated_at.is_none() { "local" }
        else if self.dirty { "changed" }
        else { "synced" }
    }

    /// Whether a sync should send this note.
    pub fn pushable(&self) -> bool { self.conflict.is_none() && (self.dirty || self.cloud_updated_at.is_none()) }

    pub fn to_json(&self) -> Value {
        let mut value = serde_json::to_value(&self.fields).unwrap_or_else(|_| json!({}));
        value["id"] = json!(self.id);
        value["created_at"] = json!(self.created_at);
        value["updated_at"] = json!(self.updated_at);
        value["sync_state"] = json!(self.sync_state());
        value["conflict"] = match self.conflict.as_deref() { None => Value::Null, Some("null") => json!("deleted"), Some(_) => json!("edited") };
        value
    }
}

#[derive(Clone, Debug)]
pub struct Account { pub id: String, pub username: String, pub password_hash: String, pub token: Option<String> }

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS accounts (
             id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, token TEXT);
         CREATE TABLE IF NOT EXISTS notes (
             id TEXT PRIMARY KEY, space TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, color TEXT NOT NULL,
             completed INTEGER NOT NULL, due_date TEXT, pos_x INTEGER, pos_y INTEGER, z_index INTEGER NOT NULL,
             collapsed INTEGER NOT NULL, width INTEGER, height INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
             cloud_updated_at TEXT, dirty INTEGER NOT NULL, deleted INTEGER NOT NULL, revision INTEGER NOT NULL, conflict TEXT);
         CREATE INDEX IF NOT EXISTS notes_space_idx ON notes(space);
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    Ok(db)
}

const NOTE_COLUMNS: &str = "id, space, title, content, color, completed, due_date, pos_x, pos_y, z_index, collapsed, width, height, \
    created_at, updated_at, cloud_updated_at, dirty, deleted, revision, conflict";

fn note_from_row(r: &Row) -> rusqlite::Result<LocalNote> {
    Ok(LocalNote {
        id: r.get(0)?, space: r.get(1)?,
        fields: NoteFields {
            title: r.get(2)?, content: r.get(3)?, color: r.get(4)?, completed: r.get(5)?, due_date: r.get(6)?,
            pos_x: r.get(7)?, pos_y: r.get(8)?, z_index: r.get(9)?, collapsed: r.get(10)?, width: r.get(11)?, height: r.get(12)?,
        },
        created_at: r.get(13)?, updated_at: r.get(14)?, cloud_updated_at: r.get(15)?, dirty: r.get(16)?, deleted: r.get(17)?,
        revision: r.get(18)?, conflict: r.get(19)?,
    })
}

/// Every note in a space, newest first; deleted notes awaiting sync only when asked for.
pub fn notes_in(db: &Connection, space: &str, include_deleted: bool) -> rusqlite::Result<Vec<LocalNote>> {
    let mut statement = db.prepare(&format!("SELECT {NOTE_COLUMNS} FROM notes WHERE space = ?1 AND (?2 OR deleted = 0)"))?;
    let mut notes = statement.query_map(params![space, include_deleted], note_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    notes.sort_by_cached_key(|note| std::cmp::Reverse(chrono::DateTime::parse_from_rfc3339(&note.created_at).ok()));
    Ok(notes)
}

pub fn note(db: &Connection, space: &str, id: &str) -> rusqlite::Result<Option<LocalNote>> {
    db.query_row(&format!("SELECT {NOTE_COLUMNS} FROM notes WHERE space = ?1 AND id = ?2"), params![space, id], note_from_row).optional()
}

pub fn save(db: &Connection, n: &LocalNote) -> rusqlite::Result<()> {
    let f = &n.fields;
    db.execute(
        &format!("INSERT OR REPLACE INTO notes ({NOTE_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)"),
        params![n.id, n.space, f.title, f.content, f.color, f.completed, f.due_date, f.pos_x, f.pos_y, f.z_index, f.collapsed, f.width, f.height,
            n.created_at, n.updated_at, n.cloud_updated_at, n.dirty, n.deleted, n.revision, n.conflict],
    )?;
    Ok(())
}

pub fn remove(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

pub fn top_z_index(db: &Connection, space: &str) -> rusqlite::Result<i32> {
    db.query_row("SELECT COALESCE(MAX(z_index), 0) FROM notes WHERE space = ?1", [space], |r| r.get(0))
}

/// Coming out of the cave: cave notes join the account as notes the cloud has not seen yet.
pub fn adopt_cave_notes(db: &Connection, space: &str) -> rusqlite::Result<()> {
    db.execute("UPDATE notes SET space = ?1, dirty = 1 WHERE space = ?2", params![space, CAVE])?;
    Ok(())
}

/// After an account is deleted its notes stay on this device, back in the cave.
pub fn release_to_cave(db: &Connection, space: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM notes WHERE space = ?1 AND deleted = 1", [space])?;
    db.execute("UPDATE notes SET space = ?1, cloud_updated_at = NULL, conflict = NULL, dirty = 1 WHERE space = ?2", params![CAVE, space])?;
    Ok(())
}

pub fn count_where(db: &Connection, space: &str, condition: &str) -> rusqlite::Result<i64> {
    db.query_row(&format!("SELECT COUNT(*) FROM notes WHERE space = ?1 AND {condition}"), [space], |r| r.get(0))
}

fn account_from_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account { id: r.get(0)?, username: r.get(1)?, password_hash: r.get(2)?, token: r.get(3)? })
}

pub fn account_by_id(db: &Connection, id: &str) -> rusqlite::Result<Option<Account>> {
    db.query_row("SELECT id, username, password_hash, token FROM accounts WHERE id = ?1", [id], account_from_row).optional()
}

pub fn account_by_username(db: &Connection, username: &str) -> rusqlite::Result<Option<Account>> {
    db.query_row("SELECT id, username, password_hash, token FROM accounts WHERE username = ?1", [username], account_from_row).optional()
}

/// Record a successful online sign-in, creating the local account the first time. Returns its id.
pub fn upsert_account(db: &Connection, username: &str, password_hash: &str, token: &str) -> rusqlite::Result<String> {
    if let Some(account) = account_by_username(db, username)? {
        db.execute("UPDATE accounts SET password_hash = ?1, token = ?2 WHERE id = ?3", params![password_hash, token, account.id])?;
        return Ok(account.id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO accounts (id, username, password_hash, token) VALUES (?1, ?2, ?3, ?4)", params![id, username, password_hash, token])?;
    Ok(id)
}

pub fn update_account(db: &Connection, id: &str, username: &str, password_hash: Option<&str>) -> rusqlite::Result<()> {
    db.execute("UPDATE accounts SET username = ?1, password_hash = COALESCE(?2, password_hash) WHERE id = ?3", params![username, password_hash, id])?;
    Ok(())
}

pub fn set_token(db: &Connection, id: &str, token: Option<&str>) -> rusqlite::Result<()> {
    db.execute("UPDATE accounts SET token = ?1 WHERE id = ?2", params![token, id])?;
    Ok(())
}

pub fn delete_account(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
    Ok(())
}

pub fn setting(db: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()
}

pub fn set_setting(db: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value {
        Some(value) => db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![key, value])?,
        None => db.execute("DELETE FROM settings WHERE key = ?1", [key])?,
    };
    Ok(())
}
