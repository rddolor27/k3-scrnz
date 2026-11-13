mod mp4;

use std::collections::HashMap;
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
use crate::mirror::MirrorHub;
use crate::scrcpy::video::{K_CONFIG, K_FRAME};

const CAPTURE_HEADER: &str = "x-tri-capture";
const MAX_DIMENSION: u32 = 8192;
const RECORD_QUEUE: usize = 600;
const GRID_MIN: u16 = 16;
const GRID_MAX: u16 = 4096;
const GRID_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ENVELOPE: usize = 12;
const MAX_DURATION: Duration = Duration::from_secs(30 * 60);
// Offsets and the mdat size are 32-bit, so the file must stay under 4 GiB with the moov.
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("{0}")]
    Invalid(String),
    #[error("no such session")]
    UnknownSession,
    #[error("no such recording")]
    UnknownRecording,
    #[error("this recording is already connected")]
    AlreadyAttached,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRecording {
    id: String,
    path: String,
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

impl Msg {
    // [kind u8][flags u8, bit 0 = key][2 zero bytes][pts u64 BE, µs] + Annex B payload
    pub fn from_envelope(data: &Bytes) -> Option<Self> {
        let (head, _) = data.split_first_chunk::<ENVELOPE>()?;
        let [kind, flags, _, _, p0, p1, p2, p3, p4, p5, p6, p7] = *head;
        let payload = data.slice(ENVELOPE..);
        match kind {
            K_CONFIG => Some(Self::Config(payload)),
            K_FRAME => Some(Self::Frame {
                key: flags & 1 != 0,
                pts: u64::from_be_bytes([p0, p1, p2, p3, p4, p5, p6, p7]),
                data: payload,
                at: Instant::now(),
            }),
            _ => None,
        }
    }
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
        session_id: String,
        release: impl FnOnce(&Arc<Ending>) + Send + 'static,
        path: PathBuf,
        file: File,
        size: (u16, u16),
        config: Option<Bytes>,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(RECORD_QUEUE);
        let ending = Arc::new(Ending::default());
        let (done_tx, done) = oneshot::channel();
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
                release(&ending);
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
        // Access unit delimiters (type 9) don't belong in MP4 samples; some players choke on them.
        let nals: Vec<&[u8]> = mp4::annexb_nals(data)
            .into_iter()
            .filter(|nal| nal.first().is_some_and(|b| b & 0x1F != 9))
            .collect();
        if nals.is_empty() {
            return Ok(Flow::Continue);
        }
        if self.mp4.is_none() {
            // A WebCodecs stream has no config packet; its key frames carry SPS/PPS in-band.
            if self.params.is_none() {
                self.params = parse_params(data);
            }
            let Some(params) = &self.params else {
                return Ok(Flow::Continue);
            };
            let Some(file) = self.file.take() else {
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
        let owner = Arc::clone(&session);
        Recorder::start(
            app,
            session_id.clone(),
            move |ending| owner.release_recorder(ending),
            path.clone(),
            file,
            size,
            config,
        )
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

struct Grid {
    recorder: Recorder,
    attached: bool,
}

#[derive(Clone, Default)]
pub struct GridRecordings(Arc<Mutex<HashMap<String, Grid>>>);

impl GridRecordings {
    fn release(&self, id: &str, ending: &Arc<Ending>) {
        let mut grids = lock(&self.0);
        if grids.get(id).is_some_and(|g| g.recorder.is(ending)) {
            grids.remove(id);
        }
    }

    fn expire(&self, id: &str) {
        let mut grids = lock(&self.0);
        if grids.get(id).is_some_and(|g| !g.attached)
            && let Some(grid) = grids.remove(id)
        {
            tracing::warn!(session = %id, "the grid recorder never connected");
            grid.recorder.finish(
                EndReason::Failed,
                Some("the grid recorder never connected".into()),
            );
        }
    }

    pub fn attach(&self, id: &str) -> Result<(), CaptureError> {
        let mut grids = lock(&self.0);
        let grid = grids.get_mut(id).ok_or(CaptureError::UnknownRecording)?;
        if std::mem::replace(&mut grid.attached, true) {
            return Err(CaptureError::AlreadyAttached);
        }
        Ok(())
    }

    pub fn feed(&self, id: &str, msg: Msg) -> bool {
        let mut grids = lock(&self.0);
        let Some(grid) = grids.get(id) else {
            return false;
        };
        match grid.recorder.offer(msg) {
            Offer::Taken => true,
            Offer::Full => {
                tracing::warn!(session = %id, "grid recording queue full; ending the recording");
                if let Some(grid) = grids.remove(id) {
                    grid.recorder
                        .finish(EndReason::Failed, Some("the disk can't keep up".into()));
                }
                false
            }
            Offer::Gone => {
                grids.remove(id);
                false
            }
        }
    }

    pub fn finish(
        &self,
        id: &str,
        reason: EndReason,
        error: Option<String>,
    ) -> Option<oneshot::Receiver<RecordingEnded>> {
        let grid = lock(&self.0).remove(id)?;
        Some(grid.recorder.finish(reason, error))
    }

    pub fn end_all(&self) -> Vec<oneshot::Receiver<RecordingEnded>> {
        let grids: Vec<Grid> = lock(&self.0).drain().map(|(_, grid)| grid).collect();
        grids
            .into_iter()
            .map(|grid| grid.recorder.finish(EndReason::SessionEnded, None))
            .collect()
    }
}

fn grid_size(width: u32, height: u32) -> Result<(u16, u16), CaptureError> {
    let dimension = |n: u32| {
        u16::try_from(n)
            .ok()
            .filter(|n| (GRID_MIN..=GRID_MAX).contains(n) && n % 2 == 0)
    };
    match (dimension(width), dimension(height)) {
        (Some(width), Some(height)) => Ok((width, height)),
        _ => Err(CaptureError::Invalid(format!(
            "the grid size must be even and between {GRID_MIN} and {GRID_MAX}"
        ))),
    }
}

#[tauri::command]
pub async fn start_grid_recording(
    app: AppHandle,
    grids: State<'_, GridRecordings>,
    name: String,
    width: u32,
    height: u32,
) -> Result<GridRecording, CaptureError> {
    let size = grid_size(width, height)?;
    let name = file_name(&name, ".mp4")?;
    let dir = files::downloads_root(&app)?;
    tokio::fs::create_dir_all(&dir).await?;
    let path = files::reserve_unique(&dir, &name).await?;
    let file = match open_for_writing(&path).await {
        Ok(file) => file,
        Err(e) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(e.into());
        }
    };
    let id = format!("grid-{:016x}", rand::random::<u64>());
    let registry = grids.inner().clone();
    let recorder = Recorder::start(
        app,
        id.clone(),
        {
            let registry = registry.clone();
            let id = id.clone();
            move |ending| registry.release(&id, ending)
        },
        path.clone(),
        file,
        size,
        None,
    );
    lock(&registry.0).insert(
        id.clone(),
        Grid {
            recorder,
            attached: false,
        },
    );
    tauri::async_runtime::spawn({
        let id = id.clone();
        async move {
            tokio::time::sleep(GRID_CONNECT_TIMEOUT).await;
            registry.expire(&id);
        }
    });
    tracing::info!(session = %id, path = %path.display(), width, height, "grid recording started");
    Ok(GridRecording {
        id,
        path: path.display().to_string(),
    })
}

#[tauri::command]
pub async fn stop_grid_recording(
    grids: State<'_, GridRecordings>,
    id: String,
) -> Result<RecordingEnded, CaptureError> {
    let done = grids
        .finish(&id, EndReason::Stopped, None)
        .ok_or(CaptureError::UnknownRecording)?;
    done.await.map_err(|_| CaptureError::Lost)
}
