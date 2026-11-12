mod binary;
mod filter;
mod ring;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering as MemOrdering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;
use tauri::ipc::Channel;
use thiserror::Error;
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};

use crate::adb::{self, AdbError, AdbServer, DeviceSel, DeviceState, ShellEvent, shell_quote};
use crate::config::ConfigStore;
use crate::devices::DeviceHub;

use binary::{Parser, Record};
use filter::{App, LogFilter, Matcher};
use ring::{LogEntry, Ring};

/// Text buffers only: `events`, `stats` and `security` carry binary payloads.
const LOGCAT_CMD: &str = "logcat -B -b main,system,crash";
const BACKLOG: u32 = 500;
const RETRY: Duration = Duration::from_secs(1);
const TICK: Duration = Duration::from_millis(100);
const RESET_ROWS: usize = 5000;
const APPEND_ROWS: usize = 2000;
const UID_REFRESH: Duration = Duration::from_secs(60);
const UID_RETRY: Duration = Duration::from_secs(5);
const UID_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TAIL: usize = 1024;

#[derive(Debug, Error)]
pub enum LogcatError {
    #[error("{0}")]
    Regex(#[from] regex::Error),
    #[error("unknown device: {0}")]
    UnknownDevice(String),
    #[error("invalid package name: {0}")]
    InvalidPackage(String),
    #[error("malformed logcat stream: {0}")]
    Malformed(String),
    #[error("{0}")]
    Command(String),
    #[error("the device did not respond in time")]
    Timeout,
    #[error(transparent)]
    Adb(#[from] AdbError),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogcatInfo {
    pub app_package: String,
    pub app_uid: Option<u32>,
}

pub struct LogcatState {
    config: Arc<ConfigStore>,
    hub: Arc<DeviceHub>,
    devices: Mutex<HashMap<String, Arc<Device>>>,
}

impl LogcatState {
    pub fn new(config: Arc<ConfigStore>, hub: Arc<DeviceHub>) -> Self {
        Self {
            config,
            hub,
            devices: Mutex::new(HashMap::new()),
        }
    }

    fn device(&self, serial: &str) -> Result<Arc<Device>, LogcatError> {
        if let Some(device) = lock(&self.devices).get(serial) {
            return Ok(Arc::clone(device));
        }
        if !self.hub.views().iter().any(|v| v.serial == serial) {
            return Err(LogcatError::UnknownDevice(serial.to_owned()));
        }
        let mut devices = lock(&self.devices);
        let device = devices.entry(serial.to_owned()).or_insert_with(|| {
            Arc::new(Device::new(
                serial,
                self.config.app_package(),
                self.config.log_ring_size(),
            ))
        });
        Ok(Arc::clone(device))
    }

    fn start(&self, serial: &str, channel: Channel<Value>) -> Result<(), LogcatError> {
        let device = self.device(serial)?;
        if !device.started.swap(true, MemOrdering::AcqRel) {
            tracing::info!(serial, package = %device.package, "logcat started");
            tauri::async_runtime::spawn(run_reader(Arc::clone(&device), Arc::clone(&self.hub)));
            tauri::async_runtime::spawn(run_delivery(Arc::clone(&device)));
            tauri::async_runtime::spawn(run_uid_refresh(
                Arc::clone(&device),
                Arc::clone(&self.hub),
            ));
        }
        device.attach(channel);
        Ok(())
    }

    fn set_filter(&self, serial: &str, filter: &LogFilter) -> Result<(), LogcatError> {
        let matcher = Matcher::new(filter)?;
        self.device(serial)?.set_matcher(matcher);
        Ok(())
    }

    fn clear(&self, serial: &str) -> Result<(), LogcatError> {
        self.device(serial)?.clear();
        Ok(())
    }

    fn info(&self, serial: &str) -> LogcatInfo {
        let app_uid = lock(&self.devices)
            .get(serial)
            .and_then(|device| device.inner().app_uid);
        LogcatInfo {
            app_package: self.config.app_package(),
            app_uid,
        }
    }
}

struct Device {
    serial: String,
    package: String,
    started: AtomicBool,
    inner: Mutex<Inner>,
}

struct Inner {
    ring: Ring,
    matcher: Matcher,
    channel: Option<Channel<Value>>,
    pending_reset: bool,
    cursor: u64,
    app_uid: Option<u32>,
}

impl Device {
    fn new(serial: &str, package: String, ring_size: usize) -> Self {
        Self {
            serial: serial.to_owned(),
            package,
            started: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                ring: Ring::new(ring_size),
                matcher: Matcher::default(),
                channel: None,
                pending_reset: false,
                cursor: 0,
                app_uid: None,
            }),
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    fn attach(&self, channel: Channel<Value>) {
        let mut inner = self.inner();
        inner.channel = Some(channel);
        inner.pending_reset = true;
    }

    fn detach(&self, channel_id: u32) {
        let mut inner = self.inner();
        if inner.channel.as_ref().map(Channel::id) == Some(channel_id) {
            inner.channel = None;
        }
    }

    fn set_matcher(&self, matcher: Matcher) {
        let mut inner = self.inner();
        inner.matcher = matcher;
        inner.pending_reset = true;
    }

    fn clear(&self) {
        let mut inner = self.inner();
        inner.ring.clear();
        inner.pending_reset = true;
    }

    fn set_app_uid(&self, uid: Option<u32>) -> bool {
        let mut inner = self.inner();
        let changed = inner.app_uid != uid;
        if changed {
            inner.app_uid = uid;
            inner.pending_reset = true;
        }
        changed
    }

    fn push(&self, records: Vec<Record>) {
        if records.is_empty() {
            return;
        }
        let mut inner = self.inner();
        for record in records {
            inner.ring.push(record);
        }
    }

    fn next_batch(&self) -> Option<(Channel<Value>, Value)> {
        self.inner().next_batch(&self.package)
    }
}

impl Inner {
    fn next_batch(&mut self, package: &str) -> Option<(Channel<Value>, Value)> {
        let channel = self.channel.clone()?;
        let end = self.ring.next_seq();
        let from = std::mem::replace(&mut self.cursor, end);
        let reset = std::mem::take(&mut self.pending_reset);
        if !reset && from >= end {
            return None;
        }
        let app = App {
            package,
            uid: self.app_uid,
        };
        let matcher = &self.matcher;
        let batch = if reset {
            let mut rows: Vec<&LogEntry> = self
                .ring
                .iter()
                .rev()
                .filter(|entry| matcher.matches(entry, &app))
                .take(RESET_ROWS)
                .collect();
            rows.reverse();
            batch_json("reset", &rows, 0)
        } else {
            let rows: Vec<&LogEntry> = self
                .ring
                .since(from)
                .filter(|entry| matcher.matches(entry, &app))
                .collect();
            if rows.is_empty() {
                return None;
            }
            let skipped = rows.len().saturating_sub(APPEND_ROWS);
            batch_json("append", &rows[skipped..], skipped)
        };
        Some((channel, batch))
    }
}

fn batch_json(kind: &str, rows: &[&LogEntry], skipped: usize) -> Value {
    let rows = rows
        .iter()
        .map(|entry| {
            Value::Array(vec![
                Value::from(entry.seq),
                Value::from(entry.ts_ms()),
                Value::from(entry.pid),
                Value::from(entry.tid),
                Value::from(entry.level),
                Value::from(&*entry.tag),
                Value::from(entry.msg.as_str()),
            ])
        })
        .collect();
    let mut batch = Map::with_capacity(3);
    batch.insert("kind".into(), Value::from(kind));
    batch.insert("rows".into(), Value::Array(rows));
    batch.insert("skipped".into(), Value::from(skipped));
    Value::Object(batch)
}

type EntryKey = (u32, u32, i32, u32);

/// `-T` takes `<sec>.<ms>`, so a restarted stream repeats the last millisecond's entries.
#[derive(Default)]
struct Resume {
    last: Option<(u32, u32)>,
    tail: HashSet<EntryKey>,
    repeats: HashSet<EntryKey>,
    accepted: u64,
}

impl Resume {
    /// The ms are zero-padded: `.5` would mean half a second.
    fn start_arg(&self) -> String {
        match self.last {
            Some((sec, ms)) => format!("{sec}.{ms:03}"),
            None => BACKLOG.to_string(),
        }
    }

    fn restart(&mut self) {
        self.repeats.clone_from(&self.tail);
    }

    fn accept(&mut self, record: &Record) -> bool {
        let key = (record.sec, record.nsec, record.pid, record.tid);
        let ms = (record.sec, record.nsec / 1_000_000);
        match self.last.map(|last| ms.cmp(&last)) {
            Some(Ordering::Less) => {
                // Out of order across buffers; older than any replay.
                self.accepted += 1;
                return true;
            }
            Some(Ordering::Equal) => {
                if self.repeats.remove(&key) {
                    return false;
                }
            }
            Some(Ordering::Greater) | None => {
                self.repeats.clear();
                self.tail.clear();
                self.last = Some(ms);
            }
        }
        if self.tail.len() < MAX_TAIL {
            self.tail.insert(key);
        }
        self.accepted += 1;
        true
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_online(hub: &DeviceHub, serial: &str) -> bool {
    hub.views()
        .iter()
        .any(|v| v.serial == serial && v.state == DeviceState::Device && !v.gone)
}

/// Never stops reading: logd drops slow readers.
async fn run_reader(device: Arc<Device>, hub: Arc<DeviceHub>) {
    let serial = device.serial.as_str();
    let server = AdbServer::default();
    let sel = DeviceSel::Serial(device.serial.clone());
    let mut resume = Resume::default();
    let mut waiting = false;
    let mut repeating = false;
    loop {
        if !is_online(&hub, serial) {
            if !waiting {
                tracing::info!(serial, "device offline; logcat waits for it");
                waiting = true;
            }
            sleep(RETRY).await;
            continue;
        }
        waiting = false;
        resume.restart();
        let accepted = resume.accepted;
        let result = stream(&device, &server, &sel, &mut resume).await;
        if resume.accepted != accepted {
            repeating = false;
        }
        match result {
            Ok(()) if repeating => tracing::debug!(serial, "logcat stream ended again"),
            Ok(()) => {
                tracing::info!(serial, "logcat stream ended; restarting");
                repeating = true;
            }
            Err(e) if repeating => tracing::debug!(serial, "logcat stream failed again: {e}"),
            Err(e) => {
                tracing::warn!(serial, "logcat stream failed: {e}; retrying");
                repeating = true;
            }
        }
        sleep(RETRY).await;
    }
}

async fn stream(
    device: &Device,
    server: &AdbServer,
    sel: &DeviceSel,
    resume: &mut Resume,
) -> Result<(), LogcatError> {
    let serial = device.serial.as_str();
    let from = resume.start_arg();
    // Shell v2, not `exec:`: logcat's warnings stay on stderr, off the binary stream.
    let mut process = adb::shell_spawn(server, sel, &format!("{LOGCAT_CMD} -T {from}")).await?;
    let mut parser = Parser::default();
    let mut streaming = false;
    // Only this loop reads the process, and never races it (`next_event` isn't cancel-safe).
    loop {
        match process.next_event().await? {
            Some(ShellEvent::Stdout(data)) => {
                if !streaming {
                    streaming = true;
                    tracing::info!(serial, from, "logcat streaming");
                }
                parser.push(&data);
                let mut records = Vec::new();
                let parsed = loop {
                    match parser.next_record() {
                        Ok(Some(record)) => {
                            if resume.accept(&record) {
                                records.push(record);
                            }
                        }
                        Ok(None) => break Ok(()),
                        Err(e) => break Err(e),
                    }
                };
                device.push(records);
                parsed?;
            }
            Some(ShellEvent::Stderr(data)) => {
                tracing::warn!(serial, "logcat: {}", String::from_utf8_lossy(&data).trim());
            }
            Some(ShellEvent::Exit(code)) => {
                tracing::info!(serial, code, "logcat exited");
                return Ok(());
            }
            None => return Ok(()),
        }
    }
}

async fn run_delivery(device: Arc<Device>) {
    let mut tick = interval(TICK);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Some((channel, batch)) = device.next_batch() else {
            continue;
        };
        if let Err(e) = channel.send(batch) {
            tracing::debug!(serial = %device.serial, "logcat channel closed: {e}");
            device.detach(channel.id());
        }
    }
}

async fn run_uid_refresh(device: Arc<Device>, hub: Arc<DeviceHub>) {
    let serial = device.serial.as_str();
    let server = AdbServer::default();
    let sel = DeviceSel::Serial(device.serial.clone());
    loop {
        let wait = if is_online(&hub, serial) {
            match lookup_uid(&server, &sel, &device.package).await {
                Ok(uid) => {
                    if device.set_app_uid(uid) {
                        tracing::info!(serial, package = %device.package, uid = ?uid, "app uid");
                    }
                    UID_REFRESH
                }
                Err(e @ LogcatError::InvalidPackage(_)) => {
                    tracing::warn!(serial, "\"only my app\" is off: {e}");
                    return;
                }
                Err(e) => {
                    tracing::debug!(serial, "app uid lookup failed: {e}");
                    UID_RETRY
                }
            }
        } else {
            RETRY
        };
        sleep(wait).await;
    }
}

async fn lookup_uid(
    server: &AdbServer,
    sel: &DeviceSel,
    package: &str,
) -> Result<Option<u32>, LogcatError> {
    if !is_valid_package(package) {
        return Err(LogcatError::InvalidPackage(package.to_owned()));
    }
    let cmd = format!("cmd package list packages -U {}", shell_quote(package));
    let out = timeout(UID_TIMEOUT, adb::shell(server, sel, &cmd))
        .await
        .map_err(|_| LogcatError::Timeout)??;
    match out.exit_code {
        Some(0) => Ok(parse_uid(&String::from_utf8_lossy(&out.stdout), package)),
        Some(code) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(LogcatError::Command(match stderr.trim() {
                "" => format!("exit code {code}"),
                text => text.to_owned(),
            }))
        }
        None => Err(LogcatError::Command("the device disconnected".into())),
    }
}

/// The command's filter is a substring match, hence the exact name check.
fn parse_uid(stdout: &str, package: &str) -> Option<u32> {
    stdout.lines().find_map(|line| {
        let (name, uids) = line.trim().strip_prefix("package:")?.split_once(" uid:")?;
        if name != package {
            return None;
        }
        // Several users list their uids comma-separated; the first is user 0's.
        uids.split([',', ' ']).next()?.parse().ok()
    })
}

fn is_valid_package(package: &str) -> bool {
    package.len() <= 255
        && package.contains('.')
        && !package.starts_with('.')
        && !package.ends_with('.')
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

#[tauri::command]
pub async fn start_logcat(
    state: State<'_, LogcatState>,
    serial: String,
    on_batch: Channel<Value>,
) -> Result<(), String> {
    state.start(&serial, on_batch).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_logcat_filter(
    state: State<'_, LogcatState>,
    serial: String,
    filter: LogFilter,
) -> Result<(), String> {
    state
        .set_filter(&serial, &filter)
        .map_err(|e| e.to_string())
}

/// Never runs `logcat -c`: it clears the buffers device-wide.
#[tauri::command]
pub async fn clear_logcat(state: State<'_, LogcatState>, serial: String) -> Result<(), String> {
    state.clear(&serial).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_logcat_info(
    state: State<'_, LogcatState>,
    serial: String,
) -> Result<LogcatInfo, String> {
    Ok(state.info(&serial))
}
