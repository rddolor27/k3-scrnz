use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::ops::RangeInclusive;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize, Serializer};
use tauri::State;

use crate::devices::DeviceHub;
use crate::emulator::{self, EmulatorState, valid_name};

const MAX_DISPLAY_NAME_LEN: usize = 64;
const MAX_INI_BYTES: u64 = 256 * 1024;
const DEFAULT_DEVICE: &str = "custom";
const SIZE_PX: RangeInclusive<u32> = 240..=4096;
const DENSITY_DPI: RangeInclusive<u32> = 120..=640;
const RAM_MB: RangeInclusive<u32> = 1024..=16384;
const STORAGE_GB: RangeInclusive<u32> = 2..=64;
// 0 = the emulator's default flags; Android reports that display with FLAG_PRESENTATION (checked on API 33).
const CUSTOMER_DISPLAY_FLAG: u32 = 0;

type Ini = HashMap<String, String>;

#[derive(Debug, thiserror::Error)]
pub enum AvdError {
    #[error("invalid AVD name: {0:?}")]
    InvalidName(String),
    #[error("invalid {0}")]
    InvalidText(&'static str),
    #[error("{field} must be between {min} and {max}")]
    OutOfRange {
        field: &'static str,
        min: u32,
        max: u32,
    },
    #[error("no Android SDK with system images found")]
    NoSdk,
    #[error("unknown system image: {0:?}")]
    UnknownImage(String),
    #[error("unsupported system image ABI: {0:?}")]
    UnsupportedAbi(String),
    #[error("an AVD named {0} already exists")]
    AlreadyExists(String),
    #[error("the AVD folder can't be located")]
    NoAvdHome,
    #[error("no AVD named {0}")]
    NotFound(String),
    #[error("{0} is running or starting; stop it first")]
    InUse(String),
    #[error("refusing to delete {0}: not a plain file or folder inside the AVD folder")]
    Unsafe(String),
    #[error("avd: {0}")]
    Io(#[from] std::io::Error),
    #[error("avd task failed: {0}")]
    Task(String),
}

impl Serialize for AvdError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AvdState {
    Stopped,
    Booting,
    Running,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySize {
    pub width: u32,
    pub height: u32,
    pub density: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Avd {
    pub name: String,
    pub serial: Option<String>,
    pub state: AvdState,
    pub display_name: Option<String>,
    pub api_level: Option<u32>,
    pub tag: Option<String>,
    pub tag_display: Option<String>,
    pub abi: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub density: Option<u32>,
    pub ram_mb: Option<u32>,
    pub play_store: bool,
    pub customer_display: Option<DisplaySize>,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemImage {
    pub id: String,
    pub api_level: u32,
    pub tag: String,
    pub tag_display: String,
    pub abi: String,
    pub play_store: bool,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvdSpec {
    pub name: String,
    pub display_name: Option<String>,
    pub image: String,
    pub width: u32,
    pub height: u32,
    pub density: u32,
    pub ram_mb: u32,
    pub storage_gb: u32,
    pub device_name: Option<String>,
    pub customer_display: Option<DisplaySize>,
}

pub struct Found {
    pub image: SystemImage,
    pub folders: [String; 3],
}

#[derive(Default)]
struct Created {
    files: Vec<PathBuf>,
    folder: Option<PathBuf>,
}

impl Created {
    fn undo(self) {
        for file in self.files.iter().rev() {
            if let Err(e) = std::fs::remove_file(file) {
                tracing::warn!(path = %file.display(), error = %e, "can't remove a file of the failed AVD");
            }
        }
        if let Some(folder) = &self.folder
            && let Err(e) = std::fs::remove_dir(folder)
        {
            tracing::warn!(path = %folder.display(), error = %e, "can't remove the folder of the failed AVD");
        }
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AvdError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AvdError::Task(e.to_string()))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn avd_home() -> Option<PathBuf> {
    env_path("ANDROID_AVD_HOME")
        .or_else(|| env_path("ANDROID_EMULATOR_HOME").map(|dir| dir.join("avd")))
        .or_else(|| env_path("ANDROID_USER_HOME").map(|dir| dir.join("avd")))
        .or_else(|| env_path("ANDROID_SDK_HOME").map(|dir| dir.join(".android").join("avd")))
        .or_else(|| {
            env_path(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|dir| dir.join(".android").join("avd"))
        })
}

pub fn sdk_root() -> Option<PathBuf> {
    crate::adb::sdk_roots().find(|root| root.join("system-images").is_dir())
}

fn parse_ini(text: &str) -> Ini {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect()
}

pub fn read_ini(path: &Path) -> Option<Ini> {
    let mut bytes = Vec::new();
    let read =
        std::fs::File::open(path).and_then(|file| file.take(MAX_INI_BYTES).read_to_end(&mut bytes));
    if let Err(e) = read {
        if e.kind() != ErrorKind::NotFound {
            tracing::debug!(path = %path.display(), error = %e, "can't read an ini file");
        }
        return None;
    }
    Some(parse_ini(&String::from_utf8_lossy(&bytes)))
}

fn text(ini: &Ini, key: &str) -> Option<String> {
    ini.get(key)
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .cloned()
}

fn number(ini: &Ini, key: &str) -> Option<u32> {
    ini.get(key)?.parse().ok()
}

fn megabytes(ini: &Ini, key: &str) -> Option<u32> {
    ini.get(key)?
        .trim_end_matches(['M', 'm', 'B', 'b'])
        .parse()
        .ok()
}

fn flag(ini: &Ini, key: &str) -> bool {
    ini.get(key)
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "yes" | "true" | "1"))
}

fn api_of(platform: &str) -> Option<u32> {
    platform
        .strip_prefix("android-")?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn customer_display(config: &Ini) -> Option<DisplaySize> {
    let width = number(config, "hw.display1.width").filter(|value| *value > 0)?;
    let height = number(config, "hw.display1.height").filter(|value| *value > 0)?;
    Some(DisplaySize {
        width,
        height,
        density: number(config, "hw.display1.density").unwrap_or(0),
    })
}

fn avd_folder(home: Option<&Path>, name: &str, pointer: &Ini) -> Option<PathBuf> {
    pointer
        .get("path")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| {
            home.map(|home| home.join(format!("{name}.avd")))
                .filter(|path| path.is_dir())
        })
}

fn read_avd(home: Option<&Path>, name: &str) -> Avd {
    let pointer = home
        .and_then(|home| read_ini(&home.join(format!("{name}.ini"))))
        .unwrap_or_default();
    let folder = avd_folder(home, name, &pointer);
    let config = folder
        .as_deref()
        .and_then(|folder| read_ini(&folder.join("config.ini")))
        .unwrap_or_default();
    Avd {
        name: name.to_owned(),
        serial: None,
        state: AvdState::Stopped,
        display_name: text(&config, "avd.ini.displayname"),
        api_level: pointer
            .get("target")
            .map(String::as_str)
            .and_then(api_of)
            .or_else(|| {
                config
                    .get("image.sysdir.1")
                    .and_then(|dir| dir.split(['/', '\\']).find_map(api_of))
            }),
        tag: text(&config, "tag.id"),
        tag_display: match (text(&config, "tag.display"), text(&config, "tag.id")) {
            (Some(display), Some(tag)) if display == tag => Some(known_tag_display(&tag)),
            (None, Some(tag)) => Some(known_tag_display(&tag)),
            (display, _) => display,
        },
        abi: text(&config, "abi.type"),
        width: number(&config, "hw.lcd.width"),
        height: number(&config, "hw.lcd.height"),
        density: number(&config, "hw.lcd.density"),
        ram_mb: megabytes(&config, "hw.ramSize"),
        play_store: flag(&config, "PlayStore.enabled"),
        customer_display: customer_display(&config),
        path: folder.map(|folder| folder.to_string_lossy().into_owned()),
    }
}

fn names_in(home: &Path) -> Vec<String> {
    let entries = match std::fs::read_dir(home) {
        Ok(entries) => entries,
        Err(e) => {
            if e.kind() != ErrorKind::NotFound {
                tracing::debug!(path = %home.display(), error = %e, "can't read the AVD folder");
            }
            return Vec::new();
        }
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| !kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".ini").map(str::to_owned))
        .filter(|stem| valid_name(stem))
        .collect();
    names.sort_by_cached_key(|name| (name.to_ascii_lowercase(), name.clone()));
    names
}

pub async fn scan_names() -> Vec<String> {
    blocking(|| avd_home().map(|home| names_in(&home)).unwrap_or_default())
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "scanning the AVD folder failed");
            Vec::new()
        })
}

pub async fn read_all(names: Vec<String>) -> Vec<Avd> {
    blocking(move || {
        let home = avd_home();
        names
            .iter()
            .map(|name| read_avd(home.as_deref(), name))
            .collect()
    })
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(error = %e, "reading the AVDs failed");
        Vec::new()
    })
}

// The name comes from a device's getprop, so it must pass `valid_name` before it touches a path.
pub async fn label(name: &str) -> Option<String> {
    if !valid_name(name) {
        return None;
    }
    let name = name.to_owned();
    blocking(move || {
        read_avd(avd_home().as_deref(), &name)
            .display_name
            .unwrap_or_else(|| name.replace('_', " "))
    })
    .await
    .map_err(|e| tracing::warn!(error = %e, "reading the AVD's display name failed"))
    .ok()
}

// Older images (e.g. API 24/25 `default`) have no SystemImage.TagDisplay.
fn known_tag_display(tag_dir: &str) -> String {
    match tag_dir {
        "default" => "Default Android System Image",
        "google_apis" => "Google APIs",
        "google_apis_playstore" => "Google Play",
        "aosp_atd" => "AOSP ATD",
        "google_atd" => "Google ATD",
        other => other,
    }
    .to_owned()
}

fn tag_list(tags: &str) -> Vec<&str> {
    tags.split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn subfolders(path: &Path) -> Vec<String> {
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| valid_name(name))
        .collect()
}

pub fn scan_images(root: &Path) -> Vec<Found> {
    let base = root.join("system-images");
    let mut found = Vec::new();
    for platform in subfolders(&base) {
        for tag_dir in subfolders(&base.join(&platform)) {
            for abi_dir in subfolders(&base.join(&platform).join(&tag_dir)) {
                let dir = base.join(&platform).join(&tag_dir).join(&abi_dir);
                let Some(props) = read_ini(&dir.join("source.properties")) else {
                    continue;
                };
                let Some(api_level) = props
                    .get("AndroidVersion.ApiLevel")
                    .and_then(|level| level.split('.').next()?.parse().ok())
                    .or_else(|| api_of(&platform))
                else {
                    continue;
                };
                let tag = text(&props, "SystemImage.TagId").unwrap_or_else(|| tag_dir.clone());
                found.push(Found {
                    image: SystemImage {
                        id: format!("system-images;{platform};{tag_dir};{abi_dir}"),
                        api_level,
                        play_store: tag.contains("playstore"),
                        tag,
                        tag_display: text(&props, "SystemImage.TagDisplay")
                            .map(|display| tag_list(&display).join(", "))
                            .filter(|display| !display.is_empty())
                            .unwrap_or_else(|| known_tag_display(&tag_dir)),
                        abi: text(&props, "SystemImage.Abi").unwrap_or_else(|| abi_dir.clone()),
                        description: text(&props, "Pkg.Desc"),
                    },
                    folders: [platform.clone(), tag_dir.clone(), abi_dir],
                });
            }
        }
    }
    found.sort_by(|a, b| {
        b.image
            .api_level
            .cmp(&a.image.api_level)
            .then_with(|| a.image.id.cmp(&b.image.id))
    });
    found
}

#[tauri::command]
pub async fn list_system_images() -> Result<Vec<SystemImage>, AvdError> {
    blocking(|| {
        sdk_root()
            .map(|root| {
                scan_images(&root)
                    .into_iter()
                    .map(|found| found.image)
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
}

fn uses_sysdir(sysdir: &str, folders: &[String; 3]) -> bool {
    let parts: Vec<&str> = sysdir
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    let [.., base, platform, tag, abi] = parts.as_slice() else {
        return false;
    };
    base.eq_ignore_ascii_case("system-images")
        && platform.eq_ignore_ascii_case(&folders[0])
        && tag.eq_ignore_ascii_case(&folders[1])
        && abi.eq_ignore_ascii_case(&folders[2])
}

pub fn avds_using_image(folders: &[String; 3]) -> Vec<String> {
    let Some(home) = avd_home() else {
        return Vec::new();
    };
    names_in(&home)
        .into_iter()
        .filter(|name| {
            let pointer = read_ini(&home.join(format!("{name}.ini"))).unwrap_or_default();
            avd_folder(Some(&home), name, &pointer)
                .and_then(|folder| read_ini(&folder.join("config.ini")))
                .and_then(|config| config.get("image.sysdir.1").cloned())
                .is_some_and(|sysdir| uses_sysdir(&sysdir, folders))
        })
        .collect()
}

fn in_range(field: &'static str, value: u32, range: &RangeInclusive<u32>) -> Result<(), AvdError> {
    if range.contains(&value) {
        return Ok(());
    }
    Err(AvdError::OutOfRange {
        field,
        min: *range.start(),
        max: *range.end(),
    })
}

fn display_name(raw: Option<&str>) -> Result<Option<&str>, AvdError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.chars().count() > MAX_DISPLAY_NAME_LEN || raw.chars().any(char::is_control) {
        return Err(AvdError::InvalidText("displayName"));
    }
    Ok(Some(raw.trim()).filter(|name| !name.is_empty()))
}

fn device_name(raw: Option<&str>) -> Result<&str, AvdError> {
    match raw.filter(|name| !name.is_empty()) {
        Some(name) if valid_name(name) => Ok(name),
        Some(_) => Err(AvdError::InvalidText("deviceName")),
        None => Ok(DEFAULT_DEVICE),
    }
}

fn cpu_arch(abi: &str) -> Option<&'static str> {
    match abi {
        "x86_64" => Some("x86_64"),
        "x86" => Some("x86"),
        "arm64-v8a" => Some("arm64"),
        "armeabi-v7a" => Some("arm"),
        _ => None,
    }
}

fn render(lines: &[(&str, String)]) -> String {
    lines
        .iter()
        .map(|(key, value)| format!("{key}={value}\n"))
        .collect()
}

fn write_new(path: &Path, content: &str, created: &mut Created) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    created.files.push(path.to_owned());
    file.write_all(content.as_bytes())
}

fn write_avd(
    home: &Path,
    folder: &Path,
    ini_path: &Path,
    config: &str,
    ini: &str,
    created: &mut Created,
) -> std::io::Result<()> {
    std::fs::create_dir_all(home)?;
    std::fs::create_dir(folder)?;
    created.folder = Some(folder.to_owned());
    write_new(&folder.join("config.ini"), config, created)?;
    write_new(ini_path, ini, created)
}

fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn create(spec: &AvdSpec) -> Result<Avd, AvdError> {
    let name = spec.name.as_str();
    if !valid_name(name) {
        return Err(AvdError::InvalidName(spec.name.clone()));
    }
    in_range("width", spec.width, &SIZE_PX)?;
    in_range("height", spec.height, &SIZE_PX)?;
    in_range("density", spec.density, &DENSITY_DPI)?;
    in_range("ramMb", spec.ram_mb, &RAM_MB)?;
    in_range("storageGb", spec.storage_gb, &STORAGE_GB)?;
    if let Some(display) = &spec.customer_display {
        in_range("customerDisplay.width", display.width, &SIZE_PX)?;
        in_range("customerDisplay.height", display.height, &SIZE_PX)?;
        in_range("customerDisplay.density", display.density, &DENSITY_DPI)?;
    }
    let display_name = display_name(spec.display_name.as_deref())?.unwrap_or(name);
    let device_name = device_name(spec.device_name.as_deref())?;

    let root = sdk_root().ok_or(AvdError::NoSdk)?;
    let found = scan_images(&root)
        .into_iter()
        .find(|found| found.image.id == spec.image)
        .ok_or_else(|| AvdError::UnknownImage(spec.image.clone()))?;
    let image = &found.image;
    let arch = cpu_arch(&image.abi).ok_or_else(|| AvdError::UnsupportedAbi(image.abi.clone()))?;

    let home = avd_home().ok_or(AvdError::NoAvdHome)?;
    let home = std::path::absolute(home)?;
    let ini_path = home.join(format!("{name}.ini"));
    let folder = home.join(format!("{name}.avd"));
    if exists(&ini_path) || exists(&folder) {
        return Err(AvdError::AlreadyExists(spec.name.clone()));
    }

    let sep = MAIN_SEPARATOR;
    let [platform, tag_dir, abi_dir] = &found.folders;
    // Multi-tag images (e.g. "google_apis_playstore,tablet") get the first tag plus the full list, as Android Studio writes them.
    let tag_ids = tag_list(&image.tag);
    let tag_names = tag_list(&image.tag_display);
    let mut lines = vec![
        ("AvdId", name.to_owned()),
        ("avd.ini.displayname", display_name.to_owned()),
        ("avd.ini.encoding", "UTF-8".to_owned()),
        ("abi.type", image.abi.clone()),
        ("hw.cpu.arch", arch.to_owned()),
        ("hw.cpu.ncore", "4".to_owned()),
        ("hw.ramSize", spec.ram_mb.to_string()),
        ("disk.dataPartition.size", format!("{}G", spec.storage_gb)),
        (
            "image.sysdir.1",
            format!("system-images{sep}{platform}{sep}{tag_dir}{sep}{abi_dir}{sep}"),
        ),
        (
            "tag.id",
            tag_ids
                .first()
                .map_or_else(|| image.tag.clone(), |tag| (*tag).to_owned()),
        ),
        (
            "tag.display",
            tag_names
                .first()
                .map_or_else(|| image.tag_display.clone(), |name| (*name).to_owned()),
        ),
        (
            "PlayStore.enabled",
            if image.play_store { "yes" } else { "no" }.to_owned(),
        ),
        ("hw.lcd.width", spec.width.to_string()),
        ("hw.lcd.height", spec.height.to_string()),
        ("hw.lcd.density", spec.density.to_string()),
        (
            "hw.initialOrientation",
            if spec.width > spec.height {
                "landscape"
            } else {
                "portrait"
            }
            .to_owned(),
        ),
        ("hw.keyboard", "yes".to_owned()),
        ("hw.mainKeys", "no".to_owned()),
        ("hw.sdCard", "no".to_owned()),
        ("hw.gpu.enabled", "yes".to_owned()),
        ("hw.gpu.mode", "auto".to_owned()),
        ("hw.device.name", device_name.to_owned()),
        ("skin.name", format!("{}x{}", spec.width, spec.height)),
        ("skin.path", "_no_skin".to_owned()),
        ("skin.dynamic", "yes".to_owned()),
        ("showDeviceFrame", "no".to_owned()),
        ("fastboot.forceColdBoot", "no".to_owned()),
    ];
    if tag_ids.len() > 1 {
        lines.push(("tag.ids", tag_ids.join(",")));
    }
    if tag_names.len() > 1 {
        lines.push(("tag.displaynames", tag_names.join(",")));
    }
    if let Some(display) = &spec.customer_display {
        lines.extend([
            ("hw.display1.width", display.width.to_string()),
            ("hw.display1.height", display.height.to_string()),
            ("hw.display1.density", display.density.to_string()),
            ("hw.display1.xOffset", "-1".to_owned()),
            ("hw.display1.yOffset", "-1".to_owned()),
            ("hw.display1.flag", CUSTOMER_DISPLAY_FLAG.to_string()),
        ]);
    }
    let ini = [
        ("avd.ini.encoding", "UTF-8".to_owned()),
        ("path", folder.to_string_lossy().into_owned()),
        ("path.rel", format!("avd{sep}{name}.avd")),
        ("target", format!("android-{}", image.api_level)),
    ];

    let mut created = Created::default();
    if let Err(e) = write_avd(
        &home,
        &folder,
        &ini_path,
        &render(&lines),
        &render(&ini),
        &mut created,
    ) {
        created.undo();
        return Err(if e.kind() == ErrorKind::AlreadyExists {
            AvdError::AlreadyExists(spec.name.clone())
        } else {
            AvdError::Io(e)
        });
    }
    tracing::info!(name, image = %spec.image, path = %folder.display(), "AVD created");
    Ok(read_avd(Some(&home), name))
}

#[tauri::command]
pub async fn create_avd(spec: AvdSpec) -> Result<Avd, AvdError> {
    blocking(move || create(&spec)).await?
}

fn probe(path: &Path, directory: bool) -> Result<bool, AvdError> {
    match path.symlink_metadata() {
        Ok(meta)
            if (if directory {
                meta.is_dir()
            } else {
                meta.is_file()
            }) =>
        {
            Ok(true)
        }
        Ok(_) => Err(AvdError::Unsafe(path.display().to_string())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn check_inside(home: &Path, folder: &Path, name: &str) -> Result<(), AvdError> {
    let real = folder.canonicalize()?;
    let real_home = home.canonicalize()?;
    let inside = real.parent() == Some(real_home.as_path())
        && real
            .file_name()
            .is_some_and(|file| file.eq_ignore_ascii_case(format!("{name}.avd")));
    if inside {
        Ok(())
    } else {
        Err(AvdError::Unsafe(folder.display().to_string()))
    }
}

fn points_elsewhere(declared: &Path, folder: &Path) -> bool {
    match declared.canonicalize() {
        Ok(declared) => folder
            .canonicalize()
            .map_or(true, |folder| folder != declared),
        Err(e) => e.kind() != ErrorKind::NotFound,
    }
}

fn delete(name: &str) -> Result<(), AvdError> {
    let home = avd_home().ok_or(AvdError::NoAvdHome)?;
    let ini_path = home.join(format!("{name}.ini"));
    let folder = home.join(format!("{name}.avd"));
    let has_ini = probe(&ini_path, false)?;
    let has_folder = probe(&folder, true)?;
    if !has_ini && !has_folder {
        return Err(AvdError::NotFound(name.to_owned()));
    }
    if has_folder {
        check_inside(&home, &folder, name)?;
    }

    let declared = if has_ini {
        read_ini(&ini_path).and_then(|ini| text(&ini, "path"))
    } else {
        None
    };
    let elsewhere = declared
        .as_deref()
        .map(Path::new)
        .is_some_and(|declared| points_elsewhere(declared, &folder));
    if elsewhere {
        tracing::warn!(
            name,
            declared = declared.as_deref().unwrap_or_default(),
            folder = %folder.display(),
            "the AVD's path points outside the AVD folder; deleting only its .ini"
        );
    }

    let remove_folder = has_folder && !elsewhere;
    if remove_folder {
        std::fs::remove_dir_all(&folder)?;
    }
    if has_ini {
        std::fs::remove_file(&ini_path)?;
    }
    tracing::info!(
        name,
        folder_removed = remove_folder,
        ini_removed = has_ini,
        folder = %folder.display(),
        ini = %ini_path.display(),
        "AVD deleted"
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_avd(
    state: State<'_, EmulatorState>,
    hub: State<'_, Arc<DeviceHub>>,
    name: String,
) -> Result<(), AvdError> {
    if !valid_name(&name) {
        return Err(AvdError::InvalidName(name));
    }
    let Some(_reservation) = emulator::reserve_idle(&state, &hub, &name).await else {
        return Err(AvdError::InUse(name));
    };
    blocking(move || delete(&name)).await?
}
