//! Android emulator launcher (user request 2026-11-12, not in SPEC v1): lists
//! the SDK's AVDs and boots one headless (`-no-window`). It registers with the
//! running adb server, so its tab mirrors it like any device. A headless
//! emulator has no window to close: it is stopped through its console
//! (`kill`), and k3.scrnz stops the ones it started when it exits.

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Serialize, Serializer};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedReadHalf;

use crate::adb::{AdbServer, DeviceSel, DeviceState};
use crate::devices::DeviceHub;

/// Windows `CREATE_NO_WINDOW`: no console window for the emulator process.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// An emulator that fails (unknown AVD, already running) exits within this.
const EARLY_EXIT: Duration = Duration::from_secs(4);
const CONSOLE_TIMEOUT: Duration = Duration::from_secs(5);
const LOG_TAIL: usize = 600;
/// Console ports are even numbers from 5554 (adb uses port + 1). New
/// emulators get one of the first 16; any emulator may use up to 5682.
const FIRST_PORT: u16 = 5554;
const LAST_PORT: u16 = 5584;
const MAX_CONSOLE_PORT: u16 = 5682;

#[derive(Debug, thiserror::Error)]
pub enum EmulatorError {
    #[error("the Android emulator isn't installed (SDK emulator\\emulator.exe not found)")]
    NotInstalled,
    #[error("invalid AVD name: {0:?}")]
    InvalidName(String),
    #[error("not an emulator serial: {0:?}")]
    InvalidSerial(String),
    #[error("{0} is already starting")]
    AlreadyStarting(String),
    #[error("{0} is already running")]
    AlreadyRunning(String),
    #[error("no free emulator port in {FIRST_PORT}–{LAST_PORT}")]
    NoFreePort,
    #[error("listing the AVDs timed out")]
    Timeout,
    #[error("the emulator exited: {0}")]
    Exited(String),
    #[error("emulator console: {0}")]
    Console(String),
    #[error("emulator: {0}")]
    Io(#[from] std::io::Error),
}

/// Tauri sends command errors to the UI as their message.
impl Serialize for EmulatorError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Avd {
    pub name: String,
    /// The adb serial while this AVD runs and has booted far enough to
    /// answer `getprop`.
    pub serial: Option<String>,
}

/// An emulator this app started, with the console port it was given.
struct Launched {
    child: Child,
    port: u16,
}

impl Launched {
    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

pub struct EmulatorState {
    exe: Option<PathBuf>,
    log_dir: Option<PathBuf>,
    /// Keyed by AVD name.
    launched: Arc<Mutex<HashMap<String, Launched>>>,
    starting: Mutex<HashSet<String>>,
}

impl EmulatorState {
    /// Blocking file checks; call once at startup.
    pub fn new(log_dir: Option<PathBuf>) -> Self {
        let exe = crate::adb::sdk_roots()
            .map(|root| root.join("emulator").join("emulator.exe"))
            .find(|exe| exe.is_file());
        match &exe {
            Some(path) => tracing::info!(path = %path.display(), "emulator found"),
            None => tracing::info!("no emulator in the SDK"),
        }
        Self {
            exe,
            log_dir,
            launched: Arc::new(Mutex::new(HashMap::new())),
            starting: Mutex::new(HashSet::new()),
        }
    }
}

/// AVD names are `[A-Za-z0-9._-]` (avdmanager's rule); anything else never
/// reaches the command line.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `-list-avds` prints one name per line; newer emulators may add `INFO |`
/// lines, which never pass `valid_name`.
fn parse_avds(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| valid_name(line))
        .map(str::to_owned)
        .collect()
}

/// `emulator-5554` → console port 5554.
fn console_port(serial: &str) -> Option<u16> {
    let port: u16 = serial.strip_prefix("emulator-")?.parse().ok()?;
    (FIRST_PORT..=MAX_CONSOLE_PORT)
        .contains(&port)
        .then_some(port)
}

/// The AVD behind a running emulator (Android 12+ uses `ro.boot.qemu`).
async fn running_avd(serial: &str) -> Option<String> {
    let out = crate::adb::shell(
        &AdbServer::default(),
        &DeviceSel::Serial(serial.to_owned()),
        "getprop ro.boot.qemu.avd_name; getprop ro.kernel.qemu.avd_name",
    )
    .await
    .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

/// The first even port whose console and adb ports are both free.
async fn free_port() -> Option<u16> {
    for port in (FIRST_PORT..=LAST_PORT).step_by(2) {
        let console = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await;
        let adb = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port + 1)).await;
        if console.is_ok() && adb.is_ok() {
            return Some(port);
        }
    }
    None
}

#[tauri::command]
pub async fn list_avds(
    state: State<'_, EmulatorState>,
    hub: State<'_, Arc<DeviceHub>>,
) -> Result<Vec<Avd>, EmulatorError> {
    let exe = state.exe.clone().ok_or(EmulatorError::NotInstalled)?;
    lock(&state.launched).retain(|_, launched| launched.running());
    let output = tokio::time::timeout(
        LIST_TIMEOUT,
        tokio::process::Command::new(exe)
            .arg("-list-avds")
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output(),
    )
    .await
    .map_err(|_| EmulatorError::Timeout)??;
    let names = parse_avds(&String::from_utf8_lossy(&output.stdout));

    let emulators: Vec<String> = hub
        .views()
        .into_iter()
        .filter(|d| d.serial.starts_with("emulator-") && d.state == DeviceState::Device && !d.gone)
        .map(|d| d.serial)
        .collect();
    let mut running = Vec::new();
    for serial in emulators {
        if let Some(avd) = running_avd(&serial).await {
            running.push((avd, serial));
        }
    }
    Ok(names
        .into_iter()
        .map(|name| Avd {
            serial: running
                .iter()
                .find(|(avd, _)| *avd == name)
                .map(|(_, serial)| serial.clone()),
            name,
        })
        .collect())
}

/// Boots the AVD without a window (host GPU, quick boot) and returns its adb
/// serial. Its output goes to `emulator-<avd>.log` next to the app log.
#[tauri::command]
pub async fn start_emulator(
    state: State<'_, EmulatorState>,
    avd: String,
) -> Result<String, EmulatorError> {
    if !valid_name(&avd) {
        return Err(EmulatorError::InvalidName(avd));
    }
    let exe = state.exe.clone().ok_or(EmulatorError::NotInstalled)?;
    if lock(&state.launched)
        .get_mut(&avd)
        .is_some_and(Launched::running)
    {
        return Err(EmulatorError::AlreadyRunning(avd));
    }
    if !lock(&state.starting).insert(avd.clone()) {
        return Err(EmulatorError::AlreadyStarting(avd));
    }
    let result = launch(exe, state.log_dir.clone(), &avd).await;
    lock(&state.starting).remove(&avd);
    let launched = result?;
    let serial = format!("emulator-{}", launched.port);
    lock(&state.launched).insert(avd, launched);
    Ok(serial)
}

async fn launch(
    exe: PathBuf,
    log_dir: Option<PathBuf>,
    avd: &str,
) -> Result<Launched, EmulatorError> {
    let port = free_port().await.ok_or(EmulatorError::NoFreePort)?;
    let log_path = log_dir.map(|dir| dir.join(format!("emulator-{avd}.log")));
    let (stdout, stderr) = match &log_path {
        Some(path) => {
            if let Some(dir) = path.parent() {
                tokio::fs::create_dir_all(dir).await?;
            }
            let file = tokio::fs::File::create(path).await?.into_std().await;
            (Stdio::from(file.try_clone()?), Stdio::from(file))
        }
        None => (Stdio::null(), Stdio::null()),
    };
    let port_arg = port.to_string();
    let mut child = std::process::Command::new(exe)
        .args([
            "-avd",
            avd,
            "-port",
            &port_arg,
            "-no-window",
            "-gpu",
            "host",
            "-no-boot-anim",
        ])
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    tracing::info!(avd, port, pid = child.id(), "emulator started headless");

    let deadline = tokio::time::Instant::now() + EARLY_EXIT;
    while tokio::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            let tail = match &log_path {
                Some(path) => tokio::fs::read(path)
                    .await
                    .map(|bytes| tail(&String::from_utf8_lossy(&bytes)))
                    .unwrap_or_default(),
                None => String::new(),
            };
            tracing::warn!(avd, %status, output = %tail, "emulator exited early");
            return Err(EmulatorError::Exited(if tail.is_empty() {
                status.to_string()
            } else {
                tail
            }));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(Launched { child, port })
}

/// Shuts an emulator down through its console (it saves its quick-boot
/// snapshot). Works for emulators started elsewhere too.
#[tauri::command]
pub async fn stop_emulator(
    state: State<'_, EmulatorState>,
    serial: String,
) -> Result<(), EmulatorError> {
    let port = console_port(&serial).ok_or_else(|| EmulatorError::InvalidSerial(serial.clone()))?;
    match console_kill(port).await {
        Ok(()) => {
            tracing::info!(serial, "emulator stopping");
            Ok(())
        }
        Err(e) => {
            // Ours and the console is stuck: end the process instead.
            let mut launched = lock(&state.launched);
            let ours = launched
                .values_mut()
                .filter(|l| l.port == port)
                .find_map(|l| l.running().then_some(l));
            match ours {
                Some(l) => {
                    tracing::warn!(serial, error = %e, "console kill failed; terminating the emulator");
                    l.child.kill()?;
                    Ok(())
                }
                None => Err(e),
            }
        }
    }
}

/// On app exit: a headless emulator would keep running unseen, so stop the
/// ones this app started (blocking, bounded by the console timeout).
pub fn shutdown(state: &EmulatorState) {
    let ports: Vec<(String, u16)> = lock(&state.launched)
        .iter_mut()
        .filter_map(|(avd, l)| l.running().then(|| (avd.clone(), l.port)))
        .collect();
    if ports.is_empty() {
        return;
    }
    let failed: Vec<String> = tauri::async_runtime::block_on(async {
        let kills = ports
            .iter()
            .map(|(avd, port)| async move { (avd.clone(), console_kill(*port).await) });
        futures_util::future::join_all(kills)
            .await
            .into_iter()
            .filter_map(|(avd, result)| match result {
                Ok(()) => {
                    tracing::info!(avd, "emulator stopped on exit");
                    None
                }
                Err(e) => {
                    tracing::warn!(avd, error = %e, "console kill on exit failed");
                    Some(avd)
                }
            })
            .collect()
    });
    let mut launched = lock(&state.launched);
    for avd in failed {
        if let Some(l) = launched.get_mut(&avd)
            && let Err(e) = l.child.kill()
        {
            tracing::warn!(avd, error = %e, "can't terminate the emulator");
        }
    }
}

/// Emulator console protocol: banner ending in `OK`, optional
/// `auth <token>`, then `kill` (replies `OK: killing emulator, bye bye`).
async fn console_kill(port: u16) -> Result<(), EmulatorError> {
    tokio::time::timeout(CONSOLE_TIMEOUT, async {
        let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let banner = read_reply(&mut lines).await?;
        if banner.contains("Authentication required") {
            let token = auth_token()
                .await
                .ok_or_else(|| EmulatorError::Console("no console auth token file".into()))?;
            write
                .write_all(format!("auth {token}\r\n").as_bytes())
                .await?;
            read_reply(&mut lines).await?;
        }
        write.write_all(b"kill\r\n").await?;
        match read_reply(&mut lines).await {
            // The emulator may close the socket before the reply arrives.
            Ok(_) | Err(EmulatorError::Io(_)) => Ok(()),
            Err(EmulatorError::Console(reason)) if reason == CONSOLE_CLOSED => Ok(()),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|_| EmulatorError::Console("no answer".into()))?
}

const CONSOLE_CLOSED: &str = "closed";

/// Reads console lines up to the `OK`/`KO` line that ends a reply.
async fn read_reply(lines: &mut Lines<BufReader<OwnedReadHalf>>) -> Result<String, EmulatorError> {
    let mut text = String::new();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim_end();
        if line.starts_with("OK") {
            text.push_str(line);
            return Ok(text);
        }
        if let Some(reason) = line.strip_prefix("KO") {
            return Err(EmulatorError::Console(
                reason.trim_start_matches(':').trim().to_owned(),
            ));
        }
        text.push_str(line);
        text.push('\n');
    }
    Err(EmulatorError::Console(CONSOLE_CLOSED.into()))
}

/// `%USERPROFILE%\.emulator_console_auth_token`, written by the emulator.
async fn auth_token() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")?;
    let path = PathBuf::from(home).join(".emulator_console_auth_token");
    let token = tokio::fs::read_to_string(path).await.ok()?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

/// The last lines of the emulator's output, for the error message.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines[lines.len().saturating_sub(3)..].join(" · ");
    let start = joined
        .char_indices()
        .rev()
        .nth(LOG_TAIL)
        .map_or(0, |(index, _)| index);
    joined[start..].to_owned()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
