mod ws;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let endpoint = ws::start()?;
            eprintln!("[ws] listening on 127.0.0.1:{}", endpoint.port);
            app.manage(endpoint);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ws::get_endpoint])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
