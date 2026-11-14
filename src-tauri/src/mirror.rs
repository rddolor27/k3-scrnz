use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{OnceCell, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::adb::{AdbServer, AdbStream, DeviceSel, ShellEvent, ShellProcess};
use crate::capture::{EndReason, Ending, Msg, Offer, Recorder, RecordingEnded};
use crate::config::ConfigStore;
use crate::scrcpy::ScrcpyError;
use crate::scrcpy::control::{self, Control, Input, KEYCODE_POWER, KEYCODE_SLEEP};
use crate::scrcpy::device_msg::{self, DeviceMessage};
use crate::scrcpy::server::{self, Connected, Options};
use crate::scrcpy::video::{self, Packet};

const FIRST_SESSION_TIMEOUT: Duration = Duration::from_secs(10);
const START_TIMEOUT: Duration = Duration::from_secs(20);
const BOOT_TIMEOUT: Duration = Duration::from_secs(180);
const START_TURN_POLL: Duration = Duration::from_millis(250);
const VIEWER_QUEUE: usize = 16;
const CONTROL_QUEUE: usize = 256;
const RESET_EVERY: Duration = Duration::from_secs(1);
const STALLED_VIEWER: Duration = Duration::from_secs(5);
/// Missing frames never stop a session: a static screen sends none.
const NO_CLIENT_TIMEOUT: Duration = Duration::from_secs(15);
const WATCHDOG_EVERY: Duration = Duration::from_secs(2);
const LEFTOVER_CHECK_AFTER: Duration = Duration::from_secs(2);
const SERVER_OUTPUT_LINES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Main,
    Customer,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub session_id: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    session_id: String,
    serial: String,
    state: &'static str,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceClipboard {
    serial: String,
    text: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn valid_serial(serial: &str) -> Result<(), String> {
    let ok = !serial.is_empty()
        && serial.len() <= 128
        && serial
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid device serial {serial:?}"))
    }
}

pub struct Session {
    pub id: String,
    pub serial: String,
    pub role: Role,
    display_id: u32,
    /// From the latest session packet; the server drops touches with another w,h.
    size: Mutex<(u16, u16)>,
    control_tx: mpsc::Sender<Vec<u8>>,
    viewer: Mutex<Option<mpsc::Sender<Bytes>>>,
    need_key: AtomicBool,
    got_frame: AtomicBool,
    last_reset: Mutex<Option<Instant>>,
    clients: AtomicUsize,
    unwatched_since: Mutex<Option<Instant>>,
    config: Mutex<Option<Bytes>>,
    recorder: Mutex<Option<Recorder>>,
    cancel: CancellationToken,
}

pub struct ClientGuard(Arc<Session>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        if self.0.clients.fetch_sub(1, Ordering::SeqCst) == 1 {
            *lock(&self.0.unwatched_since) = Some(Instant::now());
        }
    }
}

impl Session {
    fn size(&self) -> (u16, u16) {
        *lock(&self.size)
    }

    pub async fn ended(&self) {
        self.cancel.cancelled().await;
    }

    pub fn client(self: &Arc<Self>) -> ClientGuard {
        self.clients.fetch_add(1, Ordering::SeqCst);
        *lock(&self.unwatched_since) = None;
        ClientGuard(Arc::clone(self))
    }

    /// The default key-frame interval is 10 s, hence the forced reset.
    pub fn attach_viewer(&self) -> mpsc::Receiver<Bytes> {
        let (tx, rx) = mpsc::channel(VIEWER_QUEUE);
        let _ = tx.try_send(video::envelope(
            video::K_META,
            0,
            u64::from(video::CODEC_H264),
            &[],
        ));
        // A viewer that attaches after the session or config packet still needs both.
        let (width, height) = self.size();
        if width > 0 && height > 0 {
            let value = (u64::from(width) << 32) | u64::from(height);
            let _ = tx.try_send(video::envelope(video::K_SESSION, 0, value, &[]));
        }
        if let Some(config) = lock(&self.config).clone() {
            let _ = tx.try_send(video::envelope(video::K_CONFIG, 0, 0, &config));
        }
        *lock(&self.viewer) = Some(tx);
        self.need_key.store(true, Ordering::SeqCst);
        self.request_reset(true);
        rx
    }

    pub fn request_reset(&self, force: bool) {
        // scrcpy can hang for good when RESET_VIDEO arrives before the encoder's first frame
        // (seen on the Android 7 emulator's software encoder); that first frame is a key frame anyway.
        if !self.got_frame.load(Ordering::SeqCst) {
            tracing::debug!(session = %self.id, "reset skipped before the first frame");
            return;
        }
        {
            let mut last = lock(&self.last_reset);
            if !force && last.is_some_and(|t| t.elapsed() < RESET_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        if let Ok(bytes) = control::serialize(&Control::ResetVideo)
            && self.control_tx.try_send(bytes).is_err()
        {
            tracing::debug!(session = %self.id, "control queue full; reset skipped");
        }
    }

    // Under the recorder lock, so no packet slips between the snapshot and the first feed.
    pub fn begin_recording(
        &self,
        start: impl FnOnce((u16, u16), Option<Bytes>) -> Recorder,
    ) -> bool {
        let mut slot = lock(&self.recorder);
        if slot.is_some() {
            return false;
        }
        *slot = Some(start(self.size(), lock(&self.config).clone()));
        true
    }

    pub fn end_recording(
        &self,
        reason: EndReason,
        error: Option<String>,
    ) -> Option<oneshot::Receiver<RecordingEnded>> {
        let recorder = lock(&self.recorder).take()?;
        Some(recorder.finish(reason, error))
    }

    pub fn release_recorder(&self, ending: &Arc<Ending>) {
        let mut slot = lock(&self.recorder);
        if slot.as_ref().is_some_and(|r| r.is(ending)) {
            *slot = None;
        }
    }

    fn record(&self, msg: Msg) {
        let mut slot = lock(&self.recorder);
        let Some(recorder) = slot.as_ref() else {
            return;
        };
        match recorder.offer(msg) {
            Offer::Taken => {}
            Offer::Full => {
                tracing::warn!(session = %self.id, "recording queue full; ending the recording");
                if let Some(recorder) = slot.take() {
                    recorder.finish(EndReason::Failed, Some("the disk can't keep up".into()));
                }
            }
            Offer::Gone => *slot = None,
        }
    }

    fn detach(&self, gone: &mpsc::Sender<Bytes>) {
        let mut viewer = lock(&self.viewer);
        if viewer.as_ref().is_some_and(|v| v.same_channel(gone)) {
            *viewer = None;
        }
    }

    /// Never drops config/session envelopes (a stuck viewer is detached instead).
    async fn deliver(&self, envelope: Bytes, important: bool, key: bool) {
        let Some(tx) = lock(&self.viewer).clone() else {
            return;
        };
        if important {
            tokio::select! {
                sent = tokio::time::timeout(STALLED_VIEWER, tx.send(envelope)) => match sent {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => self.detach(&tx),
                    Err(_) => {
                        tracing::warn!(session = %self.id, "viewer stalled; detaching it");
                        self.detach(&tx);
                    }
                },
                () = self.cancel.cancelled() => {}
            }
            return;
        }
        if self.need_key.load(Ordering::SeqCst) && !key {
            self.request_reset(false);
            return;
        }
        match tx.try_send(envelope) {
            Ok(()) => {
                if key {
                    self.need_key.store(false, Ordering::SeqCst);
                }
            }
            Err(TrySendError::Full(_)) => {
                self.need_key.store(true, Ordering::SeqCst);
                self.request_reset(false);
            }
            Err(TrySendError::Closed(_)) => self.detach(&tx),
        }
    }

    pub async fn input(&self, input: Input) -> Result<(), String> {
        if let Input::ResetVideo { force } = input {
            self.request_reset(force);
            return Ok(());
        }
        if self.role == Role::Customer {
            return Err("the customer screen is view-only".into());
        }
        for message in control::to_controls(input, self.size()).map_err(|e| e.to_string())? {
            self.send(&message).await?;
        }
        Ok(())
    }

    async fn send(&self, message: &Control) -> Result<(), String> {
        let bytes = control::serialize(message).map_err(|e| e.to_string())?;
        self.control_tx
            .send(bytes)
            .await
            .map_err(|_| "the session has ended".to_string())
    }

    /// Only for `device_power`: the control WebSocket can't send POWER/SLEEP,
    /// and `serialize` refuses WAKEUP.
    async fn press(&self, keycode: i32) -> Result<(), String> {
        for action in [0, 1] {
            self.send(&Control::Key {
                action,
                keycode,
                repeat: 0,
                meta: 0,
            })
            .await?;
        }
        Ok(())
    }
}

struct Starting<'a> {
    set: &'a Mutex<HashSet<(String, u32, Role)>>,
    key: (String, u32, Role),
}

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        lock(self.set).remove(&self.key);
    }
}

pub struct MirrorHub {
    app: AppHandle,
    config: Arc<ConfigStore>,
    jar_path: PathBuf,
    jar: OnceCell<Arc<Vec<u8>>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    starting: Mutex<HashSet<(String, u32, Role)>>,
    swept: Mutex<HashMap<String, Arc<OnceCell<()>>>>,
}

impl MirrorHub {
    pub fn new(app: AppHandle, config: Arc<ConfigStore>, jar_path: PathBuf) -> Self {
        Self {
            app,
            config,
            jar_path,
            jar: OnceCell::new(),
            sessions: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
            swept: Mutex::new(HashMap::new()),
        }
    }

    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id).cloned()
    }

    pub fn end_recordings(&self) -> Vec<oneshot::Receiver<RecordingEnded>> {
        let sessions: Vec<Arc<Session>> = lock(&self.sessions).values().cloned().collect();
        sessions
            .iter()
            .filter_map(|s| s.end_recording(EndReason::SessionEnded, None))
            .collect()
    }

    fn main_session(&self, serial: &str) -> Option<Arc<Session>> {
        lock(&self.sessions)
            .values()
            .find(|s| s.serial == serial && s.role == Role::Main)
            .cloned()
    }

    async fn jar(&self) -> Result<Arc<Vec<u8>>, ScrcpyError> {
        self.jar
            .get_or_try_init(|| async {
                Ok::<_, ScrcpyError>(Arc::new(tokio::fs::read(&self.jar_path).await?))
            })
            .await
            .cloned()
    }

    async fn sweep_once(&self, server: &AdbServer, sel: &DeviceSel, serial: &str) {
        let cell = Arc::clone(
            lock(&self.swept)
                .entry(serial.to_owned())
                .or_insert_with(|| Arc::new(OnceCell::new())),
        );
        cell.get_or_init(|| server::sweep_stale_jars(server, sel))
            .await;
    }

    fn emit_state(
        &self,
        session_id: &str,
        serial: &str,
        state: &'static str,
        error: Option<String>,
    ) {
        let payload = SessionState {
            session_id: session_id.to_owned(),
            serial: serial.to_owned(),
            state,
            error,
        };
        if let Err(e) = self.app.emit("session-state", payload) {
            tracing::warn!("can't emit session-state: {e}");
        }
    }

    /// One server start per screen at a time (two `power_on` servers could
    /// press POWER twice). A second start waits its turn and then replaces the
    /// first: a pane remounted while an emulator boots must not give up.
    async fn start(
        self: &Arc<Self>,
        serial: String,
        display_id: u32,
        role: Role,
        max_size: Option<u32>,
    ) -> Result<Started, ScrcpyError> {
        valid_serial(&serial).map_err(ScrcpyError::Start)?;
        let key = (serial.clone(), display_id, role);
        let give_up = tokio::time::Instant::now() + BOOT_TIMEOUT + START_TIMEOUT;
        while !lock(&self.starting).insert(key.clone()) {
            if tokio::time::Instant::now() >= give_up {
                return Err(ScrcpyError::Start(
                    "a session for this screen is already starting".into(),
                ));
            }
            tokio::time::sleep(START_TURN_POLL).await;
        }
        let _starting = Starting {
            set: &self.starting,
            key,
        };
        let previous: Vec<Arc<Session>> = lock(&self.sessions)
            .values()
            .filter(|s| s.serial == serial && s.display_id == display_id && s.role == role)
            .cloned()
            .collect();
        for old in previous {
            tracing::info!(session = %old.id, "replacing the previous session for this screen");
            old.cancel.cancel();
        }

        let server = AdbServer::default();
        let sel = DeviceSel::Serial(serial.clone());
        let jar = self.jar().await?;
        let scid = rand::random::<u32>() & 0x7FFF_FFFF; // must fit in 31 bits
        let session_id = format!("{:08x}", rand::random::<u32>());
        let limit = |configured: u32| max_size.map_or(configured, |m| m.max(320).min(configured));
        let options = match role {
            Role::Main => Options {
                display_id,
                max_size: limit(self.config.max_size(false)),
                max_fps: 60,
                bit_rate: 8_000_000,
                main: true,
            },
            Role::Customer => Options {
                display_id,
                max_size: limit(self.config.max_size(true)),
                max_fps: 30,
                bit_rate: 4_000_000,
                main: false,
            },
        };
        self.emit_state(&session_id, &serial, "starting", None);

        // A just-started emulator is online in adb long before Android can run
        // the server.
        if serial.starts_with("emulator-") {
            wait_for_boot(&server, &sel).await?;
        }
        self.sweep_once(&server, &sel, &serial).await;
        let shell = tokio::time::timeout(
            START_TIMEOUT,
            server::start(&server, &sel, &jar, scid, &options),
        )
        .await
        .map_err(|_| ScrcpyError::Timeout("the server to start"))??;
        let output = Arc::new(Mutex::new(VecDeque::new()));
        let shell_task = tauri::async_runtime::spawn(read_server_output(
            shell,
            serial.clone(),
            scid,
            Arc::clone(&output),
        ));
        let server_said = || {
            let tail: Vec<String> = lock(&output).iter().cloned().collect();
            if tail.is_empty() {
                String::new()
            } else {
                format!(" — server said: {}", tail.join(" | "))
            }
        };
        let connect_timeout = if serial.starts_with("emulator-") {
            server::EMULATOR_CONNECT_TIMEOUT
        } else {
            server::CONNECT_TIMEOUT
        };
        let connected = match server::connect(&server, &sel, scid, connect_timeout).await {
            Ok(connected) => connected,
            Err(e) => {
                shell_task.abort();
                server::kill_leftover(&server, &sel, scid).await;
                let message = format!("{e}{}", server_said());
                self.emit_state(&session_id, &serial, "error", Some(message.clone()));
                return Err(ScrcpyError::Start(message));
            }
        };
        tracing::info!(%serial, scid = %format!("{scid:08x}"), device = %connected.device_name, display_id, ?role, "scrcpy session connected");

        let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE);
        let session = Arc::new(Session {
            id: session_id.clone(),
            serial: serial.clone(),
            role,
            display_id,
            size: Mutex::new((0, 0)),
            control_tx,
            viewer: Mutex::new(None),
            need_key: AtomicBool::new(true),
            got_frame: AtomicBool::new(false),
            last_reset: Mutex::new(None),
            clients: AtomicUsize::new(0),
            unwatched_since: Mutex::new(Some(Instant::now())),
            config: Mutex::new(None),
            recorder: Mutex::new(None),
            cancel: CancellationToken::new(),
        });
        lock(&self.sessions).insert(session_id.clone(), Arc::clone(&session));

        let (first_tx, first_rx) = oneshot::channel();
        tauri::async_runtime::spawn(Arc::clone(self).run(
            Arc::clone(&session),
            connected,
            shell_task,
            control_rx,
            first_tx,
            scid,
        ));
        match tokio::time::timeout(FIRST_SESSION_TIMEOUT, first_rx).await {
            Ok(Ok((width, height))) => {
                self.emit_state(&session_id, &serial, "streaming", None);
                Ok(Started {
                    session_id,
                    width,
                    height,
                })
            }
            Ok(Err(_)) => {
                session.cancel.cancel();
                Err(ScrcpyError::Start(format!(
                    "the server stopped before sending video{}",
                    server_said()
                )))
            }
            Err(_) => {
                session.cancel.cancel();
                Err(ScrcpyError::Timeout("the first video frame"))
            }
        }
    }

    /// Cleans up in SPEC section 6.7 order: control, video, shell, then a
    /// leftover check.
    async fn run(
        self: Arc<Self>,
        session: Arc<Session>,
        connected: Connected,
        mut shell_task: JoinHandle<()>,
        control_rx: mpsc::Receiver<Vec<u8>>,
        first_tx: oneshot::Sender<(u32, u32)>,
        scid: u32,
    ) {
        let Connected { video, control, .. } = connected;
        let (control_read, control_write) = tokio::io::split(control);
        let outcome: Result<(), String> = tokio::select! {
            r = control_writer(control_write, control_rx) => r.map_err(|e| e.to_string()),
            r = device_messages(control_read, &self.app, &session) => r.map_err(|e| e.to_string()),
            r = video_loop(video, &session, first_tx) => r.map_err(|e| e.to_string()),
            _ = &mut shell_task => Err("scrcpy-server exited".into()),
            () = watchdog(&session) => Err("nobody was watching it".into()),
            () = session.cancel.cancelled() => Ok(()),
        };
        shell_task.abort();
        *lock(&session.viewer) = None;
        session.cancel.cancel();
        session.end_recording(EndReason::SessionEnded, None);
        lock(&self.sessions).remove(&session.id);
        match &outcome {
            Ok(()) => {
                tracing::info!(serial = %session.serial, session = %session.id, "session stopped")
            }
            Err(e) => {
                tracing::warn!(serial = %session.serial, session = %session.id, "session ended: {e}")
            }
        }
        let (state, error) = match outcome {
            Ok(()) => ("stopped", None),
            Err(e) => ("error", Some(friendly(&e))),
        };
        self.emit_state(&session.id, &session.serial, state, error);

        tokio::time::sleep(LEFTOVER_CHECK_AFTER).await;
        server::kill_leftover(
            &AdbServer::default(),
            &DeviceSel::Serial(session.serial.clone()),
            scid,
        )
        .await;
    }
}

async fn watchdog(session: &Session) {
    let mut tick = tokio::time::interval(WATCHDOG_EVERY);
    loop {
        tick.tick().await;
        let unwatched = *lock(&session.unwatched_since);
        if unwatched.is_some_and(|since| since.elapsed() > NO_CLIENT_TIMEOUT) {
            return;
        }
    }
}

fn friendly(error: &str) -> String {
    if error.contains("early eof") || error.contains("failed to fill whole buffer") {
        "the device disconnected or the server stopped".into()
    } else {
        error.to_owned()
    }
}

async fn video_loop(
    mut video: AdbStream,
    session: &Session,
    first: oneshot::Sender<(u32, u32)>,
) -> Result<(), ScrcpyError> {
    let mut first = Some(first);
    let mut codec_logged = false;
    loop {
        match video::read_packet(&mut video).await? {
            Packet::Session { width, height } => {
                let size = (
                    u16::try_from(width).unwrap_or(u16::MAX),
                    u16::try_from(height).unwrap_or(u16::MAX),
                );
                *lock(&session.size) = size;
                session.record(Msg::Session {
                    width: size.0,
                    height: size.1,
                });
                tracing::debug!(session = %session.id, width, height, "video session");
                if let Some(tx) = first.take() {
                    let _ = tx.send((width, height));
                }
                let value = (u64::from(width) << 32) | u64::from(height);
                session
                    .deliver(
                        video::envelope(video::K_SESSION, 0, value, &[]),
                        true,
                        false,
                    )
                    .await;
            }
            Packet::Media {
                config: true, data, ..
            } => {
                if !codec_logged {
                    codec_logged = true;
                    tracing::info!(session = %session.id, codec = ?video::codec_string(&data), "video config");
                }
                *lock(&session.config) = Some(data.clone());
                session.record(Msg::Config(data.clone()));
                session
                    .deliver(video::envelope(video::K_CONFIG, 0, 0, &data), true, false)
                    .await;
            }
            Packet::Media { key, pts, data, .. } => {
                if !session.got_frame.swap(true, Ordering::SeqCst) {
                    tracing::debug!(session = %session.id, key, "first video frame");
                }
                session.record(Msg::Frame {
                    key,
                    pts,
                    data: data.clone(),
                    at: Instant::now(),
                });
                session
                    .deliver(
                        video::envelope(video::K_FRAME, u8::from(key), pts, &data),
                        false,
                        key,
                    )
                    .await;
            }
        }
    }
}

async fn control_writer<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut rx: mpsc::Receiver<Vec<u8>>,
) -> std::io::Result<()> {
    while let Some(bytes) = rx.recv().await {
        writer.write_all(&bytes).await?;
    }
    Ok(())
}

async fn device_messages<R: AsyncRead + Unpin>(
    mut reader: R,
    app: &AppHandle,
    session: &Session,
) -> Result<(), ScrcpyError> {
    loop {
        if let DeviceMessage::Clipboard(text) = device_msg::read_message(&mut reader).await? {
            let payload = DeviceClipboard {
                serial: session.serial.clone(),
                text,
            };
            if let Err(e) = app.emit("device-clipboard", payload) {
                tracing::warn!("can't emit device-clipboard: {e}");
            }
        }
    }
}

/// Drains the server's output so its pipe never fills.
async fn read_server_output(
    mut shell: ShellProcess,
    serial: String,
    scid: u32,
    tail: Arc<Mutex<VecDeque<String>>>,
) {
    let scid = format!("{scid:08x}");
    loop {
        let data = match shell.next_event().await {
            Ok(Some(ShellEvent::Stdout(data) | ShellEvent::Stderr(data))) => data,
            Ok(Some(ShellEvent::Exit(code))) => {
                tracing::info!(%serial, %scid, code, "scrcpy-server exited");
                return;
            }
            Ok(None) => return,
            Err(e) => {
                tracing::debug!(%serial, %scid, "scrcpy-server output ended: {e}");
                return;
            }
        };
        for line in String::from_utf8_lossy(&data)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
        {
            if line.contains("ERROR") || line.contains("WARN") {
                tracing::warn!(%serial, %scid, "server: {line}");
            } else {
                tracing::info!(%serial, %scid, "server: {line}");
            }
            let mut tail = lock(&tail);
            if tail.len() == SERVER_OUTPUT_LINES {
                tail.pop_front();
            }
            tail.push_back(line.to_owned());
        }
    }
}

#[tauri::command]
pub async fn start_mirror(
    hub: State<'_, Arc<MirrorHub>>,
    serial: String,
    display_id: u32,
    role: Role,
    max_size: Option<u32>,
) -> Result<Started, String> {
    hub.start(serial, display_id, role, max_size)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_mirror(hub: State<'_, Arc<MirrorHub>>, session_id: String) {
    if let Some(session) = hub.session(&session_id) {
        session.cancel.cancel();
    }
}

async fn wait_for_boot(server: &AdbServer, sel: &DeviceSel) -> Result<(), ScrcpyError> {
    let deadline = tokio::time::Instant::now() + BOOT_TIMEOUT;
    loop {
        if let Ok(out) = crate::adb::shell(server, sel, "getprop sys.boot_completed").await
            && String::from_utf8_lossy(&out.stdout).trim() == "1"
        {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ScrcpyError::Start(
                "the emulator hasn't finished booting".into(),
            ));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn wakefulness(sel: &DeviceSel) -> Result<String, String> {
    let out = crate::adb::shell(
        &AdbServer::default(),
        sel,
        "dumpsys power | grep -m1 mWakefulness=",
    )
    .await
    .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim()
        .split_once('=')
        .map(|(_, value)| value.trim().to_owned())
        .ok_or_else(|| format!("unexpected dumpsys power output: {}", text.trim()))
}

async fn input_keyevent(sel: &DeviceSel, keycode: i32) -> Result<(), String> {
    let out = crate::adb::shell(
        &AdbServer::default(),
        sel,
        &format!("input keyevent {keycode}"),
    )
    .await
    .map_err(|e| e.to_string())?;
    if out.exit_code == Some(0) {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// SLEEP (223) to turn off, POWER (26) only when `mWakefulness=Asleep`; never a
/// blind POWER, never WAKEUP (224) (SPEC section 6.8).
#[tauri::command]
pub async fn device_power(
    hub: State<'_, Arc<MirrorHub>>,
    serial: String,
    action: String,
) -> Result<String, String> {
    valid_serial(&serial)?;
    let sel = DeviceSel::Serial(serial.clone());
    let asleep = wakefulness(&sel).await? == "Asleep";
    let keycode = match (action.as_str(), asleep) {
        ("sleep", _) | ("toggle", false) => Some(KEYCODE_SLEEP),
        ("wake", true) | ("toggle", true) => Some(KEYCODE_POWER),
        ("wake", false) => None,
        _ => return Err(format!("unknown power action {action}")),
    };
    if let Some(keycode) = keycode {
        let via_session = match hub.main_session(&serial) {
            Some(session) => session.press(keycode).await.is_ok(),
            None => false,
        };
        if !via_session {
            input_keyevent(&sel, keycode).await?;
        }
        tracing::info!(%serial, keycode, "power key sent");
    }
    Ok(if keycode == Some(KEYCODE_SLEEP) {
        "Asleep".into()
    } else {
        "Awake".into()
    })
}
