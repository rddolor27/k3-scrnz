//! Loopback WebSocket server (spec section 8.1).
//!
//! Binds `127.0.0.1:0` at startup and authenticates every connection with a 128-bit
//! random token. The first message on a socket must be the JSON hello
//! `{token, sessionId, role}`; anything else closes it.
//!
//! Roles:
//! - `video` / `control`: per-session mirror streams, wired up in M2.
//! - `echo`: the M0 transport check. Echoes every message back, which proves the page
//!   can reach this port from a release build (Chromium Local Network Access).

use std::net::{Ipv4Addr, TcpListener as StdTcpListener};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// How long a new socket may stay silent before its hello arrives.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// What the UI needs to open sockets. Returned by the `get_endpoint` command.
#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// First message on every socket. The UI also sends `sessionId`; it is read once the
/// video and control roles exist (M2).
#[derive(Deserialize)]
struct Hello {
    token: String,
    role: String,
}

/// Binds the listener and starts accepting connections in the background.
pub fn start() -> std::io::Result<Endpoint> {
    let std_listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    std_listener.set_nonblocking(true)?;
    let port = std_listener.local_addr()?.port();
    let token = format!("{:032x}", rand::random::<u128>());
    let endpoint = Endpoint {
        port,
        token: token.clone(),
    };

    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(e) => return eprintln!("[ws] cannot register listener: {e}"),
        };
        loop {
            match listener.accept().await {
                Ok((tcp, _)) => {
                    tauri::async_runtime::spawn(handle(tcp, token.clone()));
                }
                Err(e) => {
                    eprintln!("[ws] accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
    Ok(endpoint)
}

async fn handle(tcp: TcpStream, token: String) {
    let _ = tcp.set_nodelay(true);
    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
        return;
    };

    let hello = match tokio::time::timeout(HELLO_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Hello>(text.as_str()).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|h| h.token == token) else {
        return reject(ws, "bad hello").await;
    };

    match hello.role.as_str() {
        "echo" => echo(ws).await,
        // M2: attach to the mirror session named by the hello's sessionId.
        "video" | "control" => reject(ws, "no such session").await,
        _ => reject(ws, "unknown role").await,
    }
}

async fn reject(mut ws: WebSocketStream<TcpStream>, reason: &'static str) {
    let frame = CloseFrame {
        code: CloseCode::Policy,
        reason: reason.into(),
    };
    let _ = ws.close(Some(frame)).await;
}

async fn echo(mut ws: WebSocketStream<TcpStream>) {
    eprintln!("[ws] echo client authenticated");
    let mut echoed = 0usize;
    while let Some(Ok(msg)) = ws.next().await {
        // tungstenite answers pings and close frames itself.
        if !(msg.is_text() || msg.is_binary()) {
            continue;
        }
        if ws.send(msg).await.is_err() {
            break;
        }
        echoed += 1;
    }
    eprintln!("[ws] echo client closed after {echoed} message(s)");
}

#[tauri::command]
pub fn get_endpoint(endpoint: tauri::State<'_, Endpoint>) -> Endpoint {
    endpoint.inner().clone()
}
