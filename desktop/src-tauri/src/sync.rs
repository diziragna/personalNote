//! Syncing between this device and the cloud. Sending changes up only happens when the user asks, for one
//! note or for all of them; bringing cloud changes down also happens on its own while the app is online.

use crate::api::{self, fail, ApiError, ApiResult, AppState};
use crate::cloud::{self, CloudError};
use crate::store::{self, LocalNote, NoteFields};
use reqwest::Method;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const OFFLINE: &str = "You're offline. Your notes are safe on this device; sync when you're back online.";

fn fields_of(cloud: &Value) -> Option<NoteFields> { serde_json::from_value(cloud.clone()).ok() }

/// Push this device's changes (every pushable note, or only `ids`) and bring the cloud's notes back down.
pub async fn sync(s: &AppState, body: Value) -> ApiResult {
    let ids: Option<HashSet<String>> = body["ids"].as_array().map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect());
    let mut retried = false;
    loop {
        let (space, token) = api::ensure_token(s).await?;
        let (changes, revisions) = {
            let db = s.db();
            let mut changes = Vec::new();
            let mut revisions = HashMap::new();
            for note in store::notes_in(&db, &space, true)? {
                if !note.pushable() || ids.as_ref().is_some_and(|ids| !ids.contains(&note.id)) { continue }
                changes.push(change_for(&note));
                revisions.insert(note.id.clone(), note.revision);
            }
            (changes, revisions)
        };
        let request = json!({"changes": changes, "pull": true});
        match cloud::call(&s.http, Method::POST, "/api/sync", Some(&token), Some(&request)).await {
            Ok(data) => {
                s.set_online(true);
                return apply_results(s, &space, ids.as_ref(), &revisions, &data);
            }
            // The token was revoked or expired: forget it and sign in again once, if the password is at hand.
            Err(CloudError::Status(401, _)) if !retried => {
                api::drop_token(s, &space)?;
                retried = true;
            }
            Err(error) => {
                if matches!(error, CloudError::Offline) { s.set_online(false) }
                return Err(api::cloud_error(error, OFFLINE));
            }
        }
    }
}

fn change_for(note: &LocalNote) -> Value {
    if note.deleted { return json!({"id": note.id, "base_updated_at": note.cloud_updated_at, "deleted": true}) }
    let mut payload = serde_json::to_value(&note.fields).unwrap_or_else(|_| json!({}));
    payload["created_at"] = json!(note.created_at);
    json!({"id": note.id, "base_updated_at": note.cloud_updated_at, "note": payload})
}

fn apply_results(s: &AppState, space: &str, ids: Option<&HashSet<String>>, revisions: &HashMap<String, i64>, data: &Value) -> ApiResult {
    let db = s.db();
    let (mut synced, mut conflicts, mut errors) = (0, 0, Vec::new());
    for result in data["results"].as_array().into_iter().flatten() {
        let Some(id) = result["id"].as_str() else { continue };
        let Some(mut note) = store::note(&db, space, id)? else { continue };
        let cloud = &result["note"];
        let version = cloud["updated_at"].as_str().map(str::to_owned);
        // Edits made while the request was in flight stay pending.
        let unchanged = revisions.get(id) == Some(&note.revision);
        match result["status"].as_str() {
            Some("created" | "updated") => {
                if unchanged { if let Some(fields) = fields_of(cloud) { note.fields = fields; note.dirty = false } }
                note.cloud_updated_at = version;
                store::save(&db, &note)?;
                synced += 1;
            }
            Some("deleted") => { store::remove(&db, id)?; synced += 1 }
            Some("conflict") => {
                let cloud_fields = fields_of(cloud);
                if note.deleted {
                    // Deleted here but changed in the cloud: keep the cloud's version rather than lose that work.
                    take_cloud(&db, note, cloud)?;
                    conflicts += 1;
                } else if cloud_fields.as_ref() == Some(&note.fields) {
                    // Both sides already agree (for example a create whose reply was lost), so nothing needs deciding.
                    note.cloud_updated_at = version;
                    note.dirty = false;
                    store::save(&db, &note)?;
                    synced += 1;
                } else {
                    note.conflict = Some(cloud.to_string());
                    store::save(&db, &note)?;
                    conflicts += 1;
                }
            }
            _ => errors.push(result["error"].as_str().unwrap_or("A note could not be synced.").to_owned()),
        }
    }
    if let Some(cloud_notes) = data["notes"].as_array() { pull_into(&db, space, cloud_notes, ids)?; }
    Ok(json!({"notes": api::notes_json(&db, space)?, "synced": synced, "conflicts": conflicts, "errors": errors}))
}

/// Replace a local note with its cloud copy, or remove it when the cloud copy is gone.
fn take_cloud(db: &Connection, mut note: LocalNote, cloud: &Value) -> Result<(), ApiError> {
    let (Some(fields), Some(version)) = (fields_of(cloud), cloud["updated_at"].as_str()) else { return Ok(store::remove(db, &note.id)?) };
    note.fields = fields;
    note.cloud_updated_at = Some(version.to_owned());
    note.updated_at = version.to_owned();
    note.dirty = false;
    note.deleted = false;
    note.conflict = None;
    note.revision += 1;
    Ok(store::save(db, &note)?)
}

/// Bring cloud notes into a space. Notes with unsynced local changes are left alone; their next sync
/// reports any conflict. Returns whether anything on this device changed.
fn pull_into(db: &Connection, space: &str, cloud_notes: &[Value], ids: Option<&HashSet<String>>) -> Result<bool, ApiError> {
    let wanted = |id: &str| ids.is_none_or(|ids| ids.contains(id));
    let mut changed = false;
    let mut seen = HashSet::new();
    for cloud in cloud_notes {
        let (Some(id), Some(version), Some(fields)) = (cloud["id"].as_str(), cloud["updated_at"].as_str(), fields_of(cloud)) else { continue };
        seen.insert(id.to_owned());
        if !wanted(id) { continue }
        match store::note(db, space, id)? {
            None => {
                store::save(db, &LocalNote {
                    id: id.to_owned(), space: space.to_owned(), fields,
                    created_at: cloud["created_at"].as_str().unwrap_or(version).to_owned(), updated_at: version.to_owned(),
                    cloud_updated_at: Some(version.to_owned()), dirty: false, deleted: false, revision: 0, conflict: None,
                })?;
                changed = true;
            }
            Some(note) if !note.dirty && note.conflict.is_none() && note.cloud_updated_at.as_deref() != Some(version) => {
                take_cloud(db, note, cloud)?;
                changed = true;
            }
            Some(_) => {}
        }
    }
    // A synced note missing from the cloud was deleted there.
    for note in store::notes_in(db, space, true)? {
        if note.cloud_updated_at.is_some() && !note.dirty && note.conflict.is_none() && !seen.contains(&note.id) && wanted(&note.id) {
            store::remove(db, &note.id)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Bring the cloud's notes down without sending anything up. Quietly does nothing while offline.
pub async fn pull(s: &AppState) -> ApiResult {
    let (space, token) = match api::ensure_token(s).await {
        Ok(found) => found,
        Err(error) => return Ok(json!({"changed": false, "error": error.message})),
    };
    match cloud::call(&s.http, Method::GET, "/api/notes", Some(&token), None).await {
        Ok(data) => {
            s.set_online(true);
            let db = s.db();
            let changed = pull_into(&db, &space, data["notes"].as_array().map(Vec::as_slice).unwrap_or_default(), None)?;
            Ok(json!({"changed": changed, "notes": api::notes_json(&db, &space)?}))
        }
        Err(CloudError::Offline) => { s.set_online(false); Ok(json!({"changed": false})) }
        Err(CloudError::Status(401, message)) => { api::drop_token(s, &space)?; Ok(json!({"changed": false, "error": message})) }
        Err(error) => Err(api::cloud_error(error, OFFLINE)),
    }
}

/// Settle a conflict: keep this device's version (and sync it now), keep the cloud's, or keep both as two notes.
pub async fn resolve(s: &AppState, body: Value) -> ApiResult {
    let id = body["id"].as_str().unwrap_or_default().to_owned();
    let keep = body["keep"].as_str().unwrap_or_default();
    let space = match s.session().as_ref() {
        Some(session) if session.account_id().is_some() => session.space.clone(),
        _ => return Err(fail(401, "Please sign in to continue.")),
    };
    {
        let db = s.db();
        let mut note = store::note(&db, &space, &id)?.ok_or_else(|| fail(404, "Note not found."))?;
        let cloud: Value = match note.conflict.as_deref() {
            Some(conflict) => serde_json::from_str(conflict).unwrap_or(Value::Null),
            None => return Err(fail(400, "This note has nothing to resolve.")),
        };
        match keep {
            "cloud" => take_cloud(&db, note, &cloud)?,
            "device" => {
                // Base the device's version on the cloud's latest so the next sync replaces it (or recreates a deleted note).
                note.cloud_updated_at = cloud["updated_at"].as_str().map(str::to_owned);
                note.conflict = None;
                note.dirty = true;
                note.revision += 1;
                store::save(&db, &note)?;
            }
            "both" => {
                let now = api::now();
                let mut copy = note.clone();
                copy.id = uuid::Uuid::new_v4().to_string();
                copy.fields.pos_x = copy.fields.pos_x.map(|x| (x + 28).min(100_000));
                copy.fields.pos_y = copy.fields.pos_y.map(|y| (y + 28).min(100_000));
                copy.created_at = now.clone();
                copy.updated_at = now;
                copy.cloud_updated_at = None;
                copy.conflict = None;
                copy.dirty = true;
                copy.revision = 0;
                store::save(&db, &copy)?;
                take_cloud(&db, note, &cloud)?;
            }
            _ => return Err(fail(400, "Choose which version to keep.")),
        }
    }
    if keep == "device" { return sync(s, json!({"ids": [id]})).await }
    Ok(json!({"notes": api::notes_json(&s.db(), &space)?, "synced": 0, "conflicts": 0, "errors": []}))
}
