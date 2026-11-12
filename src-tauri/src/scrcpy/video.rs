use bytes::{BufMut, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt};

use super::ScrcpyError;

pub const K_META: u8 = 0;
pub const K_SESSION: u8 = 1;
pub const K_CONFIG: u8 = 2;
pub const K_FRAME: u8 = 3;
pub const CODEC_H264: u32 = 0x6832_3634;
const MAX_PACKET: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Packet {
    Session {
        width: u32,
        height: u32,
    },
    Media {
        config: bool,
        key: bool,
        pts: u64,
        data: Bytes,
    },
}

pub async fn read_packet<R: AsyncRead + Unpin>(r: &mut R) -> Result<Packet, ScrcpyError> {
    let mut header = [0u8; 12];
    r.read_exact(&mut header).await?;
    let hi = u64::from_be_bytes([
        header[0], header[1], header[2], header[3], header[4], header[5], header[6], header[7],
    ]);
    let lo = u32::from_be_bytes([header[8], header[9], header[10], header[11]]);
    if hi >> 63 == 1 {
        // [flags u32][width u32][height u32], no payload.
        return Ok(Packet::Session {
            width: (hi & 0xFFFF_FFFF) as u32,
            height: lo,
        });
    }
    let len = lo as usize;
    if len > MAX_PACKET {
        return Err(ScrcpyError::Protocol(format!(
            "media packet of {len} bytes"
        )));
    }
    let mut data = vec![0u8; len];
    r.read_exact(&mut data).await?;
    Ok(Packet::Media {
        config: (hi >> 62) & 1 == 1,
        key: (hi >> 61) & 1 == 1,
        pts: hi & 0x1FFF_FFFF_FFFF_FFFF,
        data: Bytes::from(data),
    })
}

/// `value` is the codec id (meta), `w << 32 | h` (session) or the PTS (frame).
pub fn envelope(kind: u8, flags: u8, value: u64, payload: &[u8]) -> Bytes {
    let mut b = BytesMut::with_capacity(12 + payload.len());
    b.put_u8(kind);
    b.put_u8(flags);
    b.put_u16(0);
    b.put_u64(value);
    b.put_slice(payload);
    b.freeze()
}

pub fn codec_string(config: &[u8]) -> Option<String> {
    let mut i = 0;
    while i + 4 < config.len() {
        let start = if config[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if config[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i += 1;
            continue;
        };
        let nal = i + start;
        if config.get(nal).is_some_and(|b| b & 0x1F == 7) {
            let sps = config.get(nal + 1..nal + 4)?;
            return Some(format!("avc1.{:02X}{:02X}{:02X}", sps[0], sps[1], sps[2]));
        }
        i = nal;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// SPEC section 13, captured on the Gemini.
    const MAIN_CONFIG: &str = "000000016764002aac1b1a8078021e9a80808083c2211a800000000168ea43cb";
    const CUSTOMER_CONFIG: &str = "0000000167640028ac1b1a8050065a6a0202020f08846a0000000168ea43cb";

    #[tokio::test]
    async fn demuxes_session_config_key_and_delta() {
        let config = from_hex(MAIN_CONFIG);
        let mut stream = Vec::new();
        // Session packet: flags 0x80000000, width 1920 (0x780), height 1072 (0x430).
        stream.extend(from_hex("800000000000078000000430"));
        // Config: bit 62, PTS 0.
        stream.extend((1u64 << 62).to_be_bytes());
        stream.extend((config.len() as u32).to_be_bytes());
        stream.extend(&config);
        // Key frame (bit 61), PTS 1000, NAL type 5.
        stream.extend(((1u64 << 61) | 1000).to_be_bytes());
        stream.extend(5u32.to_be_bytes());
        stream.extend([0, 0, 0, 1, 0x65]);
        // Delta frame, PTS 2000, NAL type 1.
        stream.extend(2000u64.to_be_bytes());
        stream.extend(5u32.to_be_bytes());
        stream.extend([0, 0, 0, 1, 0x41]);

        let mut r: &[u8] = &stream;
        assert_eq!(
            read_packet(&mut r).await.unwrap(),
            Packet::Session {
                width: 1920,
                height: 1072
            }
        );
        match read_packet(&mut r).await.unwrap() {
            Packet::Media {
                config: true,
                key: false,
                pts: 0,
                data,
            } => assert_eq!(data.as_ref(), config.as_slice()),
            other => panic!("expected config, got {other:?}"),
        }
        assert!(matches!(
            read_packet(&mut r).await.unwrap(),
            Packet::Media {
                config: false,
                key: true,
                pts: 1000,
                ..
            }
        ));
        assert!(matches!(
            read_packet(&mut r).await.unwrap(),
            Packet::Media {
                config: false,
                key: false,
                pts: 2000,
                ..
            }
        ));
    }

    #[test]
    fn codec_strings_from_captured_configs() {
        // SPEC section 15: → avc1.64002A / avc1.640028.
        assert_eq!(
            codec_string(&from_hex(MAIN_CONFIG)).as_deref(),
            Some("avc1.64002A")
        );
        assert_eq!(
            codec_string(&from_hex(CUSTOMER_CONFIG)).as_deref(),
            Some("avc1.640028")
        );
    }

    #[test]
    fn builds_envelopes() {
        let env = envelope(K_SESSION, 0, (1920u64 << 32) | 1072, &[]);
        assert_eq!(
            env.as_ref(),
            &[1, 0, 0, 0, 0, 0, 0x07, 0x80, 0, 0, 0x04, 0x30]
        );
        let frame = envelope(K_FRAME, 1, 7, &[9]);
        assert_eq!(frame.as_ref(), &[3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 9]);
    }
}
