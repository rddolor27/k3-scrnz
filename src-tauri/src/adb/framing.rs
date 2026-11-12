//! Smart-socket framing (SPEC section 5.1): requests are `hex4 length + payload`,
//! replies are `OKAY`, `FAIL` + protocol string, or a protocol string.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::AdbError;

/// The length has 4 hex digits, so a request is at most 0xFFFF bytes.
const MAX_REQUEST: usize = 0xFFFF;

pub fn encode_request(payload: &str) -> Result<Vec<u8>, AdbError> {
    if payload.is_empty() || payload.len() > MAX_REQUEST {
        return Err(AdbError::Protocol(format!(
            "request length {} out of range",
            payload.len()
        )));
    }
    let mut buf = format!("{:04x}", payload.len()).into_bytes();
    buf.extend_from_slice(payload.as_bytes());
    Ok(buf)
}

pub fn parse_hex4(digits: &[u8; 4]) -> Result<usize, AdbError> {
    let invalid = || AdbError::Protocol(format!("bad length prefix {digits:02x?}"));
    if !digits.iter().all(u8::is_ascii_hexdigit) {
        return Err(invalid());
    }
    let text = std::str::from_utf8(digits).map_err(|_| invalid())?;
    usize::from_str_radix(text, 16).map_err(|_| invalid())
}

pub async fn send_request<W: AsyncWrite + Unpin>(w: &mut W, payload: &str) -> Result<(), AdbError> {
    w.write_all(&encode_request(payload)?).await?;
    Ok(())
}

/// Reads `OKAY`, or `FAIL` + reason (mapped to an [`AdbError`]).
pub async fn read_status<R: AsyncRead + Unpin>(r: &mut R) -> Result<(), AdbError> {
    let mut status = [0u8; 4];
    r.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => Err(AdbError::from_fail(read_protocol_string(r).await?)),
        other => Err(AdbError::Protocol(format!(
            "unexpected status {other:02x?}"
        ))),
    }
}

/// Reads `hex4 length + bytes`. Non-UTF-8 bytes are replaced.
pub async fn read_protocol_string<R: AsyncRead + Unpin>(r: &mut R) -> Result<String, AdbError> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let mut data = vec![0u8; parse_hex4(&len)?];
    r.read_exact(&mut data).await?;
    Ok(String::from_utf8_lossy(&data).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_hex4_requests() {
        assert_eq!(encode_request("host:version").unwrap(), b"000chost:version");
        assert_eq!(
            encode_request("host:tport:serial:D055202X2608DD00043").unwrap(),
            b"0025host:tport:serial:D055202X2608DD00043"
        );
        assert!(encode_request("").is_err());
        assert!(encode_request(&"x".repeat(0x1_0000)).is_err());
    }

    #[test]
    fn parses_hex4_lengths() {
        assert_eq!(parse_hex4(b"0029").unwrap(), 41);
        assert_eq!(parse_hex4(b"FFFF").unwrap(), 0xFFFF);
        assert!(parse_hex4(b"00g1").is_err());
        assert!(parse_hex4(b"+001").is_err());
    }

    #[tokio::test]
    async fn reads_okay_and_protocol_string() {
        // host:version reply validated on the Gemini (SPEC section 5.2).
        let mut reply: &[u8] = b"OKAY00040029";
        read_status(&mut reply).await.unwrap();
        assert_eq!(read_protocol_string(&mut reply).await.unwrap(), "0029");
    }

    #[tokio::test]
    async fn maps_fail_reasons() {
        let fail = |reason: &str| format!("FAIL{:04x}{reason}", reason.len()).into_bytes();

        let mut r: &[u8] = &fail("closed");
        assert!(matches!(read_status(&mut r).await, Err(AdbError::Closed)));

        let mut r: &[u8] = &fail("device offline (no transport)");
        assert!(matches!(read_status(&mut r).await, Err(AdbError::Offline)));

        let unauthorized = "device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set\nTry 'adb kill-server' if that seems wrong.\nOtherwise check for a confirmation dialog on your device.";
        let mut r: &[u8] = &fail(unauthorized);
        assert!(matches!(
            read_status(&mut r).await,
            Err(AdbError::Unauthorized)
        ));

        let mut r: &[u8] = &fail("device 'ABC' not found");
        assert!(matches!(
            read_status(&mut r).await,
            Err(AdbError::NotFound(_))
        ));

        let mut r: &[u8] = &fail("unknown host service 'host:nope'");
        assert!(matches!(read_status(&mut r).await, Err(AdbError::Fail(_))));
    }

    #[tokio::test]
    async fn rejects_unknown_status() {
        let mut r: &[u8] = b"WHAT";
        assert!(matches!(
            read_status(&mut r).await,
            Err(AdbError::Protocol(_))
        ));
    }
}
