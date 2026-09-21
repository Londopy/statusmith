//! Minimal Discord IPC client (the same local named-pipe protocol discord-rpc,
//! pypresence and CustomRP use). Frames are `[opcode u32 LE][len u32 LE][json]`.
//!
//! All I/O is synchronous on one handle. A reader thread on a duplicated handle
//! does NOT work here: Windows serialises synchronous I/O per file object, so a
//! pending ReadFile blocks the WriteFile Discord is waiting for. Instead we poll
//! `PeekNamedPipe` and only read once the bytes are already there.

use serde_json::{json, Value};
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::time::{Duration, Instant};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;

const REPLY_TIMEOUT: Duration = Duration::from_secs(6);
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

/// Bytes waiting on the pipe, or an error once the other end is gone.
fn available(pipe: &File) -> std::io::Result<u32> {
    let mut avail: u32 = 0;
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle() as *mut c_void,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut avail,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(avail)
    }
}

/// Transport errors mean the pipe is gone and the connection must be dropped;
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

pub struct Conn {
    pipe: File,
    pub client_id: String,
    pub user: Value,
    nonce: u64,
}

fn open_pipe() -> Result<File, IpcError> {
    let mut last = String::from("Discord isn't running (no IPC pipe found)");
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(f) => return Ok(f),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => last = format!("{path}: {e}"),
        }
    }
    Err(IpcError::Transport(last))
}

/// Wait until `n` bytes are readable, then read exactly that many without blocking.
fn read_ready(pipe: &mut File, n: usize, deadline: Instant) -> Result<Vec<u8>, IpcError> {
    loop {
        let avail = available(pipe).map_err(|e| IpcError::Transport(format!("Discord closed the pipe ({e})")))?;
        if avail as usize >= n {
            let mut buf = vec![0u8; n];
            pipe.read_exact(&mut buf).map_err(|e| IpcError::Transport(format!("pipe read failed: {e}")))?;
            return Ok(buf);
        }
        if Instant::now() >= deadline {
            return Err(IpcError::Transport("Discord didn't answer".into()));
        }
        std::thread::sleep(POLL);
    }
}

fn read_frame(pipe: &mut File, timeout: Duration) -> Result<(u32, Value), IpcError> {
    let deadline = Instant::now() + timeout;
    let hdr = read_ready(pipe, 8, deadline)?;
    let op = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
    let len = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as usize;
    let body = read_ready(pipe, len, deadline)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

fn write_frame(pipe: &mut File, op: u32, v: &Value) -> Result<(), IpcError> {
    let body = serde_json::to_vec(v).map_err(|e| IpcError::Transport(e.to_string()))?;
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    pipe.write_all(&buf).map_err(|e| IpcError::Transport(format!("pipe write failed: {e}")))
}

impl Conn {
    /// Open the pipe, handshake with the application id, wait for READY.
    pub fn connect(client_id: &str) -> Result<Conn, IpcError> {
        let mut pipe = open_pipe()?;
        write_frame(&mut pipe, OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))?;
        let (op, v) = read_frame(&mut pipe, REPLY_TIMEOUT)
            .map_err(|e| IpcError::Transport(format!("{} (handshake)", e.message())))?;
        if op == OP_CLOSE {
            let msg = v["message"].as_str().unwrap_or("unknown reason");
            return Err(IpcError::Rejected(format!("Discord refused the handshake: {msg}")));
        }
        if v["evt"] != "READY" {
            return Err(IpcError::Rejected(format!("unexpected handshake reply: {v}")));
        }
        Ok(Conn { pipe, client_id: client_id.to_string(), user: v["data"]["user"].clone(), nonce: 0 })
    }

    /// `None` clears the presence. Returns Discord's resolved activity (includes the app `name`).
    pub fn set_activity(&mut self, activity: Option<Value>) -> Result<Value, IpcError> {
        self.nonce += 1;
        let nonce = self.nonce.to_string();
        let mut args = json!({ "pid": std::process::id() });
        if let Some(a) = activity {
            args["activity"] = a;
        }
        write_frame(&mut self.pipe, OP_FRAME, &json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce }))?;

        let deadline = Instant::now() + REPLY_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (op, v) = read_frame(&mut self.pipe, remaining)?;
            match op {
                OP_CLOSE => {
                    let msg = v["message"].as_str().unwrap_or("");
                    return Err(IpcError::Transport(format!("Discord closed the connection {msg}").trim().to_string()));
                }
                OP_PING => write_frame(&mut self.pipe, OP_PONG, &v)?,
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

    /// Cheap liveness probe: PeekNamedPipe fails as soon as Discord's end is gone.
    pub fn alive(&self) -> bool {
        available(&self.pipe).is_ok()
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        // Tell Discord we're leaving so it drops the presence right away.
        let _ = write_frame(&mut self.pipe, OP_CLOSE, &json!({}));
    }
}
