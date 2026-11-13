use std::sync::Arc;

use tokio::sync::mpsc::UnboundedReceiver;

use crate::adb::{self, AdbServer, DeviceSel, ShellEvent};

use super::{Input, Session};

const TERM: &str = "xterm-256color";

pub async fn run(session: Arc<Session>, mut input: UnboundedReceiver<Input>) {
    let server = AdbServer::default();
    let sel = DeviceSel::Serial(session.serial.clone());
    let (mut reader, mut writer) = match adb::shell_pty(&server, &sel, TERM).await {
        Ok(halves) => halves,
        Err(e) => {
            tracing::warn!(id = %session.id, serial = %session.serial, "device shell failed: {e}");
            session
                .push(format!("\r\nCan't open a shell on {}: {e}\r\n", session.serial).as_bytes());
            session.finish(None);
            return;
        }
    };
    let (rows, cols) = session.size();
    if let Err(e) = writer.resize(rows, cols).await {
        tracing::debug!(id = %session.id, "initial resize failed: {e}");
    }

    let output = Arc::clone(&session);
    let reader_task = tauri::async_runtime::spawn(async move {
        let code = loop {
            match reader.next_event().await {
                Ok(Some(ShellEvent::Stdout(data) | ShellEvent::Stderr(data))) => output.push(&data),
                Ok(Some(ShellEvent::Exit(code))) => break Some(u32::from(code)),
                Ok(None) => break None,
                Err(e) => {
                    tracing::debug!(id = %output.id, "device shell read failed: {e}");
                    break None;
                }
            }
        };
        output.finish(code);
    });

    loop {
        let msg = tokio::select! {
            msg = input.recv() => msg,
            () = session.ended() => None,
        };
        let written = match msg {
            Some(Input::Data(data)) => writer.write_stdin(&data).await,
            Some(Input::Resize { rows, cols }) => writer.resize(rows, cols).await,
            Some(Input::Close) | None => break,
        };
        if let Err(e) = written {
            tracing::debug!(id = %session.id, "device shell write failed: {e}");
            break;
        }
    }
    reader_task.abort();
    session.finish(None);
}
