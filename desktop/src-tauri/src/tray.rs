//! The tray icon and its menu. With no board window, this menu is where everything outside a note lives.
//! It is rebuilt whenever the session or a setting changes, so it only offers what applies right now.

use crate::api::AppState;
use crate::windows::{self, show_main};
use crate::{store, sync};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

pub const ID: &str = "main";
const THEME_SETTING: &str = "theme";

fn setting_is(app: &AppHandle, key: &str, value: &str) -> bool {
    store::setting(&app.state::<AppState>().db(), key).ok().flatten().as_deref() == Some(value)
}

fn set(app: &AppHandle, key: &str, value: &str) {
    let _ = store::set_setting(&app.state::<AppState>().db(), key, Some(value));
}

pub fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let signed_in = app.state::<AppState>().session().as_ref().is_some_and(|session| session.account_id().is_some());
    let auto_sync = setting_is(app, sync::MODE_SETTING, sync::AUTO);
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let check = |id: &str, text: &str, checked: bool| CheckMenuItem::with_id(app, id, text, true, checked, None::<&str>);

    // Syncing needs an account, so the whole menu is greyed out in the cave and before signing in.
    // The two choices behave as radio buttons: picking one unticks the other.
    let sync_menu = Submenu::with_items(app, "Sync", signed_in, &[
        &check("sync-auto", "Sync automatically when online", auto_sync)?,
        &check("sync-manual", "Sync only when I ask", !auto_sync)?,
        &PredefinedMenuItem::separator(app)?,
        &item("sync-now", "Sync now")?,
    ])?;
    let account_menu = if signed_in {
        Submenu::with_items(app, "Account", true, &[&item("change-password", "Change password…")?, &item("sign-out", "Sign out")?])?
    } else {
        Submenu::with_items(app, "Account", true, &[&item("sign-in", "Sign in…")?])?
    };
    Menu::with_items(app, &[
        &item("new", "New note")?,
        &item("show", "Show notes")?,
        &item("hide", "Hide notes")?,
        &PredefinedMenuItem::separator(app)?,
        &sync_menu,
        &account_menu,
        &check("dark", "Dark mode", setting_is(app, THEME_SETTING, "dark"))?,
        &check("autostart", "Start with the system", app.autolaunch().is_enabled().unwrap_or(false))?,
        &PredefinedMenuItem::separator(app)?,
        &item("quit", "Quit Daynote")?,
    ])
}

/// Rebuild the menu after the session or a setting changed. The menu is replaced a moment later rather
/// than right away, because this is also called from the menu's own click.
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let (Some(tray), Ok(menu)) = (app.tray_by_id(ID), menu(&app)) { let _ = tray.set_menu(Some(menu)); }
    });
}

/// Bring the notes forward. With none to show, start a first note, or open the sign-in window when nobody is signed in.
pub fn show_notes(app: &AppHandle) {
    if windows::show_notes(app) > 0 { return }
    new_note(app);
}

fn new_note(app: &AppHandle) {
    // Windows cannot be opened from inside a menu or tray event, so the note is made on another thread.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !windows::new_note(&app) { show_main(&app) }
    });
}

pub fn on_event(app: &AppHandle, id: &str) {
    match id {
        "new" => new_note(app),
        "show" => show_notes(app),
        "hide" => windows::hide_notes(app),
        // The main window shows the sign-in screen, or the account form when signed in.
        "sign-in" | "change-password" => {
            let _ = app.emit(windows::OPEN_ACCOUNT, ());
            show_main(app);
        }
        "sign-out" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { windows::sign_out(&app).await });
        }
        "sync-auto" => set(app, sync::MODE_SETTING, sync::AUTO),
        "sync-manual" => set(app, sync::MODE_SETTING, "manual"),
        "sync-now" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { windows::sync_all(&app).await; });
        }
        "dark" => {
            let dark = !setting_is(app, THEME_SETTING, "dark");
            set(app, THEME_SETTING, if dark { "dark" } else { "light" });
            let _ = app.emit(windows::THEME, dark);
        }
        "autostart" => {
            let autolaunch = app.autolaunch();
            let _ = if autolaunch.is_enabled().unwrap_or(false) { autolaunch.disable() } else { autolaunch.enable() };
        }
        "quit" => app.exit(0),
        _ => return,
    }
    refresh(app);
}
