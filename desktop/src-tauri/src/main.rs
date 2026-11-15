// Release builds on Windows run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod cloud;
mod store;
mod sync;
#[allow(dead_code)]
#[path = "../../../src/rules.rs"]
mod rules;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// Passed when the system starts Daynote at login, so it waits in the tray instead of opening a window.
const HIDDEN_ARG: &str = "--hidden";

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // Opening Daynote again brings the running window forward instead of starting a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
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

            let open = MenuItem::with_id(app, "open", "Open Daynote", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Start with the system", true, autolaunch.is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Daynote", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Daynote")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
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
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if !std::env::args().any(|arg| arg == HIDDEN_ARG) { show_main(app.handle()) }
            Ok(())
        })
        // Closing the window keeps Daynote running in the tray; Quit in the tray menu exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![api::api])
        .run(tauri::generate_context!())
        .expect("error while running Daynote");
}
