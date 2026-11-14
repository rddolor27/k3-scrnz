mod catalog;
mod install;

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Serialize, Serializer};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::avd;
use crate::config::{ConfigError, ConfigStore};
use catalog::{Entry, Revision};

const CATALOG_ROOT: &str = "https://dl.google.com/android/repository/sys-img/";
const CATALOG_FILE: &str = "sys-img2-3.xml";
const SITES: [&str; 6] = [
    "android",
    "google_apis",
    "google_apis_playstore",
    "google_apis_tablet",
    "aosp_tablet",
    "google_playstore_tablet",
];
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(75);
const EMIT_EVERY: Duration = Duration::from_millis(500);
const MAX_XML_BYTES: u64 = 1024 * 1024;
const PROGRESS_EVENT: &str = "system-image-progress";

#[derive(Debug, thiserror::Error)]
pub enum SysImgError {
    #[error("no Android SDK found")]
    NoSdk,
    #[error("invalid system image id: {0:?}")]
    InvalidId(String),
    #[error("unknown system image: {0:?}")]
    UnknownImage(String),
    #[error("the {0} license hasn't been accepted")]
    LicenseNotAccepted(String),
    #[error("{0} is already being installed")]
    Busy(String),
    #[error("not enough free disk space: {} needed, {} free", gib(*.needed), gib(*.available))]
    NoSpace { needed: u64, available: u64 },
    #[error("curl.exe wasn't found, so nothing can be downloaded")]
    NoCurl,
    #[error("download failed: {0}")]
    Network(String),
    #[error("the download is {actual} bytes, expected {expected}")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error("the download's SHA-1 doesn't match the catalog")]
    Checksum,
    #[error("invalid system image archive: {0}")]
    Archive(String),
    #[error("{0} is not installed")]
    NotInstalled(String),
    #[error("{id} is used by {avds}; delete {avds} first")]
    InUse { id: String, avds: String },
    #[error("refusing to delete {0}: not a plain folder inside the SDK's system-images")]
    Unsafe(String),
    #[error("can't replace the installed image ({0}); is an emulator using it?")]
    Replace(std::io::Error),
    #[error("installation cancelled")]
    Cancelled,
    #[error("system image: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("system image task failed: {0}")]
    Task(String),
}

impl Serialize for SysImgError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImage {
    pub id: String,
    pub api_level: u32,
    pub api_minor: Option<u32>,
    pub extension_level: Option<u32>,
    pub tag: String,
    pub tag_display: String,
    pub abi: String,
    pub play_store: bool,
    pub revision: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub license_id: String,
    pub min_emulator: Option<String>,
    pub emulator_too_old: bool,
    pub installed: bool,
    pub installed_revision: Option<String>,
    pub update_available: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct License {
    pub id: String,
    pub text: String,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct RemoteCatalog {
    pub images: Vec<RemoteImage>,
    pub licenses: Vec<License>,
    pub errors: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Downloading,
    Verifying,
    Extracting,
    Installing,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct InstallProgress {
    pub id: String,
    pub phase: Phase,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}

struct Fetched {
    entries: Vec<Entry>,
    licenses: Vec<(String, String)>,
    errors: Vec<String>,
}

impl Fetched {
    fn license(&self, id: &str) -> Option<&str> {
        self.licenses
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, text)| text.as_str())
    }
}

struct Cached {
    at: Instant,
    data: Arc<Fetched>,
}

struct Running {
    run: u64,
    progress: InstallProgress,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Inner {
    cache: Mutex<Option<Cached>>,
    install: Mutex<Option<Running>>,
    runs: AtomicU64,
}

#[derive(Default)]
pub struct SysImgState {
    inner: Arc<Inner>,
}

struct Guard {
    inner: Arc<Inner>,
    run: u64,
}

impl Drop for Guard {
    fn drop(&mut self) {
        let mut slot = lock(&self.inner.install);
        if slot.as_ref().is_some_and(|running| running.run == self.run) {
            *slot = None;
        }
    }
}

struct Pace {
    phase: Option<Phase>,
    at: Instant,
}

#[derive(Clone)]
pub struct Reporter {
    app: AppHandle,
    inner: Arc<Inner>,
    run: u64,
    id: String,
    cancel: CancellationToken,
    pace: Arc<Mutex<Pace>>,
}

impl Reporter {
    pub fn report(&self, phase: Phase, received: u64, total: u64) {
        let progress = InstallProgress {
            id: self.id.clone(),
            phase,
            received,
            total,
            error: None,
        };
        let due = {
            let mut pace = lock(&self.pace);
            let due = pace.phase != Some(phase)
                || pace.at.elapsed() >= EMIT_EVERY
                || (total > 0 && received >= total);
            if due {
                pace.phase = Some(phase);
                pace.at = Instant::now();
            }
            due
        };
        if let Some(running) = lock(&self.inner.install)
            .as_mut()
            .filter(|running| running.run == self.run)
        {
            running.progress = progress.clone();
        }
        if due {
            self.emit(&progress);
        }
    }

    pub fn check(&self) -> Result<(), SysImgError> {
        if self.cancel.is_cancelled() {
            return Err(SysImgError::Cancelled);
        }
        Ok(())
    }

    pub async fn cancelled(&self) {
        self.cancel.cancelled().await;
    }

    fn finish(&self, phase: Phase, error: Option<String>) {
        let last = {
            let mut slot = lock(&self.inner.install);
            if slot.as_ref().is_some_and(|running| running.run == self.run) {
                slot.take().map(|running| running.progress)
            } else {
                None
            }
        };
        let mut progress = last.unwrap_or_else(|| InstallProgress {
            id: self.id.clone(),
            phase,
            received: 0,
            total: 0,
            error: None,
        });
        progress.phase = phase;
        progress.error = error;
        self.emit(&progress);
    }

    fn emit(&self, progress: &InstallProgress) {
        if let Err(e) = self.app.emit(PROGRESS_EVENT, progress) {
            tracing::warn!(error = %e, "can't send the system image progress");
        }
    }
}

impl SysImgState {
    async fn catalog(&self, refresh: bool) -> Arc<Fetched> {
        if !refresh
            && let Some(cached) = lock(&self.inner.cache)
                .as_ref()
                .filter(|cached| cached.at.elapsed() < CACHE_TTL)
        {
            return Arc::clone(&cached.data);
        }
        let fetched = Arc::new(fetch_all().await);
        if fetched.errors.is_empty() {
            *lock(&self.inner.cache) = Some(Cached {
                at: Instant::now(),
                data: Arc::clone(&fetched),
            });
        }
        fetched
    }

    fn begin(
        &self,
        app: &AppHandle,
        id: &str,
        size: u64,
    ) -> Result<(Guard, Reporter), SysImgError> {
        let mut slot = lock(&self.inner.install);
        if let Some(running) = slot.as_ref() {
            return Err(SysImgError::Busy(running.progress.id.clone()));
        }
        let run = self.inner.runs.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        *slot = Some(Running {
            run,
            progress: InstallProgress {
                id: id.to_owned(),
                phase: Phase::Downloading,
                received: 0,
                total: size,
                error: None,
            },
            cancel: cancel.clone(),
        });
        drop(slot);
        let guard = Guard {
            inner: Arc::clone(&self.inner),
            run,
        };
        let reporter = Reporter {
            app: app.clone(),
            inner: Arc::clone(&self.inner),
            run,
            id: id.to_owned(),
            cancel,
            pace: Arc::new(Mutex::new(Pace {
                phase: None,
                at: Instant::now(),
            })),
        };
        Ok((guard, reporter))
    }
}

pub(super) async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, SysImgError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| SysImgError::Task(e.to_string()))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha1_hex(data: &[u8]) -> String {
    hex(&Sha1::digest(data))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn host_abi() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Some("x86_64"),
        "aarch64" => Some("arm64-v8a"),
        _ => None,
    }
}

async fn fetch_text(url: &str) -> Result<String, SysImgError> {
    let mut command = install::curl(&[
        "-fsSL",
        "--max-time",
        "60",
        "--connect-timeout",
        "20",
        "--proto",
        "=https",
        "--max-filesize",
        "33554432",
    ])
    .await;
    let output = tokio::time::timeout(CATALOG_TIMEOUT, command.arg(url).output())
        .await
        .map_err(|_| SysImgError::Network("no answer".into()))?
        .map_err(install::spawn_error)?;
    if !output.status.success() {
        return Err(SysImgError::Network(install::curl_message(
            output.status,
            &output.stderr,
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn fetch_all() -> Fetched {
    let mut fetched = Fetched {
        entries: Vec::new(),
        licenses: Vec::new(),
        errors: Vec::new(),
    };
    let Some(abi) = host_abi() else {
        fetched.errors.push(format!(
            "no emulator system images run on this CPU ({})",
            std::env::consts::ARCH
        ));
        return fetched;
    };
    let results = futures_util::future::join_all(SITES.map(|site| async move {
        let base = format!("{CATALOG_ROOT}{site}/");
        let xml = fetch_text(&format!("{base}{CATALOG_FILE}")).await;
        (site, base, xml)
    }))
    .await;
    let mut position: HashMap<String, usize> = HashMap::new();
    for (site, base, xml) in results {
        let xml = match xml {
            Ok(xml) if xml.contains("<remotePackage") => xml,
            Ok(_) => {
                tracing::warn!(site, "the response is not a system image catalog");
                fetched
                    .errors
                    .push(format!("{site}: not a system image catalog"));
                continue;
            }
            Err(e) => {
                tracing::warn!(site, error = %e, "can't fetch a system image catalog");
                fetched.errors.push(format!("{site}: {e}"));
                continue;
            }
        };
        let parsed = catalog::parse(&xml, &base, abi);
        tracing::debug!(
            site,
            images = parsed.entries.len(),
            "system image catalog read"
        );
        for (id, text) in parsed.licenses {
            if fetched.license(&id).is_none() {
                fetched.licenses.push((id, text));
            }
        }
        for entry in parsed.entries {
            match position.get(&entry.id.to_ascii_lowercase()) {
                Some(&at) => {
                    if entry.revision.key() > fetched.entries[at].revision.key() {
                        fetched.entries[at] = entry;
                    }
                }
                None => {
                    position.insert(entry.id.to_ascii_lowercase(), fetched.entries.len());
                    fetched.entries.push(entry);
                }
            }
        }
    }
    fetched.entries.sort_by(|a, b| {
        b.api_level
            .cmp(&a.api_level)
            .then_with(|| b.api_minor.cmp(&a.api_minor))
            .then_with(|| b.extension_level.cmp(&a.extension_level))
            .then_with(|| a.id.cmp(&b.id))
    });
    tracing::info!(
        images = fetched.entries.len(),
        errors = fetched.errors.len(),
        "system image catalogs fetched"
    );
    fetched
}

#[derive(Default)]
struct Local {
    installed: HashMap<String, Option<Revision>>,
    emulator: Option<Revision>,
}

fn read_capped(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_XML_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn package_revision(dir: &Path) -> Option<Revision> {
    read_capped(&dir.join("package.xml"))
        .and_then(|xml| catalog::local_revision(&xml))
        .or_else(|| {
            avd::read_ini(&dir.join("source.properties"))
                .and_then(|props| Revision::parse(props.get("Pkg.Revision")?))
        })
}

fn read_local() -> Local {
    let Some(root) = avd::sdk_root() else {
        return Local::default();
    };
    let base = root.join("system-images");
    let installed = avd::scan_images(&root)
        .into_iter()
        .map(|found| {
            let dir = found
                .folders
                .iter()
                .fold(base.clone(), |dir, folder| dir.join(folder));
            (found.image.id.to_ascii_lowercase(), package_revision(&dir))
        })
        .collect();
    Local {
        installed,
        emulator: package_revision(&root.join("emulator")),
    }
}

fn install_root() -> Option<PathBuf> {
    avd::sdk_root().or_else(|| {
        crate::adb::sdk_roots()
            .find(|root| root.join("emulator").is_dir() || root.join("platform-tools").is_dir())
    })
}

fn assemble(fetched: &Fetched, local: &Local, accepted: &HashSet<String>) -> RemoteCatalog {
    let mut licenses: Vec<License> = Vec::new();
    let images = fetched
        .entries
        .iter()
        .map(|entry| {
            if !licenses
                .iter()
                .any(|license| license.id == entry.license_id)
                && let Some(text) = fetched.license(&entry.license_id)
            {
                licenses.push(License {
                    id: entry.license_id.clone(),
                    text: text.to_owned(),
                    accepted: accepted.contains(&sha1_hex(text.as_bytes())),
                });
            }
            let local_entry = local.installed.get(&entry.id.to_ascii_lowercase());
            let installed_revision = local_entry.copied().flatten();
            RemoteImage {
                id: entry.id.clone(),
                api_level: entry.api_level,
                api_minor: entry.api_minor,
                extension_level: entry.extension_level,
                tag: entry
                    .tags
                    .iter()
                    .map(|(id, _)| id.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
                tag_display: entry
                    .tags
                    .iter()
                    .map(|(_, display)| display.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                abi: entry.abi.clone(),
                play_store: entry.tags.iter().any(|(id, _)| id.contains("playstore")),
                revision: entry.revision.to_string(),
                display_name: entry.display_name.clone(),
                size_bytes: entry.size,
                license_id: entry.license_id.clone(),
                min_emulator: entry.min_emulator.map(|revision| revision.to_string()),
                emulator_too_old: entry
                    .min_emulator
                    .zip(local.emulator)
                    .is_some_and(|(needed, have)| have.key() < needed.key()),
                installed: local_entry.is_some(),
                installed_revision: installed_revision.map(|revision| revision.to_string()),
                update_available: installed_revision
                    .is_some_and(|have| entry.revision.key() > have.key()),
            }
        })
        .collect();
    RemoteCatalog {
        images,
        licenses,
        errors: fetched.errors.clone(),
    }
}

#[tauri::command]
pub async fn list_remote_images(
    state: State<'_, SysImgState>,
    config: State<'_, Arc<ConfigStore>>,
    refresh: bool,
) -> Result<RemoteCatalog, SysImgError> {
    let fetched = state.catalog(refresh).await;
    let local = blocking(read_local).await?;
    Ok(assemble(&fetched, &local, &config.accepted_licenses()))
}

#[tauri::command]
pub async fn install_system_image(
    app: AppHandle,
    state: State<'_, SysImgState>,
    config: State<'_, Arc<ConfigStore>>,
    id: String,
    accept_license: bool,
) -> Result<(), SysImgError> {
    let fetched = state.catalog(false).await;
    let entry = fetched
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .cloned()
        .ok_or_else(|| SysImgError::UnknownImage(id.clone()))?;
    let license = fetched
        .license(&entry.license_id)
        .map(str::to_owned)
        .ok_or_else(|| SysImgError::UnknownImage(id.clone()))?;
    let hash = sha1_hex(license.as_bytes());
    if !config.accepted_licenses().contains(&hash) {
        if !accept_license {
            return Err(SysImgError::LicenseNotAccepted(entry.license_id));
        }
        config.accept_license(hash).await?;
        tracing::info!(license = %entry.license_id, "SDK license accepted");
    }
    let root = blocking(install_root).await?.ok_or(SysImgError::NoSdk)?;
    let [platform, tag, abi] = &entry.folders;
    let target = root
        .join("system-images")
        .join(platform)
        .join(tag)
        .join(abi);
    let (_guard, reporter) = state.begin(&app, &entry.id, entry.size)?;
    tracing::info!(id = %entry.id, size = entry.size, url = %entry.url, "system image install started");
    let job = install::Job {
        entry,
        license,
        root,
        target,
    };
    let result = install::run(&job, &reporter).await;
    install::cleanup(&job).await;
    match result {
        Ok(()) => {
            tracing::info!(id = %job.entry.id, path = %job.target.display(), "system image installed");
            reporter.finish(Phase::Done, None);
            Ok(())
        }
        // A cancel rejects too: the event and the command reply can reach the webview in either order.
        Err(SysImgError::Cancelled) => {
            tracing::info!(id = %job.entry.id, "system image install cancelled");
            reporter.finish(Phase::Cancelled, None);
            Err(SysImgError::Cancelled)
        }
        Err(e) => {
            tracing::warn!(id = %job.entry.id, error = %e, "system image install failed");
            reporter.finish(Phase::Failed, Some(e.to_string()));
            Err(e)
        }
    }
}

#[tauri::command]
pub fn cancel_system_image_install(state: State<'_, SysImgState>) {
    if let Some(running) = lock(&state.inner.install).as_ref() {
        tracing::info!(id = %running.progress.id, "system image install cancel requested");
        running.cancel.cancel();
    }
}

#[tauri::command]
pub fn get_system_image_install(state: State<'_, SysImgState>) -> Option<InstallProgress> {
    lock(&state.inner.install)
        .as_ref()
        .map(|running| running.progress.clone())
}

#[tauri::command]
pub async fn uninstall_system_image(
    state: State<'_, SysImgState>,
    id: String,
) -> Result<(), SysImgError> {
    if catalog::parse_id(&id).is_none() {
        return Err(SysImgError::InvalidId(id));
    }
    let running = lock(&state.inner.install)
        .as_ref()
        .map(|running| running.progress.id.clone());
    if running.is_some_and(|running| running.eq_ignore_ascii_case(&id)) {
        return Err(SysImgError::Busy(id));
    }
    blocking(move || install::uninstall(&id)).await?
}
