//! The board talks to this module exactly as it talks to the web API: the same paths, bodies, rules, and
//! messages, answered from the on-device store. Desktop-only routes live under `/api/desktop/`.

use crate::cloud::{self, CloudError};
use crate::rules::*;
use crate::store::{self, LocalNote, NoteFields, CAVE};
use crate::sync;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use reqwest::Method;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};

pub struct Session {
    /// `CAVE`, or the id of the signed-in local account.
    pub space: String,
    pub username: String,
    /// Kept in memory after an offline sign-in, to get a session token once the app is back online.
    pub password: Option<String>,
}

impl Session {
    pub fn account_id(&self) -> Option<&str> { (self.space != CAVE).then_some(self.space.as_str()) }
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub http: reqwest::Client,
    pub session: Mutex<Option<Session>>,
    /// Whether the last call to the cloud got through; unknown until the first one.
    pub online: Mutex<Option<bool>>,
}

impl AppState {
    /// Reopen whatever session was active when the app last closed.
    pub fn new(db: Connection) -> Self {
        let session = match store::setting(&db, "session").ok().flatten() {
            Some(space) if space == CAVE => Some(Session { space, username: "cave".into(), password: None }),
            Some(id) => store::account_by_id(&db, &id).ok().flatten().map(|a| Session { space: a.id, username: a.username, password: None }),
            None => None,
        };
        Self { db: Mutex::new(db), http: cloud::client(), session: Mutex::new(session), online: Mutex::new(None) }
    }

    pub fn db(&self) -> MutexGuard<'_, Connection> { self.db.lock().unwrap_or_else(|e| e.into_inner()) }
    pub fn session(&self) -> MutexGuard<'_, Option<Session>> { self.session.lock().unwrap_or_else(|e| e.into_inner()) }
    pub fn set_online(&self, online: bool) { *self.online.lock().unwrap_or_else(|e| e.into_inner()) = Some(online) }
}

pub struct ApiError { pub status: u16, pub message: String }
pub type ApiResult = Result<Value, ApiError>;

pub fn fail(status: u16, message: &str) -> ApiError { ApiError { status, message: message.to_owned() } }

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        eprintln!("local store error: {error}");
        fail(500, "Daynote couldn't read or write its data on this device.")
    }
}

pub fn cloud_error(error: CloudError, offline_message: &str) -> ApiError {
    match error {
        CloudError::Offline => fail(503, offline_message),
        CloudError::Status(status, message) => fail(status, &message),
    }
}

#[tauri::command]
pub async fn api(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, method: String, path: String, body: Option<Value>) -> Result<Value, Value> {
    let result = route(&state, &method, &path, body.unwrap_or(Value::Null)).await;
    if let Ok(data) = &result { crate::windows::after_change(&app, &window, &method, &path, data) }
    result.map_err(|e| json!({"status": e.status, "error": e.message}))
}

/// A new empty note in the current session, for the tray menu. Colors rotate as they do on the board.
pub fn create_note(s: &AppState) -> ApiResult {
    let space = current_space(s)?;
    let count = store::notes_in(&s.db(), &space, false)?.len();
    notes(s, "POST", json!({"color": NOTE_COLORS[count % NOTE_COLORS.len()]}))
}

async fn route(s: &AppState, method: &str, path: &str, body: Value) -> ApiResult {
    match (method, path) {
        ("GET", "/api/auth") => current_account(s),
        ("POST", "/api/auth") => sign_in(s, body).await,
        ("PATCH", "/api/auth") => change_credentials(s, body).await,
        ("DELETE", "/api/auth") => sign_out(s, body).await,
        (_, "/api/notes") => notes(s, method, body),
        ("POST", "/api/desktop/cave") => enter_cave(s),
        ("GET", "/api/desktop/status") => status(s),
        ("POST", "/api/desktop/sync") => sync::sync(s, body).await,
        ("POST", "/api/desktop/pull") => sync::pull(s).await,
        ("POST", "/api/desktop/resolve") => sync::resolve(s, body).await,
        _ => Err(fail(404, "Not found.")),
    }
}

pub fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true) }

fn current_space(s: &AppState) -> Result<String, ApiError> {
    s.session().as_ref().map(|session| session.space.clone()).ok_or_else(|| fail(401, "Please sign in to continue."))
}

pub fn notes_json(db: &Connection, space: &str) -> Result<Vec<Value>, ApiError> {
    Ok(store::notes_in(db, space, false)?.iter().map(LocalNote::to_json).collect())
}

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = argon2::password_hash::SaltString::generate(&mut rand::thread_rng());
    Argon2::default().hash_password(password.as_bytes(), &salt).map(|hash| hash.to_string()).map_err(|_| fail(500, "Could not save your account on this device."))
}

fn verify_password(password: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|hash| Argon2::default().verify_password(password.as_bytes(), &hash).is_ok())
}

fn current_account(s: &AppState) -> ApiResult {
    match s.session().as_ref() {
        Some(session) => Ok(json!({"username": session.username, "cave": session.space == CAVE})),
        None => Err(fail(401, "Please sign in to continue.")),
    }
}

fn enter_cave(s: &AppState) -> ApiResult {
    store::set_setting(&s.db(), "session", Some(CAVE))?;
    *s.session() = Some(Session { space: CAVE.into(), username: "cave".into(), password: None });
    Ok(json!({"username": "cave", "cave": true}))
}

fn status(s: &AppState) -> ApiResult {
    let space = current_space(s)?;
    let db = s.db();
    let pending = store::count_where(&db, &space, "conflict IS NULL AND (dirty = 1 OR cloud_updated_at IS NULL)")?;
    let conflicts = store::count_where(&db, &space, "conflict IS NOT NULL")?;
    let online = *s.online.lock().unwrap_or_else(|e| e.into_inner());
    Ok(json!({"cave": space == CAVE, "online": online, "pending": pending, "conflicts": conflicts}))
}

async fn sign_in(s: &AppState, body: Value) -> ApiResult {
    let action = body["action"].as_str().unwrap_or_default();
    if action != "signup" && action != "signin" { return Err(fail(400, "Unknown action.")) }
    let username = body["username"].as_str().unwrap_or_default().trim().to_ascii_lowercase();
    let password = body["password"].as_str().unwrap_or_default().to_owned();
    if !valid_username(&username) { return Err(fail(400, "Use 3-24 letters, numbers, underscores, or hyphens for your username.")) }
    if !valid_password(&password) { return Err(fail(400, "Your password must be at least 8 characters.")) }
    let from_cave = s.session().as_ref().is_some_and(|session| session.space == CAVE);

    let request = json!({"action": action, "username": username, "password": password, "return_token": true});
    match cloud::call(&s.http, Method::POST, "/api/auth", None, Some(&request)).await {
        Ok(data) => {
            s.set_online(true);
            let name = data["username"].as_str().unwrap_or(&username).to_owned();
            let token = data["token"].as_str().unwrap_or_default();
            let hash = hash_password(&password)?;
            let id = store::upsert_account(&s.db(), &name, &hash, token)?;
            finish_sign_in(s, id, name, None, from_cave)
        }
        // A returning user can open their notes offline; the password is checked against the copy kept from the last online sign-in.
        Err(CloudError::Offline) if action == "signin" => {
            s.set_online(false);
            let account = store::account_by_username(&s.db(), &username)?
                .ok_or_else(|| fail(503, "You're offline. Connect to the internet to sign in on this device for the first time."))?;
            if !verify_password(&password, &account.password_hash) { return Err(fail(401, "Username or password is incorrect.")) }
            finish_sign_in(s, account.id, account.username, Some(password), from_cave)
        }
        Err(error) => Err(cloud_error(error, "You're offline. Connect to the internet to create an account.")),
    }
}

fn finish_sign_in(s: &AppState, id: String, username: String, password: Option<String>, from_cave: bool) -> ApiResult {
    {
        let db = s.db();
        if from_cave { store::adopt_cave_notes(&db, &id)? }
        store::set_setting(&db, "session", Some(&id))?;
    }
    *s.session() = Some(Session { space: id, username: username.clone(), password });
    Ok(json!({"username": username, "cave": false}))
}

/// A session token for the signed-in account, signing in again with the remembered password if there is none.
pub async fn ensure_token(s: &AppState) -> Result<(String, String), ApiError> {
    let (id, username, password) = match s.session().as_ref() {
        Some(session) if session.space != CAVE => (session.space.clone(), session.username.clone(), session.password.clone()),
        _ => return Err(fail(401, "Please sign in to continue.")),
    };
    if let Some(token) = store::account_by_id(&s.db(), &id)?.and_then(|account| account.token) { return Ok((id, token)) }
    let password = password.ok_or_else(|| fail(401, "Sign out and sign in again to sync this account."))?;
    let request = json!({"action": "signin", "username": username, "password": password, "return_token": true});
    let data = cloud::call(&s.http, Method::POST, "/api/auth", None, Some(&request)).await
        .map_err(|error| cloud_error(error, "You're offline. Your notes are safe on this device; sync when you're back online."))?;
    s.set_online(true);
    let token = data["token"].as_str().unwrap_or_default().to_owned();
    store::set_token(&s.db(), &id, Some(&token))?;
    Ok((id, token))
}

/// Forget a token the cloud no longer accepts.
pub fn drop_token(s: &AppState, id: &str) -> Result<(), ApiError> { Ok(store::set_token(&s.db(), id, None)?) }

async fn change_credentials(s: &AppState, body: Value) -> ApiResult {
    let (id, token) = ensure_token(s).await?;
    let data = cloud::call(&s.http, Method::PATCH, "/api/auth", Some(&token), Some(&body)).await
        .map_err(|error| cloud_error(error, "You're offline. Connect to the internet to change your account."))?;
    let username = data["username"].as_str().unwrap_or_default().to_owned();
    let new_hash = match body["new_password"].as_str() { Some(password) if !password.is_empty() => Some(hash_password(password)?), _ => None };
    store::update_account(&s.db(), &id, &username, new_hash.as_deref())?;
    if let Some(session) = s.session().as_mut() { session.username = username.clone() }
    Ok(json!({"username": username, "cave": false}))
}

/// Signing out keeps the account's synced notes on this device and in the cloud, for the next sign-in; notes
/// the cloud never saw go back to the cave. Deleting the account removes it from the cloud; its notes stay on
/// this device, in the cave.
pub async fn sign_out(s: &AppState, body: Value) -> ApiResult {
    let account_id = s.session().as_ref().and_then(|session| session.account_id().map(str::to_owned));
    if body["delete_account"].as_bool() == Some(true) {
        let (id, token) = ensure_token(s).await?;
        let request = json!({"delete_account": true, "password": body["password"]});
        cloud::call(&s.http, Method::DELETE, "/api/auth", Some(&token), Some(&request)).await
            .map_err(|error| cloud_error(error, "You're offline. Connect to the internet to delete your account."))?;
        let db = s.db();
        store::release_to_cave(&db, &id)?;
        store::delete_account(&db, &id)?;
    } else if let Some(id) = account_id {
        let token = store::account_by_id(&s.db(), &id)?.and_then(|account| account.token);
        // Revoke the session in the cloud when possible; signing out on this device works either way.
        if let Some(token) = token { let _ = cloud::call(&s.http, Method::DELETE, "/api/auth", Some(&token), None).await; }
        drop_token(s, &id)?;
        store::keep_unsynced_in_cave(&s.db(), &id)?;
    }
    // Notes that are only on this device stay on the screen: the app carries on in the cave instead of signing out to nothing.
    let cave = store::count_where(&s.db(), CAVE, "deleted = 0")? > 0;
    store::set_setting(&s.db(), "session", cave.then_some(CAVE))?;
    *s.session() = cave.then(|| Session { space: CAVE.into(), username: "cave".into(), password: None });
    Ok(json!({"ok": true, "cave": cave}))
}

#[derive(Deserialize)]
struct NewNote {
    #[serde(default)] title: String, #[serde(default)] content: String, color: Option<String>,
    pos_x: Option<i32>, pos_y: Option<i32>, due_date: Option<String>,
}

#[derive(Deserialize)]
struct UpdateNote {
    id: String, title: Option<String>, content: Option<String>, color: Option<String>, completed: Option<bool>,
    due_date: Option<String>, pos_x: Option<i32>, pos_y: Option<i32>, z_index: Option<i32>,
    collapsed: Option<bool>, width: Option<i32>, height: Option<i32>,
}

#[derive(Deserialize)]
struct DeleteNote { id: String }

fn parse<T: for<'de> Deserialize<'de>>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body).map_err(|_| fail(400, "Invalid request body."))
}

fn deadline(value: Option<&str>) -> Result<Option<String>, ApiError> {
    parse_due_date(value).map(|date| date.map(|d| d.to_string())).map_err(|_| fail(400, "Use a valid deadline date."))
}

fn notes(s: &AppState, method: &str, body: Value) -> ApiResult {
    let space = current_space(s)?;
    let db = s.db();
    match method {
        "GET" => Ok(json!({"notes": notes_json(&db, &space)?})),
        "POST" => {
            let input: NewNote = parse(body)?;
            let color = input.color.unwrap_or_else(|| "yellow".into());
            if let Some(message) = invalid_fields(Some(&input.title), Some(&input.content), Some(&color), &[input.pos_x, input.pos_y]) { return Err(fail(400, message)) }
            let due_date = deadline(input.due_date.as_deref())?;
            let now = now();
            // New notes land on top of every existing note.
            let note = LocalNote {
                id: uuid::Uuid::new_v4().to_string(), space: space.clone(),
                fields: NoteFields {
                    title: input.title.trim().into(), content: input.content.trim().into(), color, completed: false, due_date,
                    pos_x: input.pos_x, pos_y: input.pos_y, z_index: store::top_z_index(&db, &space)? + 1, collapsed: false, width: None, height: None,
                },
                created_at: now.clone(), updated_at: now, cloud_updated_at: None, dirty: true, deleted: false, revision: 0, conflict: None,
            };
            store::save(&db, &note)?;
            Ok(json!({"note": note.to_json()}))
        }
        "PATCH" => {
            let input: UpdateNote = parse(body)?;
            if let Some(message) = invalid_fields(input.title.as_deref(), input.content.as_deref(), input.color.as_deref(), &[input.pos_x, input.pos_y]) { return Err(fail(400, message)) }
            if input.z_index.is_some_and(|z| z < 0) { return Err(fail(400, "That note layer is out of range.")) }
            if input.width.is_some_and(|w| !valid_width(w)) || input.height.is_some_and(|h| !valid_height(h)) { return Err(fail(400, "That note size is out of range.")) }
            let due_date = deadline(input.due_date.as_deref())?;
            let mut note = store::note(&db, &space, &input.id)?.filter(|note| !note.deleted).ok_or_else(|| fail(404, "Note not found."))?;
            let f = &mut note.fields;
            if let Some(title) = input.title { f.title = title.trim().into() }
            if let Some(content) = input.content { f.content = content.trim().into() }
            if let Some(color) = input.color { f.color = color }
            if let Some(completed) = input.completed { f.completed = completed }
            if input.due_date.is_some() { f.due_date = due_date }
            if input.pos_x.is_some() { f.pos_x = input.pos_x }
            if input.pos_y.is_some() { f.pos_y = input.pos_y }
            if let Some(z_index) = input.z_index { f.z_index = z_index }
            if let Some(collapsed) = input.collapsed { f.collapsed = collapsed }
            if input.width.is_some() { f.width = input.width }
            if input.height.is_some() { f.height = input.height }
            note.updated_at = now();
            note.dirty = true;
            note.revision += 1;
            store::save(&db, &note)?;
            Ok(json!({"note": note.to_json()}))
        }
        "DELETE" => {
            let input: DeleteNote = parse(body)?;
            let mut note = store::note(&db, &space, &input.id)?.filter(|note| !note.deleted).ok_or_else(|| fail(404, "Note not found."))?;
            // A note the cloud has seen is kept as a deletion to sync; one it never saw can simply go.
            if note.cloud_updated_at.is_none() {
                store::remove(&db, &note.id)?;
            } else {
                note.deleted = true;
                note.dirty = true;
                note.revision += 1;
                store::save(&db, &note)?;
            }
            Ok(json!({"ok": true}))
        }
        _ => Err(fail(405, "Method not allowed.")),
    }
}
