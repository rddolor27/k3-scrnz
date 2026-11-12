use thiserror::Error;

/// Errors from the adb client (SPEC section 5.6).
#[derive(Debug, Error)]
pub enum AdbError {
    #[error("adb server is not running on 127.0.0.1:5037")]
    ServerDown,
    #[error("the adb server closed the connection")]
    ServerClosed,
    #[error("the adb server did not answer in time")]
    Timeout,
    #[error("adb: {0}")]
    Fail(String),
    #[error("{0}")]
    NotFound(String),
    /// `device still authorizing` / `device still connecting`: retry later.
    #[error("{0}")]
    NotReady(String),
    /// `more than one device ...`: select by transport id instead.
    #[error("{0}")]
    Ambiguous(String),
    #[error("device unauthorized: accept the USB debugging prompt on the device")]
    Unauthorized,
    #[error("device offline")]
    Offline,
    #[error("stream closed by the device")]
    Closed,
    #[error("sync failed: {0}")]
    Sync(String),
    #[error("adb protocol error: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AdbError {
    /// Maps a server `FAIL` reason to a variant. Only prefixes are matched: the
    /// unauthorized message is multi-line and the offline one has a suffix.
    pub fn from_fail(reason: String) -> Self {
        if reason == "closed" {
            Self::Closed
        } else if reason.starts_with("device offline") {
            Self::Offline
        } else if reason.starts_with("device unauthorized") {
            Self::Unauthorized
        } else if reason.starts_with("device still") {
            Self::NotReady(reason)
        } else if reason.starts_with("more than one") {
            Self::Ambiguous(reason)
        } else if (reason.starts_with("device '") && reason.ends_with("' not found"))
            || reason.starts_with("no devices")
            || reason.starts_with("no device with transport id")
        {
            Self::NotFound(reason)
        } else {
            Self::Fail(reason)
        }
    }

    /// EOF from the server means it went away (e.g. Android Studio's "Restart adb").
    pub(super) fn eof_as_server_closed(self) -> Self {
        match self {
            Self::Io(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Self::ServerClosed,
            other => other,
        }
    }
}
