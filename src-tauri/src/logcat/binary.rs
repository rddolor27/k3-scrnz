use bytes::{Buf, BytesMut};

use super::LogcatError;

const PREFIX_LEN: usize = 4;
/// Header through `nsec`; `lid` and `uid` only exist in newer, larger headers.
const MIN_HDR_SIZE: usize = 20;
const UID_HDR_SIZE: usize = 28;
/// Real headers are 20 to 28 bytes; past this the stream has lost sync.
const MAX_HDR_SIZE: usize = 128;

#[derive(Debug, PartialEq, Eq)]
pub struct Record {
    pub pid: i32,
    pub tid: u32,
    pub sec: u32,
    pub nsec: u32,
    pub uid: u32,
    pub level: u8,
    pub tag: String,
    pub msg: String,
}

#[derive(Default)]
pub struct Parser {
    buf: BytesMut,
}

impl Parser {
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    pub fn next_record(&mut self) -> Result<Option<Record>, LogcatError> {
        loop {
            let Some(prefix) = self.buf.get(..PREFIX_LEN) else {
                return Ok(None);
            };
            let len = usize::from(u16::from_le_bytes(bytes_at(prefix, 0)));
            let hdr_size = usize::from(u16::from_le_bytes(bytes_at(prefix, 2)));
            if !(MIN_HDR_SIZE..=MAX_HDR_SIZE).contains(&hdr_size) {
                return Err(LogcatError::Malformed(format!("hdr_size {hdr_size}")));
            }
            let total = hdr_size + len;
            let Some(record) = self.buf.get(..total) else {
                return Ok(None);
            };
            // Always skip by hdr_size, never by a hard-coded 28.
            let parsed = record
                .split_at_checked(hdr_size)
                .and_then(|(header, payload)| parse_record(header, payload));
            self.buf.advance(total);
            if let Some(record) = parsed {
                return Ok(Some(record));
            }
        }
    }
}

fn parse_record(header: &[u8], payload: &[u8]) -> Option<Record> {
    let (&level, rest) = payload.split_first()?;
    let tag_end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    let (tag, after_tag) = rest.split_at_checked(tag_end)?;
    // `after_tag` starts with the tag's NUL; a truncated record has none.
    let msg = after_tag.get(1..).unwrap_or_default();
    let msg = msg.strip_suffix(&[0]).unwrap_or(msg);
    Some(Record {
        pid: i32::from_le_bytes(bytes_at(header, 4)),
        tid: u32::from_le_bytes(bytes_at(header, 8)),
        sec: u32::from_le_bytes(bytes_at(header, 12)),
        nsec: u32::from_le_bytes(bytes_at(header, 16)),
        uid: if header.len() >= UID_HDR_SIZE {
            u32::from_le_bytes(bytes_at(header, 24))
        } else {
            u32::MAX
        },
        level,
        tag: String::from_utf8_lossy(tag).into_owned(),
        msg: String::from_utf8_lossy(msg).into_owned(),
    })
}

fn bytes_at<const N: usize>(bytes: &[u8], at: usize) -> [u8; N] {
    let mut out = [0u8; N];
    if let Some(src) = bytes.get(at..at + N) {
        out.copy_from_slice(src);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PID: i32 = 1234;
    const TID: u32 = 1250;
    const SEC: u32 = 1_762_841_002;
    const NSEC: u32 = 517_000_000;
    const UID: u32 = 10162;

    /// A record with the given header size; bytes past the 28 known ones are
    /// filler a parser must skip.
    fn record(hdr_size: u16, level: u8, tag: &str, msg: &str) -> Vec<u8> {
        let mut payload = vec![level];
        payload.extend_from_slice(tag.as_bytes());
        payload.push(0);
        payload.extend_from_slice(msg.as_bytes());
        payload.push(0);

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&hdr_size.to_le_bytes());
        bytes.extend_from_slice(&PID.to_le_bytes());
        bytes.extend_from_slice(&TID.to_le_bytes());
        bytes.extend_from_slice(&SEC.to_le_bytes());
        bytes.extend_from_slice(&NSEC.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes()); // lid: main
        bytes.extend_from_slice(&UID.to_le_bytes());
        bytes.resize(usize::from(hdr_size), 0xEE);
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn drain(parser: &mut Parser) -> Vec<Record> {
        let mut out = Vec::new();
        while let Some(record) = parser.next_record().unwrap() {
            out.push(record);
        }
        out
    }

    #[test]
    fn parses_a_28_byte_header_with_a_multi_line_message() {
        let msg =
            "FATAL EXCEPTION: main\nProcess: pos.kulay.pos, PID: 1234\n\tat a.b.C.d(C.java:1)";
        let mut parser = Parser::default();
        parser.push(&record(28, 6, "AndroidRuntime", msg));

        assert_eq!(
            drain(&mut parser),
            [Record {
                pid: PID,
                tid: TID,
                sec: SEC,
                nsec: NSEC,
                uid: UID,
                level: 6,
                tag: "AndroidRuntime".into(),
                msg: msg.into(),
            }]
        );
    }

    #[test]
    fn a_record_split_across_packets_is_emitted_once_complete() {
        let mut bytes = record(28, 4, "First", "one\ntwo");
        bytes.extend_from_slice(&record(28, 5, "Second", "three"));

        // Split inside the prefix, the header, the payload and between records.
        for split in 0..=bytes.len() {
            let mut parser = Parser::default();
            let mut records = Vec::new();
            parser.push(&bytes[..split]);
            records.extend(drain(&mut parser));
            parser.push(&bytes[split..]);
            records.extend(drain(&mut parser));

            let tags: Vec<&str> = records.iter().map(|r| r.tag.as_str()).collect();
            assert_eq!(tags, ["First", "Second"], "split at {split}");
            assert_eq!(records[0].msg, "one\ntwo");
            assert_eq!(records[1].msg, "three");
        }
    }

    #[test]
    fn skips_a_larger_header_by_hdr_size() {
        let mut bytes = record(36, 4, "Big", "after the filler");
        bytes.extend_from_slice(&record(28, 3, "Next", "still in sync"));
        let mut parser = Parser::default();
        parser.push(&bytes);

        let records = drain(&mut parser);
        assert_eq!(records.len(), 2);
        assert_eq!((records[0].tag.as_str(), records[0].uid), ("Big", UID));
        assert_eq!(records[0].msg, "after the filler");
        assert_eq!(records[1].tag, "Next");
        assert_eq!(records[1].msg, "still in sync");
    }
}
