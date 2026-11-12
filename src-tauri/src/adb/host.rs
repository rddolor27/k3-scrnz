//! Host services (SPEC section 5.2), device-service open (5.3) and server bootstrap (5.7).

use std::collections::HashSet;
use std::fmt;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Serialize, Serializer};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

use super::framing::{read_protocol_string, read_status, send_request};
use super::{AdbError, AdbStream};

/// Windows `CREATE_NO_WINDOW`: no console window flashes up for `adb start-server`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How long to keep retrying `host:version` after starting the server.
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound for a request/reply exchange (not for streaming reads).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The adb server. Always `127.0.0.1`: the Windows server binds IPv4 loopback only.
#[derive(Clone, Debug)]
pub struct AdbServer {
    addr: SocketAddr,
}

impl Default for AdbServer {
    fn default() -> Self {
        Self {
            addr: SocketAddr::from((Ipv4Addr::LOCALHOST, 5037)),
        }
    }
}

#[derive(Clone, Debug)]
pub enum DeviceSel {
    Serial(String),
    /// Changes every time the device reconnects; use when serials collide.
    TransportId(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeviceState {
    Device,
    Offline,
    Unauthorized,
    Authorizing,
    Connecting,
    Recovery,
    Sideload,
    Rescue,
    Bootloader,
    Host,
    Detached,
    NoPermissions(String),
    Unknown(String),
}

impl DeviceState {
    pub fn parse(text: &str) -> Self {
        match text {
            "device" => Self::Device,
            "offline" => Self::Offline,
            "unauthorized" => Self::Unauthorized,
            "authorizing" => Self::Authorizing,
            "connecting" => Self::Connecting,
            "recovery" => Self::Recovery,
            "sideload" => Self::Sideload,
            "rescue" => Self::Rescue,
            "bootloader" => Self::Bootloader,
            "host" => Self::Host,
            "detached" => Self::Detached,
            t if t.starts_with("no permissions") => Self::NoPermissions(t.to_owned()),
            t => Self::Unknown(t.to_owned()),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::Offline => "offline",
            Self::Unauthorized => "unauthorized",
            Self::Authorizing => "authorizing",
            Self::Connecting => "connecting",
            Self::Recovery => "recovery",
            Self::Sideload => "sideload",
            Self::Rescue => "rescue",
            Self::Bootloader => "bootloader",
            Self::Host => "host",
            Self::Detached => "detached",
            Self::NoPermissions(_) => "no-permissions",
            Self::Unknown(_) => "unknown",
        }
    }
}

impl fmt::Display for DeviceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for DeviceState {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// One line of `host:devices-l`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceInfo {
    pub serial: String,
    pub state: DeviceState,
    pub transport_id: u64,
    pub product: Option<String>,
    pub model: Option<String>,
    pub device: Option<String>,
}

/// Parses a `devices-l` list (one device per line). An empty list (the `0000`
/// tracker frame) yields no devices. Lines that don't parse are skipped.
pub fn parse_devices(text: &str) -> Vec<DeviceInfo> {
    text.lines().filter_map(parse_device_line).collect()
}

/// `%-22s %s` (serial, state), optional ` key:value` tokens, then ` transport_id:N`.
/// `transport_id` is always last. The state is one word, except the Linux-only
/// `no permissions (...); see [...]` text, which runs up to the first detail
/// token. Unknown `key:value` tokens from newer adb versions are ignored.
fn parse_device_line(line: &str) -> Option<DeviceInfo> {
    const NO_SERIAL: &str = "(no serial number)";
    let line = line.trim();
    let (serial, rest) = match line.strip_prefix(NO_SERIAL) {
        Some(rest) => (NO_SERIAL, rest),
        None => line.split_once(char::is_whitespace)?,
    };

    let mut tokens: Vec<&str> = rest.split_whitespace().collect();
    let transport_id = tokens.pop()?.strip_prefix("transport_id:")?.parse().ok()?;

    let is_detail = |t: &&str| {
        ["usb:", "product:", "model:", "device:"]
            .iter()
            .any(|key| t.starts_with(key))
    };
    let state_len = if tokens.first() == Some(&"no") && tokens.get(1) == Some(&"permissions") {
        tokens.iter().position(is_detail).unwrap_or(tokens.len())
    } else {
        tokens.len().min(1)
    };
    let (state_tokens, details) = tokens.split_at(state_len);

    let (mut product, mut model, mut device) = (None, None, None);
    for token in details {
        if let Some(v) = token.strip_prefix("product:") {
            product = Some(v.to_owned());
        } else if let Some(v) = token.strip_prefix("model:") {
            model = Some(v.to_owned());
        } else if let Some(v) = token.strip_prefix("device:") {
            device = Some(v.to_owned());
        }
    }

    Some(DeviceInfo {
        serial: serial.to_owned(),
        state: DeviceState::parse(&state_tokens.join(" ")),
        transport_id,
        product,
        model,
        device,
    })
}

/// `host:track-devices-l` stream. Never write to it: the server closes trackers
/// that send anything.
pub struct Tracker {
    stream: TcpStream,
}

impl Tracker {
    /// Waits for the next frame. Every frame is the full list and frames can
    /// repeat, so callers diff. EOF means the server went away (e.g. "Restart adb").
    pub async fn next(&mut self) -> Result<Vec<DeviceInfo>, AdbError> {
        let text = read_protocol_string(&mut self.stream)
            .await
            .map_err(AdbError::eof_as_server_closed)?;
        Ok(parse_devices(&text))
    }
}

/// Bounds a request/reply exchange. A server that accepts the connection but
/// never answers (e.g. still initializing USB) must not wedge the caller.
async fn handshake<T>(exchange: impl Future<Output = Result<T, AdbError>>) -> Result<T, AdbError> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, exchange)
        .await
        .map_err(|_| AdbError::Timeout)?
        .map_err(AdbError::eof_as_server_closed)
}

impl AdbServer {
    /// One TCP connection per request: the server closes the socket after
    /// answering any host query.
    async fn connect(&self) -> Result<TcpStream, AdbError> {
        match TcpStream::connect(self.addr).await {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                Ok(stream)
            }
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                Err(AdbError::ServerDown)
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn host_query(&self, request: &str) -> Result<String, AdbError> {
        handshake(async {
            let mut stream = self.connect().await?;
            send_request(&mut stream, request).await?;
            read_status(&mut stream).await?;
            read_protocol_string(&mut stream).await
        })
        .await
    }

    /// Server protocol version (41 for adb 37.x).
    pub async fn version(&self) -> Result<u32, AdbError> {
        let hex = self.host_query("host:version").await?;
        u32::from_str_radix(hex.trim(), 16)
            .map_err(|_| AdbError::Protocol(format!("bad version {hex:?}")))
    }

    pub async fn devices(&self) -> Result<Vec<DeviceInfo>, AdbError> {
        Ok(parse_devices(&self.host_query("host:devices-l").await?))
    }

    pub async fn track_devices(&self) -> Result<Tracker, AdbError> {
        handshake(async {
            let mut stream = self.connect().await?;
            send_request(&mut stream, "host:track-devices-l").await?;
            read_status(&mut stream).await?;
            Ok(Tracker { stream })
        })
        .await
    }

    pub async fn features(&self, sel: &DeviceSel) -> Result<HashSet<String>, AdbError> {
        let request = match sel {
            DeviceSel::Serial(serial) => format!("host-serial:{serial}:features"),
            DeviceSel::TransportId(id) => format!("host-transport-id:{id}:features"),
        };
        let list = self.host_query(&request).await?;
        Ok(list
            .split(',')
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// Switches to the device's transport and opens `service` on it, returning
    /// the raw stream after `OKAY`. `FAIL closed` maps to [`AdbError::Closed`].
    pub async fn open(&self, sel: &DeviceSel, service: &str) -> Result<AdbStream, AdbError> {
        handshake(async {
            let mut stream = self.connect().await?;
            let transport_id = match sel {
                DeviceSel::Serial(serial) => {
                    // tport: OKAY is followed by the transport id as a u64 (LE on x86-64).
                    send_request(&mut stream, &format!("host:tport:serial:{serial}")).await?;
                    read_status(&mut stream).await?;
                    let mut id = [0u8; 8];
                    stream.read_exact(&mut id).await?;
                    u64::from_le_bytes(id)
                }
                DeviceSel::TransportId(id) => {
                    send_request(&mut stream, &format!("host:transport-id:{id}")).await?;
                    read_status(&mut stream).await?;
                    *id
                }
            };
            send_request(&mut stream, service).await?;
            read_status(&mut stream).await?;
            Ok(AdbStream::new(stream, transport_id))
        })
        .await
    }

    /// Returns the server version, starting the server with the SDK's adb
    /// only when nothing is listening. Never spawn a different adb build: a
    /// version mismatch kills the running server (SPEC section 5.7).
    pub async fn ensure_running(&self, adb_exe: &Path) -> Result<u32, AdbError> {
        match self.version().await {
            Err(AdbError::ServerDown) => {}
            other => return other,
        }
        tracing::info!(adb = %adb_exe.display(), "adb server not running; starting it");
        let mut command = tokio::process::Command::new(adb_exe);
        command
            .arg("start-server")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let status = tokio::time::timeout(Duration::from_secs(15), command.status())
            .await
            .map_err(|_| AdbError::Fail("adb start-server timed out".into()))??;
        if !status.success() {
            tracing::warn!(%status, "adb start-server exited with an error");
        }

        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        loop {
            match self.version().await {
                Err(AdbError::ServerDown) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                other => return other,
            }
        }
    }
}

/// Candidate SDK roots: `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then Android
/// Studio's default location (SPEC section 5.7).
pub fn sdk_roots() -> impl Iterator<Item = PathBuf> {
    ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .chain(studio_sdk())
}

#[cfg(windows)]
fn studio_sdk() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("Android").join("Sdk"))
}

#[cfg(target_os = "macos")]
fn studio_sdk() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Android/sdk"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn studio_sdk() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Android/Sdk"))
}

/// An SDK tool's executable name (`adb.exe` on Windows, `adb` elsewhere).
pub fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// The SDK's adb (SPEC section 5.7). Blocking (file checks); call it once at
/// startup.
pub fn find_adb() -> Option<PathBuf> {
    sdk_roots()
        .map(|root| root.join("platform-tools").join(executable("adb")))
        .find(|exe| exe.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_real_gemini_line() {
        // SPEC section 5.2, captured on the Gemini.
        let devices = parse_devices(
            "D055202X2608DD00043    device product:Ranger2K_N model:Gemini1_SE device:MFT2221 transport_id:32\n",
        );
        assert_eq!(
            devices,
            vec![DeviceInfo {
                serial: "D055202X2608DD00043".into(),
                state: DeviceState::Device,
                transport_id: 32,
                product: Some("Ranger2K_N".into()),
                model: Some("Gemini1_SE".into()),
                device: Some("MFT2221".into()),
            }]
        );
    }

    #[test]
    fn parses_several_lines_and_states_without_details() {
        let devices = parse_devices(
            "NDS214NH614F00562      device product:I24D02 model:I24D02 device:Swan2 transport_id:33\n\
             192.168.1.50:5555      unauthorized transport_id:9\n",
        );
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].device.as_deref(), Some("Swan2"));
        assert_eq!(devices[1].serial, "192.168.1.50:5555");
        assert_eq!(devices[1].state, DeviceState::Unauthorized);
        assert_eq!(devices[1].transport_id, 9);
        assert_eq!(devices[1].model, None);
    }

    #[test]
    fn empty_frame_means_no_devices() {
        assert!(parse_devices("").is_empty());
    }

    #[tokio::test]
    async fn empty_tracker_frame_reads_as_no_devices() {
        let mut frame: &[u8] = b"0000";
        let text = read_protocol_string(&mut frame).await.unwrap();
        assert!(parse_devices(&text).is_empty());
    }

    #[test]
    fn keeps_a_multi_word_state() {
        let devices = parse_devices(
            "ABC123                 no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-1 transport_id:4\n",
        );
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].serial, "ABC123");
        assert_eq!(devices[0].transport_id, 4);
        assert!(matches!(
            &devices[0].state,
            DeviceState::NoPermissions(text) if text.starts_with("no permissions (user in plugdev group;")
        ));
    }

    #[test]
    fn skips_lines_without_a_transport_id() {
        assert!(parse_devices("garbage\nABC device\n").is_empty());
    }
}
