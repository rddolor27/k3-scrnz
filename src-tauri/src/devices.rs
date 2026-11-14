use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::adb::{AdbError, AdbServer, DeviceInfo, DeviceState};
use crate::config::ConfigStore;
use crate::{avd, emulator};

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lookup {
    Wanted,
    Running,
    Done,
}

struct Entry {
    info: DeviceInfo,
    first_seen: u64,
    gone_since: Option<Instant>,
    conn: u64,
    avd: Option<String>,
    lookup: Lookup,
}

impl Entry {
    fn connect(&mut self, conn: u64, avd: Option<String>) {
        self.conn = conn;
        self.lookup = if avd.is_some() {
            Lookup::Done
        } else {
            Lookup::Wanted
        };
        self.avd = avd;
    }
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    next_seq: u64,
    next_conn: u64,
    /// Emulator names set at launch, taken by the first connection that appears under the serial.
    launched: HashMap<String, String>,
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
                    if entry.gone_since.is_some() || entry.info.transport_id != info.transport_id {
                        self.next_conn += 1;
                        entry.connect(self.next_conn, self.launched.remove(&info.serial));
                    }
                    entry.info = info;
                    entry.gone_since = None;
                    changed = true;
                }
                None => {
                    tracing::info!(serial = %info.serial, state = %info.state, model = ?info.model, "device attached");
                    self.next_conn += 1;
                    let mut entry = Entry {
                        first_seen: self.next_seq,
                        gone_since: None,
                        conn: 0,
                        avd: None,
                        lookup: Lookup::Wanted,
                        info,
                    };
                    entry.connect(self.next_conn, self.launched.remove(&entry.info.serial));
                    self.entries.insert(entry.info.serial.clone(), entry);
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

    fn set_launched(&mut self, serial: &str, avd: String) -> bool {
        match self.entries.get_mut(serial) {
            Some(entry) if entry.gone_since.is_none() => {
                let changed = entry.avd.as_ref() != Some(&avd);
                entry.avd = Some(avd);
                entry.lookup = Lookup::Done;
                changed
            }
            _ => {
                self.launched.insert(serial.to_owned(), avd);
                false
            }
        }
    }

    fn take_lookups(&mut self) -> Vec<(String, u64)> {
        self.entries
            .iter_mut()
            .filter(|(serial, entry)| {
                entry.lookup == Lookup::Wanted
                    && entry.gone_since.is_none()
                    && entry.info.state == DeviceState::Device
                    && serial.starts_with("emulator-")
            })
            .map(|(serial, entry)| {
                entry.lookup = Lookup::Running;
                (serial.clone(), entry.conn)
            })
            .collect()
    }

    fn set_avd(&mut self, serial: &str, conn: u64, avd: Option<String>) -> bool {
        let Some(entry) = self
            .entries
            .get_mut(serial)
            .filter(|entry| entry.conn == conn && entry.lookup == Lookup::Running)
        else {
            return false;
        };
        entry.lookup = Lookup::Done;
        if avd.is_some() && entry.avd != avd {
            entry.avd = avd;
            return true;
        }
        false
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
                        .or_else(|| e.avd.clone())
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

    fn update(self: &Arc<Self>, apply: impl FnOnce(&mut Registry) -> bool) {
        let changed = apply(&mut lock(&self.registry));
        if changed {
            self.emit_devices();
            self.start_lookups();
        }
    }

    // Spawned so a slow adb shell never stalls the device tracker.
    fn start_lookups(self: &Arc<Self>) {
        let wanted = lock(&self.registry).take_lookups();
        for (serial, conn) in wanted {
            let hub = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                let label = lookup_avd(&serial).await;
                hub.update(|registry| registry.set_avd(&serial, conn, label));
            });
        }
    }

    pub async fn name_emulator(self: &Arc<Self>, serial: &str, avd_name: &str) {
        let Some(label) = avd::label(avd_name).await else {
            return;
        };
        tracing::info!(serial, avd = avd_name, "emulator named from its launch");
        self.update(|registry| registry.set_launched(serial, label));
    }

    pub fn forget_emulator(&self, serial: &str) {
        lock(&self.registry).launched.remove(serial);
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

async fn lookup_avd(serial: &str) -> Option<String> {
    let name = tokio::time::timeout(LOOKUP_TIMEOUT, emulator::running_avd(serial))
        .await
        .ok()
        .flatten();
    let Some(name) = name else {
        tracing::debug!(serial, "no AVD name from the emulator");
        return None;
    };
    tracing::info!(serial, avd = %name, "emulator AVD identified");
    avd::label(&name).await
}

/// Never writes to the tracker socket (SPEC section 5.2).
async fn track(
    hub: &Arc<DeviceHub>,
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
