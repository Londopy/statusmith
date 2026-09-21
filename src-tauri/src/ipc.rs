//! Minimal Discord IPC client (the same local protocol discord-rpc, pypresence and CustomRP
//! use). Frames are `[opcode u32 LE][len u32 LE][json]` over a named pipe on Windows and a
//! Unix socket elsewhere. The frame logic is shared; `transport` is the only platform code.

use serde_json::{json, Value};
use std::time::{Duration, Instant};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;

const REPLY_TIMEOUT: Duration = Duration::from_secs(6);

/// Transport errors mean the connection is gone and must be dropped;
/// Rejected means Discord answered but disliked the payload.
#[derive(Debug)]
pub enum IpcError {
    Transport(String),
    Rejected(String),
}

impl IpcError {
    pub fn message(&self) -> &str {
        match self {
            IpcError::Transport(m) | IpcError::Rejected(m) => m,
        }
    }
}

// ---------------------------------------------------------------- Windows: named pipe
//
// All I/O is synchronous on one handle. A reader thread on a duplicated handle does NOT work:
// Windows serialises synchronous I/O per file object, so a pending ReadFile blocks the WriteFile
// Discord is waiting for. Instead we poll `PeekNamedPipe` and read only once the bytes are there.
#[cfg(windows)]
mod transport {
    use super::IpcError;
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::time::{Duration, Instant};

    const POLL: Duration = Duration::from_millis(15);

    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(
            pipe: *mut c_void,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_bytes_avail: *mut u32,
            bytes_left_this_message: *mut u32,
        ) -> i32;
    }

    pub struct Transport(File);

    /// Bytes waiting on the pipe, or an error once the other end is gone.
    fn available(pipe: &File) -> std::io::Result<u32> {
        let mut avail: u32 = 0;
        let ok = unsafe {
            PeekNamedPipe(pipe.as_raw_handle() as *mut c_void, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut())
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(avail)
        }
    }

    pub fn open() -> Result<Transport, IpcError> {
        let mut last = String::from("Discord isn't running (no IPC pipe found)");
        for i in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{i}");
            match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(f) => return Ok(Transport(f)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => last = format!("{path}: {e}"),
            }
        }
        Err(IpcError::Transport(last))
    }

    impl Transport {
        /// Wait until `n` bytes are readable, then read exactly that many without blocking.
        pub fn read_exact_by(&mut self, n: usize, deadline: Instant) -> Result<Vec<u8>, IpcError> {
            loop {
                let avail = available(&self.0).map_err(|e| IpcError::Transport(format!("Discord closed the pipe ({e})")))?;
                if avail as usize >= n {
                    let mut buf = vec![0u8; n];
                    self.0.read_exact(&mut buf).map_err(|e| IpcError::Transport(format!("pipe read failed: {e}")))?;
                    return Ok(buf);
                }
                if Instant::now() >= deadline {
                    return Err(IpcError::Transport("Discord didn't answer".into()));
                }
                std::thread::sleep(POLL);
            }
        }

        pub fn write_all(&mut self, buf: &[u8]) -> Result<(), IpcError> {
            self.0.write_all(buf).map_err(|e| IpcError::Transport(format!("pipe write failed: {e}")))
        }

        /// Cheap liveness probe: PeekNamedPipe fails as soon as Discord's end is gone.
        pub fn alive(&self) -> bool {
            available(&self.0).is_ok()
        }
    }
}

// ---------------------------------------------------------------- Unix: domain socket
//
// Discord listens on `discord-ipc-N` under $XDG_RUNTIME_DIR (or the temp dirs), and inside
// its Flatpak / Snap sandboxes under a subdirectory of it. Sockets are full-duplex, so a
// plain read with a timeout is enough here.
#[cfg(unix)]
mod transport {
    use super::IpcError;
    use std::ffi::c_void;
    use std::io::{ErrorKind, Read, Write};
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::Instant;

    extern "C" {
        fn recv(fd: i32, buf: *mut c_void, len: usize, flags: i32) -> isize;
    }
    const MSG_PEEK: i32 = 2;

    pub struct Transport(UnixStream);

    fn candidates() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
            .iter()
            .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
            .collect();
        dirs.push(PathBuf::from("/tmp"));
        let mut out = Vec::new();
        for d in dirs {
            for sub in ["", "app/com.discordapp.Discord", "snap.discord", "snap.discord-canary"] {
                let base = if sub.is_empty() { d.clone() } else { d.join(sub) };
                for i in 0..10 {
                    out.push(base.join(format!("discord-ipc-{i}")));
                }
            }
        }
        out
    }

    pub fn open() -> Result<Transport, IpcError> {
        for path in candidates() {
            if let Ok(s) = UnixStream::connect(&path) {
                return Ok(Transport(s));
            }
        }
        Err(IpcError::Transport("Discord isn't running (no IPC socket found)".into()))
    }

    impl Transport {
        pub fn read_exact_by(&mut self, n: usize, deadline: Instant) -> Result<Vec<u8>, IpcError> {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(IpcError::Transport("Discord didn't answer".into()));
            }
            self.0.set_read_timeout(Some(remaining)).map_err(|e| IpcError::Transport(e.to_string()))?;
            let mut buf = vec![0u8; n];
            match self.0.read_exact(&mut buf) {
                Ok(()) => Ok(buf),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    Err(IpcError::Transport("Discord didn't answer".into()))
                }
                Err(e) => Err(IpcError::Transport(format!("Discord closed the socket ({e})"))),
            }
        }

        pub fn write_all(&mut self, buf: &[u8]) -> Result<(), IpcError> {
            self.0.write_all(buf).map_err(|e| IpcError::Transport(format!("socket write failed: {e}")))
        }

        /// Non-blocking peek: 0 bytes means Discord hung up, EAGAIN means quiet but open.
        pub fn alive(&self) -> bool {
            if self.0.set_nonblocking(true).is_err() {
                return false;
            }
            let mut b = [0u8; 1];
            let n = unsafe { recv(self.0.as_raw_fd(), b.as_mut_ptr() as *mut c_void, 1, MSG_PEEK) };
            let err = std::io::Error::last_os_error();
            let _ = self.0.set_nonblocking(false);
            match n {
                0 => false,
                x if x > 0 => true,
                _ => err.kind() == ErrorKind::WouldBlock,
            }
        }
    }
}

use transport::Transport;

// ---------------------------------------------------------------- frames

fn read_frame(t: &mut Transport, timeout: Duration) -> Result<(u32, Value), IpcError> {
    let deadline = Instant::now() + timeout;
    let hdr = t.read_exact_by(8, deadline)?;
    let op = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
    let len = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as usize;
    let body = t.read_exact_by(len, deadline)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

fn write_frame(t: &mut Transport, op: u32, v: &Value) -> Result<(), IpcError> {
    let body = serde_json::to_vec(v).map_err(|e| IpcError::Transport(e.to_string()))?;
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    t.write_all(&buf)
}

// ---------------------------------------------------------------- client

pub struct Conn {
    t: Transport,
    pub client_id: String,
    pub user: Value,
    nonce: u64,
}

impl Conn {
    /// Open the transport, handshake with the application id, wait for READY.
    pub fn connect(client_id: &str) -> Result<Conn, IpcError> {
        let mut t = transport::open()?;
        write_frame(&mut t, OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))?;
        let (op, v) = read_frame(&mut t, REPLY_TIMEOUT)
            .map_err(|e| IpcError::Transport(format!("{} (handshake)", e.message())))?;
        if op == OP_CLOSE {
            let msg = v["message"].as_str().unwrap_or("unknown reason");
            return Err(IpcError::Rejected(format!("Discord refused the handshake: {msg}")));
        }
        if v["evt"] != "READY" {
            return Err(IpcError::Rejected(format!("unexpected handshake reply: {v}")));
        }
        Ok(Conn { t, client_id: client_id.to_string(), user: v["data"]["user"].clone(), nonce: 0 })
    }

    /// `None` clears the presence. Returns Discord's resolved activity (includes the app `name`).
    pub fn set_activity(&mut self, activity: Option<Value>) -> Result<Value, IpcError> {
        self.nonce += 1;
        let nonce = self.nonce.to_string();
        let mut args = json!({ "pid": std::process::id() });
        if let Some(a) = activity {
            args["activity"] = a;
        }
        write_frame(&mut self.t, OP_FRAME, &json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce }))?;

        let deadline = Instant::now() + REPLY_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (op, v) = read_frame(&mut self.t, remaining)?;
            match op {
                OP_CLOSE => {
                    let msg = v["message"].as_str().unwrap_or("");
                    return Err(IpcError::Transport(format!("Discord closed the connection {msg}").trim().to_string()));
                }
                OP_PING => write_frame(&mut self.t, OP_PONG, &v)?,
                OP_FRAME if v["nonce"] == nonce => {
                    if v["evt"] == "ERROR" {
                        let msg = v["data"]["message"].as_str().unwrap_or("").trim();
                        let msg = if msg.is_empty() { "Discord rejected the activity" } else { msg };
                        return Err(IpcError::Rejected(msg.to_string()));
                    }
                    return Ok(v["data"].clone());
                }
                _ => {} // unsolicited event; we subscribe to none, so just skip it
            }
        }
    }

    /// Cheap liveness probe, safe to call often.
    pub fn alive(&self) -> bool {
        self.t.alive()
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        // Tell Discord we're leaving so it drops the presence right away.
        let _ = write_frame(&mut self.t, OP_CLOSE, &json!({}));
    }
}
