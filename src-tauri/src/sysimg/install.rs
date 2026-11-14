use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use sha1::{Digest, Sha1};
use sysinfo::{DiskRefreshKind, Disks};
use tokio::process::Command;
use zip::ZipArchive;
use zip::result::ZipError;

use super::catalog::Entry;
use super::{Phase, Reporter, SysImgError, blocking, hex};
use crate::avd;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL: Duration = Duration::from_millis(500);
const CHUNK: usize = 1024 * 1024;
const DOWNLOAD_RETRIES: &str = "3";
const DOWNLOAD_MARGIN: u64 = 1024 * 1024 * 1024;
const EXTRACT_MARGIN: u64 = 512 * 1024 * 1024;

pub struct Job {
    pub entry: Entry,
    pub license: String,
    pub root: PathBuf,
    pub target: PathBuf,
}

async fn curl_exe() -> PathBuf {
    if let Some(root) = std::env::var_os("SystemRoot") {
        let path = PathBuf::from(root).join("System32").join("curl.exe");
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|meta| meta.is_file())
        {
            return path;
        }
    }
    PathBuf::from("curl")
}

pub async fn curl(args: &[&str]) -> Command {
    let mut command = Command::new(curl_exe().await);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub fn spawn_error(e: std::io::Error) -> SysImgError {
    if e.kind() == ErrorKind::NotFound {
        SysImgError::NoCurl
    } else {
        SysImgError::Io(e)
    }
}

pub fn curl_message(status: ExitStatus, stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map_or_else(|| format!("curl exited with {status}"), str::to_owned)
}

fn temp_dir(root: &Path) -> PathBuf {
    root.join(".temp").join("tri-scrnz")
}

async fn fresh_dir(dir: &Path) -> Result<(), SysImgError> {
    match tokio::fs::remove_dir_all(dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    tokio::fs::create_dir_all(dir).await?;
    Ok(())
}

pub async fn cleanup(job: &Job) {
    let temp = temp_dir(&job.root);
    match tokio::fs::remove_dir_all(&temp).await {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!(path = %temp.display(), error = %e, "can't remove the temporary install files");
        }
    }
}

pub async fn run(job: &Job, reporter: &Reporter) -> Result<(), SysImgError> {
    let temp = temp_dir(&job.root);
    let file = job.entry.url.rsplit('/').next().unwrap_or("image.zip");
    let part = temp.join(format!("{file}.part"));
    let staging = temp.join("staging");
    fresh_dir(&temp).await?;
    check_space(&job.root, job.entry.size.saturating_add(DOWNLOAD_MARGIN)).await?;
    download(&job.entry, &part, &temp.join("curl.log"), reporter).await?;
    reporter.check()?;
    verify(&job.entry, &part, reporter).await?;
    reporter.check()?;
    extract(&part, &staging, reporter).await?;
    place(job, &staging, reporter).await
}

fn free_space(path: &Path) -> Option<u64> {
    let path = std::path::absolute(path).ok()?;
    let disks =
        Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage()).ok()?;
    disks
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space())
}

fn ensure_space(path: &Path, needed: u64) -> Result<(), SysImgError> {
    match free_space(path) {
        Some(available) if available < needed => Err(SysImgError::NoSpace { needed, available }),
        Some(_) => Ok(()),
        None => {
            tracing::warn!("can't read the free disk space; installing anyway");
            Ok(())
        }
    }
}

async fn check_space(root: &Path, needed: u64) -> Result<(), SysImgError> {
    let root = root.to_owned();
    blocking(move || ensure_space(&root, needed)).await?
}

async fn download(
    entry: &Entry,
    part: &Path,
    log: &Path,
    reporter: &Reporter,
) -> Result<(), SysImgError> {
    reporter.report(Phase::Downloading, 0, entry.size);
    let stderr = tokio::fs::File::create(log).await?.into_std().await;
    let mut command = curl(&[
        "-fsSL",
        "--retry",
        DOWNLOAD_RETRIES,
        "--connect-timeout",
        "30",
        "--proto",
        "=https",
        "-o",
    ])
    .await;
    let (Some(dir), Some(name)) = (part.parent(), part.file_name()) else {
        return Err(SysImgError::Io(ErrorKind::InvalidInput.into()));
    };
    // curl gets a relative file name so a non-ASCII SDK path can't be mangled by its argument decoding.
    command
        .current_dir(dir)
        .arg(name)
        .arg(&entry.url)
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr));
    let mut child = command.spawn().map_err(spawn_error)?;
    let mut tick = tokio::time::interval(POLL);
    let status = loop {
        tokio::select! {
            status = child.wait() => break status?,
            () = reporter.cancelled() => {
                // Best effort: `kill_on_drop` covers a failed kill.
                let _ = child.kill().await;
                return Err(SysImgError::Cancelled);
            }
            _ = tick.tick() => {
                let received = tokio::fs::metadata(part).await.map_or(0, |meta| meta.len());
                reporter.report(Phase::Downloading, received.min(entry.size), entry.size);
            }
        }
    };
    if !status.success() {
        let stderr = tokio::fs::read(log).await.unwrap_or_default();
        return Err(SysImgError::Network(curl_message(status, &stderr)));
    }
    let received = tokio::fs::metadata(part).await.map_or(0, |meta| meta.len());
    reporter.report(Phase::Downloading, received.min(entry.size), entry.size);
    Ok(())
}

fn hash_file(
    path: &Path,
    entry_size: u64,
    sha1: &str,
    reporter: &Reporter,
) -> Result<(), SysImgError> {
    let mut file = File::open(path)?;
    let actual = file.metadata()?.len();
    if actual != entry_size {
        return Err(SysImgError::SizeMismatch {
            expected: entry_size,
            actual,
        });
    }
    let mut hasher = Sha1::new();
    let mut buffer = vec![0; CHUNK];
    let mut done = 0u64;
    reporter.report(Phase::Verifying, 0, entry_size);
    loop {
        reporter.check()?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        done += read as u64;
        reporter.report(Phase::Verifying, done, entry_size);
    }
    if hex(&hasher.finalize()) != sha1 {
        return Err(SysImgError::Checksum);
    }
    Ok(())
}

async fn verify(entry: &Entry, part: &Path, reporter: &Reporter) -> Result<(), SysImgError> {
    reporter.report(Phase::Verifying, 0, entry.size);
    let (part, size, sha1, reporter) = (
        part.to_owned(),
        entry.size,
        entry.sha1.clone(),
        reporter.clone(),
    );
    blocking(move || hash_file(&part, size, &sha1, &reporter)).await?
}

struct Item {
    index: usize,
    path: PathBuf,
    dir: bool,
    size: u64,
}

fn bad_archive(e: ZipError) -> SysImgError {
    SysImgError::Archive(e.to_string())
}

fn unpack(archive: &Path, staging: &Path, reporter: &Reporter) -> Result<(), SysImgError> {
    let mut zip = ZipArchive::new(BufReader::with_capacity(CHUNK, File::open(archive)?))
        .map_err(bad_archive)?;
    let mut top: Option<OsString> = None;
    let mut items = Vec::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let entry = zip.by_index_data(index).map_err(bad_archive)?;
        let Some(path) = entry.enclosed_name() else {
            return Err(SysImgError::Archive(format!(
                "unsafe entry name {}",
                String::from_utf8_lossy(entry.name_raw())
            )));
        };
        if entry.is_symlink() {
            return Err(SysImgError::Archive(format!(
                "{} is a symbolic link",
                path.display()
            )));
        }
        let mut parts = path.components();
        let Some(Component::Normal(folder)) = parts.next() else {
            return Err(SysImgError::Archive(format!(
                "unexpected entry name {}",
                path.display()
            )));
        };
        match &top {
            Some(known) if known != folder => {
                return Err(SysImgError::Archive(
                    "more than one top-level folder".into(),
                ));
            }
            Some(_) => {}
            None => top = Some(folder.to_owned()),
        }
        let rest = parts.as_path().to_path_buf();
        let dir = entry.is_dir();
        if rest.as_os_str().is_empty() {
            if dir {
                continue;
            }
            return Err(SysImgError::Archive(format!(
                "{} is outside the image folder",
                path.display()
            )));
        }
        if !dir {
            total += entry.size();
        }
        items.push(Item {
            index,
            path: rest,
            dir,
            size: entry.size(),
        });
    }
    if items.is_empty() {
        return Err(SysImgError::Archive("the archive is empty".into()));
    }
    // The zip is already on disk, so this is the room still needed for the unpacked files.
    ensure_space(staging, total.saturating_add(EXTRACT_MARGIN))?;

    std::fs::create_dir_all(staging)?;
    let mut buffer = vec![0; CHUNK];
    let mut written = 0u64;
    reporter.report(Phase::Extracting, 0, total);
    for item in &items {
        reporter.check()?;
        let dest = staging.join(&item.path);
        if item.dir {
            std::fs::create_dir_all(&dest)?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut entry = zip.by_index(item.index).map_err(bad_archive)?;
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)?;
        let mut copied = 0u64;
        loop {
            reporter.check()?;
            let read = entry
                .read(&mut buffer)
                .map_err(|e| SysImgError::Archive(e.to_string()))?;
            if read == 0 {
                break;
            }
            copied += read as u64;
            if copied > item.size {
                return Err(SysImgError::Archive(format!(
                    "{} is larger than declared",
                    item.path.display()
                )));
            }
            out.write_all(&buffer[..read])?;
            written += read as u64;
            reporter.report(Phase::Extracting, written, total);
        }
    }
    Ok(())
}

async fn extract(part: &Path, staging: &Path, reporter: &Reporter) -> Result<(), SysImgError> {
    let (part, staging, reporter) = (part.to_owned(), staging.to_owned(), reporter.clone());
    blocking(move || unpack(&part, &staging, &reporter)).await?
}

fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

// The backup's leading dot keeps it out of the AVD scan, which only lists names starting with a letter or digit.
fn swap(staging: &Path, target: &Path) -> Result<(), SysImgError> {
    let parent = target
        .parent()
        .ok_or_else(|| SysImgError::Unsafe(target.display().to_string()))?;
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let backup = parent.join(format!(".tri-scrnz-old-{name}"));
    std::fs::create_dir_all(parent)?;
    if exists(&backup) {
        if exists(target) {
            std::fs::remove_dir_all(&backup)?;
        } else {
            tracing::warn!(path = %backup.display(), "restoring an image left aside by an interrupted install");
            std::fs::rename(&backup, target)?;
        }
    }
    let replacing = exists(target);
    if replacing {
        std::fs::rename(target, &backup).map_err(SysImgError::Replace)?;
    }
    if let Err(e) = std::fs::rename(staging, target) {
        if replacing && let Err(restore) = std::fs::rename(&backup, target) {
            tracing::error!(backup = %backup.display(), error = %restore, "can't restore the previous system image");
        }
        return Err(SysImgError::Replace(e));
    }
    if replacing && let Err(e) = std::fs::remove_dir_all(&backup) {
        tracing::warn!(path = %backup.display(), error = %e, "can't remove the previous system image");
    }
    Ok(())
}

async fn place(job: &Job, staging: &Path, reporter: &Reporter) -> Result<(), SysImgError> {
    reporter.check()?;
    reporter.report(Phase::Installing, job.entry.size, job.entry.size);
    let xml = job.entry.package_xml(&job.license);
    let (staging, target) = (staging.to_owned(), job.target.clone());
    blocking(move || {
        std::fs::write(staging.join("package.xml"), xml)?;
        swap(&staging, &target)
    })
    .await?
}

fn named(path: Option<&Path>, name: &str) -> bool {
    path.and_then(Path::file_name)
        .is_some_and(|file| file.eq_ignore_ascii_case(name))
}

fn check_plain_image_dir(
    base: &Path,
    image_dir: &Path,
    folders: &[String; 3],
) -> Result<(), SysImgError> {
    let refuse = || SysImgError::Unsafe(image_dir.display().to_string());
    let meta = image_dir.symlink_metadata()?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(refuse());
    }
    let real = image_dir.canonicalize()?;
    let real_base = base.canonicalize()?;
    let tag = real.parent();
    let platform = tag.and_then(Path::parent);
    let inside = named(Some(&real), &folders[2])
        && named(tag, &folders[1])
        && named(platform, &folders[0])
        && platform.and_then(Path::parent) == Some(real_base.as_path());
    if inside { Ok(()) } else { Err(refuse()) }
}

pub fn uninstall(id: &str) -> Result<(), SysImgError> {
    let root = avd::sdk_root().ok_or(SysImgError::NoSdk)?;
    let found = avd::scan_images(&root)
        .into_iter()
        .find(|found| found.image.id.eq_ignore_ascii_case(id))
        .ok_or_else(|| SysImgError::NotInstalled(id.to_owned()))?;
    let users = avd::avds_using_image(&found.folders);
    if !users.is_empty() {
        return Err(SysImgError::InUse {
            id: found.image.id,
            avds: users.join(", "),
        });
    }
    let base = root.join("system-images");
    let [platform, tag, abi] = &found.folders;
    let platform_dir = base.join(platform);
    let tag_dir = platform_dir.join(tag);
    let image_dir = tag_dir.join(abi);
    check_plain_image_dir(&base, &image_dir, &found.folders)?;
    std::fs::remove_dir_all(&image_dir)?;
    tracing::info!(id = %found.image.id, path = %image_dir.display(), "system image removed");
    for dir in [&tag_dir, &platform_dir] {
        match std::fs::remove_dir(dir) {
            Ok(()) => tracing::info!(path = %dir.display(), "empty system image folder removed"),
            Err(e) => {
                tracing::debug!(path = %dir.display(), error = %e, "system image folder kept");
            }
        }
    }
    Ok(())
}
