use tokio::io::{AsyncRead, AsyncReadExt};

use super::ScrcpyError;

const MAX_CLIPBOARD: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum DeviceMessage {
    Clipboard(String),
    AckClipboard(u64),
    UhidOutput,
}

/// Not cancel-safe: run it on its own task.
pub async fn read_message<R: AsyncRead + Unpin>(r: &mut R) -> Result<DeviceMessage, ScrcpyError> {
    match r.read_u8().await? {
        0 => {
            let len = r.read_u32().await? as usize;
            if len > MAX_CLIPBOARD {
                return Err(ScrcpyError::Protocol(format!("clipboard of {len} bytes")));
            }
            let mut text = vec![0u8; len];
            r.read_exact(&mut text).await?;
            Ok(DeviceMessage::Clipboard(
                String::from_utf8_lossy(&text).into_owned(),
            ))
        }
        1 => Ok(DeviceMessage::AckClipboard(r.read_u64().await?)),
        2 => {
            let _id = r.read_u16().await?;
            let size = r.read_u16().await? as usize;
            let mut data = vec![0u8; size];
            r.read_exact(&mut data).await?;
            Ok(DeviceMessage::UhidOutput)
        }
        other => Err(ScrcpyError::Protocol(format!(
            "unknown device message {other}"
        ))),
    }
}
