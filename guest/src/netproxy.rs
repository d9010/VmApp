//! The guest side of the network permission (SPEC section 8.3).
//!
//! The VM has no network device. The core's HTTP client is pointed (environment variables) at an HTTP proxy that
//! `vmapp-init` runs on `127.0.0.1:3128`. For every new connection the proxy asks the host, over one persistent
//! vsock connection (port 1022, opened by the host only when the app has network grants), whether it may open
//! `host:port`. When the host agrees it has already connected to the target and opened a fresh vsock connection to
//! guest port 1025 whose first line is `N\n`; the proxy then copies bytes between the core's socket and that vsock
//! connection. TLS is end to end: this code never looks past the HTTP head of a plain-HTTP request.
//!
//! The guest never opens an outbound socket of its own (INV-N1): it only listens, on loopback and on vsock.
//!
//! PID 1 must never panic (panic=abort): no `unwrap`, `expect` or indexing, and no `println!`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::json;
use crate::NAME;

/// Where the proxy listens, as seen by the core.
pub const PROXY_ADDR: &str = "127.0.0.1:3128";
const PROXY_URL: &str = "http://127.0.0.1:3128";
/// The CA bundle of the runtime image (Debian and the `native` runtime both ship it here).
pub const CA_BUNDLE: &str = "/etc/ssl/certs/ca-certificates.crt";

/// Defaults added to the core's environment (SPEC 8.3). An `env` of the manifest or the runtime image wins.
pub const ENV_DEFAULTS: [(&str, &str); 9] = [
    ("HTTPS_PROXY", PROXY_URL),
    ("HTTP_PROXY", PROXY_URL),
    ("ALL_PROXY", PROXY_URL),
    ("https_proxy", PROXY_URL),
    ("http_proxy", PROXY_URL),
    ("all_proxy", PROXY_URL),
    ("NO_PROXY", "localhost,127.0.0.1"),
    ("no_proxy", "localhost,127.0.0.1"),
    ("NODE_USE_ENV_PROXY", "1"),
];

/// Concurrent client connections the proxy serves (the host allows 64 tunnels; the rest are refused quickly).
const MAX_CLIENTS: usize = 128;
/// Longest request head accepted from the core.
const MAX_HEAD: usize = 16 * 1024;
/// Time the core has to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the host may take to answer one `net-open` (it allows 10 s to resolve and connect).
const OPEN_TIMEOUT: Duration = Duration::from_secs(25);
/// After an `ok`, how long the data connection may take to show up.
const DATA_TIMEOUT: Duration = Duration::from_secs(5);
/// Stack of the per-connection threads (the guest has little memory and up to ~250 of them).
const STACK: usize = 256 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------------------
// rendezvous between the control reader, the data acceptor and the proxy threads
// ---------------------------------------------------------------------------------------------------------

type Reply = Result<(), (u16, String)>;

#[derive(Default)]
struct Pending {
    reply: Option<Reply>,
    data: Option<File>,
}

struct Hub {
    /// The writing half of the host's control connection, with its generation number.
    ctl: Mutex<Option<(u64, File)>>,
    pending: Mutex<HashMap<u64, Pending>>,
    cv: Condvar,
}

static HUB: OnceLock<Hub> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CLIENTS: AtomicUsize = AtomicUsize::new(0);

fn hub() -> &'static Hub {
    HUB.get_or_init(|| Hub { ctl: Mutex::new(None), pending: Mutex::new(HashMap::new()), cv: Condvar::new() })
}

impl Hub {
    fn deliver_reply(&self, id: u64, reply: Reply) {
        if let Some(p) = lock(&self.pending).get_mut(&id) {
            p.reply = Some(reply);
            self.cv.notify_all();
        }
    }

    fn deliver_data(&self, id: u64, data: File) {
        // No waiting request (it timed out, or the id is made up): the connection is dropped, i.e. closed.
        if let Some(p) = lock(&self.pending).get_mut(&id) {
            p.data = Some(data);
            self.cv.notify_all();
        }
    }

    /// The control connection ended: forget it (if it is still the current one) and fail every waiting request.
    fn ctl_closed(&self, generation: u64) {
        {
            let mut ctl = lock(&self.ctl);
            if ctl.as_ref().map(|(g, _)| *g) == Some(generation) {
                *ctl = None;
            }
        }
        let mut pending = lock(&self.pending);
        for p in pending.values_mut() {
            if p.reply.is_none() {
                p.reply = Some(Err((403, "network channel closed".to_owned())));
            }
        }
        self.cv.notify_all();
    }
}

/// Port 1022: the host's persistent control connection. Replies arrive here, one JSON line each:
/// `{"id":N,"ok":true}` or `{"id":N,"ok":false,"error":"…","status":403}`.
pub fn control_conn(stream: File, _n: u64) {
    let writer = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            log!("net: cannot duplicate the control socket: {e}");
            return;
        }
    };
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    *lock(&hub().ctl) = Some((generation, writer));
    log!("net: the host opened the network channel");
    let mut reader = BufReader::new(stream);
    loop {
        let line = match crate::read_line(&mut reader) {
            Ok(crate::Line::Text(l)) => l,
            Ok(crate::Line::TooLong) | Ok(crate::Line::Eof) | Err(_) => break,
        };
        let Some(obj) = json::parse_object(&line) else { continue };
        let Some(id) = json::find_uint(&obj, "id") else { continue };
        let reply = if json::find_bool(&obj, "ok") == Some(true) {
            Ok(())
        } else {
            let status = json::find_uint(&obj, "status").and_then(|s| u16::try_from(s).ok()).unwrap_or(502);
            let status = if matches!(status, 403 | 502 | 503 | 504) { status } else { 502 };
            Err((status, clean_message(json::find_str(&obj, "error").unwrap_or("refused by the host"))))
        };
        hub().deliver_reply(id, reply);
    }
    hub().ctl_closed(generation);
    log!("net: the network channel closed");
}

/// Port 1025: one data connection per tunnel. The first line is the request id; the bytes after it belong to the
/// tunnel, so the id is read one byte at a time (no buffering that could swallow tunnel bytes).
pub fn data_conn(mut stream: File, _n: u64) {
    let Some(id) = read_id_line(&mut stream) else { return };
    hub().deliver_data(id, stream);
}

fn read_id_line(f: &mut File) -> Option<u64> {
    let mut digits = String::new();
    let mut byte = [0u8; 1];
    loop {
        match f.read(&mut byte) {
            Ok(1) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            _ => return None,
        }
        let c = byte.first().copied()?;
        if c == b'\n' {
            break;
        }
        if !c.is_ascii_digit() || digits.len() >= 20 {
            return None;
        }
        digits.push(char::from(c));
    }
    digits.parse().ok()
}

/// A message from the host or the proxy itself, safe to put in a one-line response body.
fn clean_message(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(300).collect()
}

/// Asks the host to open `host:port` and returns the data connection of the tunnel.
fn open_tunnel(host: &str, port: u16) -> Result<File, (u16, String)> {
    open_with(
        |id| format!("{{\"op\":\"net-open\",\"id\":{id},\"host\":{},\"port\":{port}}}\n", json::quote(host)),
        "network not granted",
    )
}

/// Asks the host to open the host service `name` (SPEC 8.6) and returns the data connection of the tunnel. The guest
/// names the service and nothing else: the host decides where it is.
fn open_service_tunnel(name: &str) -> Result<File, (u16, String)> {
    open_with(|id| format!("{{\"op\":\"service-open\",\"id\":{id},\"name\":{}}}\n", json::quote(name)), "service not granted")
}

/// Sends one open request (`make_request(id)` builds the line) on the control connection and waits for the host's
/// answer and the data connection. `no_channel` is the refusal when the host never opened the control connection.
fn open_with(make_request: impl FnOnce(u64) -> String, no_channel: &str) -> Result<File, (u16, String)> {
    let h = hub();
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut ctl = lock(&h.ctl);
        let Some((_, w)) = ctl.as_mut() else { return Err((403, no_channel.to_owned())) };
        // Registered before the request is sent, so an answer cannot arrive unseen.
        lock(&h.pending).insert(id, Pending::default());
        let req = make_request(id);
        if let Err(e) = w.write_all(req.as_bytes()) {
            lock(&h.pending).remove(&id);
            *ctl = None;
            return Err((403, clean_message(&format!("network channel closed ({e})"))));
        }
    }
    let result = wait_for(h, id);
    lock(&h.pending).remove(&id);
    result
}

fn wait_for(h: &Hub, id: u64) -> Result<File, (u16, String)> {
    let deadline = Instant::now() + OPEN_TIMEOUT;
    let mut data_deadline: Option<Instant> = None;
    let mut pending = lock(&h.pending);
    loop {
        let Some(p) = pending.get_mut(&id) else { return Err((502, "request lost".to_owned())) };
        match &p.reply {
            Some(Err((status, msg))) => return Err((*status, msg.clone())),
            Some(Ok(())) => {
                if let Some(f) = p.data.take() {
                    return Ok(f);
                }
                data_deadline.get_or_insert_with(|| Instant::now() + DATA_TIMEOUT);
            }
            None => {}
        }
        let limit = data_deadline.unwrap_or(deadline);
        let now = Instant::now();
        if now >= limit {
            return Err((504, "timed out waiting for the host".to_owned()));
        }
        pending = h.cv.wait_timeout(pending, limit - now).unwrap_or_else(|e| e.into_inner()).0;
    }
}

// ---------------------------------------------------------------------------------------------------------
// the HTTP proxy on 127.0.0.1:3128
// ---------------------------------------------------------------------------------------------------------

/// Starts the listener on loopback. A failure is logged and leaves the app without network (it is not fatal).
pub fn start_proxy() {
    let listener = match TcpListener::bind(PROXY_ADDR) {
        Ok(l) => l,
        Err(e) => {
            log!("net: cannot listen on {PROXY_ADDR}: {e}; the app will have no network");
            return;
        }
    };
    let spawned = thread::Builder::new().name("netproxy".into()).spawn(move || accept_clients(listener));
    match spawned {
        Ok(_) => log!("net: proxy listening on {PROXY_ADDR}"),
        Err(e) => log!("net: cannot start the proxy thread: {e}"),
    }
}

struct ClientGuard;

impl Drop for ClientGuard {
    fn drop(&mut self) {
        CLIENTS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn accept_clients(listener: TcpListener) {
    for conn in listener.incoming() {
        let mut client = match conn {
            Ok(c) => c,
            Err(e) => {
                log!("net: accept failed: {e}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        if CLIENTS.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS {
            CLIENTS.fetch_sub(1, Ordering::SeqCst);
            respond(&mut client, 503, "too many connections");
            continue;
        }
        let spawned = thread::Builder::new().name("netproxy-conn".into()).stack_size(STACK).spawn(move || {
            let _guard = ClientGuard;
            serve_client(client);
        });
        if let Err(e) = spawned {
            CLIENTS.fetch_sub(1, Ordering::SeqCst);
            log!("net: cannot start a connection thread: {e}");
        }
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "Connection Established",
        400 => "Bad Request",
        403 => "Forbidden",
        408 => "Request Timeout",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

/// Writes a short plain-text refusal and ends the exchange.
fn respond(client: &mut TcpStream, status: u16, msg: &str) {
    let body = format!("D9010 VmApp network: {}\n", clean_message(msg));
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nX-Vmapp-Proxy: refused\r\n\r\n",
        reason_phrase(status),
        body.len()
    );
    let _ = client.write_all(head.as_bytes());
    let _ = client.write_all(body.as_bytes());
    let _ = client.shutdown(Shutdown::Both);
}

/// What the core asked for.
#[derive(Debug, PartialEq, Eq)]
struct Request {
    host: String,
    port: u16,
    /// `CONNECT` (answer 200 and tunnel) or plain HTTP (forward `head` first).
    connect: bool,
    /// Bytes to send into the tunnel before copying starts (plain HTTP: the rewritten request head).
    head: Vec<u8>,
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Reads until the end of the request head. Returns the bytes read (head and whatever followed it).
fn read_head(client: &mut TcpStream) -> Result<Vec<u8>, (u16, &'static str)> {
    let deadline = Instant::now() + HEAD_TIMEOUT;
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        if find_head_end(&buf).is_some() {
            return Ok(buf);
        }
        if buf.len() > MAX_HEAD {
            return Err((431, "the request head is too large"));
        }
        let now = Instant::now();
        if now >= deadline {
            return Err((408, "the request head did not arrive in time"));
        }
        let _ = client.set_read_timeout(Some((deadline - now).min(Duration::from_secs(5))));
        match client.read(&mut chunk) {
            Ok(0) => return Err((400, "the connection closed before the request head ended")),
            Ok(n) => buf.extend_from_slice(chunk.get(..n).unwrap_or(&[])),
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted) => {}
            Err(_) => return Err((400, "the request could not be read")),
        }
    }
}

/// `host:port`, `[v6]:port` or (with a default) `host`. The host is not judged here beyond its characters: the
/// host machine decides what may be reached.
fn split_hostport(auth: &str, default_port: Option<u16>) -> Option<(String, u16)> {
    let (host, port_text) = if let Some(rest) = auth.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        match after {
            "" => (h, None),
            a => (h, Some(a.strip_prefix(':')?)),
        }
    } else if let Some((h, p)) = auth.rsplit_once(':') {
        (h, Some(p))
    } else {
        (auth, None)
    };
    let port = match port_text {
        Some(p) => p.parse::<u16>().ok().filter(|p| *p > 0)?,
        None => default_port?,
    };
    let ok_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':');
    if host.is_empty() || host.len() > 253 || !host.chars().all(ok_char) {
        return None;
    }
    Some((host.to_owned(), port))
}

fn split_crlf(head: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i + 1 < head.len() {
        if head.get(i) == Some(&b'\r') && head.get(i + 1) == Some(&b'\n') {
            lines.push(head.get(start..i).unwrap_or(&[]));
            start = i + 2;
            i += 2;
        } else {
            i += 1;
        }
    }
    if let Some(last) = head.get(start..) {
        if !last.is_empty() {
            lines.push(last);
        }
    }
    lines
}

fn header_name(line: &[u8]) -> Vec<u8> {
    line.iter().take_while(|b| **b != b':').map(|b| b.to_ascii_lowercase()).collect()
}

/// The request head of a plain-HTTP request as it goes to the server, like any forward proxy sends it: the request
/// target in origin form (`/path?query`; many servers only route that form), the client's headers unchanged except
/// that the proxy-only ones are dropped, a `Host` header if the client sent none, and `Connection: close`, so one
/// proxied connection never carries a request for another host. Upgrades keep their `Connection` header.
/// `lines` is the head split at CRLF (its first entry is the request line, the first empty entry ends the headers).
fn rewrite_plain_head(lines: &[&[u8]], method: &str, origin_target: &str, version: &str, authority: &str) -> Vec<u8> {
    let headers: Vec<&[u8]> = lines.iter().skip(1).take_while(|l| !l.is_empty()).copied().collect();
    let upgrade = headers.iter().any(|l| header_name(l) == b"upgrade");
    let has_host = headers.iter().any(|l| header_name(l) == b"host");
    let mut out: Vec<u8> = format!("{method} {origin_target} {version}\r\n").into_bytes();
    for line in headers {
        let name = header_name(line);
        let drop = name == b"proxy-connection"
            || name == b"proxy-authorization"
            || (!upgrade && (name == b"connection" || name == b"keep-alive"));
        if drop {
            continue;
        }
        out.extend_from_slice(line);
        out.extend_from_slice(b"\r\n");
    }
    if !has_host {
        out.extend_from_slice(format!("Host: {authority}\r\n").as_bytes());
    }
    if !upgrade {
        out.extend_from_slice(b"Connection: close\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// Parses a request head (up to and including the blank line).
fn parse_request(head: &[u8]) -> Result<Request, (u16, &'static str)> {
    let lines = split_crlf(head);
    let first = lines.first().copied().unwrap_or(&[]);
    let line = std::str::from_utf8(first).map_err(|_| (400u16, "the request line is not valid text"))?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err((400, "malformed request line"));
    };
    if !version.starts_with("HTTP/1.") {
        return Err((400, "only HTTP/1.x is supported"));
    }
    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_hostport(target, None).ok_or((400u16, "CONNECT needs host:port"))?;
        return Ok(Request { host, port, connect: true, head: Vec::new() });
    }
    let lower = target.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("http://") {
        // `rest` is lower-cased only for the scheme test; the authority is taken from the original text.
        let authority_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let original = target.get("http://".len()..).unwrap_or("");
        let authority = original.get(..authority_len).unwrap_or("");
        if authority.contains('@') {
            return Err((400, "user names in URLs are not supported"));
        }
        let (host, port) = split_hostport(authority, Some(80)).ok_or((400u16, "the URL has no usable host"))?;
        // What follows the authority is the path and query ("/" when there is none); a fragment never goes on the wire.
        let tail = original.get(authority_len..).unwrap_or("");
        let tail = tail.split('#').next().unwrap_or("");
        let origin = if tail.is_empty() {
            "/".to_owned()
        } else if tail.starts_with('?') {
            format!("/{tail}")
        } else {
            tail.to_owned()
        };
        let head = rewrite_plain_head(&lines, method, &origin, version, authority);
        return Ok(Request { host, port, connect: false, head });
    }
    if lower.starts_with("https://") {
        return Err((400, "use CONNECT for https"));
    }
    Err((400, "this is an HTTP proxy: request the full http:// URL, or use CONNECT"))
}

/// Refusals are logged to the console (the app developer's log) so a failed `fetch` can be explained; a flood is not.
fn note_refusal(host: &str, port: u16, status: u16, msg: &str) {
    static LOGGED: AtomicUsize = AtomicUsize::new(0);
    const LIMIT: usize = 50;
    let n = LOGGED.fetch_add(1, Ordering::SeqCst);
    if n < LIMIT {
        log!("net: {}:{} refused ({status}): {}", clean_message(host), port, msg);
    } else if n == LIMIT {
        log!("net: more than {LIMIT} refusals; the rest are not logged here (the host reports every one)");
    }
}

fn serve_client(mut client: TcpStream) {
    let _ = client.set_nodelay(true);
    let buf = match read_head(&mut client) {
        Ok(b) => b,
        Err((status, msg)) => return respond(&mut client, status, msg),
    };
    let Some(end) = find_head_end(&buf) else { return respond(&mut client, 400, "no request head") };
    let head_len = end + 4;
    let req = match parse_request(buf.get(..head_len).unwrap_or(&[])) {
        Ok(r) => r,
        Err((status, msg)) => return respond(&mut client, status, msg),
    };
    let data = match open_tunnel(&req.host, req.port) {
        Ok(d) => d,
        Err((status, msg)) => {
            note_refusal(&req.host, req.port, status, &msg);
            return respond(&mut client, status, &msg);
        }
    };
    // Bytes the core sent right behind its head (a client that does not wait for the 200) go into the tunnel first.
    let mut first = req.head;
    first.extend_from_slice(buf.get(head_len..).unwrap_or(&[]));
    if req.connect && client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").is_err() {
        return;
    }
    let _ = client.set_read_timeout(None);
    splice(client, data, &first);
}

/// Copies bytes both ways until the tunnel ends. A half-close from the core is passed on; when the host side
/// ends, everything is closed.
fn splice(client: TcpStream, mut data: File, first: &[u8]) {
    if !first.is_empty() && data.write_all(first).is_err() {
        return;
    }
    let (Ok(mut client_r), Ok(mut data_w)) = (client.try_clone(), data.try_clone()) else { return };
    let mut client_w = match client.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let up = thread::Builder::new().name("netproxy-up".into()).stack_size(STACK).spawn(move || {
        let _ = io::copy(&mut client_r, &mut data_w);
        // SAFETY: shutdown(2) on a descriptor this thread owns; the host sees EOF and passes it to the server.
        unsafe { libc::shutdown(data_w.as_raw_fd(), libc::SHUT_WR) };
    });
    let _ = io::copy(&mut data, &mut client_w);
    // The host side is done (server closed, idle timeout, revoke or stop): end the whole exchange.
    // SAFETY: as above; unblocks the other direction.
    unsafe { libc::shutdown(data.as_raw_fd(), libc::SHUT_RDWR) };
    let _ = client.shutdown(Shutdown::Both);
    if let Ok(h) = up {
        let _ = h.join();
    }
}

// ---------------------------------------------------------------------------------------------------------
// host services (SPEC 8.6): a loopback listener per service, each connection tunnelled to the host by NAME
// ---------------------------------------------------------------------------------------------------------

/// The services this guest knows and the loopback port the core finds each on. The host's `--service NAME=…` list is
/// the same set (host/src/net.rs `KNOWN_SERVICES`). `gpu` is llama.cpp's RPC protocol: `VMAPP_GPU_RPC=127.0.0.1:50052`.
pub const SERVICES: [(&str, u16); 1] = [("gpu", 50052)];

/// Services that are listening now, with the flag that makes their accept loop end (and so closes the port).
static SERVICE_STOPS: Mutex<Vec<(&'static str, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

/// Opens the loopback listener of a service, when the host asks for it (control op `service`, before the core starts).
/// Without this call the port is closed and a connection to it is refused: an app that was not granted the service
/// cannot even reach the guest side of it. Calling it twice is fine.
pub fn start_service(name: &str) -> Result<(), String> {
    let Some(&(svc, port)) = SERVICES.iter().find(|(n, _)| *n == name) else {
        return Err(format!("unknown service \"{}\"", clean_message(name)));
    };
    if lock(&SERVICE_STOPS).iter().any(|(n, _)| *n == svc) {
        return Ok(());
    }
    start_listener(svc, &format!("127.0.0.1:{port}")).map(|_| ())
}

/// Closes the listener of a service (control op `service-stop`, when the user took the service away). Connections that
/// are open are closed by the host. A service that is not listening is fine.
pub fn stop_service(name: &str) -> Result<(), String> {
    let Some(&(svc, _)) = SERVICES.iter().find(|(n, _)| *n == name) else {
        return Err(format!("unknown service \"{}\"", clean_message(name)));
    };
    let mut running = lock(&SERVICE_STOPS);
    running.retain(|(n, stop)| {
        if *n == svc {
            stop.store(true, Ordering::SeqCst);
            false
        } else {
            true
        }
    });
    Ok(())
}

/// Binds `bind` (loopback) and serves `name` on it. Returns the bound address.
fn start_listener(name: &'static str, bind: &str) -> Result<SocketAddr, String> {
    let mut running = lock(&SERVICE_STOPS);
    if running.iter().any(|(n, _)| *n == name) {
        return Err(format!("the {name} service is already listening"));
    }
    let listener = TcpListener::bind(bind).map_err(|e| format!("cannot listen on {bind}: {e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("cannot read the listening address: {e}"))?;
    // Not blocking: the accept loop looks at its stop flag, and dropping the listener then closes the port.
    listener.set_nonblocking(true).map_err(|e| format!("cannot set up the listener: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let mine = stop.clone();
    thread::Builder::new()
        .name(format!("svc-{name}"))
        .spawn(move || accept_service(listener, name, mine))
        .map_err(|e| format!("cannot start the listener thread: {e}"))?;
    running.push((name, stop));
    log!("service: {name} listening on {addr}");
    Ok(addr)
}

fn accept_service(listener: TcpListener, name: &'static str, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((client, _)) => {
                // Some systems hand out the listener's non-blocking mode with the connection.
                let _ = client.set_nonblocking(false);
                if CLIENTS.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS {
                    CLIENTS.fetch_sub(1, Ordering::SeqCst);
                    continue; // dropped: closed at once
                }
                let spawned = thread::Builder::new().name("svc-conn".into()).stack_size(STACK).spawn(move || {
                    let _guard = ClientGuard;
                    serve_service_client(client, name);
                });
                if let Err(e) = spawned {
                    CLIENTS.fetch_sub(1, Ordering::SeqCst);
                    log!("service: cannot start a connection thread: {e}");
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(50)),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => {
                log!("service: accept failed: {e}");
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    log!("service: {name} stopped listening");
}

/// One connection of the core to a service: ask the host for a tunnel, then copy bytes both ways. When the host
/// refuses (the service was taken away, too many connections) the connection is simply closed.
fn serve_service_client(client: TcpStream, name: &str) {
    let _ = client.set_nodelay(true);
    let data = match open_service_tunnel(name) {
        Ok(d) => d,
        Err((status, msg)) => {
            log!("service: {name} refused ({status}): {msg}");
            let _ = client.shutdown(Shutdown::Both);
            return;
        }
    };
    splice(client, data, &[]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(text: &str) -> Result<Request, (u16, &'static str)> {
        parse_request(text.as_bytes())
    }

    #[test]
    fn connect_requests() {
        let r = req("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n").unwrap();
        assert_eq!(r, Request { host: "registry.npmjs.org".into(), port: 443, connect: true, head: vec![] });
        assert_eq!(req("CONNECT [::1]:443 HTTP/1.1\r\n\r\n").unwrap().host, "::1");
        assert!(req("CONNECT example.com HTTP/1.1\r\n\r\n").is_err(), "CONNECT needs a port");
        assert!(req("CONNECT example.com:0 HTTP/1.1\r\n\r\n").is_err());
        assert!(req("CONNECT example.com:70000 HTTP/1.1\r\n\r\n").is_err());
        assert!(req("CONNECT exa\"mple.com:443 HTTP/1.1\r\n\r\n").is_err(), "no quotes in a host name");
        assert!(req("CONNECT example.com:443 SPDY/3\r\n\r\n").is_err());
    }

    #[test]
    fn plain_http_requests() {
        let r = req("GET http://Example.com:8080/a?b=c HTTP/1.1\r\nHost: Example.com:8080\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: x\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n").unwrap();
        assert_eq!((r.host.as_str(), r.port, r.connect), ("Example.com", 8080, false));
        let head = String::from_utf8(r.head).unwrap();
        assert_eq!(head, "GET /a?b=c HTTP/1.1\r\nHost: Example.com:8080\r\nAccept: */*\r\nConnection: close\r\n\r\n");
        assert_eq!(req("GET http://example.com HTTP/1.1\r\n\r\n").unwrap().port, 80);
        assert_eq!(req("GET http://example.com?x=1 HTTP/1.1\r\n\r\n").unwrap().host, "example.com");
        // target in origin form, Host added when missing, fragment dropped, exactly one blank line (the end of the head)
        let h = |t: &str| String::from_utf8(req(&format!("GET {t} HTTP/1.1\r\nAccept: x\r\n\r\n")).unwrap().head).unwrap();
        assert_eq!(h("http://example.com"), "GET / HTTP/1.1\r\nAccept: x\r\nHost: example.com\r\nConnection: close\r\n\r\n");
        assert_eq!(h("http://example.com?x=1"), "GET /?x=1 HTTP/1.1\r\nAccept: x\r\nHost: example.com\r\nConnection: close\r\n\r\n");
        assert_eq!(h("http://example.com:81/p#frag"), "GET /p HTTP/1.1\r\nAccept: x\r\nHost: example.com:81\r\nConnection: close\r\n\r\n");
        assert_eq!(h("http://example.com/").matches("\r\n\r\n").count(), 1);
        assert!(req("GET http://user:pw@example.com/ HTTP/1.1\r\n\r\n").is_err(), "no credentials in URLs");
        assert!(req("GET https://example.com/ HTTP/1.1\r\n\r\n").is_err());
        assert!(req("GET /path HTTP/1.1\r\nHost: x\r\n\r\n").is_err(), "origin form is not a proxy request");
    }

    #[test]
    fn upgrade_keeps_connection_header() {
        let r = req("GET http://example.com/ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").unwrap();
        let head = String::from_utf8(r.head).unwrap();
        assert!(head.contains("Connection: Upgrade\r\n"), "{head}");
        assert!(!head.contains("Connection: close"), "{head}");
    }

    #[test]
    fn head_end_and_hostport() {
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r\nrest"), Some(14));
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n"), None);
        assert_eq!(split_hostport("a.b:443", None), Some(("a.b".to_owned(), 443)));
        assert_eq!(split_hostport("a.b", Some(80)), Some(("a.b".to_owned(), 80)));
        assert_eq!(split_hostport("a.b", None), None);
        assert_eq!(split_hostport("[::1]", Some(80)), Some(("::1".to_owned(), 80)));
        assert_eq!(split_hostport("", Some(80)), None);
    }

    #[test]
    fn messages_are_one_line() {
        assert_eq!(clean_message("a\r\nb"), "a  b");
        assert_eq!(clean_message(&"x".repeat(1000)).len(), 300);
    }

    // ---- the whole proxy against a fake host (one test: the hub is a process-wide singleton) ----

    use std::io::BufRead;
    use std::net::TcpListener;
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;

    fn file_of(s: UnixStream) -> File {
        File::from(OwnedFd::from(s))
    }

    /// Sends `request` to a fresh proxy connection and returns what the proxy answers until it closes, or until
    /// `stop_after` bytes arrived.
    fn exchange(request: &[u8], stop_after: usize) -> (TcpStream, Vec<u8>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                serve_client(s);
            }
        });
        let mut c = TcpStream::connect(addr).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        c.write_all(request).unwrap();
        let mut got = vec![];
        let mut buf = [0u8; 1024];
        while got.len() < stop_after {
            match c.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => got.extend_from_slice(&buf[..n]),
            }
        }
        (c, got)
    }

    #[test]
    fn proxy_flows_with_a_fake_host() {
        // 1. no control connection yet: nothing is granted
        let (_c, got) = exchange(b"CONNECT test.example.com:443 HTTP/1.1\r\n\r\n", usize::MAX);
        let text = String::from_utf8_lossy(&got).into_owned();
        assert!(text.starts_with("HTTP/1.1 403 Forbidden"), "{text}");
        assert!(text.contains("D9010 VmApp network: network not granted"), "{text}");

        // 2. the host connects: a thread plays `vmapp-vm`
        let (host_ctl, guest_ctl) = UnixStream::pair().unwrap();
        let guest_file = file_of(guest_ctl);
        thread::spawn(move || control_conn(guest_file, 0));
        let host_w = host_ctl.try_clone().unwrap();
        thread::spawn(move || {
            let mut w = host_w;
            for line in BufReader::new(host_ctl).lines() {
                let line = line.unwrap();
                let obj = json::parse_object(&line).unwrap();
                let id = json::find_uint(&obj, "id").unwrap();
                if json::find_str(&obj, "op") == Some("service-open") {
                    // a host service: the data connection first (its id line, then an echo server), then the answer
                    if json::find_str(&obj, "name") == Some("gpu") {
                        let (mut data, guest_data) = UnixStream::pair().unwrap();
                        write!(data, "{id}\n").unwrap();
                        let gf = file_of(guest_data);
                        thread::spawn(move || data_conn(gf, 1));
                        thread::spawn(move || {
                            let mut r = data.try_clone().unwrap();
                            let _ = io::copy(&mut r, &mut data);
                        });
                        writeln!(w, "{{\"id\":{id},\"ok\":true}}").unwrap();
                    } else {
                        writeln!(w, "{{\"id\":{id},\"ok\":false,\"error\":\"service not granted\",\"status\":403}}").unwrap();
                    }
                    continue;
                }
                let host = json::find_str(&obj, "host").unwrap().to_owned();
                if host == "deny.example.com" {
                    writeln!(w, "{{\"id\":{id},\"ok\":false,\"error\":\"not allowed: deny.example.com:443\",\"status\":403}}").unwrap();
                } else if host == "slow.example.com" {
                    writeln!(w, "{{\"id\":{id},\"ok\":false,\"error\":\"connect timed out\",\"status\":504}}").unwrap();
                } else {
                    // the data connection first (its id line, then an echo server), then the answer
                    let (mut data, guest_data) = UnixStream::pair().unwrap();
                    write!(data, "{id}\n").unwrap();
                    let gf = file_of(guest_data);
                    thread::spawn(move || data_conn(gf, 1));
                    thread::spawn(move || {
                        let mut r = data.try_clone().unwrap();
                        let _ = io::copy(&mut r, &mut data);
                    });
                    writeln!(w, "{{\"id\":{id},\"ok\":true}}").unwrap();
                }
            }
        });
        for _ in 0..200 {
            if lock(&hub().ctl).is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        // 3. refusals keep the host's status and reason
        let (_c, got) = exchange(b"CONNECT deny.example.com:443 HTTP/1.1\r\n\r\n", usize::MAX);
        let text = String::from_utf8_lossy(&got).into_owned();
        assert!(text.starts_with("HTTP/1.1 403 Forbidden"), "{text}");
        assert!(text.contains("not allowed: deny.example.com:443"), "{text}");
        let (_c, got) = exchange(b"CONNECT slow.example.com:443 HTTP/1.1\r\n\r\n", usize::MAX);
        assert!(String::from_utf8_lossy(&got).starts_with("HTTP/1.1 504 Gateway Timeout"));
        let (_c, got) = exchange(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n", usize::MAX);
        assert!(String::from_utf8_lossy(&got).starts_with("HTTP/1.1 400 Bad Request"));

        // 4. CONNECT: 200, then bytes both ways, including bytes sent right behind the head
        let (mut c, got) = exchange(b"CONNECT test.example.com:443 HTTP/1.1\r\n\r\nearly", 39);
        let text = String::from_utf8_lossy(&got).into_owned();
        assert!(text.starts_with("HTTP/1.1 200 Connection Established\r\n\r\n"), "{text}");
        let mut echoed = text.trim_start_matches("HTTP/1.1 200 Connection Established\r\n\r\n").as_bytes().to_vec();
        c.write_all(b" then more").unwrap();
        let mut buf = [0u8; 64];
        while echoed.len() < "early then more".len() {
            let n = c.read(&mut buf).unwrap();
            assert!(n > 0, "tunnel closed early, got {:?}", String::from_utf8_lossy(&echoed));
            echoed.extend_from_slice(&buf[..n]);
        }
        assert_eq!(String::from_utf8_lossy(&echoed), "early then more");

        // 5. plain HTTP: the head reaches the server rewritten (the echo server sends it back)
        let req = b"GET http://test.example.com/x HTTP/1.1\r\nHost: test.example.com\r\nProxy-Connection: keep-alive\r\n\r\n";
        let (_c, got) = exchange(req, 62); // the length of the rewritten head the echo sends back
        let text = String::from_utf8_lossy(&got).into_owned();
        assert!(text.starts_with("GET /x HTTP/1.1\r\nHost: test.example.com\r\n"), "{text}");
        assert!(text.ends_with("Connection: close\r\n\r\n"), "{text}");
        assert!(!text.to_ascii_lowercase().contains("proxy-connection"), "{text}");

        // 6. a host service (SPEC 8.6): the listener only exists after `start_service`, tunnels by NAME, and closes again
        assert!(start_service("tools").is_err(), "only known services can be started");
        assert!(stop_service("tools").is_err());
        assert!(start_service("").is_err());
        let addr = start_listener("gpu", "127.0.0.1:0").unwrap();
        assert!(start_listener("gpu", "127.0.0.1:0").is_err(), "one listener per service");
        assert!(start_service("gpu").is_ok(), "asking again is fine");
        let mut c = TcpStream::connect(addr).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        c.write_all(b"ggml").unwrap();
        let mut got = [0u8; 4];
        c.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ggml", "bytes go through the tunnel and come back");
        // a service the host refuses closes the connection (the host has no other name than gpu)
        let refused = open_service_tunnel("nope");
        assert_eq!(refused.err().map(|e| e.0), Some(403));
        stop_service("gpu").unwrap();
        let mut closed = false;
        for _ in 0..100 {
            if TcpStream::connect(addr).is_err() {
                closed = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(closed, "after service-stop the port is closed and connections are refused");
        assert!(lock(&SERVICE_STOPS).is_empty());
        // and it can come back
        let again = start_listener("gpu", "127.0.0.1:0").unwrap();
        assert!(TcpStream::connect(again).is_ok());
        stop_service("gpu").unwrap();
    }

    #[test]
    fn service_ports_are_fixed_and_known() {
        assert_eq!(SERVICES, [("gpu", 50052)]);
        assert!(start_service("tools").unwrap_err().contains("unknown service"));
    }
}
