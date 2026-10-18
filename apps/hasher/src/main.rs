// Hasher: the core of a vmapp sample app, written in Rust against the bridge protocol (SPEC section 6) directly.
//
// It is a server on $VMAPP_SOCKET: the host's bridge connection arrives through the guest's vsock port 1024.
// Messages are JSON lines. The flow:
//
//   host -> init                       we answer `ready`, then ask for a window (request window.create)
//   host -> invoke hasher:choose       we ask for a folder (request dialog.open {directory:true}), walk it, and stream
//                                      emit "progress" {done,total,current} and emit "result" {path,sha256,size}
//   host -> invoke hasher:save         we ask where to save (request dialog.save) and write `sha256  path` lines
//   host -> window closed              exit(0): the VM is the app
//
// A request blocks the thread that made it until the `reply` arrives, so every invoke runs on its own thread while the
// main thread keeps reading the socket.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const MAX_FILES: usize = 10_000;
const MAX_DEPTH: usize = 64;
const MAX_LINE: usize = 16 * 1024 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Report {
    root: String,
    rows: Vec<(String, String)>, // (relative path, sha256 hex)
}

struct Bridge {
    writer: Mutex<UnixStream>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    win: AtomicI64, // -1 until the window exists
    scanning: AtomicBool,
    cancel: AtomicBool,
    report: Mutex<Report>,
}

impl Bridge {
    fn send(&self, v: &Value) {
        let mut line = v.to_string();
        line.push('\n');
        let _ = lock(&self.writer).write_all(line.as_bytes());
    }

    fn log(&self, level: &str, message: &str) {
        self.send(&json!({"t": "log", "level": level, "message": message}));
    }

    fn request(&self, op: &str, params: Value) -> Result<Value, String> {
        self.request_within(op, params, Duration::from_secs(3600))
    }

    fn request_within(&self, op: &str, params: Value, wait: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        lock(&self.pending).insert(id, tx);
        self.send(&json!({"t": "request", "id": id, "op": op, "params": params}));
        match rx.recv_timeout(wait) {
            Ok(r) => r,
            Err(_) => Err("the host did not answer".to_string()),
        }
    }

    fn win(&self) -> Option<i64> {
        let w = self.win.load(Ordering::SeqCst);
        if w < 0 {
            None
        } else {
            Some(w)
        }
    }

    fn emit(&self, channel: &str, arg: Value) {
        if let Some(win) = self.win() {
            self.send(&json!({"t": "emit", "win": win, "channel": channel, "args": [arg]}));
        }
    }
}

// ------------------------------------------------------------------------------------------------ scanning

/// Collects regular files below `dir`, sorted by name. Symlinks are skipped. Stops at MAX_FILES.
fn collect(dir: &Path, depth: usize, out: &mut Vec<PathBuf>, truncated: &mut bool) {
    if depth > MAX_DEPTH || *truncated {
        return;
    }
    let mut entries: Vec<_> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ft = meta.file_type();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            collect(&path, depth + 1, out, truncated);
        } else if ft.is_file() {
            if out.len() >= MAX_FILES {
                *truncated = true;
                return;
            }
            out.push(path);
        }
        if *truncated {
            return;
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Returns (sha256 hex, size), or None when the scan was canceled.
fn hash_file(bridge: &Bridge, path: &Path) -> Result<Option<(String, u64)>, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        if bridge.cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok(Some((hex(hasher.finalize().as_slice()), size)))
}

fn rel_string(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn scan(bridge: &Bridge, root: PathBuf) {
    bridge.cancel.store(false, Ordering::SeqCst);
    let mut files = Vec::new();
    let mut truncated = false;
    collect(&root, 0, &mut files, &mut truncated);
    let total = files.len();
    {
        let mut r = lock(&bridge.report);
        r.root = root.to_string_lossy().into_owned();
        r.rows.clear();
    }
    bridge.emit("started", json!({"total": total, "truncated": truncated}));

    let mut errors = 0usize;
    let mut canceled = false;
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    for (i, path) in files.iter().enumerate() {
        let rel = rel_string(&root, path);
        match hash_file(bridge, path) {
            Ok(Some((hash, size))) => {
                lock(&bridge.report).rows.push((rel.clone(), hash.clone()));
                bridge.emit("result", json!({"path": rel, "sha256": hash, "size": size}));
            }
            Ok(None) => {
                canceled = true;
                break;
            }
            Err(e) => {
                errors += 1;
                bridge.emit("result", json!({"path": rel, "error": e}));
            }
        }
        let done = i + 1;
        if done == total || last_progress.elapsed() >= Duration::from_millis(40) {
            last_progress = Instant::now();
            bridge.emit("progress", json!({"done": done, "total": total, "current": rel}));
        }
    }
    let count = lock(&bridge.report).rows.len();
    // clear the flag before announcing the end: the UI may ask to save the moment it sees "done"
    bridge.scanning.store(false, Ordering::SeqCst);
    bridge.emit(
        "done",
        json!({"count": count, "errors": errors, "truncated": truncated, "canceled": canceled}),
    );
    if let Some(win) = bridge.win() {
        // the core only sees /host/pick-N, so the folder's own name is not available here; show the count instead
        let title = if count == 1 { "1 file hashed".to_string() } else { format!("{} files hashed", count) };
        let _ = bridge.request("window.setTitle", json!({"win": win, "title": title}));
    }
}

// ------------------------------------------------------------------------------------------------ invoke handlers

fn choose(bridge: &Arc<Bridge>) -> Result<Value, String> {
    if bridge.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running".to_string());
    }
    let reply = bridge.request(
        "dialog.open",
        json!({"win": bridge.win(), "title": "Choose a folder to hash", "directory": true, "multiple": false}),
    );
    let reply = match reply {
        Ok(v) => v,
        Err(e) => {
            bridge.scanning.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let path = if reply["canceled"].as_bool().unwrap_or(false) {
        None
    } else {
        reply["paths"].get(0).and_then(|p| p.as_str()).map(|s| s.to_string())
    };
    match path {
        None => {
            bridge.scanning.store(false, Ordering::SeqCst);
            Ok(json!({"canceled": true}))
        }
        Some(p) => {
            let b = Arc::clone(bridge);
            let root = PathBuf::from(&p);
            std::thread::spawn(move || scan(&b, root));
            Ok(json!({"canceled": false, "path": p}))
        }
    }
}

fn save(bridge: &Arc<Bridge>) -> Result<Value, String> {
    if bridge.scanning.load(Ordering::SeqCst) {
        return Err("Wait for the scan to finish".to_string());
    }
    let rows = lock(&bridge.report).rows.clone();
    if rows.is_empty() {
        return Err("There is nothing to save yet. Choose a folder first.".to_string());
    }
    let reply = bridge.request(
        "dialog.save",
        json!({"win": bridge.win(), "title": "Save the hash report", "defaultName": "hashes.txt"}),
    )?;
    if reply["canceled"].as_bool().unwrap_or(false) {
        return Ok(json!({"canceled": true}));
    }
    let path = reply["path"].as_str().ok_or("the host returned no path")?.to_string();
    let mut text = String::new();
    for (rel, hash) in &rows {
        text.push_str(&format!("{}  {}\n", hash, rel));
    }
    // Write <name>.partial and rename: the host delivers the file once the write has settled.
    let partial = format!("{}.partial", path);
    fs::write(&partial, text.as_bytes()).map_err(|e| format!("cannot write the report: {}", e))?;
    fs::rename(&partial, &path).map_err(|e| format!("cannot finish the report: {}", e))?;
    Ok(json!({"canceled": false, "count": rows.len(), "bytes": text.len()}))
}

fn handle_invoke(bridge: &Arc<Bridge>, id: Value, channel: &str) {
    let r = match channel {
        "hasher:choose" => choose(bridge),
        "hasher:save" => save(bridge),
        "hasher:cancel" => {
            bridge.cancel.store(true, Ordering::SeqCst);
            Ok(json!({}))
        }
        "hasher:state" => {
            let r = lock(&bridge.report);
            Ok(json!({"root": r.root, "count": r.rows.len(), "scanning": bridge.scanning.load(Ordering::SeqCst)}))
        }
        other => Err(format!("No handler registered for '{}'", other)),
    };
    match r {
        Ok(v) => bridge.send(&json!({"t": "result", "id": id, "result": v})),
        Err(e) => bridge.send(&json!({"t": "result", "id": id, "error": {"message": e}})),
    }
}

// ------------------------------------------------------------------------------------------------ main loop

fn open_window(bridge: &Arc<Bridge>) {
    let r = bridge.request(
        "window.create",
        json!({"entry": "index.html", "width": 900, "height": 640, "minWidth": 600, "minHeight": 420, "title": "Hasher"}),
    );
    match r {
        Ok(v) => {
            if let Some(w) = v["win"].as_i64() {
                bridge.win.store(w, Ordering::SeqCst);
            }
        }
        Err(e) => {
            bridge.log("error", &format!("window.create failed: {}", e));
            std::process::exit(1);
        }
    }
}

fn handle_message(bridge: &Arc<Bridge>, msg: Value) {
    match msg["t"].as_str().unwrap_or("") {
        "init" => {
            bridge.send(&json!({"t": "ready"}));
            let b = Arc::clone(bridge);
            std::thread::spawn(move || open_window(&b));
        }
        "invoke" => {
            let b = Arc::clone(bridge);
            let id = msg["id"].clone();
            let channel = msg["channel"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || handle_invoke(&b, id, &channel));
        }
        "reply" => {
            let id = msg["id"].as_u64().unwrap_or(0);
            if let Some(tx) = lock(&bridge.pending).remove(&id) {
                let res = match msg.get("error") {
                    Some(e) if !e.is_null() => Err(e["message"].as_str().unwrap_or("request failed").to_string()),
                    _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(res);
            }
        }
        "window" => {
            if msg["event"] == "closed" {
                // the only window is gone: quit like Electron's default. The reply to app.quit arrives on the
                // reader loop, so wait for it on another thread (at most 1 s), then exit: the VM is the app.
                let b = Arc::clone(bridge);
                std::thread::spawn(move || {
                    let _ = b.request_within("app.quit", json!({}), Duration::from_secs(1));
                    std::process::exit(0);
                });
            }
        }
        "before-quit" => std::process::exit(0),
        _ => {}
    }
}

fn main() {
    let socket = std::env::var("VMAPP_SOCKET").unwrap_or_else(|_| {
        eprintln!("hasher: VMAPP_SOCKET is not set");
        std::process::exit(1);
    });
    let _ = fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap_or_else(|e| {
        eprintln!("hasher: cannot listen on {}: {}", socket, e);
        std::process::exit(1);
    });
    let (stream, _) = listener.accept().unwrap_or_else(|e| {
        eprintln!("hasher: accept failed: {}", e);
        std::process::exit(1);
    });
    let reader = BufReader::new(stream.try_clone().expect("clone socket"));
    let bridge = Arc::new(Bridge {
        writer: Mutex::new(stream),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        win: AtomicI64::new(-1),
        scanning: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        report: Mutex::new(Report { root: String::new(), rows: Vec::new() }),
    });

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.is_empty() || line.len() > MAX_LINE {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle_message(&bridge, msg),
            Err(_) => bridge.log("warn", "ignoring a malformed bridge line"),
        }
    }
    // the host closed the connection: the app is over
    std::process::exit(0);
}
