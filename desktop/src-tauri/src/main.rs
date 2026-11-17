// Release builds on Windows run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod cloud;
mod store;
mod sync;
mod windows;
#[allow(dead_code)]
#[path = "../../../src/rules.rs"]
mod rules;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// Passed when the system starts Daynote at login, so it does not open the sign-in window on its own.
const HIDDEN_ARG: &str = "--hidden";

/// The main window is only for the account: signing in, syncing, and settings. The notes are windows of their own.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Bring the notes forward, or the main window when there are none to show.
fn show_notes(app: &AppHandle) {
    if windows::show_notes(app) == 0 { show_main(app) }
}

fn main() {
    // Wayland does not let an app place its own windows, so notes could not return to where they were left. XWayland does.
    #[cfg(target_os = "linux")]
    {
        // Nothing else is running yet, so no other thread can be reading the environment.
        if std::env::var_os("GDK_BACKEND").is_none() { unsafe { std::env::set_var("GDK_BACKEND", "x11") } }
    }

    tauri::Builder::default()
        // Opening Daynote again brings the running notes forward instead of starting a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_notes(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let state = api::AppState::new(store::open(&dir.join("daynote.sqlite3"))?);

            // Start with the system from the first run; the tray menu turns it off.
            let autolaunch = app.autolaunch();
            if store::setting(&state.db(), "autostart_set")?.is_none() {
                let _ = autolaunch.enable();
                store::set_setting(&state.db(), "autostart_set", Some("1"))?;
            }
            app.manage(state);

            let new_note = MenuItem::with_id(app, "new", "New note", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show notes", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide notes", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Account and sync…", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Start with the system", true, autolaunch.is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Daynote", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &new_note, &show, &hide, &PredefinedMenuItem::separator(app)?,
                &open, &autostart, &PredefinedMenuItem::separator(app)?, &quit,
            ])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Daynote")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "new" => {
                        // Windows cannot be opened from inside a menu event, so the note is made on another thread.
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if !windows::new_note(&app) { show_main(&app) }
                        });
                    }
                    "show" => show_notes(app),
                    "hide" => windows::hide_notes(app),
                    "open" => show_main(app),
                    "autostart" => {
                        let enable = autostart.is_checked().unwrap_or(false);
                        let _ = if enable { app.autolaunch().enable() } else { app.autolaunch().disable() };
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_notes(tray.app_handle());
                    }
                })
                .build(app)?;

            // The notes go straight onto the desktop. The main window only opens when there is nothing to show yet.
            let notes = windows::reconcile(app.handle(), None, false);
            if notes == 0 && !std::env::args().any(|arg| arg == HIDDEN_ARG) { show_main(app.handle()) }
            Ok(())
        })
        // Closing the main window keeps Daynote running in the tray; Quit in the tray menu exits.
        // A note's window only goes away when its note does.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" { let _ = window.hide(); }
            }
        })
        .invoke_handler(tauri::generate_handler![api::api, windows::note_drag, windows::note_place, windows::note_fit])
        .run(tauri::generate_context!())
        .expect("error while running Daynote");
}
