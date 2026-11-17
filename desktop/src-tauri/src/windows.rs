//! Every note is a small frameless window of its own, placed anywhere on the screen. This module keeps
//! those windows in step with the notes of the current session and remembers where each one was left.

use crate::api::{self, AppState};
use crate::store::{self, LocalNote};
use crate::sync;
use serde_json::Value;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// A note's window is labelled with this prefix followed by the note's id; the page reads its note from the label.
pub const NOTE_PREFIX: &str = "note-";
/// Sent to the windows when notes were added, removed, or changed outside the window that shows them.
const CHANGED: &str = "notes-changed";

/// Tells the main window to show the account form, or the sign-in screen when there is no account to change.
pub const OPEN_ACCOUNT: &str = "open-account";
/// Tells the main window that the tray signed the account out.
const SIGNED_OUT: &str = "signed-out";
/// Tells every window that dark mode was turned on (`true`) or off.
pub const THEME: &str = "theme";

const DEFAULT_WIDTH: f64 = 248.0;
const DEFAULT_HEIGHT: f64 = 220.0;
/// The height of a collapsed note until its page measures the real one.
const COLLAPSED_HEIGHT: f64 = 44.0;

/// A monitor, in physical pixels.
struct Screen { x: i32, y: i32, width: i32, height: i32, scale: f64 }

impl Screen {
    fn px(&self, logical: f64) -> i32 { (logical * self.scale).round() as i32 }

    /// Whether a note placed at this point is still reachable on this monitor.
    fn shows(&self, x: i32, y: i32) -> bool {
        x + self.px(60.0) > self.x && x < self.x + self.width - self.px(60.0) && y >= self.y && y < self.y + self.height - self.px(40.0)
    }

    /// Where a note that was never placed on this device goes: where it sits on the web board when it has
    /// a position there, otherwise stepping down from the top-left corner so new notes do not hide each other.
    fn default_place(&self, note: &LocalNote, slot: usize) -> (i32, i32) {
        let step = self.px(32.0) * (slot % 8) as i32;
        let x = note.fields.pos_x.map_or(self.px(60.0) + step, |v| self.px(v as f64));
        let y = note.fields.pos_y.map_or(self.px(60.0) + step, |v| self.px(v as f64 + 40.0));
        let max_x = (self.width - self.px(DEFAULT_WIDTH + 32.0)).max(0);
        let max_y = (self.height - self.px(DEFAULT_HEIGHT + 60.0)).max(0);
        (self.x + x.clamp(0, max_x), self.y + y.clamp(0, max_y))
    }
}

fn screens(app: &AppHandle) -> (Vec<Screen>, Option<Screen>) {
    let Some(main) = app.get_webview_window("main") else { return (Vec::new(), None) };
    let all: Vec<Screen> = main.available_monitors().unwrap_or_default().iter()
        .map(|m| Screen { x: m.position().x, y: m.position().y, width: m.size().width as i32, height: m.size().height as i32, scale: m.scale_factor() })
        .collect();
    let primary = main.primary_monitor().ok().flatten()
        .map(|m| Screen { x: m.position().x, y: m.position().y, width: m.size().width as i32, height: m.size().height as i32, scale: m.scale_factor() });
    (all, primary)
}

fn note_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(label, _)| label.starts_with(NOTE_PREFIX)).map(|(_, window)| window).collect()
}

/// Open a window for every note of the current session that has none, and close the windows of notes that
/// are gone (deleted, or the session ended). `near` places a new note next to the note it was created from.
/// Returns how many notes the session has.
pub fn reconcile(app: &AppHandle, near: Option<PhysicalPosition<i32>>, focus_new: bool) -> usize {
    let state = app.state::<AppState>();
    let space = state.session().as_ref().map(|session| session.space.clone());
    let notes = match &space {
        Some(space) => store::notes_in(&state.db(), space, false).unwrap_or_default(),
        None => Vec::new(),
    };
    let wanted: HashSet<String> = notes.iter().map(|note| format!("{NOTE_PREFIX}{}", note.id)).collect();
    let mut open = 0;
    for window in note_windows(app) {
        if wanted.contains(window.label()) { open += 1 } else { let _ = window.destroy(); }
    }

    let (all, primary) = screens(app);
    // Oldest first, so newer notes end up on top.
    for note in notes.iter().rev() {
        let label = format!("{NOTE_PREFIX}{}", note.id);
        if app.get_webview_window(&label).is_some() { continue }
        let saved = store::place(&state.db(), &note.id).ok().flatten()
            .filter(|&(x, y)| all.is_empty() || all.iter().any(|screen| screen.shows(x, y)));
        let place = saved.or_else(|| {
            let fresh = match (near, primary.as_ref()) {
                (Some(p), Some(screen)) => Some((p.x + screen.px(36.0), p.y + screen.px(36.0))),
                (Some(p), None) => Some((p.x + 36, p.y + 36)),
                (None, Some(screen)) => Some(screen.default_place(note, open)),
                (None, None) => None,
            };
            if let Some((x, y)) = fresh { let _ = store::set_place(&state.db(), &note.id, x, y); }
            fresh
        });

        let fields = &note.fields;
        let width = fields.width.map_or(DEFAULT_WIDTH, f64::from);
        let height = if fields.collapsed { COLLAPSED_HEIGHT } else { fields.height.map_or(DEFAULT_HEIGHT, f64::from) };
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title(if fields.title.is_empty() { "Daynote" } else { fields.title.as_str() })
            .inner_size(width, height)
            .min_inner_size(180.0, 40.0)
            .decorations(false)
            .skip_taskbar(true)
            .maximizable(false)
            .minimizable(false)
            .focused(focus_new)
            .visible(false)
            .build();
        match built {
            Ok(window) => {
                if let Some((x, y)) = place { let _ = window.set_position(PhysicalPosition::new(x, y)); }
                let _ = window.show();
                if focus_new { let _ = window.set_focus(); }
                open += 1;
            }
            Err(error) => eprintln!("could not open a note window: {error}"),
        }
    }
    notes.len()
}

/// Called after every request a window made to the local API, to bring the note windows up to date.
pub fn after_change(app: &AppHandle, source: &WebviewWindow, method: &str, path: &str, data: &Value) {
    if method == "GET" || (path == "/api/desktop/pull" && data["changed"] != true) { return }
    let on_notes = path == "/api/notes";
    // An edit only matters to the note's own window, which already shows it, and to the main window's counts.
    if on_notes && method == "PATCH" {
        let _ = app.emit_to("main", CHANGED, ());
        return;
    }
    let created = on_notes && method == "POST";
    let near = if created && source.label().starts_with(NOTE_PREFIX) { source.outer_position().ok() } else { None };
    reconcile(app, near, created);
    let _ = app.emit(CHANGED, ());
}

/// Send every waiting change to the cloud and bring the cloud's notes down, as "Sync all" does, then bring
/// the windows up to date. Returns whether the cloud was reached.
pub async fn sync_all(app: &AppHandle) -> bool {
    let reached = sync::sync(&app.state::<AppState>(), Value::Null).await.is_ok();
    if reached {
        reconcile(app, None, false);
        let _ = app.emit(CHANGED, ());
    }
    reached
}

/// With "Sync automatically when online" chosen, changes go up a few seconds after they are made. A sync that
/// fails or leaves changes behind (offline, or the cloud refused a note) is tried again a minute later.
pub fn start_auto_sync(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if !sync::waiting_for_auto(&app.state::<AppState>()) { continue }
        let reached = tauri::async_runtime::block_on(sync_all(&app));
        if !reached || sync::waiting_for_auto(&app.state::<AppState>()) { std::thread::sleep(std::time::Duration::from_secs(55)) }
    });
}

/// The main window never shows notes. It holds the sign-in screen and the account form, and stays hidden otherwise.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The main window's page is done: the user signed in, or closed the account form.
#[tauri::command]
pub fn hide_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
}

/// Sign out from the tray: the notes leave the screen (they stay on this device) and the sign-in screen opens.
/// In the cave there is no account to sign out of, so this is the way out of the cave: sign in or create one.
pub async fn sign_out(app: &AppHandle) {
    let state = app.state::<AppState>();
    let signed_in = state.session().as_ref().is_some_and(|session| session.account_id().is_some());
    if signed_in {
        let _ = api::sign_out(&state, Value::Null).await;
        reconcile(app, None, false);
        let _ = app.emit(SIGNED_OUT, ());
    } else {
        let _ = app.emit(OPEN_ACCOUNT, ());
    }
    show_main(app);
}

/// Create an empty note and open its window. Returns false when nobody is signed in.
pub fn new_note(app: &AppHandle) -> bool {
    if api::create_note(&app.state::<AppState>()).is_err() { return false }
    reconcile(app, None, true);
    let _ = app.emit(CHANGED, ());
    true
}

/// Bring every note in front of the other windows. Returns how many notes there are.
pub fn show_notes(app: &AppHandle) -> usize {
    let windows = note_windows(app);
    for window in &windows {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    windows.len()
}

pub fn hide_notes(app: &AppHandle) {
    for window in note_windows(app) { let _ = window.hide(); }
}

/// The page asks for the move once the pointer has travelled a little, so a double-click still renames the note.
#[tauri::command]
pub fn note_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

/// The page reports that its window was moved; remember where it is now.
#[tauri::command]
pub fn note_place(window: WebviewWindow, state: tauri::State<'_, AppState>) {
    let Some(id) = window.label().strip_prefix(NOTE_PREFIX) else { return };
    if let Ok(position) = window.outer_position() { let _ = store::set_place(&state.db(), id, position.x, position.y); }
}

/// Size the window to its note. A collapsed note is exactly as tall as its header and cannot be stretched.
#[tauri::command]
pub fn note_fit(window: WebviewWindow, width: f64, height: f64, collapsed: bool) {
    if !window.label().starts_with(NOTE_PREFIX) { return }
    let (min_height, max_height) = if collapsed { (height, height) } else { (120.0, 1200.0) };
    let _ = window.set_min_size(Some(LogicalSize::new(180.0, min_height)));
    let _ = window.set_max_size(Some(LogicalSize::new(1200.0, max_height)));
    let _ = window.set_size(LogicalSize::new(width, height));
}
