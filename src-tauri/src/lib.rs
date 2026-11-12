pub mod adb;
mod config;
mod devices;
mod ws;

use std::sync::Arc;

use tauri::Manager;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Rust code logs with `tracing`; its `log` feature forwards every event to this
/// plugin, which writes them to stdout and a rotating file in the app log dir
/// (`%LOCALAPPDATA%\<identifier>\logs\k3-scrnz.log`). The webview logs through
/// the same plugin (`src/lib/log.ts`).
fn log_plugin<R: tauri::Runtime>() -> TauriPlugin<R> {
    let level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some("k3-scrnz".into()),
            }),
        ])
        .level(level)
        .level_for("tungstenite", LevelFilter::Warn)
        .level_for("tokio_tungstenite", LevelFilter::Warn)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(log_plugin())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let endpoint = ws::start()?;
            tracing::info!(port = endpoint.port, "WebSocket server listening");
            app.manage(endpoint);

            let config = Arc::new(config::ConfigStore::load());
            let hub = Arc::new(devices::DeviceHub::new(app.handle().clone(), config));
            devices::start(Arc::clone(&hub), adb::find_adb());
            app.manage(hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ws::get_endpoint,
            devices::list_devices,
            devices::get_adb_status,
            devices::set_device_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
