mod mp4;

use std::fs::File;
use std::io::{self, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde::{Deserialize, Serialize, Serializer};
use tauri::image::Image;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use thiserror::Error;
use tokio::sync::oneshot;

use self::mp4::Mp4;
use crate::files::{self, FilesError};
use crate::mirror::{MirrorHub, Session};

const CAPTURE_HEADER: &str = "x-k3-capture";
const MAX_DIMENSION: u32 = 8192;
const RECORD_QUEUE: usize = 600;
const MAX_DURATION: Duration = Duration::from_secs(30 * 60);
// Offsets and the mdat size are 32-bit, so the file must stay under 4 GiB with the moov.
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("{0}")]
    Invalid(String),
    #[error("no such session")]
    UnknownSession,
    #[error("this session is already being recorded")]
    AlreadyRecording,
    #[error("this session isn't being recorded")]
    NotRecording,
    #[error("the recording ended unexpectedly")]
    Lost,
    #[error(transparent)]
    Files(#[from] FilesError),
    #[error("local file: {0}")]
    Io(#[from] io::Error),
}

impl Serialize for CaptureError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotSaved {
    path: String,
    copied: bool,
    copy_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    Stopped,
    SessionEnded,
    SizeChanged,
    Limit,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEnded {
    session_id: String,
    path: String,
    duration_ms: u64,
    bytes: u64,
    reason: EndReason,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotMeta {
    serial: String,
    name: String,
    width: u32,
    height: u32,
    png_length: u64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn file_name(name: &str, ext: &str) -> Result<String, CaptureError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CaptureError::Invalid("the file name is empty".into()));
    }
    let named = if name.to_ascii_lowercase().ends_with(ext) {
        name.to_owned()
    } else {
        format!("{name}{ext}")
    };
    Ok(files::local_name(&named))
}

async fn capture_dir(app: &AppHandle, serial: &str) -> Result<PathBuf, CaptureError> {
    let dir = files::downloads_root(app)?.join(files::local_name(serial));
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

fn split_capture<'a>(
    meta: &ScreenshotMeta,
    body: &'a [u8],
) -> Result<(&'a [u8], &'a [u8]), CaptureError> {
    let invalid = |message: &str| CaptureError::Invalid(message.into());
    if !(1..=MAX_DIMENSION).contains(&meta.width) || !(1..=MAX_DIMENSION).contains(&meta.height) {
        return Err(invalid("the screenshot size is out of range"));
    }
    let png_len = usize::try_from(meta.png_length).map_err(|_| invalid("invalid PNG length"))?;
    let (png, rgba) = body
        .split_at_checked(png_len)
        .ok_or_else(|| invalid("the PNG is longer than the body"))?;
    let pixels = u64::from(meta.width)
        .checked_mul(u64::from(meta.height))
        .and_then(|p| p.checked_mul(4));
    if png.is_empty() {
        return Err(invalid("the PNG is empty"));
    }
    if pixels != u64::try_from(rgba.len()).ok() {
        return Err(invalid("the pixel data doesn't match the screenshot size"));
    }
    Ok((png, rgba))
}

async fn copy_to_clipboard(
    app: &AppHandle,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard()
            .write_image(&Image::new_owned(rgba, width, height))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_screenshot(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ScreenshotSaved, CaptureError> {
    let meta: ScreenshotMeta = files::json_header(&request, CAPTURE_HEADER)
        .ok_or_else(|| CaptureError::Invalid("missing or invalid capture metadata".into()))?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(CaptureError::Invalid(
            "the capture body must be raw bytes".into(),
        ));
    };
    let (png, rgba) = split_capture(&meta, body)?;
    let name = file_name(&meta.name, ".png")?;
    let dir = capture_dir(&app, &meta.serial).await?;
    let path = files::reserve_unique(&dir, &name).await?;
    if let Err(e) = tokio::fs::write(&path, png).await {
        let _ = tokio::fs::remove_file(&path).await;
        tracing::warn!(serial = %meta.serial, path = %path.display(), "screenshot not saved: {e}");
        return Err(e.into());
    }
    let (copied, copy_error) =
        match copy_to_clipboard(&app, rgba.to_vec(), meta.width, meta.height).await {
            Ok(()) => (true, None),
            Err(e) => {
                tracing::warn!(serial = %meta.serial, "screenshot not copied: {e}");
                (false, Some(e))
            }
        };
    tracing::info!(serial = %meta.serial, path = %path.display(), copied, "screenshot saved");
    Ok(ScreenshotSaved {
        path: path.display().to_string(),
        copied,
        copy_error,
    })
}

pub enum Msg {
    Config(Bytes),
    Session {
        width: u16,
        height: u16,
    },
    Frame {
        key: bool,
        pts: u64,
        data: Bytes,
        at: Instant,
    },
}

pub enum Offer {
    Taken,
    Full,
    Gone,
}

#[derive(Default)]
pub struct Ending(Mutex<Option<(EndReason, Option<String>)>>);

impl Ending {
    fn set(&self, reason: EndReason, error: Option<String>) {
        let mut ending = lock(&self.0);
        if ending.is_none() {
            *ending = Some((reason, error));
        }
    }

    fn take(&self) -> Option<(EndReason, Option<String>)> {
        lock(&self.0).take()
    }
}

pub struct Recorder {
    tx: SyncSender<Msg>,
    ending: Arc<Ending>,
    done: oneshot::Receiver<RecordingEnded>,
}

struct Job {
    session_id: String,
    path: PathBuf,
    file: File,
    size: (u16, u16),
    config: Option<Bytes>,
}

impl Recorder {
    pub fn start(
        app: AppHandle,
        session: Arc<Session>,
        path: PathBuf,
        file: File,
        size: (u16, u16),
        config: Option<Bytes>,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(RECORD_QUEUE);
        let ending = Arc::new(Ending::default());
        let (done_tx, done) = oneshot::channel();
        let session_id = session.id.clone();
        let job = Job {
            session_id: session_id.clone(),
            path: path.clone(),
            file,
            size,
            config,
        };
        let writer = tauri::async_runtime::spawn_blocking({
            let ending = Arc::clone(&ending);
            move || record(job, &rx, &ending)
        });
        tauri::async_runtime::spawn({
            let ending = Arc::clone(&ending);
            async move {
                let ended = writer.await.unwrap_or_else(|e| {
                    tracing::error!(session = %session_id, "recording task died: {e}");
                    RecordingEnded {
                        session_id,
                        path: path.display().to_string(),
                        duration_ms: 0,
                        bytes: 0,
                        reason: EndReason::Failed,
                        error: Some("the recording task stopped unexpectedly".into()),
                    }
                });
                session.release_recorder(&ending);
                if let Err(e) = app.emit("recording-ended", ended.clone()) {
                    tracing::warn!("can't emit recording-ended: {e}");
                }
                let _ = done_tx.send(ended);
            }
        });
        Self { tx, ending, done }
    }

    pub fn offer(&self, msg: Msg) -> Offer {
        match self.tx.try_send(msg) {
            Ok(()) => Offer::Taken,
            Err(TrySendError::Full(_)) => Offer::Full,
            Err(TrySendError::Disconnected(_)) => Offer::Gone,
        }
    }

    pub fn is(&self, ending: &Arc<Ending>) -> bool {
        Arc::ptr_eq(&self.ending, ending)
    }

    pub fn finish(
        self,
        reason: EndReason,
        error: Option<String>,
    ) -> oneshot::Receiver<RecordingEnded> {
        self.ending.set(reason, error);
        self.done
    }
}

#[derive(PartialEq)]
struct Params {
    sps: Vec<u8>,
    pps: Vec<u8>,
}

fn parse_params(data: &[u8]) -> Option<Params> {
    let (mut sps, mut pps) = (None, None);
    for nal in mp4::annexb_nals(data) {
        match nal.first().map(|b| b & 0x1F) {
            Some(7) => sps = Some(nal.to_vec()),
            Some(8) => pps = Some(nal.to_vec()),
            _ => {}
        }
    }
    sps.filter(|s| s.len() >= 4)
        .zip(pps)
        .map(|(sps, pps)| Params { sps, pps })
}

enum Flow {
    Continue,
    End(EndReason),
}

struct Writer {
    file: Option<File>,
    size: (u16, u16),
    params: Option<Params>,
    pending: Vec<u8>,
    sample: Vec<u8>,
    mp4: Option<Mp4<BufWriter<File>>>,
}

impl Writer {
    fn config(&mut self, data: &[u8]) {
        let Some(params) = parse_params(data) else {
            return;
        };
        if self.params.as_ref() == Some(&params) {
            return;
        }
        // The sample entry keeps the first parameter sets; later ones travel in-band.
        if self.mp4.is_some() {
            self.pending.clear();
            mp4::length_prefixed(
                &[params.sps.as_slice(), params.pps.as_slice()],
                &mut self.pending,
            );
        }
        self.params = Some(params);
    }

    fn handle(&mut self, msg: Msg) -> io::Result<Flow> {
        match msg {
            Msg::Config(data) => self.config(&data),
            Msg::Session { width, height } => {
                if self.mp4.is_none() {
                    self.size = (width, height);
                } else if (width, height) != self.size {
                    return Ok(Flow::End(EndReason::SizeChanged));
                }
            }
            Msg::Frame { key, pts, data, at } => return self.frame(key, pts, &data, at),
        }
        Ok(Flow::Continue)
    }

    fn frame(&mut self, key: bool, pts: u64, data: &[u8], at: Instant) -> io::Result<Flow> {
        if self.mp4.is_none() && !key {
            return Ok(Flow::Continue);
        }
        let nals = mp4::annexb_nals(data);
        if nals.is_empty() {
            return Ok(Flow::Continue);
        }
        if self.mp4.is_none() {
            let (Some(params), Some(file)) = (&self.params, self.file.take()) else {
                return Ok(Flow::Continue);
            };
            let (width, height) = self.size;
            self.mp4 = Some(Mp4::new(
                BufWriter::new(file),
                width,
                height,
                &params.sps,
                &params.pps,
            )?);
        }
        let Some(mp4) = self.mp4.as_mut() else {
            return Ok(Flow::Continue);
        };
        self.sample.clear();
        if key {
            self.sample.append(&mut self.pending);
        }
        mp4::length_prefixed(&nals, &mut self.sample);
        if mp4.written() + self.sample.len() as u64 > MAX_BYTES {
            return Ok(Flow::End(EndReason::Limit));
        }
        mp4.push(&self.sample, key, pts, at)?;
        Ok(Flow::Continue)
    }

    fn finish(self) -> io::Result<Option<mp4::Finished>> {
        match self.mp4 {
            Some(mp4) if !mp4.is_empty() => mp4.finish().map(Some),
            _ => Ok(None),
        }
    }
}

fn record(job: Job, rx: &Receiver<Msg>, ending: &Ending) -> RecordingEnded {
    let Job {
        session_id,
        path,
        file,
        size,
        config,
    } = job;
    let mut writer = Writer {
        file: Some(file),
        size,
        params: None,
        pending: Vec::new(),
        sample: Vec::new(),
        mp4: None,
    };
    if let Some(config) = config {
        writer.config(&config);
    }
    let deadline = Instant::now() + MAX_DURATION;
    let (mut reason, mut error) = loop {
        let now = Instant::now();
        if now >= deadline {
            break (EndReason::Limit, None);
        }
        let msg = match rx.recv_timeout(deadline - now) {
            Ok(msg) => msg,
            Err(RecvTimeoutError::Timeout) => break (EndReason::Limit, None),
            Err(RecvTimeoutError::Disconnected) => {
                break ending.take().unwrap_or((EndReason::SessionEnded, None));
            }
        };
        match writer.handle(msg) {
            Ok(Flow::Continue) => {}
            Ok(Flow::End(reason)) => break (reason, None),
            Err(e) => break (EndReason::Failed, Some(e.to_string())),
        }
    };

    let (bytes, duration_ms) = match writer.finish() {
        Ok(Some(done)) => (done.bytes, done.duration_ms),
        Ok(None) => {
            let _ = std::fs::remove_file(&path);
            error.get_or_insert_with(|| "no video was recorded".into());
            (0, 0)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            reason = EndReason::Failed;
            error.get_or_insert_with(|| format!("couldn't finish the file: {e}"));
            (0, 0)
        }
    };
    match &error {
        Some(e) => {
            tracing::warn!(session = %session_id, ?reason, path = %path.display(), "recording ended: {e}")
        }
        None => {
            tracing::info!(session = %session_id, ?reason, duration_ms, bytes, path = %path.display(), "recording ended")
        }
    }
    RecordingEnded {
        session_id,
        path: path.display().to_string(),
        duration_ms,
        bytes,
        reason,
        error,
    }
}

async fn open_for_writing(path: &Path) -> io::Result<File> {
    let file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
    Ok(file.into_std().await)
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    hub: State<'_, Arc<MirrorHub>>,
    session_id: String,
    name: String,
) -> Result<String, CaptureError> {
    let session = hub
        .session(&session_id)
        .ok_or(CaptureError::UnknownSession)?;
    let name = file_name(&name, ".mp4")?;
    let dir = capture_dir(&app, &session.serial).await?;
    let path = files::reserve_unique(&dir, &name).await?;
    let file = match open_for_writing(&path).await {
        Ok(file) => file,
        Err(e) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(e.into());
        }
    };
    let started = session.begin_recording(|size, config| {
        Recorder::start(app, Arc::clone(&session), path.clone(), file, size, config)
    });
    if !started {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(CaptureError::AlreadyRecording);
    }
    session.request_reset(true);
    tracing::info!(session = %session_id, serial = %session.serial, path = %path.display(), "recording started");
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn stop_recording(
    hub: State<'_, Arc<MirrorHub>>,
    session_id: String,
) -> Result<RecordingEnded, CaptureError> {
    let session = hub
        .session(&session_id)
        .ok_or(CaptureError::UnknownSession)?;
    let done = session
        .end_recording(EndReason::Stopped, None)
        .ok_or(CaptureError::NotRecording)?;
    done.await.map_err(|_| CaptureError::Lost)
}
