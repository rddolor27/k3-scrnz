use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_NAME_LEN: usize = 40;
const DEFAULT_APP_PACKAGE: &str = "pos.kulay.pos";
const DEFAULT_LOG_RING_SIZE: usize = 50_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub names: BTreeMap<String, String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("APPDATA is not set, so the config can't be saved")]
    NoAppData,
    #[error("config file: {0}")]
    Io(#[from] std::io::Error),
    #[error("config JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("config task failed: {0}")]
    Task(String),
}

pub struct ConfigStore {
    path: Option<PathBuf>,
    config: Mutex<Config>,
    write_lock: Mutex<()>,
}

impl ConfigStore {
    pub fn load() -> Self {
        let path = std::env::var_os("APPDATA")
            .map(|dir| PathBuf::from(dir).join("k3-scrnz").join("config.json"));
        let config = path.as_deref().map(read_or_default).unwrap_or_default();
        Self {
            path,
            config: Mutex::new(config),
            write_lock: Mutex::new(()),
        }
    }

    pub fn names(&self) -> BTreeMap<String, String> {
        self.lock().names.clone()
    }

    /// Not validated here; whoever puts it in a shell command must.
    pub fn app_package(&self) -> String {
        self.lock()
            .other
            .get("appPackage")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|package| !package.is_empty())
            .unwrap_or(DEFAULT_APP_PACKAGE)
            .to_owned()
    }

    pub fn log_ring_size(&self) -> usize {
        self.lock()
            .other
            .get("logRingSize")
            .and_then(serde_json::Value::as_u64)
            .and_then(|size| usize::try_from(size).ok())
            .filter(|size| *size > 0)
            .unwrap_or(DEFAULT_LOG_RING_SIZE)
    }

    pub fn max_size(&self, customer: bool) -> u32 {
        let (key, default) = if customer {
            ("customerMaxSize", 1280)
        } else {
            ("mainMaxSize", 1920)
        };
        self.lock()
            .other
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|size| u32::try_from(size).ok())
            .filter(|size| (320..=4096).contains(size))
            .unwrap_or(default)
    }

    pub async fn set_name(
        self: &Arc<Self>,
        serial: String,
        name: String,
    ) -> Result<(), ConfigError> {
        let store = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || store.set_name_blocking(&serial, &name))
            .await
            .map_err(|e| ConfigError::Task(e.to_string()))?
    }

    /// Saves first, then updates memory; `write_lock` keeps concurrent saves in order.
    fn set_name_blocking(&self, serial: &str, name: &str) -> Result<(), ConfigError> {
        let path = self.path.as_deref().ok_or(ConfigError::NoAppData)?;
        let name: String = name.trim().chars().take(MAX_NAME_LEN).collect();
        let _saving = self
            .write_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut next = self.lock().clone();
        if name.is_empty() {
            next.names.remove(serial);
        } else {
            next.names.insert(serial.to_owned(), name);
        }
        write_atomically(path, &next)?;
        *self.lock() = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Config> {
        self.config.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn read_or_default(path: &Path) -> Config {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Config::default(),
        Err(e) => {
            tracing::warn!(path = %path.display(), "can't read config, using defaults: {e}");
            return Config::default();
        }
    };
    // PowerShell 5.1 writes a UTF-8 BOM when the file is edited by hand.
    match serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
        Ok(config) => config,
        Err(e) => {
            let bad = path.with_extension("json.bad");
            tracing::error!(path = %path.display(), "invalid config, moved to {}: {e}", bad.display());
            if let Err(e) = std::fs::rename(path, &bad) {
                tracing::warn!("can't move the invalid config aside: {e}");
            }
            Config::default()
        }
    }
}

fn write_atomically(path: &Path, config: &Config) -> Result<(), ConfigError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(&serde_json::to_vec_pretty(config)?)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    Ok(())
}
