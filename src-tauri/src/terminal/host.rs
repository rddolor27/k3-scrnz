use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::adb;

use super::{Input, Session, TerminalError, shell};

const READ_CHUNK: usize = 16 * 1024;

pub fn spawn(
    session: Arc<Session>,
    mut input: UnboundedReceiver<Input>,
    close: UnboundedSender<Input>,
    cwd: &Path,
    shell_id: Option<&str>,
    command: Option<&str>,
) -> Result<&'static str, TerminalError> {
    let (rows, cols) = session.size();
    let pair = native_pty_system()
        .openpty(pty_size(rows, cols))
        .map_err(spawn_error)?;
    let shell = shell::resolve(shell_id)?;
    let mut cmd = shell.command(command)?;
    cmd.cwd(cwd);
    link_to_device(&mut cmd, &session.serial);
    let mut child = pair.slave.spawn_command(cmd).map_err(spawn_error)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(spawn_error)?;
    let mut writer = pair.master.take_writer().map_err(spawn_error)?;
    let master = pair.master;
    let mut killer = child.clone_killer();

    let output = Arc::clone(&session);
    thread("terminal-read", move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.push(&buf[..n]),
            }
        }
    })?;

    let waiter = Arc::clone(&session);
    thread("terminal-wait", move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        waiter.finish(code);
        // ConPTY keeps the reader blocked until the pseudo-console is closed.
        if close.send(Input::Close).is_err() {
            tracing::debug!(id = %waiter.id, "terminal writer already gone");
        }
    })?;

    let id = session.id.clone();
    thread("terminal-write", move || {
        while let Some(msg) = input.blocking_recv() {
            match msg {
                Input::Data(data) => {
                    if let Err(e) = writer.write_all(&data).and_then(|()| writer.flush()) {
                        tracing::debug!(id, "terminal write failed: {e}");
                        break;
                    }
                }
                Input::Resize { rows, cols } => {
                    if let Err(e) = master.resize(pty_size(rows, cols)) {
                        tracing::debug!(id, "terminal resize failed: {e}");
                    }
                }
                Input::Close => break,
            }
        }
        if let Err(e) = killer.kill() {
            tracing::debug!(id, "terminal kill: {e}");
        }
        drop(writer);
        drop(master);
    })?;
    Ok(shell.id)
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_error(e: impl std::fmt::Display) -> TerminalError {
    TerminalError::Spawn(e.to_string())
}

fn thread(name: &str, body: impl FnOnce() + Send + 'static) -> Result<(), TerminalError> {
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(body)
        .map(drop)
        .map_err(spawn_error)
}

/// `adb` must be the SDK's: another version restarts the shared server and drops every device.
fn link_to_device(cmd: &mut CommandBuilder, serial: &str) {
    cmd.env("ANDROID_SERIAL", serial);
    let Some(adb_exe) = adb::find_adb() else {
        tracing::warn!("no SDK adb found; the terminal uses whatever adb is on PATH");
        return;
    };
    let Some(tools) = adb_exe.parent() else {
        return;
    };
    if let Some(sdk) = tools.parent() {
        for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
            if cmd.get_env(key).is_none() {
                cmd.env(key, sdk);
            }
        }
    }
    let base = cmd
        .get_env("PATH")
        .map(ToOwned::to_owned)
        .unwrap_or_default();
    let dirs = std::iter::once(tools.to_path_buf()).chain(std::env::split_paths(&base));
    match std::env::join_paths(dirs) {
        Ok(path) => cmd.env("PATH", path),
        Err(e) => tracing::warn!("can't put the SDK adb first on PATH: {e}"),
    }
}
