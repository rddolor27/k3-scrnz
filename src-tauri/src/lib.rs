pub mod adb;
mod apps;
mod capture;
mod config;
mod devices;
mod displays;
mod emulator;
mod files;
mod logcat;
mod mirror;
mod scrcpy;
mod stats;
mod terminal;
mod ws;

use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;
use tauri::path::BaseDirectory;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const RECORDING_FINISH: Duration = Duration::from_secs(5);

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
                file_name: Some("tri-scrnz".into()),
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
        .plugin(tauri_plugin_dialog::init())
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
            app.manage(capture::GridRecordings::default());
            app.manage(terminal::TerminalHub::default());
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
            files::download_folder,
            files::upload_path,
            files::upload_bytes,
            files::make_dir,
            files::delete_path,
            files::reveal_file,
            files::list_packages,
            capture::save_screenshot,
            capture::start_recording,
            capture::stop_recording,
            capture::start_grid_recording,
            capture::stop_grid_recording,
            apps::install_apk_path,
            apps::install_apk_bytes,
            apps::app_action,
            logcat::start_logcat,
            logcat::set_logcat_filter,
            logcat::clear_logcat,
            logcat::get_logcat_info,
            logcat::set_app_package,
            stats::get_app_stats,
            terminal::start_terminal,
            terminal::list_terminal_shells,
            terminal::stop_terminal,
            emulator::list_avds,
            emulator::start_emulator,
            emulator::stop_emulator,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if !matches!(event, tauri::RunEvent::Exit) {
                return;
            }
            if let Some(terminals) = app.try_state::<terminal::TerminalHub>() {
                terminals.stop_all();
            }
            let mut pending = Vec::new();
            if let Some(hub) = app.try_state::<Arc<mirror::MirrorHub>>() {
                pending.extend(hub.end_recordings());
            }
            if let Some(grids) = app.try_state::<capture::GridRecordings>() {
                pending.extend(grids.end_all());
            }
            if !pending.is_empty() {
                // Without its moov box a recording doesn't play.
                tauri::async_runtime::block_on(async {
                    let all = futures_util::future::join_all(pending);
                    if tokio::time::timeout(RECORDING_FINISH, all).await.is_err() {
                        tracing::warn!("recordings did not finish before exit");
                    }
                });
            }
            if let Some(emulators) = app.try_state::<emulator::EmulatorState>() {
                emulator::shutdown(&emulators);
            }
        });
}
