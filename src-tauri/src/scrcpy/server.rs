//! Starting scrcpy-server on the device and connecting its sockets (SPEC
//! sections 6.1, 6.2) and cleaning up after it (6.7).

use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::time::Instant;

use super::video::CODEC_H264;
use super::{SERVER_VERSION, ScrcpyError};
use crate::adb::{
    self, AdbError, AdbServer, AdbStream, DeviceSel, MODE_FILE_0644, ShellProcess, shell_quote,
};

/// `FAIL closed` on the socket means nothing listens yet: retry this often...
const CONNECT_RETRY: Duration = Duration::from_millis(100);
/// ...for this long (the Gemini needed about 1.3 s).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Options {
    pub display_id: u32,
    pub max_size: u32,
    pub max_fps: u32,
    pub bit_rate: u32,
    /// The main session wakes the screen and syncs the clipboard; the customer
    /// session only watches.
    pub main: bool,
}

pub struct Connected {
    pub video: AdbStream,
    pub control: AdbStream,
    pub device_name: String,
}

/// Per-session jar: the server's cleanup deletes its own jar, so two sessions
/// never delete each other's.
fn jar_path(scid: u32) -> String {
    format!("/data/local/tmp/scrcpy-server-{scid:08x}.jar")
}

fn socket_name(scid: u32) -> String {
    format!("localabstract:scrcpy_{scid:08x}")
}

/// `key=value` arguments (SPEC section 6.1). `audio=false` is required (audio
/// would add a third socket). Global settings such as `stay_awake` are left at
/// their defaults on purpose.
fn server_args(scid: u32, o: &Options) -> String {
    [
        format!("scid={scid:08x}"),
        "log_level=info".into(),
        "tunnel_forward=true".into(),
        "audio=false".into(),
        "control=true".into(),
        format!("display_id={}", o.display_id),
        "video_codec=h264".into(),
        format!("max_size={}", o.max_size),
        format!("max_fps={}", o.max_fps),
        format!("video_bit_rate={}", o.bit_rate),
        format!("power_on={}", o.main),
        format!("clipboard_autosync={}", o.main),
        "cleanup=true".into(),
    ]
    .join(" ")
}

/// Pushes the server and starts it over shell v2. Keep the returned process
/// alive for the whole session: closing it kills the server.
pub async fn start(
    server: &AdbServer,
    sel: &DeviceSel,
    jar: &[u8],
    scid: u32,
    options: &Options,
) -> Result<ShellProcess, ScrcpyError> {
    let path = jar_path(scid);
    adb::push(server, sel, jar, &path, MODE_FILE_0644).await?;
    let cmd = format!(
        "CLASSPATH={} app_process / com.genymobile.scrcpy.Server {SERVER_VERSION} {}",
        shell_quote(&path),
        server_args(scid, options)
    );
    match adb::shell_spawn(server, sel, &cmd).await {
        Ok(shell) => Ok(shell),
        Err(e) => {
            let _ = adb::shell(server, sel, &format!("rm -f {}", shell_quote(&path))).await;
            Err(e.into())
        }
    }
}

/// Removes our jars left behind by sessions that were killed mid-start (the app
/// closed during a push). Run once per device per app run, before its first
/// push, so no live session of ours can own one yet.
pub async fn sweep_stale_jars(server: &AdbServer, sel: &DeviceSel) {
    let cmd = "rm -f /data/local/tmp/scrcpy-server-????????.jar";
    if let Err(e) = adb::shell(server, sel, cmd).await {
        tracing::debug!("stale jar sweep failed: {e}");
    }
}

async fn timed<T>(
    read: impl Future<Output = std::io::Result<T>>,
    what: &'static str,
) -> Result<T, ScrcpyError> {
    tokio::time::timeout(READ_TIMEOUT, read)
        .await
        .map_err(|_| ScrcpyError::Timeout(what))?
        .map_err(ScrcpyError::from)
}

/// Video socket (retrying `FAIL closed`), its dummy byte, the control socket
/// right away, then the 64-byte device name and the codec id (SPEC section 6.2).
pub async fn connect(
    server: &AdbServer,
    sel: &DeviceSel,
    scid: u32,
) -> Result<Connected, ScrcpyError> {
    let socket = socket_name(scid);
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut video = loop {
        match server.open(sel, &socket).await {
            Ok(stream) => break stream,
            Err(AdbError::Closed) if Instant::now() < deadline => {
                tokio::time::sleep(CONNECT_RETRY).await;
            }
            Err(AdbError::Closed) => {
                return Err(ScrcpyError::Start("its socket never opened".into()));
            }
            Err(e) => return Err(e.into()),
        }
    };
    let mut dummy = [0u8; 1];
    timed(video.read_exact(&mut dummy), "the dummy byte").await?;
    let control = server.open(sel, &socket).await?;

    // Sent only after all sockets are connected.
    let mut name = [0u8; 64];
    timed(video.read_exact(&mut name), "the device name").await?;
    let codec = timed(video.read_u32(), "the codec id").await?;
    if codec != CODEC_H264 {
        return Err(ScrcpyError::Protocol(format!(
            "unexpected codec {codec:#010x}"
        )));
    }
    let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
    Ok(Connected {
        video,
        control,
        device_name: String::from_utf8_lossy(&name[..end]).into_owned(),
    })
}

/// Kills a server that outlived its streams and removes its jar (SPEC section
/// 6.7). The bracket in the pattern keeps `pkill -f` from matching the `sh -c`
/// that runs it.
pub async fn kill_leftover(server: &AdbServer, sel: &DeviceSel, scid: u32) {
    let hex = format!("{scid:08x}");
    let pattern = format!("scid=[{}]{}", &hex[..1], &hex[1..]);
    match adb::shell(server, sel, &format!("pkill -f {}", shell_quote(&pattern))).await {
        Ok(out) if out.exit_code == Some(0) => {
            tracing::info!(scid = %hex, "killed a leftover scrcpy-server");
        }
        Ok(_) => {} // nothing left over, the normal case
        Err(e) => tracing::debug!(scid = %hex, "leftover check failed: {e}"),
    }
    let _ = adb::shell(
        server,
        sel,
        &format!("rm -f {}", shell_quote(&jar_path(scid))),
    )
    .await;
}
