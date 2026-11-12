pub mod control;
pub mod device_msg;
pub mod server;
pub mod video;

use thiserror::Error;

use crate::adb::AdbError;

/// Must equal the bundled server's version exactly.
pub const SERVER_VERSION: &str = "5.0.1";
pub const SERVER_RESOURCE: &str = "scrcpy-server-v5.0.1";

#[derive(Debug, Error)]
pub enum ScrcpyError {
    #[error(transparent)]
    Adb(#[from] AdbError),
    #[error("scrcpy protocol error: {0}")]
    Protocol(String),
    #[error("scrcpy-server did not start: {0}")]
    Start(String),
    #[error("timed out waiting for {0}")]
    Timeout(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
