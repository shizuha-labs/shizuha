mod core;
mod health;

use core::{start_core as spawn_core, StartCoreResult};
use health::{check_core_health, HealthResult};

/// Tauri command: check the health of the local Shizuha agent core.
///
/// Hits `GET /health` on the local core (default http://127.0.0.1:8015)
/// and returns a structured result with version, auth status, providers,
/// and compatibility info.
#[tauri::command]
async fn core_health(core_url: Option<String>) -> HealthResult {
    check_core_health(core_url).await
}

#[tauri::command]
fn start_core() -> StartCoreResult {
    spawn_core()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_health, start_core])
        .run(tauri::generate_context!())
        .expect("error while running Shizuha desktop app");
}
