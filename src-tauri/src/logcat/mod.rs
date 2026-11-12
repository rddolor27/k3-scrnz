//! Logcat (SPEC section 10). Once started, a device gets three tasks that run
//! until the app exits, whether or not its tab is visible: a reader that keeps
//! a `logcat -B` stream open and fills the ring, a delivery tick that sends
//! filtered 100 ms batches to the UI's `Channel`, and an app-uid refresher.
//!
//! `logcat -c` is never run: it clears the buffers device-wide. Clearing only
//! empties the local ring.

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

/// Binary records from the text buffers only: `events`, `stats` and `security`
/// carry binary payloads. `-T` is appended per start.
const LOGCAT_CMD: &str = "logcat -B -b main,system,crash";
/// Entries replayed when the first stream opens.
const BACKLOG: u32 = 500;
/// Wait before restarting a stream, and between online checks.
const RETRY: Duration = Duration::from_secs(1);
/// UI delivery tick (SPEC section 10.3).
const TICK: Duration = Duration::from_millis(100);
/// Rows in a `reset` batch.
const RESET_ROWS: usize = 5000;
/// Flood guard: rows in an `append` batch.
const APPEND_ROWS: usize = 2000;
const UID_REFRESH: Duration = Duration::from_secs(60);
const UID_RETRY: Duration = Duration::from_secs(5);
const UID_TIMEOUT: Duration = Duration::from_secs(10);
/// Most entry keys remembered for the newest millisecond.
const MAX_TAIL: usize = 1024;

#[derive(Debug, Error)]
pub enum LogcatError {
    /// The `regex` crate's own message, shown to the user as is.
    #[error("{0}")]
    Regex(#[from] regex::Error),
    #[error("unknown device: {0}")]
    UnknownDevice(String),
    #[error("invalid package name: {0}")]
    InvalidPackage(String),
    #[error("malformed logcat stream: {0}")]
    Malformed(String),
    /// A device command failed; holds its stderr.
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
    /// `None` until the first lookup succeeds, or when the app isn't installed.
    pub app_uid: Option<u32>,
}

/// Tauri state: the started devices.
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

    /// The device's state, created on first use so that commands work in any
    /// order. Only devices the tracker knows get one.
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
    /// Whether the three tasks were spawned.
    started: AtomicBool,
    /// Held briefly and never across an `.await`.
    inner: Mutex<Inner>,
}

struct Inner {
    ring: Ring,
    matcher: Matcher,
    channel: Option<Channel<Value>>,
    /// A `reset` batch is owed to the UI (new channel, new filter, clear).
    pending_reset: bool,
    /// First `seq` the UI has not been sent.
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

    /// Replaces the UI channel; the new one starts with a `reset`.
    fn attach(&self, channel: Channel<Value>) {
        let mut inner = self.inner();
        inner.channel = Some(channel);
        inner.pending_reset = true;
    }

    /// Forgets a channel that failed to send, unless it was replaced meanwhile.
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

    /// Returns whether the uid changed. A new uid changes what "only my app"
    /// shows, so the UI gets a fresh `reset`.
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
    /// What the UI is owed this tick: a pending `reset`, else an `append` of
    /// the new matching rows, else nothing.
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

/// `{"kind", "rows": [[seq, tsMs, pid, tid, level, tag, msg], ...], "skipped"}`.
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

/// Where a restarted stream continues (SPEC section 10.1). `-T` takes
/// `<sec>.<ms>`, so the new stream repeats the entries of the last
/// millisecond; those are recognised by `(sec, nsec, pid, tid)` and dropped.
#[derive(Default)]
struct Resume {
    /// `(sec, ms)` of the newest entry.
    last: Option<(u32, u32)>,
    /// Keys of the entries seen within that millisecond.
    tail: HashSet<EntryKey>,
    /// Keys the running stream may still repeat.
    repeats: HashSet<EntryKey>,
    /// Entries kept so far; tells whether a stream delivered anything.
    accepted: u64,
}

impl Resume {
    /// The `-T` argument: the last entry's time, or a backlog count at first.
    /// The fractional part is required and is zero-padded: `.5` would be half
    /// a second.
    fn start_arg(&self) -> String {
        match self.last {
            Some((sec, ms)) => format!("{sec}.{ms:03}"),
            None => BACKLOG.to_string(),
        }
    }

    /// Call before every stream: whatever was seen in the last millisecond may
    /// come again.
    fn restart(&mut self) {
        self.repeats.clone_from(&self.tail);
    }

    /// Whether `record` is new.
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
            // A newer millisecond also means the replay is over.
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

/// The device is attached and authorized, and hasn't been unplugged.
fn is_online(hub: &DeviceHub, serial: &str) -> bool {
    hub.views()
        .iter()
        .any(|v| v.serial == serial && v.state == DeviceState::Device && !v.gone)
}

/// Keeps a logcat stream open for as long as the app runs. Never stops
/// reading: logd drops slow readers.
async fn run_reader(device: Arc<Device>, hub: Arc<DeviceHub>) {
    let serial = device.serial.as_str();
    let server = AdbServer::default();
    let sel = DeviceSel::Serial(device.serial.clone());
    let mut resume = Resume::default();
    let mut waiting = false;
    // Set after the first end or failure; repeats log at debug until a
    // stream delivers entries again.
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

/// Runs one logcat process until its stream ends or breaks.
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
                // Keep what parsed before a bad header.
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

/// Sends the UI at most one message per [`TICK`].
async fn run_delivery(device: Arc<Device>) {
    let mut tick = interval(TICK);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Some((channel, batch)) = device.next_batch() else {
            continue;
        };
        if let Err(e) = channel.send(batch) {
            // The page went away; it re-attaches by calling `start_logcat`.
            tracing::debug!(serial = %device.serial, "logcat channel closed: {e}");
            device.detach(channel.id());
        }
    }
}

/// Looks the app's uid up at start and then every [`UID_REFRESH`].
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

/// `cmd package list packages -U <package>`; `None` when the app isn't installed.
async fn lookup_uid(
    server: &AdbServer,
    sel: &DeviceSel,
    package: &str,
) -> Result<Option<u32>, LogcatError> {
    // The package reaches a shell command, so it is validated here.
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

/// The uid on the line `package:<package> uid:<n>` whose package matches
/// exactly; the command's filter is a substring match.
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

/// Android package names: ASCII letters, digits, `_` and `.`, with at least one
/// dot and none at the ends.
fn is_valid_package(package: &str) -> bool {
    package.len() <= 255
        && package.contains('.')
        && !package.starts_with('.')
        && !package.ends_with('.')
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

// The commands are `async` only to run off the main thread; they never await.

/// Starts the device's reader if needed, attaches `on_batch` in place of any
/// previous channel and sends it a `reset` batch.
#[tauri::command]
pub async fn start_logcat(
    state: State<'_, LogcatState>,
    serial: String,
    on_batch: Channel<Value>,
) -> Result<(), String> {
    state.start(&serial, on_batch).map_err(|e| e.to_string())
}

/// Applies the filter and sends a `reset` batch. An invalid regex is an error
/// carrying the regex message, and leaves the old filter in place.
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

/// Empties the local ring and sends a `reset` batch. Never runs `logcat -c`.
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
