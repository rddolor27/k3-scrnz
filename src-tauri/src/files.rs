use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
use thiserror::Error;
use tokio::io::AsyncWriteExt;

use crate::adb::{self, AdbError, AdbServer, DeviceSel, MODE_FILE_0644, ShellEvent, shell_quote};

const UPLOAD_HEADER: &str = "x-k3-upload";
const MAX_UPLOAD: u64 = 256 * 1024 * 1024;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

const PROTECTED: &[&str] = &[
    "/sdcard/Android",
    "/storage/emulated",
    "/storage/emulated/0",
    "/storage/emulated/0/Android",
    "/storage/self",
    "/storage/self/primary",
    "/mnt/sdcard",
    "/data/local/tmp",
];

#[derive(Debug, Error)]
pub enum FilesError {
    #[error("invalid device path: {0}")]
    InvalidPath(String),
    #[error("invalid package name: {0}")]
    InvalidPackage(String),
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Device(String),
    #[error("the device did not respond in time")]
    Timeout,
    #[error(transparent)]
    Adb(#[from] AdbError),
    #[error("local file: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    App(String),
}

impl Serialize for FilesError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Dir,
    File,
    Link,
    Other,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified: i64,
    pub mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub error: Option<String>,
}

async fn within<T>(
    limit: Duration,
    work: impl Future<Output = Result<T, FilesError>>,
) -> Result<T, FilesError> {
    tokio::time::timeout(limit, work)
        .await
        .map_err(|_| FilesError::Timeout)?
}

struct Target {
    sel: DeviceSel,
    run_as: Option<String>,
}

impl Target {
    fn new(serial: String, run_as: Option<String>) -> Result<Self, FilesError> {
        let run_as = run_as
            .filter(|p| !p.is_empty())
            .map(validate_package)
            .transpose()?;
        Ok(Self {
            sel: DeviceSel::Serial(serial),
            run_as,
        })
    }

    fn command(&self, cmd: &str) -> String {
        match &self.run_as {
            Some(package) => format!("run-as {package} {cmd}"),
            None => cmd.to_owned(),
        }
    }

    async fn run(&self, cmd: &str) -> Result<adb::ShellOutput, FilesError> {
        Ok(adb::shell(&AdbServer::default(), &self.sel, &self.command(cmd)).await?)
    }

    async fn run_ok(&self, cmd: &str) -> Result<adb::ShellOutput, FilesError> {
        let out = within(COMMAND_TIMEOUT, self.run(cmd)).await?;
        match out.exit_code {
            Some(0) => Ok(out),
            Some(_) => Err(FilesError::Device(output_text(&out.stderr, &out.stdout))),
            None => Err(FilesError::Device("the device disconnected".into())),
        }
    }
}

pub(crate) fn output_text(stderr: &[u8], stdout: &[u8]) -> String {
    let text = if stderr.is_empty() { stdout } else { stderr };
    let text = String::from_utf8_lossy(text).trim().to_owned();
    if text.is_empty() {
        "the device command failed".into()
    } else {
        text
    }
}

pub(crate) fn validate_package(package: String) -> Result<String, FilesError> {
    let valid = package.len() <= 255
        && package.contains('.')
        && !package.starts_with('.')
        && !package.ends_with('.')
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if valid {
        Ok(package)
    } else {
        Err(FilesError::InvalidPackage(package))
    }
}

fn normalize_path(path: &str) -> Result<String, FilesError> {
    if !path.starts_with('/') || path.contains(['\0', '\n', '\r']) {
        return Err(FilesError::InvalidPath(path.to_owned()));
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(FilesError::InvalidPath(path.to_owned())),
            part => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn join(dir: &str, name: &str) -> Result<String, FilesError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0', '\n', '\r']) {
        return Err(FilesError::InvalidPath(name.to_owned()));
    }
    let dir = normalize_path(dir)?;
    Ok(if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    })
}

/// Records start with a random per-request marker, so a file name containing a
/// newline can't forge entries.
fn parse_listing(stdout: &str, marker: &str) -> Vec<FileEntry> {
    let mut entries: Vec<FileEntry> = stdout
        .split(marker)
        .filter_map(|record| {
            let record = record.strip_suffix('\n').unwrap_or(record);
            let mut fields = record.splitn(4, ' ');
            let mode = u32::from_str_radix(fields.next()?, 16).ok()?;
            let size = fields.next()?.parse().ok()?;
            let modified = fields.next()?.parse().ok()?;
            let name = fields.next()?.rsplit('/').next()?;
            if name.is_empty() {
                return None;
            }
            Some(FileEntry {
                name: name.to_owned(),
                kind: match mode & 0o170_000 {
                    0o040_000 => FileKind::Dir,
                    0o100_000 => FileKind::File,
                    0o120_000 => FileKind::Link,
                    _ => FileKind::Other,
                },
                size,
                modified,
                mode: mode_string(mode),
            })
        })
        .collect();
    entries.sort_by_cached_key(|e| (e.kind != FileKind::Dir, e.name.to_lowercase()));
    entries
}

fn mode_string(mode: u32) -> String {
    let kind = match mode & 0o170_000 {
        0o040_000 => 'd',
        0o120_000 => 'l',
        0o100_000 => '-',
        0o020_000 => 'c',
        0o060_000 => 'b',
        0o010_000 => 'p',
        0o140_000 => 's',
        _ => '?',
    };
    let mut text = String::with_capacity(10);
    text.push(kind);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 0o7;
        text.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        text.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        text.push(if bits & 0o1 != 0 { 'x' } else { '-' });
    }
    text
}

/// `invoice<U+202E>fdp.exe` shows as a PDF in Explorer.
fn is_format_char(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{FEFF}'
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{2069}')
}

pub(crate) fn local_name(name: &str) -> String {
    let mut clean: String = name
        .chars()
        .map(|c| {
            if c.is_control()
                || is_format_char(c)
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    while clean.ends_with(['.', ' ']) {
        clean.pop();
    }
    let stem = clean
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.chars().count() == 4
        && stem.ends_with(|c: char| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³')));
    if clean.is_empty() || reserved {
        clean.insert(0, '_');
    }
    clean
}

pub(crate) fn downloads_root(app: &AppHandle) -> Result<PathBuf, FilesError> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| FilesError::App(format!("no Downloads folder: {e}")))?;
    Ok(dir.join("k3-scrnz"))
}

pub(crate) async fn reserve_unique(dir: &Path, name: &str) -> Result<PathBuf, FilesError> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    for n in 0..1000 {
        let candidate = if n == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({n}){ext}"))
        };
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(FilesError::Refused(format!(
        "too many copies of {name} in {}",
        dir.display()
    )))
}

#[tauri::command]
pub async fn list_dir(
    serial: String,
    path: String,
    run_as: Option<String>,
) -> Result<Listing, FilesError> {
    let target = Target::new(serial, run_as)?;
    let path = normalize_path(&path)?;
    // The trailing slash makes find follow a symlinked directory such as /sdcard.
    let dir_arg = if path == "/" {
        "/".to_owned()
    } else {
        format!("{path}/")
    };
    let marker = format!("@k3:{:016x}@", rand::random::<u64>());
    let cmd = format!(
        "find {} -mindepth 1 -maxdepth 1 -exec stat -c {} {{}} +",
        shell_quote(&dir_arg),
        shell_quote(&format!("{marker}%f %s %Y %n"))
    );
    let out = within(LIST_TIMEOUT, target.run(&cmd)).await?;
    let entries = parse_listing(&String::from_utf8_lossy(&out.stdout), &marker);
    let error = match out.exit_code {
        Some(0) => None,
        Some(_) => Some(
            output_text(&out.stderr, b"")
                .lines()
                .next()
                .unwrap_or("listing failed")
                .to_owned(),
        ),
        None => Some("the device disconnected".into()),
    };
    Ok(Listing {
        path,
        entries,
        error,
    })
}

#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    serial: String,
    path: String,
    run_as: Option<String>,
) -> Result<String, FilesError> {
    let target = Target::new(serial.clone(), run_as)?;
    let path = normalize_path(&path)?;
    let name = path.rsplit('/').next().unwrap_or_default();
    if name.is_empty() {
        return Err(FilesError::InvalidPath(path));
    }
    let dir = downloads_root(&app)?.join(local_name(&serial));
    tokio::fs::create_dir_all(&dir).await?;
    let local = reserve_unique(&dir, &local_name(name)).await?;
    let part = PathBuf::from(format!("{}.part", local.display()));

    let result = download_into(&target, &path, &part).await;
    match result {
        Ok(()) => {
            tokio::fs::rename(&part, &local).await?;
            tracing::info!(%serial, %path, local = %local.display(), "downloaded");
            Ok(local.display().to_string())
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = tokio::fs::remove_file(&local).await;
            tracing::warn!(%serial, %path, "download failed: {e}");
            Err(e)
        }
    }
}

async fn download_into(target: &Target, path: &str, part: &Path) -> Result<(), FilesError> {
    let mut file = tokio::fs::File::create(part).await?;
    let result = match &target.run_as {
        None => adb::pull(&AdbServer::default(), &target.sel, path, &mut file)
            .await
            .map(|_| ())
            .map_err(FilesError::from),
        Some(_) => pull_with_run_as(target, path, &mut file).await,
    };
    let flushed = file.flush().await;
    result?;
    flushed?;
    Ok(())
}

async fn pull_with_run_as(
    target: &Target,
    path: &str,
    file: &mut tokio::fs::File,
) -> Result<(), FilesError> {
    let cmd = target.command(&format!("cat {}", shell_quote(path)));
    let mut process = adb::shell_spawn(&AdbServer::default(), &target.sel, &cmd).await?;
    let mut stderr = Vec::new();
    loop {
        let event = tokio::time::timeout(IDLE_TIMEOUT, process.next_event())
            .await
            .map_err(|_| FilesError::Timeout)??;
        match event {
            Some(ShellEvent::Stdout(data)) => file.write_all(&data).await?,
            Some(ShellEvent::Stderr(data)) => stderr.extend_from_slice(&data),
            Some(ShellEvent::Exit(0)) => return Ok(()),
            Some(ShellEvent::Exit(_)) => return Err(FilesError::Device(output_text(&stderr, b""))),
            None => return Err(FilesError::Device("the device disconnected".into())),
        }
    }
}

async fn upload(
    target: &Target,
    dir: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String, FilesError> {
    let remote = join(dir, name)?;
    let server = AdbServer::default();
    match &target.run_as {
        None => adb::push(&server, &target.sel, bytes, &remote, MODE_FILE_0644).await?,
        Some(_) => {
            // `cp file <existing dir>` would copy under the staging name.
            if within(
                COMMAND_TIMEOUT,
                target.run(&format!("test -d {}", shell_quote(&remote))),
            )
            .await?
            .exit_code
                == Some(0)
            {
                return Err(FilesError::Refused(format!(
                    "{remote} is a folder; rename the file or delete the folder first"
                )));
            }
            let staging = format!(
                "/data/local/tmp/k3-scrnz-upload-{:016x}",
                rand::random::<u64>()
            );
            let copied =
                match adb::push(&server, &target.sel, bytes, &staging, MODE_FILE_0644).await {
                    Ok(()) => {
                        target
                            .run_ok(&format!(
                                "cp {} {}",
                                shell_quote(&staging),
                                shell_quote(&remote)
                            ))
                            .await
                    }
                    Err(e) => Err(e.into()),
                };
            // Cleanup as the shell user, who owns the staging file.
            let cleanup = adb::shell(
                &server,
                &target.sel,
                &format!("rm -f {}", shell_quote(&staging)),
            )
            .await;
            if !matches!(cleanup, Ok(ref out) if out.exit_code == Some(0)) {
                tracing::warn!(%staging, "could not remove the upload staging file");
            }
            copied?;
        }
    }
    tracing::info!(%remote, bytes = bytes.len(), run_as = ?target.run_as, "uploaded");
    Ok(remote)
}

fn check_upload_size(len: u64, name: &str) -> Result<(), FilesError> {
    if len > MAX_UPLOAD {
        return Err(FilesError::Refused(format!(
            "{name} is larger than {} MiB; push it with adb instead",
            MAX_UPLOAD / (1024 * 1024)
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn upload_path(
    serial: String,
    local_path: String,
    remote_dir: String,
    run_as: Option<String>,
) -> Result<String, FilesError> {
    let target = Target::new(serial, run_as)?;
    let local = PathBuf::from(&local_path);
    let meta = tokio::fs::metadata(&local).await?;
    if !meta.is_file() {
        return Err(FilesError::Refused(format!(
            "{local_path} is a folder; only files can be uploaded"
        )));
    }
    check_upload_size(meta.len(), &local_path)?;
    let name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FilesError::InvalidPath(local_path.clone()))?
        .to_owned();
    let bytes = tokio::fs::read(&local).await?;
    upload(&target, &remote_dir, &name, &bytes).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadMeta {
    serial: String,
    dir: String,
    name: String,
    run_as: Option<String>,
}

/// `x-k3-upload` is hex-encoded JSON: headers must be ASCII and names may not be.
#[tauri::command]
pub async fn upload_bytes(request: Request<'_>) -> Result<String, FilesError> {
    let meta = request
        .headers()
        .get(UPLOAD_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| FilesError::Refused("missing upload metadata".into()))?;
    let meta: UploadMeta = hex_decode(meta)
        .and_then(|json| serde_json::from_slice(&json).ok())
        .ok_or_else(|| FilesError::Refused("invalid upload metadata".into()))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(FilesError::Refused(
            "the upload body must be raw bytes".into(),
        ));
    };
    check_upload_size(bytes.len() as u64, &meta.name)?;
    let target = Target::new(meta.serial, meta.run_as)?;
    upload(&target, &meta.dir, &meta.name, bytes).await
}

pub(crate) fn json_header<T: DeserializeOwned>(request: &Request<'_>, name: &str) -> Option<T> {
    let value = request.headers().get(name)?.to_str().ok()?;
    serde_json::from_slice(&hex_decode(value)?).ok()
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[tauri::command]
pub async fn make_dir(
    serial: String,
    path: String,
    run_as: Option<String>,
) -> Result<(), FilesError> {
    let target = Target::new(serial, run_as)?;
    let path = normalize_path(&path)?;
    target
        .run_ok(&format!("mkdir {}", shell_quote(&path)))
        .await?;
    tracing::info!(%path, run_as = ?target.run_as, "folder created");
    Ok(())
}

fn is_app_data_root(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').skip(1).collect();
    match parts.as_slice() {
        ["data", "data", _] => true,
        ["data", "user", user, _] => user.chars().all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

#[tauri::command]
pub async fn delete_path(
    serial: String,
    path: String,
    run_as: Option<String>,
) -> Result<(), FilesError> {
    let target = Target::new(serial, run_as)?;
    let path = normalize_path(&path)?;
    if path.matches('/').count() < 2
        || PROTECTED.contains(&path.as_str())
        || is_app_data_root(&path)
    {
        return Err(FilesError::Refused(format!("refusing to delete {path}")));
    }
    target
        .run_ok(&format!("rm -r {}", shell_quote(&path)))
        .await?;
    tracing::info!(%path, run_as = ?target.run_as, "deleted");
    Ok(())
}

#[tauri::command]
pub fn reveal_file(app: AppHandle, path: String) -> Result<(), FilesError> {
    let refused = || FilesError::Refused("only downloaded files can be shown".into());
    if path
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '?' | '*'))
    {
        return Err(refused());
    }
    let local = PathBuf::from(&path);
    if local
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(refused());
    }
    let root = std::fs::canonicalize(downloads_root(&app)?).map_err(|_| refused())?;
    let resolved = std::fs::canonicalize(&local).map_err(|_| refused())?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err(refused());
    }
    // Not `resolved`: on Windows it is a `\\?\` path, which Explorer rejects.
    reveal(&local)?;
    Ok(())
}

#[cfg(windows)]
fn reveal(file: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let explorer = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("explorer.exe"))
        .unwrap_or_else(|| PathBuf::from("explorer.exe"));
    // Explorer parses its own command line: `/select,"path"` must be one raw arg.
    std::process::Command::new(explorer)
        .raw_arg(format!("/select,\"{}\"", file.display()))
        .spawn()
        .map(drop)
}

#[cfg(target_os = "macos")]
fn reveal(file: &Path) -> std::io::Result<()> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(file)
        .spawn()
        .map(drop)
}

/// Linux file managers have no common "select this file", so open its folder.
#[cfg(not(any(windows, target_os = "macos")))]
fn reveal(file: &Path) -> std::io::Result<()> {
    let folder = file.parent().unwrap_or(file);
    std::process::Command::new("xdg-open")
        .arg(folder)
        .spawn()
        .map(drop)
}

#[tauri::command]
pub async fn list_packages(serial: String) -> Result<Vec<String>, FilesError> {
    let target = Target::new(serial, None)?;
    let out = target.run_ok("pm list packages -3").await?;
    let mut packages: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(str::to_owned)
        .collect();
    packages.sort();
    Ok(packages)
}
