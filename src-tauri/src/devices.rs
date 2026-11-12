use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::adb::{AdbError, AdbServer, DeviceInfo, DeviceState};
use crate::config::ConfigStore;

const GONE_GRACE: Duration = Duration::from_secs(30);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
const PRUNE_EVERY: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub serial: String,
    pub name: String,
    pub pinned: bool,
    pub state: DeviceState,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: u64,
    pub gone: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbStatus {
    pub connected: bool,
    pub version: Option<u32>,
    pub error: Option<String>,
}

struct Entry {
    info: DeviceInfo,
    first_seen: u64,
    gone_since: Option<Instant>,
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    next_seq: u64,
}

impl Registry {
    fn apply(&mut self, list: Vec<DeviceInfo>, now: Instant) -> bool {
        let mut changed = false;
        let mut present: HashSet<String> = HashSet::with_capacity(list.len());
        for info in list {
            // The registry is keyed by serial; cheap devices can share one.
            if !present.insert(info.serial.clone()) {
                tracing::warn!(serial = %info.serial, transport_id = info.transport_id, "two devices share a serial; ignoring the second");
                continue;
            }
            match self.entries.get_mut(&info.serial) {
                Some(entry) if entry.info == info && entry.gone_since.is_none() => {}
                Some(entry) => {
                    tracing::info!(serial = %info.serial, state = %info.state, "device changed");
                    entry.info = info;
                    entry.gone_since = None;
                    changed = true;
                }
                None => {
                    tracing::info!(serial = %info.serial, state = %info.state, model = ?info.model, "device attached");
                    self.entries.insert(
                        info.serial.clone(),
                        Entry {
                            info,
                            first_seen: self.next_seq,
                            gone_since: None,
                        },
                    );
                    self.next_seq += 1;
                    changed = true;
                }
            }
        }
        for (serial, entry) in &mut self.entries {
            if entry.gone_since.is_none() && !present.contains(serial) {
                tracing::info!(%serial, "device detached");
                entry.gone_since = Some(now);
                changed = true;
            }
        }
        changed
    }

    fn mark_all_gone(&mut self, now: Instant) -> bool {
        let mut changed = false;
        for entry in self.entries.values_mut().filter(|e| e.gone_since.is_none()) {
            entry.gone_since = Some(now);
            changed = true;
        }
        changed
    }

    fn prune(&mut self, now: Instant) -> bool {
        let before = self.entries.len();
        self.entries.retain(|serial, entry| {
            let keep = entry
                .gone_since
                .is_none_or(|since| now.duration_since(since) < GONE_GRACE);
            if !keep {
                tracing::info!(%serial, "device tab removed");
            }
            keep
        });
        self.entries.len() != before
    }

    fn views(&self, names: &BTreeMap<String, String>) -> Vec<DeviceView> {
        let mut entries: Vec<&Entry> = self.entries.values().collect();
        entries.sort_by_key(|e| (!names.contains_key(&e.info.serial), e.first_seen));
        entries
            .into_iter()
            .map(|e| {
                let configured = names.get(&e.info.serial);
                DeviceView {
                    serial: e.info.serial.clone(),
                    name: configured
                        .cloned()
                        .or_else(|| e.info.model.as_ref().map(|m| m.replace('_', " ")))
                        .unwrap_or_else(|| e.info.serial.clone()),
                    pinned: configured.is_some(),
                    state: e.info.state.clone(),
                    model: e.info.model.clone(),
                    product: e.info.product.clone(),
                    device: e.info.device.clone(),
                    transport_id: e.info.transport_id,
                    gone: e.gone_since.is_some(),
                }
            })
            .collect()
    }
}

pub struct DeviceHub {
    app: AppHandle,
    config: Arc<ConfigStore>,
    registry: Mutex<Registry>,
    status: Mutex<AdbStatus>,
    /// Serializes "compute views + emit" so an older list is never emitted after a newer one.
    emit_guard: Mutex<()>,
}

impl DeviceHub {
    pub fn new(app: AppHandle, config: Arc<ConfigStore>) -> Self {
        Self {
            app,
            config,
            registry: Mutex::new(Registry::default()),
            status: Mutex::new(AdbStatus::default()),
            emit_guard: Mutex::new(()),
        }
    }

    pub fn views(&self) -> Vec<DeviceView> {
        let names = self.config.names();
        lock(&self.registry).views(&names)
    }

    fn emit_devices(&self) {
        let _ordered = lock(&self.emit_guard);
        if let Err(e) = self.app.emit("devices-changed", self.views()) {
            tracing::warn!("can't emit devices-changed: {e}");
        }
    }

    fn update(&self, apply: impl FnOnce(&mut Registry) -> bool) {
        let changed = apply(&mut lock(&self.registry));
        if changed {
            self.emit_devices();
        }
    }

    fn set_status(&self, status: AdbStatus) {
        let changed = {
            let mut current = lock(&self.status);
            let changed = *current != status;
            *current = status.clone();
            changed
        };
        if changed && let Err(e) = self.app.emit("adb-status", status) {
            tracing::warn!("can't emit adb-status: {e}");
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn start(hub: Arc<DeviceHub>, adb_exe: Option<PathBuf>) {
    match &adb_exe {
        Some(exe) => {
            tracing::info!(adb = %exe.display(), "using the SDK adb to start the server when needed")
        }
        None => {
            tracing::warn!("SDK adb not found; can't start the adb server if it isn't running")
        }
    }
    let tracker_hub = Arc::clone(&hub);
    tauri::async_runtime::spawn(async move {
        let server = AdbServer::default();
        let mut backoff = BACKOFF_MIN;
        loop {
            let error = track(&tracker_hub, &server, adb_exe.as_deref(), &mut backoff).await;
            if backoff == BACKOFF_MIN {
                tracing::warn!("device tracker stopped: {error}; retrying");
            } else {
                tracing::debug!("device tracker retry failed: {error}; next in {backoff:?}");
            }
            tracker_hub.set_status(AdbStatus {
                connected: false,
                version: None,
                error: Some(error.to_string()),
            });
            tracker_hub.update(|r| r.mark_all_gone(Instant::now()));
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(PRUNE_EVERY);
        loop {
            tick.tick().await;
            hub.update(|r| r.prune(Instant::now()));
        }
    });
}

/// Never writes to the tracker socket (SPEC section 5.2).
async fn track(
    hub: &DeviceHub,
    server: &AdbServer,
    adb_exe: Option<&std::path::Path>,
    backoff: &mut Duration,
) -> AdbError {
    let version = match adb_exe {
        Some(exe) => server.ensure_running(exe).await,
        None => server.version().await,
    };
    let version = match version {
        Ok(version) => version,
        Err(e) => return e,
    };
    let mut tracker = match server.track_devices().await {
        Ok(tracker) => tracker,
        Err(e) => return e,
    };
    tracing::info!(version, "device tracker connected");
    hub.set_status(AdbStatus {
        connected: true,
        version: Some(version),
        error: None,
    });
    loop {
        match tracker.next().await {
            Ok(list) => {
                // Reset only once frames arrive, so accept-then-drop keeps backing off.
                *backoff = BACKOFF_MIN;
                hub.update(|r| r.apply(list, Instant::now()));
            }
            Err(e) => return e,
        }
    }
}

#[tauri::command]
pub fn list_devices(hub: State<'_, Arc<DeviceHub>>) -> Vec<DeviceView> {
    hub.views()
}

#[tauri::command]
pub fn get_adb_status(hub: State<'_, Arc<DeviceHub>>) -> AdbStatus {
    lock(&hub.status).clone()
}

#[tauri::command]
pub async fn set_device_name(
    hub: State<'_, Arc<DeviceHub>>,
    serial: String,
    name: String,
) -> Result<(), String> {
    hub.config
        .set_name(serial, name)
        .await
        .map_err(|e| e.to_string())?;
    hub.emit_devices();
    Ok(())
}
