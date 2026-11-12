use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use super::{AdbError, AdbServer, AdbStream, DeviceSel};

const ID_STDIN: u8 = 0;
const ID_STDOUT: u8 = 1;
const ID_STDERR: u8 = 2;
const ID_EXIT: u8 = 3;
const ID_CLOSE_STDIN: u8 = 4;
const MAX_PACKET: usize = 16 * 1024 * 1024;
const STDIN_CHUNK: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ShellEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Exit(u8),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ShellOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<u8>,
}

fn encode_packet(id: u8, payload: &[u8]) -> Result<Vec<u8>, AdbError> {
    let len = u32::try_from(payload.len())
        .map_err(|_| AdbError::Protocol("shell packet too large".into()))?;
    let mut packet = Vec::with_capacity(5 + payload.len());
    packet.push(id);
    packet.extend_from_slice(&len.to_le_bytes());
    packet.extend_from_slice(payload);
    Ok(packet)
}

async fn read_packet<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<(u8, Vec<u8>)>, AdbError> {
    let mut header = [0u8; 5];
    if r.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    r.read_exact(&mut header[1..]).await?;
    let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_PACKET {
        return Err(AdbError::Protocol(format!("shell packet of {len} bytes")));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    Ok(Some((header[0], payload)))
}

fn to_event(id: u8, payload: Vec<u8>) -> Result<ShellEvent, AdbError> {
    match id {
        ID_STDOUT => Ok(ShellEvent::Stdout(payload)),
        ID_STDERR => Ok(ShellEvent::Stderr(payload)),
        ID_EXIT => payload
            .first()
            .map(|code| ShellEvent::Exit(*code))
            .ok_or_else(|| AdbError::Protocol("empty exit packet".into())),
        other => Err(AdbError::Protocol(format!(
            "unexpected shell packet id {other}"
        ))),
    }
}

pub struct ShellProcess {
    stream: AdbStream,
}

impl ShellProcess {
    /// Not cancel-safe: dropping the future mid-packet desyncs the stream.
    pub async fn next_event(&mut self) -> Result<Option<ShellEvent>, AdbError> {
        match read_packet(&mut self.stream).await? {
            Some((id, payload)) => to_event(id, payload).map(Some),
            None => Ok(None),
        }
    }

    pub async fn write_stdin(&mut self, data: &[u8]) -> Result<(), AdbError> {
        for chunk in data.chunks(STDIN_CHUNK) {
            self.stream
                .write_all(&encode_packet(ID_STDIN, chunk)?)
                .await?;
        }
        Ok(())
    }

    /// Never half-close the socket instead.
    pub async fn close_stdin(&mut self) -> Result<(), AdbError> {
        self.stream
            .write_all(&encode_packet(ID_CLOSE_STDIN, &[])?)
            .await?;
        Ok(())
    }
}

pub async fn shell_spawn(
    server: &AdbServer,
    sel: &DeviceSel,
    cmd: &str,
) -> Result<ShellProcess, AdbError> {
    let stream = server.open(sel, &format!("shell,v2,raw:{cmd}")).await?;
    Ok(ShellProcess { stream })
}

pub async fn shell(
    server: &AdbServer,
    sel: &DeviceSel,
    cmd: &str,
) -> Result<ShellOutput, AdbError> {
    let mut process = shell_spawn(server, sel, cmd).await?;
    let mut output = ShellOutput::default();
    while let Some(event) = process.next_event().await? {
        match event {
            ShellEvent::Stdout(data) => output.stdout.extend_from_slice(&data),
            ShellEvent::Stderr(data) => output.stderr.extend_from_slice(&data),
            ShellEvent::Exit(code) => {
                output.exit_code = Some(code);
                break;
            }
        }
    }
    Ok(output)
}

pub fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn decodes_stdout_and_exit_packets() {
        // SPEC section 15: `01 03000000 'h' 'i' '\n'`, `03 01000000 00`.
        let mut bytes: &[u8] = &[
            0x01, 0x03, 0x00, 0x00, 0x00, b'h', b'i', b'\n', //
            0x03, 0x01, 0x00, 0x00, 0x00, 0x00,
        ];
        let (id, payload) = read_packet(&mut bytes).await.unwrap().unwrap();
        assert_eq!(
            to_event(id, payload).unwrap(),
            ShellEvent::Stdout(b"hi\n".to_vec())
        );
        let (id, payload) = read_packet(&mut bytes).await.unwrap().unwrap();
        assert_eq!(to_event(id, payload).unwrap(), ShellEvent::Exit(0));
        assert_eq!(read_packet(&mut bytes).await.unwrap(), None);
    }

    #[tokio::test]
    async fn eof_inside_a_packet_is_an_error() {
        let mut bytes: &[u8] = &[0x01, 0x03, 0x00, 0x00, 0x00, b'h'];
        assert!(read_packet(&mut bytes).await.is_err());
    }

    #[test]
    fn encodes_client_packets() {
        assert_eq!(encode_packet(ID_CLOSE_STDIN, &[]).unwrap(), [4, 0, 0, 0, 0]);
        assert_eq!(
            encode_packet(ID_STDIN, b"ok").unwrap(),
            [0, 2, 0, 0, 0, b'o', b'k']
        );
    }

    #[test]
    fn quotes_like_adb() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
