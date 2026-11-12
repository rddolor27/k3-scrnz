//! `sync:` file push (SPEC section 5.5) and pull. Every integer is little-endian
//! and the ids are literal ASCII.

use std::time::{SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{AdbError, AdbServer, DeviceSel};

/// Regular file, 0644 (`0o100644`), sent in decimal as adb does.
pub const MODE_FILE_0644: u32 = 0o100_644;
/// adbd's `SYNC_DATA_MAX`.
const DATA_MAX: usize = 64 * 1024;
/// adbd rejects longer paths with "path too long".
const PATH_MAX: usize = 1024;
/// A pull that receives nothing for this long is stuck.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `SEND` + `"<remote>,<mode>"`, `DATA` chunks of at most 64 KiB, `DONE` + mtime.
fn encode_send(bytes: &[u8], remote: &str, mode: u32, mtime: u32) -> Result<Vec<u8>, AdbError> {
    // adbd's limit applies to the whole "<remote>,<mode>" string.
    let target = format!("{remote},{mode}");
    if target.len() > PATH_MAX {
        return Err(AdbError::Sync(format!("remote path too long: {remote}")));
    }
    let mut buf =
        Vec::with_capacity(16 + target.len() + bytes.len() + 8 * bytes.len().div_ceil(DATA_MAX));
    buf.extend_from_slice(b"SEND");
    buf.extend_from_slice(&len_u32(target.len())?.to_le_bytes());
    buf.extend_from_slice(target.as_bytes());
    for chunk in bytes.chunks(DATA_MAX) {
        buf.extend_from_slice(b"DATA");
        buf.extend_from_slice(&len_u32(chunk.len())?.to_le_bytes());
        buf.extend_from_slice(chunk);
    }
    buf.extend_from_slice(b"DONE");
    buf.extend_from_slice(&mtime.to_le_bytes());
    Ok(buf)
}

fn len_u32(len: usize) -> Result<u32, AdbError> {
    u32::try_from(len).map_err(|_| AdbError::Sync("length exceeds u32".into()))
}

/// `OKAY` + `00000000`, or `FAIL` + u32 length + message.
async fn read_status<R: AsyncRead + Unpin>(r: &mut R) -> Result<(), AdbError> {
    let mut header = [0u8; 8];
    r.read_exact(&mut header).await?;
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    match &header[..4] {
        b"OKAY" => Ok(()),
        b"FAIL" if len <= PATH_MAX * 4 => {
            let mut message = vec![0u8; len];
            r.read_exact(&mut message).await?;
            Err(AdbError::Sync(
                String::from_utf8_lossy(&message).into_owned(),
            ))
        }
        other => Err(AdbError::Protocol(format!(
            "unexpected sync reply {other:02x?}"
        ))),
    }
}

/// Pushes `bytes` to `remote` on the device and ends the sync session with `QUIT`.
pub async fn push(
    server: &AdbServer,
    sel: &DeviceSel,
    bytes: &[u8],
    remote: &str,
    mode: u32,
) -> Result<(), AdbError> {
    let mtime = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
        .unwrap_or(0);
    let request = encode_send(bytes, remote, mode, mtime)?;
    let mut stream = server.open(sel, "sync:").await?;
    stream.write_all(&request).await?;
    read_status(&mut stream).await?;
    stream.write_all(b"QUIT\0\0\0\0").await?;
    Ok(())
}

/// Pulls `remote` from the device into `out` (`RECV` v1: `DATA` chunks of at
/// most 64 KiB, then an 8-byte `DONE`, or `FAIL` + message). Returns the size.
pub async fn pull<W: AsyncWrite + Unpin>(
    server: &AdbServer,
    sel: &DeviceSel,
    remote: &str,
    out: &mut W,
) -> Result<u64, AdbError> {
    if remote.len() > PATH_MAX {
        return Err(AdbError::Sync(format!("remote path too long: {remote}")));
    }
    let mut request = Vec::with_capacity(8 + remote.len());
    request.extend_from_slice(b"RECV");
    request.extend_from_slice(&len_u32(remote.len())?.to_le_bytes());
    request.extend_from_slice(remote.as_bytes());

    let mut stream = server.open(sel, "sync:").await?;
    stream.write_all(&request).await?;
    let mut chunk = vec![0u8; DATA_MAX];
    let mut total = 0u64;
    loop {
        let mut header = [0u8; 8];
        read_within(&mut stream, &mut header).await?;
        let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        match &header[..4] {
            b"DATA" if len <= DATA_MAX => {
                read_within(&mut stream, &mut chunk[..len]).await?;
                out.write_all(&chunk[..len]).await?;
                total += len as u64;
            }
            b"DONE" => break,
            b"FAIL" if len <= PATH_MAX * 4 => {
                let mut message = vec![0u8; len];
                stream.read_exact(&mut message).await?;
                return Err(AdbError::Sync(
                    String::from_utf8_lossy(&message).into_owned(),
                ));
            }
            other => {
                return Err(AdbError::Protocol(format!(
                    "unexpected sync reply {other:02x?}"
                )));
            }
        }
    }
    // The file is complete; a failed QUIT changes nothing.
    let _ = stream.write_all(b"QUIT\0\0\0\0").await;
    out.flush().await?;
    Ok(total)
}

/// `read_exact` that fails when the device sends nothing for [`IDLE_TIMEOUT`]
/// (a hung FUSE read), and reports EOF as the stream closing.
async fn read_within<R: AsyncRead + Unpin>(r: &mut R, buf: &mut [u8]) -> Result<(), AdbError> {
    match tokio::time::timeout(IDLE_TIMEOUT, r.read_exact(buf)).await {
        Err(_) => Err(AdbError::Timeout),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => Err(AdbError::Closed),
        Ok(result) => result.map(|_| ()).map_err(AdbError::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_small_file() {
        let bytes = encode_send(b"hi", "/data/local/tmp/x", MODE_FILE_0644, 0x0102_0304).unwrap();
        let target = b"/data/local/tmp/x,33188";
        let mut expected = Vec::new();
        expected.extend_from_slice(b"SEND");
        expected.extend_from_slice(&(target.len() as u32).to_le_bytes());
        expected.extend_from_slice(target);
        expected.extend_from_slice(b"DATA\x02\x00\x00\x00hi");
        expected.extend_from_slice(b"DONE\x04\x03\x02\x01");
        assert_eq!(bytes, expected);
        assert_eq!(&bytes[4..8], &[23, 0, 0, 0]);
    }

    #[test]
    fn splits_data_into_64k_chunks() {
        let bytes = encode_send(&vec![7u8; DATA_MAX + 1], "/x", MODE_FILE_0644, 0).unwrap();
        let first = 8 + "/x,33188".len();
        assert_eq!(&bytes[first..first + 8], b"DATA\x00\x00\x01\x00");
        let second = first + 8 + DATA_MAX;
        assert_eq!(&bytes[second..second + 9], b"DATA\x01\x00\x00\x00\x07");
        assert_eq!(&bytes[bytes.len() - 8..bytes.len() - 4], b"DONE");
    }

    #[tokio::test]
    async fn reads_okay_and_fail_replies() {
        let mut okay: &[u8] = b"OKAY\0\0\0\0";
        read_status(&mut okay).await.unwrap();

        let message = b"couldn't create file: Permission denied";
        let mut fail = b"FAIL".to_vec();
        fail.extend_from_slice(&(message.len() as u32).to_le_bytes());
        fail.extend_from_slice(message);
        let mut fail: &[u8] = &fail;
        assert!(matches!(
            read_status(&mut fail).await,
            Err(AdbError::Sync(m)) if m == "couldn't create file: Permission denied"
        ));
    }
}
