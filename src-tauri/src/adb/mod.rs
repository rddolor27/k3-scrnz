//! Hand-rolled async client for the adb server protocol (SPEC section 5).
//!
//! Talks to the adb server that is already running on `127.0.0.1:5037` (Android
//! Studio's). It never spawns adb per command, and only starts the server with
//! the SDK's own `adb.exe` when nothing is listening (section 5.7).

mod error;
mod framing;
mod host;
mod shell;
mod stream;
mod sync;

pub use error::AdbError;
pub use host::{AdbServer, DeviceInfo, DeviceSel, DeviceState, Tracker, find_adb, sdk_roots};
pub use shell::{ShellEvent, ShellOutput, ShellProcess, shell, shell_quote, shell_spawn};
pub use stream::AdbStream;
pub use sync::{MODE_FILE_0644, pull, push};
