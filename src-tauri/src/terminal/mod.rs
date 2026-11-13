mod device;
mod host;
mod project;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tauri::State;
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::{CancellationToken, WaitForCancellationFuture};

use project::ProjectKind;

const SCROLLBACK_BYTES: usize = 1024 * 1024;
const VIEWER_QUEUE: usize = 1024;
const DEFAULT_SIZE: (u16, u16) = (24, 100);

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("not a valid device serial: {0}")]
    BadSerial(String),
    #[error("{0} is not a folder")]
    NotAFolder(String),
    #[error("can't read package.json: {0}")]
    Manifest(String),
    #[error("can't start the terminal: {0}")]
    Spawn(String),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalSpec {
    Device,
    Project { path: String, run: bool },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalKind {
    Device,
    Project,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStarted {
    pub id: String,
    pub serial: String,
    pub title: String,
    pub kind: TerminalKind,
    pub project: Option<ProjectKind>,
    pub command: Option<String>,
    pub cwd: Option<String>,
}

pub enum Input {
    Data(Vec<u8>),
    Resize { rows: u16, cols: u16 },
    Close,
}

pub enum Output {
    Data(Bytes),
    Exit(Option<u32>),
}

struct Viewer {
    id: u64,
    tx: mpsc::Sender<Output>,
}

struct Shared {
    scrollback: VecDeque<u8>,
    viewer: Option<Viewer>,
    exit: Option<Option<u32>>,
    size: (u16, u16),
}

pub struct Session {
    pub id: String,
    serial: String,
    input: mpsc::UnboundedSender<Input>,
    ended: CancellationToken,
    shared: Mutex<Shared>,
}

impl Session {
    fn new(id: String, serial: String, input: mpsc::UnboundedSender<Input>) -> Self {
        Self {
            id,
            serial,
            input,
            ended: CancellationToken::new(),
            shared: Mutex::new(Shared {
                scrollback: VecDeque::new(),
                viewer: None,
                exit: None,
                size: DEFAULT_SIZE,
            }),
        }
    }

    fn shared(&self) -> MutexGuard<'_, Shared> {
        lock(&self.shared)
    }

    pub fn write(&self, data: Vec<u8>) {
        if self.input.send(Input::Data(data)).is_err() {
            tracing::debug!(id = %self.id, "input after the terminal closed");
        }
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        if rows == 0 || cols == 0 {
            return;
        }
        self.shared().size = (rows, cols);
        if self.input.send(Input::Resize { rows, cols }).is_err() {
            tracing::debug!(id = %self.id, "resize after the terminal closed");
        }
    }

    /// The previous viewer, if any, is dropped: one WebSocket per session.
    pub fn attach(&self) -> (u64, Vec<u8>, mpsc::Receiver<Output>) {
        let (tx, rx) = mpsc::channel(VIEWER_QUEUE);
        let id = rand::random::<u64>();
        let mut shared = self.shared();
        let snapshot = shared.scrollback.iter().copied().collect();
        if let Some(code) = shared.exit
            && tx.try_send(Output::Exit(code)).is_err()
        {
            tracing::debug!(id = %self.id, "exit not queued for the new viewer");
        }
        shared.viewer = Some(Viewer { id, tx });
        (id, snapshot, rx)
    }

    pub fn detach(&self, viewer: u64) {
        let mut shared = self.shared();
        if shared.viewer.as_ref().is_some_and(|v| v.id == viewer) {
            shared.viewer = None;
        }
    }

    fn size(&self) -> (u16, u16) {
        self.shared().size
    }

    fn push(&self, data: &[u8]) {
        let mut shared = self.shared();
        shared.scrollback.extend(data);
        let excess = shared.scrollback.len().saturating_sub(SCROLLBACK_BYTES);
        shared.scrollback.drain(..excess);
        let sent = shared
            .viewer
            .as_ref()
            .map(|v| v.tx.try_send(Output::Data(Bytes::copy_from_slice(data))));
        if let Some(Err(e)) = sent {
            // The viewer reattaches and gets the scrollback again.
            tracing::debug!(id = %self.id, "terminal viewer dropped: {e}");
            shared.viewer = None;
        }
    }

    fn finish(&self, code: Option<u32>) {
        let mut shared = self.shared();
        if shared.exit.is_some() {
            return;
        }
        shared.exit = Some(code);
        if let Some(viewer) = &shared.viewer
            && viewer.tx.try_send(Output::Exit(code)).is_err()
        {
            tracing::debug!(id = %self.id, "exit not delivered to the viewer");
        }
        drop(shared);
        self.ended.cancel();
        tracing::info!(id = %self.id, serial = %self.serial, code = ?code, "terminal exited");
    }

    fn ended(&self) -> WaitForCancellationFuture<'_> {
        self.ended.cancelled()
    }

    fn close(&self) {
        if self.input.send(Input::Close).is_err() {
            tracing::debug!(id = %self.id, "terminal already closed");
        }
    }
}

#[derive(Default)]
pub struct TerminalHub {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalHub {
    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id).cloned()
    }

    pub fn stop_all(&self) {
        let sessions: Vec<Arc<Session>> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.close();
        }
    }

    async fn start(
        &self,
        serial: String,
        spec: TerminalSpec,
    ) -> Result<TerminalStarted, TerminalError> {
        if !is_valid_serial(&serial) {
            return Err(TerminalError::BadSerial(serial));
        }
        let id = format!("term-{:016x}", rand::random::<u64>());
        let (tx, rx) = mpsc::unbounded_channel();
        let session = Arc::new(Session::new(id.clone(), serial.clone(), tx));
        let started = match spec {
            TerminalSpec::Device => {
                tauri::async_runtime::spawn(device::run(Arc::clone(&session), rx));
                TerminalStarted {
                    id,
                    serial,
                    title: "Device shell".to_owned(),
                    kind: TerminalKind::Device,
                    project: None,
                    command: None,
                    cwd: None,
                }
            }
            TerminalSpec::Project { path, run } => {
                let project = project::inspect(PathBuf::from(path)).await?;
                let command = run
                    .then(|| project::run_command(project.kind, &serial))
                    .flatten();
                let cwd = project.path.display().to_string();
                let spawned = Arc::clone(&session);
                let spawn_command = command.clone();
                let close = session.input.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    host::spawn(spawned, rx, close, &project.path, spawn_command.as_deref())
                })
                .await
                .map_err(|e| TerminalError::Spawn(e.to_string()))??;
                TerminalStarted {
                    id,
                    serial,
                    title: project.name,
                    kind: TerminalKind::Project,
                    project: Some(project.kind),
                    command,
                    cwd: Some(cwd),
                }
            }
        };
        tracing::info!(id = %started.id, serial = %started.serial, kind = ?started.kind, "terminal started");
        lock(&self.sessions).insert(started.id.clone(), session);
        Ok(started)
    }

    fn stop(&self, id: &str) {
        if let Some(session) = lock(&self.sessions).remove(id) {
            session.close();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Serials end up in a shell command line, so only plain characters pass.
fn is_valid_serial(serial: &str) -> bool {
    !serial.is_empty()
        && serial.len() <= 128
        && serial
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

#[tauri::command]
pub async fn start_terminal(
    hub: State<'_, TerminalHub>,
    serial: String,
    spec: TerminalSpec,
) -> Result<TerminalStarted, String> {
    hub.start(serial, spec).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_terminal(hub: State<'_, TerminalHub>, id: String) {
    hub.stop(&id);
}
