// Release builds on Windows run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod cloud;
mod store;
mod sync;
mod tray;
mod windows;
#[allow(dead_code)]
#[path = "../../../src/rules.rs"]
mod rules;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// Passed when the system starts Daynote at login, so it does not open the sign-in window on its own.
const HIDDEN_ARG: &str = "--hidden";

fn main() {
    // Wayland does not let an app place its own windows, so notes could not return to where they were left. XWayland does.
    #[cfg(target_os = "linux")]
    {
        // Nothing else is running yet, so no other thread can be reading the environment.
        if std::env::var_os("GDK_BACKEND").is_none() { unsafe { std::env::set_var("GDK_BACKEND", "x11") } }
    }

    tauri::Builder::default()
        // Opening Daynote again brings the running notes forward instead of starting a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_notes(app)))
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

            TrayIconBuilder::with_id(tray::ID)
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Daynote")
                .menu(&tray::menu(app.handle())?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| tray::on_event(app, event.id().as_ref()))
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        tray::show_notes(tray.app_handle());
                    }
                })
                .build(app)?;

            windows::start_auto_sync(app.handle().clone());

            // The notes go straight onto the desktop. Opened by hand with none to show, Daynote starts a first
            // note, or shows the sign-in window when nobody is signed in.
            let notes = windows::reconcile(app.handle(), None, false);
            if notes == 0 && !std::env::args().any(|arg| arg == HIDDEN_ARG) && !windows::new_note(app.handle()) { windows::show_main(app.handle()) }
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
        .invoke_handler(tauri::generate_handler![api::api, windows::note_drag, windows::note_place, windows::note_fit, windows::hide_main])
        .run(tauri::generate_context!())
        .expect("error while running Daynote");
}
