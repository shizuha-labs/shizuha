use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static CORE: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCoreResult {
    pub ok: bool,
    pub message: String,
}

fn find_shizuha() -> Option<String> {
    if let Ok(path) = std::env::var("SHIZUHA_BIN") {
        if !path.trim().is_empty() {
            return Some(path);
        }
    }
    which("shizuha")
}

fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.cmd"));
            if exe.is_file() {
                return Some(exe.to_string_lossy().into_owned());
            }
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub fn start_core() -> StartCoreResult {
    if let Ok(guard) = CORE.lock() {
        if let Some(child) = guard.as_ref() {
            if child.id() > 0 {
                return StartCoreResult {
                    ok: true,
                    message: "Local core is already running.".to_string(),
                };
            }
        }
    }
    let Some(bin) = find_shizuha() else {
        return StartCoreResult {
            ok: false,
            message: "shizuha is not on PATH. Install Shizuha Code first: curl -fsSL https://shizuha.com/install.sh | bash".to_string(),
        };
    };
    let child = Command::new(&bin)
        .args(["up", "--foreground", "--no-service"])
        .env("SHIZUHA_ALLOW_LOCAL_DAEMON", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(proc) => {
            if let Ok(mut guard) = CORE.lock() {
                *guard = Some(proc);
            }
            StartCoreResult {
                ok: true,
                message: "Started `shizuha up`.".to_string(),
            }
        }
        Err(err) => StartCoreResult {
            ok: false,
            message: format!("Failed to start {bin}: {err}"),
        },
    }
}
