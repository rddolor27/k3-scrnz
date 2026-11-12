pub mod adb;
mod config;
mod devices;
mod displays;
mod emulator;
mod files;
mod logcat;
mod mirror;
mod scrcpy;
mod stats;
mod ws;

use std::sync::Arc;

use tauri::Manager;
use tauri::path::BaseDirectory;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

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
            let endpoint = ws::start(app.handle().clone())?;
            tracing::info!(port = endpoint.port, "WebSocket server listening");
            app.manage(endpoint);

            let config = Arc::new(config::ConfigStore::load());
            let hub = Arc::new(devices::DeviceHub::new(
                app.handle().clone(),
                Arc::clone(&config),
            ));
            devices::start(Arc::clone(&hub), adb::find_adb());
            let display_hub = Arc::new(displays::DisplayHub::new(
                app.handle().clone(),
                Arc::clone(&hub),
            ));
            displays::start(Arc::clone(&display_hub));
            app.manage(display_hub);
            let jar = app
                .path()
                .resolve(scrcpy::SERVER_RESOURCE, BaseDirectory::Resource)?;
            app.manage(Arc::new(mirror::MirrorHub::new(
                app.handle().clone(),
                Arc::clone(&config),
                jar,
            )));
            app.manage(logcat::LogcatState::new(
                Arc::clone(&config),
                Arc::clone(&hub),
            ));
            app.manage(stats::StatsState::new());
            app.manage(emulator::EmulatorState::new(app.path().app_log_dir().ok()));
            app.manage(Arc::clone(&config));
            app.manage(hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ws::get_endpoint,
            mirror::start_mirror,
            mirror::stop_mirror,
            mirror::device_power,
            devices::list_devices,
            devices::get_adb_status,
            devices::set_device_name,
            displays::get_displays,
            displays::set_visible_device,
            files::list_dir,
            files::download_file,
            files::upload_path,
            files::upload_bytes,
            files::make_dir,
            files::delete_path,
            files::reveal_file,
            files::list_packages,
            logcat::start_logcat,
            logcat::set_logcat_filter,
            logcat::clear_logcat,
            logcat::get_logcat_info,
            stats::get_app_stats,
            emulator::list_avds,
            emulator::start_emulator,
            emulator::stop_emulator,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event
                && let Some(emulators) = app.try_state::<emulator::EmulatorState>()
            {
                emulator::shutdown(&emulators);
            }
        });
}
