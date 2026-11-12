//! Mirror sessions: one scrcpy-server per (device, display), main or customer
//! (SPEC sections 4, 6). Video goes to the webview over the loopback WebSocket;
//! input comes back over it as JSON and is validated here.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::scrcpy::ScrcpyError;
use crate::scrcpy::control::{self, Control, Input, KEYCODE_POWER, KEYCODE_SLEEP};
use crate::scrcpy::device_msg::{self, DeviceMessage};
use crate::scrcpy::server::{self, Connected, Options};
use crate::scrcpy::video::{self, Packet};

const FIRST_SESSION_TIMEOUT: Duration = Duration::from_secs(10);
/// Bounded queue to the viewer (SPEC section 6.4).
const VIEWER_QUEUE: usize = 16;
const CONTROL_QUEUE: usize = 256;
/// RESET_VIDEO at most this often when the viewer falls behind.
const RESET_EVERY: Duration = Duration::from_secs(1);
/// Config/session envelopes are never dropped; wait this long for room.
const IMPORTANT_SEND_TIMEOUT: Duration = Duration::from_secs(1);
const LEFTOVER_CHECK_AFTER: Duration = Duration::from_secs(2);
const SERVER_OUTPUT_LINES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

pub struct Session {
    pub id: String,
    pub serial: String,
    pub role: Role,
    /// Size from the latest session packet; input must use it.
    size: Mutex<(u16, u16)>,
    control_tx: mpsc::Sender<Vec<u8>>,
    viewer: Mutex<Option<mpsc::Sender<Bytes>>>,
    need_key: AtomicBool,
    last_reset: Mutex<Option<Instant>>,
    cancel: CancellationToken,
}

impl Session {
    fn size(&self) -> (u16, u16) {
        *lock(&self.size)
    }

    /// Attaches a video viewer, replacing any previous one, and asks for a
    /// fresh config + key frame (the default key-frame interval is 10 s).
    pub fn attach_viewer(&self) -> mpsc::Receiver<Bytes> {
        let (tx, rx) = mpsc::channel(VIEWER_QUEUE);
        let _ = tx.try_send(video::envelope(
            video::K_META,
            0,
            u64::from(video::CODEC_H264),
            &[],
        ));
        *lock(&self.viewer) = Some(tx);
        self.need_key.store(true, Ordering::SeqCst);
        self.request_reset(true);
        rx
    }

    fn request_reset(&self, force: bool) {
        {
            let mut last = lock(&self.last_reset);
            if !force && last.is_some_and(|t| t.elapsed() < RESET_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        if let Ok(bytes) = control::serialize(&Control::ResetVideo) {
            let _ = self.control_tx.try_send(bytes);
        }
    }

    fn detach(&self, gone: &mpsc::Sender<Bytes>) {
        let mut viewer = lock(&self.viewer);
        if viewer.as_ref().is_some_and(|v| v.same_channel(gone)) {
            *viewer = None;
        }
    }

    /// Never drops config/session envelopes; drops frames until the next key
    /// frame when the viewer falls behind, and asks for one (SPEC section 6.4).
    async fn deliver(&self, envelope: Bytes, important: bool, key: bool) {
        let Some(tx) = lock(&self.viewer).clone() else {
            return;
        };
        if important {
            match tokio::time::timeout(IMPORTANT_SEND_TIMEOUT, tx.send(envelope)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => self.detach(&tx),
                Err(_) => {
                    self.need_key.store(true, Ordering::SeqCst);
                    self.request_reset(false);
                }
            }
            return;
        }
        if self.need_key.load(Ordering::SeqCst) && !key {
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

    /// Validates and queues UI input. The customer session never takes input:
    /// that screen has no touch, and its control socket is only a shutdown handle.
    pub async fn input(&self, input: Input) -> Result<(), String> {
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

    /// Key down + up. `serialize` refuses KEYCODE_WAKEUP.
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

pub struct MirrorHub {
    app: AppHandle,
    jar_path: PathBuf,
    jar: OnceCell<Arc<Vec<u8>>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl MirrorHub {
    pub fn new(app: AppHandle, jar_path: PathBuf) -> Self {
        Self {
            app,
            jar_path,
            jar: OnceCell::new(),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id).cloned()
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

    /// Starts a session and resolves after its first session packet (SPEC section 4).
    async fn start(
        self: &Arc<Self>,
        serial: String,
        display_id: u32,
        role: Role,
    ) -> Result<Started, ScrcpyError> {
        let server = AdbServer::default();
        let sel = DeviceSel::Serial(serial.clone());
        let jar = self.jar().await?;
        let scid = rand::random::<u32>() & 0x7FFF_FFFF; // must fit in 31 bits
        let session_id = format!("{:08x}", rand::random::<u32>());
        let options = match role {
            Role::Main => Options {
                display_id,
                max_size: 1920,
                max_fps: 60,
                bit_rate: 8_000_000,
                main: true,
            },
            Role::Customer => Options {
                display_id,
                max_size: 1280,
                max_fps: 30,
                bit_rate: 4_000_000,
                main: false,
            },
        };
        self.emit_state(&session_id, &serial, "starting", None);

        let shell = server::start(&server, &sel, &jar, scid, &options).await?;
        let output = Arc::new(Mutex::new(VecDeque::new()));
        let shell_task = tauri::async_runtime::spawn(read_server_output(
            shell,
            serial.clone(),
            scid,
            Arc::clone(&output),
        ));
        let connected = match server::connect(&server, &sel, scid).await {
            Ok(connected) => connected,
            Err(e) => {
                shell_task.abort();
                server::kill_leftover(&server, &sel, scid).await;
                let tail: Vec<String> = lock(&output).iter().cloned().collect();
                let detail = if tail.is_empty() {
                    String::new()
                } else {
                    format!(" — server said: {}", tail.join(" | "))
                };
                self.emit_state(&session_id, &serial, "error", Some(format!("{e}{detail}")));
                return Err(ScrcpyError::Start(format!("{e}{detail}")));
            }
        };
        tracing::info!(%serial, scid = %format!("{scid:08x}"), device = %connected.device_name, display_id, ?role, "scrcpy session connected");

        let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE);
        let session = Arc::new(Session {
            id: session_id.clone(),
            serial: serial.clone(),
            role,
            size: Mutex::new((0, 0)),
            control_tx,
            viewer: Mutex::new(None),
            need_key: AtomicBool::new(true),
            last_reset: Mutex::new(None),
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
            _ => {
                session.cancel.cancel();
                Err(ScrcpyError::Timeout("the first video frame"))
            }
        }
    }

    /// Runs a session until a stream ends or it is stopped, then cleans up in
    /// SPEC section 6.7 order: control, video, shell, then a leftover check.
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
            () = session.cancel.cancelled() => Ok(()),
        };
        // The streams were owned by the select branches and are closed now.
        shell_task.abort();
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
                session
                    .deliver(video::envelope(video::K_CONFIG, 0, 0, &data), true, false)
                    .await;
            }
            Packet::Media { key, pts, data, .. } => {
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

/// Drains the server's stdout/stderr so the pipe never fills, logging each line
/// and keeping the last few for error messages. Returns when the server exits.
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
            if line.starts_with("ERROR") || line.starts_with("WARN") {
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
) -> Result<Started, String> {
    hub.start(serial, display_id, role)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_mirror(hub: State<'_, Arc<MirrorHub>>, session_id: String) {
    if let Some(session) = hub.session(&session_id) {
        session.cancel.cancel();
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

/// Screen power per SPEC section 6.8: SLEEP (223) to turn off, POWER (26) only
/// when `mWakefulness=Asleep`, never a blind POWER and never WAKEUP (224).
/// Uses the main session's control socket when mirroring, else `input keyevent`.
#[tauri::command]
pub async fn device_power(
    hub: State<'_, Arc<MirrorHub>>,
    serial: String,
    action: String,
) -> Result<String, String> {
    let sel = DeviceSel::Serial(serial.clone());
    let asleep = wakefulness(&sel).await? == "Asleep";
    let keycode = match (action.as_str(), asleep) {
        ("sleep", _) | ("toggle", false) => Some(KEYCODE_SLEEP),
        ("wake", true) | ("toggle", true) => Some(KEYCODE_POWER),
        ("wake", false) => None,
        _ => return Err(format!("unknown power action {action}")),
    };
    if let Some(keycode) = keycode {
        match hub.main_session(&serial) {
            Some(session) => session.press(keycode).await?,
            None => {
                let out = crate::adb::shell(
                    &AdbServer::default(),
                    &sel,
                    &format!("input keyevent {keycode}"),
                )
                .await
                .map_err(|e| e.to_string())?;
                if out.exit_code != Some(0) {
                    return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
                }
            }
        }
        tracing::info!(%serial, keycode, "power key sent");
    }
    Ok(if keycode == Some(KEYCODE_SLEEP) {
        "Asleep".into()
    } else {
        "Awake".into()
    })
}
