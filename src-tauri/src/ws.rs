//! Loopback WebSocket server (SPEC section 8.1).
//!
//! Binds `127.0.0.1:0` at startup and authenticates every connection with a
//! 128-bit random token. The first message on a socket must be the JSON hello
//! `{token, sessionId, role}`; anything else closes it.
//!
//! Roles:
//! - `video`: binary envelopes of a mirror session, consumed by a Web Worker.
//! - `control`: JSON input for a mirror session (SPEC section 9.4).
//! - `echo`: the transport check; echoes every message back.

use std::net::{Ipv4Addr, TcpListener as StdTcpListener};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::mirror::{MirrorHub, Session};
use crate::scrcpy::control::Input;

/// How long a new socket may stay silent before its hello arrives.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// What the UI needs to open sockets. Returned by the `get_endpoint` command.
#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    token: String,
    role: String,
    session_id: Option<String>,
}

/// Binds the listener and starts accepting connections in the background.
pub fn start(app: AppHandle) -> std::io::Result<Endpoint> {
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
            Err(e) => {
                tracing::error!("cannot register WebSocket listener: {e}");
                return;
            }
        };
        loop {
            match listener.accept().await {
                Ok((tcp, _)) => {
                    tauri::async_runtime::spawn(handle(tcp, token.clone(), app.clone()));
                }
                Err(e) => {
                    tracing::warn!("WebSocket accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
    Ok(endpoint)
}

async fn handle(tcp: TcpStream, token: String, app: AppHandle) {
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
        "video" | "control" => {
            let session = hello.session_id.as_deref().and_then(|id| {
                app.try_state::<Arc<MirrorHub>>()
                    .and_then(|hub| hub.session(id))
            });
            match (session, hello.role.as_str()) {
                (Some(session), "video") => video(ws, session).await,
                (Some(session), _) => control(ws, session).await,
                (None, _) => reject(ws, "no such session").await,
            }
        }
        _ => reject(ws, "unknown role").await,
    }
}

async fn reject(mut ws: WebSocketStream<TcpStream>, reason: &'static str) {
    tracing::warn!(reason, "rejected WebSocket client");
    let frame = CloseFrame {
        code: CloseCode::Policy,
        reason: reason.into(),
    };
    let _ = ws.close(Some(frame)).await;
}

async fn echo(mut ws: WebSocketStream<TcpStream>) {
    tracing::info!("echo client authenticated");
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
    tracing::info!("echo client closed after {echoed} message(s)");
}

/// Streams the session's envelopes until the viewer or the session goes away.
async fn video(ws: WebSocketStream<TcpStream>, session: Arc<Session>) {
    tracing::debug!(session = %session.id, "video viewer attached");
    let mut rx = session.attach_viewer();
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            envelope = rx.recv() => match envelope {
                Some(bytes) => {
                    if sink.send(Message::binary(bytes)).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = sink.close().await;
    tracing::debug!(session = %session.id, "video viewer detached");
}

/// Applies JSON input messages in order (TCP keeps them ordered).
async fn control(mut ws: WebSocketStream<TcpStream>, session: Arc<Session>) {
    while let Some(Ok(msg)) = ws.next().await {
        let Message::Text(text) = msg else { continue };
        match serde_json::from_str::<Input>(text.as_str()) {
            Ok(input) => {
                if let Err(e) = session.input(input).await {
                    // e.g. a touch for the pre-rotation size; the next event is fine.
                    tracing::debug!(session = %session.id, "input refused: {e}");
                }
            }
            Err(e) => tracing::warn!(session = %session.id, "bad control message: {e}"),
        }
    }
}

#[tauri::command]
pub fn get_endpoint(endpoint: tauri::State<'_, Endpoint>) -> Endpoint {
    endpoint.inner().clone()
}
