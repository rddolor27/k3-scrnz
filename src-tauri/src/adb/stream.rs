use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

/// A raw full-duplex stream to a device service, opened after a transport switch.
///
/// adb has no half-close (SPEC section 5.1): shutting down the write side makes
/// the server close the whole stream. So `poll_shutdown` only flushes; drop the
/// stream to close it (which also SIGHUPs a shell process on the device).
pub struct AdbStream {
    inner: TcpStream,
    transport_id: u64,
}

impl AdbStream {
    pub(super) fn new(inner: TcpStream, transport_id: u64) -> Self {
        Self {
            inner,
            transport_id,
        }
    }

    pub fn transport_id(&self) -> u64 {
        self.transport_id
    }
}

impl AsyncRead for AdbStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for AdbStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
}
