//! core-echo: a tiny test core for the vmapp end-to-end tests.
//!
//! Listens on `$VMAPP_SOCKET` (a Unix stream socket). Every request is one line, every reply one JSON line:
//!   ENV                 -> {"VMAPP_ID":..,"VMAPP_DATA":..,"HOME":..,"uid":..,"gid":..,"cwd":..,"env":{..}}
//!   LS <path>           -> {"ok":true,"names":[sorted names]}
//!   WRITE <path> <text> -> {"ok":true}
//!   READ <path>         -> {"ok":true,"text":".."}
//!   PTY                 -> opens a pseudo-terminal through /dev/ptmx, sets a 7x40 window size, writes "pty-ok\n" to the slave and
//!                          reads it back from the master:
//!                          {"ok":true,"slave":"/dev/pts/N","text":"pty-ok\r\n","rows":7,"cols":40,"uid":..,"gid":..,"mode":"0620",
//!                          "ptmx":"<what the symlink /dev/ptmx points to>"} (SPEC section 4: devpts)
//!   EXIT <code>         -> {"ok":true}, then the process exits with that code
//!   anything else       -> {"echo":"<line>"}
//! Network (SPEC 8.3; everything goes through the proxy at 127.0.0.1:3128, as any HTTP client would):
//!   HTTPGET <host> <port> <path>  -> {"ok":true,"status":N,"text":"<first 4 KiB of the body>","bytes":<body length>}
//!   CONNECT <host> <port> <text>  -> opens a CONNECT tunnel, sends <text>, half-closes, reads to EOF:
//!                                    {"ok":true,"status":N,"text":".."} (status 200 and the echoed text, or the refusal)
//!   TUNNEL <host> <port>          -> opens a CONNECT tunnel and keeps it: {"ok":true,"id":N} or the refusal
//!   PING <id>                     -> sends "ping" through tunnel <id> and expects it back: {"ok":true} or an error
//! Host services (SPEC 8.6; a loopback port of the guest that tunnels to a service the loader started on the host):
//!   SVC <port> <text>             -> connects to 127.0.0.1:<port>, sends <text>, half-closes, reads to EOF:
//!                                    {"ok":true,"text":".."} (the echo; empty when the host refused), or {"ok":false,...} when
//!                                    nothing listens on the port
//!   SVCBIG <port> <bytes>         -> sends <bytes> bytes of a pattern and checks that the same bytes come back:
//!                                    {"ok":true,"bytes":N,"ms":M} or an error
//!   SVCOPEN <port>                -> connects and keeps the connection: {"ok":true,"id":N} (PING <id> then works on it)
//! Failures reply {"ok":false,"error":".."}. Any number of connections may be open at once.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

const PROXY: &str = "127.0.0.1:3128";

/// Open tunnels of the TUNNEL / PING commands.
static TUNNELS: Mutex<Vec<TcpStream>> = Mutex::new(Vec::new());

fn proxy_connect() -> std::io::Result<TcpStream> {
    let s = TcpStream::connect(PROXY)?;
    s.set_read_timeout(Some(Duration::from_secs(20)))?;
    s.set_write_timeout(Some(Duration::from_secs(20)))?;
    Ok(s)
}

/// Reads the response head (up to the blank line) and returns (status, head text, bytes read past the head).
fn read_head(s: &mut TcpStream) -> std::io::Result<(u16, String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).into_owned();
            let status = head.split(' ').nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
            return Ok((status, head, buf[i + 4..].to_vec()));
        }
        let n = s.read(&mut chunk)?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the proxy closed before the response head ended"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn http_get(host: &str, port: &str, path: &str) -> String {
    let run = || -> std::io::Result<String> {
        let mut s = proxy_connect()?;
        write!(s, "GET http://{host}:{port}{path} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: core-echo\r\nConnection: close\r\n\r\n")?;
        let (status, _head, mut body) = read_head(&mut s)?;
        s.read_to_end(&mut body)?;
        let text = String::from_utf8_lossy(&body[..body.len().min(4096)]).into_owned();
        Ok(format!("{{\"ok\":true,\"status\":{status},\"text\":{},\"bytes\":{}}}", jstr(&text), body.len()))
    };
    run().unwrap_or_else(err)
}

/// Sends CONNECT and returns the open stream and the status; bytes the proxy sent after the head are returned too.
fn open_tunnel(host: &str, port: &str) -> std::io::Result<(TcpStream, u16, Vec<u8>)> {
    let mut s = proxy_connect()?;
    write!(s, "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n")?;
    let (status, head, rest) = read_head(&mut s)?;
    if status != 200 {
        let mut body = rest;
        let _ = s.read_to_end(&mut body);
        let text = format!("{head}\n{}", String::from_utf8_lossy(&body));
        return Err(std::io::Error::other(format!("{status}:{text}")));
    }
    Ok((s, status, rest))
}

fn refusal_reply(e: std::io::Error) -> String {
    let m = e.to_string();
    match m.split_once(':') {
        Some((code, text)) if code.parse::<u16>().is_ok() => {
            format!("{{\"ok\":true,\"status\":{code},\"text\":{}}}", jstr(text))
        }
        _ => err(m),
    }
}

fn connect_echo(host: &str, port: &str, text: &str) -> String {
    let (mut s, status, mut got) = match open_tunnel(host, port) {
        Ok(t) => t,
        Err(e) => return refusal_reply(e),
    };
    let mut run = || -> std::io::Result<()> {
        s.write_all(text.as_bytes())?;
        s.shutdown(Shutdown::Write)?;
        s.read_to_end(&mut got)?;
        Ok(())
    };
    if let Err(e) = run() {
        return err(e);
    }
    format!("{{\"ok\":true,\"status\":{status},\"text\":{}}}", jstr(&String::from_utf8_lossy(&got)))
}

fn tunnel_open(host: &str, port: &str) -> String {
    match open_tunnel(host, port) {
        Ok((s, _, _)) => {
            let mut t = TUNNELS.lock().unwrap_or_else(|e| e.into_inner());
            t.push(s);
            format!("{{\"ok\":true,\"id\":{}}}", t.len() - 1)
        }
        Err(e) => refusal_reply(e),
    }
}

fn tunnel_ping(id: usize) -> String {
    let mut t = TUNNELS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(s) = t.get_mut(id) else { return err("no such tunnel") };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let run = |s: &mut TcpStream| -> std::io::Result<()> {
        s.write_all(b"ping")?;
        let mut b = [0u8; 4];
        s.read_exact(&mut b)?;
        if &b == b"ping" {
            Ok(())
        } else {
            Err(std::io::Error::other("unexpected bytes"))
        }
    };
    match run(s) {
        Ok(()) => "{\"ok\":true}".to_string(),
        Err(e) => err(format!("tunnel {id} is closed: {e}")),
    }
}

fn svc_connect(port: &str) -> std::io::Result<TcpStream> {
    let s = TcpStream::connect(format!("127.0.0.1:{port}"))?;
    s.set_read_timeout(Some(Duration::from_secs(60)))?;
    s.set_write_timeout(Some(Duration::from_secs(60)))?;
    Ok(s)
}

fn svc_echo(port: &str, text: &str) -> String {
    let run = || -> std::io::Result<String> {
        let mut s = svc_connect(port)?;
        s.write_all(text.as_bytes())?;
        s.shutdown(Shutdown::Write)?;
        let mut got = Vec::new();
        let _ = s.read_to_end(&mut got); // a reset after the host refused is the same as an empty answer
        Ok(format!("{{\"ok\":true,\"text\":{}}}", jstr(&String::from_utf8_lossy(&got))))
    };
    run().unwrap_or_else(err)
}

/// Sends `n` bytes of a pattern and reads them back (the peer is an echo), writing and reading at the same time.
fn svc_big(port: &str, n: usize) -> String {
    let run = || -> std::io::Result<String> {
        let started = std::time::Instant::now();
        let s = svc_connect(port)?;
        let mut w = s.try_clone()?;
        let writer = thread::spawn(move || -> std::io::Result<()> {
            let mut chunk = [0u8; 65536];
            let mut sent = 0usize;
            while sent < n {
                let m = chunk.len().min(n - sent);
                for (i, b) in chunk[..m].iter_mut().enumerate() {
                    *b = ((sent + i) % 251) as u8;
                }
                w.write_all(&chunk[..m])?;
                sent += m;
            }
            Ok(())
        });
        let mut r = s;
        let mut buf = vec![0u8; 65536];
        let mut got = 0usize;
        while got < n {
            let m = r.read(&mut buf)?;
            if m == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, format!("the connection closed after {got} of {n} bytes")));
            }
            for (i, b) in buf[..m].iter().enumerate() {
                if *b != ((got + i) % 251) as u8 {
                    return Err(std::io::Error::other(format!("byte {} came back changed", got + i)));
                }
            }
            got += m;
        }
        match writer.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(std::io::Error::other("the writer panicked")),
        }
        Ok(format!("{{\"ok\":true,\"bytes\":{got},\"ms\":{}}}", started.elapsed().as_millis()))
    };
    run().unwrap_or_else(err)
}

fn svc_open(port: &str) -> String {
    match svc_connect(port) {
        Ok(s) => {
            let mut t = TUNNELS.lock().unwrap_or_else(|e| e.into_inner());
            t.push(s);
            format!("{{\"ok\":true,\"id\":{}}}", t.len() - 1)
        }
        Err(e) => err(e),
    }
}

fn jstr(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn err(msg: impl std::fmt::Display) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", jstr(&msg.to_string()))
}

fn env_reply() -> String {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    let (uid, gid) = std::fs::metadata("/proc/self").map(|m| (m.uid(), m.gid())).unwrap_or((u32::MAX, u32::MAX));
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let env_json: Vec<String> = env.iter().map(|(k, v)| format!("{}:{}", jstr(k), jstr(v))).collect();
    format!(
        "{{\"VMAPP_ID\":{},\"VMAPP_DATA\":{},\"HOME\":{},\"uid\":{uid},\"gid\":{gid},\"cwd\":{},\"env\":{{{}}}}}",
        jstr(&var("VMAPP_ID")),
        jstr(&var("VMAPP_DATA")),
        jstr(&var("HOME")),
        jstr(&cwd),
        env_json.join(",")
    )
}

/// The PTY command: a full round trip through a fresh pseudo-terminal (see the header).
fn pty_probe() -> String {
    use std::ffi::CStr;
    use std::os::fd::{FromRawFd, OwnedFd};
    let run = || -> std::io::Result<String> {
        let last = std::io::Error::last_os_error;
        // SAFETY: plain libc calls on descriptors and buffers owned by this function; each descriptor is wrapped in an
        // OwnedFd at once, so it is closed on every path.
        unsafe {
            let m = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            if m < 0 {
                return Err(last());
            }
            let master = OwnedFd::from_raw_fd(m);
            if libc::grantpt(m) != 0 || libc::unlockpt(m) != 0 {
                return Err(last());
            }
            let mut name = [0 as libc::c_char; 64];
            if libc::ptsname_r(m, name.as_mut_ptr(), name.len()) != 0 {
                return Err(last());
            }
            let slave_path = CStr::from_ptr(name.as_ptr()).to_string_lossy().into_owned();
            let s = libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
            if s < 0 {
                return Err(last());
            }
            let slave = OwnedFd::from_raw_fd(s);
            let ws = libc::winsize { ws_row: 7, ws_col: 40, ws_xpixel: 0, ws_ypixel: 0 };
            if libc::ioctl(m, libc::TIOCSWINSZ as _, &ws) != 0 {
                return Err(last());
            }
            let mut got: libc::winsize = std::mem::zeroed();
            if libc::ioctl(s, libc::TIOCGWINSZ as _, &mut got) != 0 {
                return Err(last());
            }
            if libc::write(s, b"pty-ok\n".as_ptr().cast(), 7) != 7 {
                return Err(last());
            }
            let mut p = libc::pollfd { fd: m, events: libc::POLLIN, revents: 0 };
            if libc::poll(&mut p, 1, 3000) != 1 {
                return Err(std::io::Error::other("nothing came out of the master within 3 s"));
            }
            let mut buf = [0u8; 64];
            let n = libc::read(m, buf.as_mut_ptr().cast(), buf.len());
            if n < 0 {
                return Err(last());
            }
            let text = String::from_utf8_lossy(buf.get(..n as usize).unwrap_or(&[])).into_owned();
            let md = std::fs::metadata(&slave_path)?;
            let ptmx = std::fs::read_link("/dev/ptmx").map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            drop((master, slave));
            Ok(format!(
                "{{\"ok\":true,\"slave\":{},\"text\":{},\"rows\":{},\"cols\":{},\"uid\":{},\"gid\":{},\"mode\":\"{:04o}\",\"ptmx\":{}}}",
                jstr(&slave_path),
                jstr(&text),
                got.ws_row,
                got.ws_col,
                md.uid(),
                md.gid(),
                md.mode() & 0o7777,
                jstr(&ptmx)
            ))
        }
    };
    run().unwrap_or_else(err)
}

fn handle(line: &str) -> String {
    if line == "ENV" {
        return env_reply();
    }
    if line == "PTY" {
        return pty_probe();
    }
    if let Some(path) = line.strip_prefix("LS ") {
        return match std::fs::read_dir(path) {
            Ok(rd) => {
                let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                names.sort();
                let items: Vec<String> = names.iter().map(|n| jstr(n)).collect();
                format!("{{\"ok\":true,\"names\":[{}]}}", items.join(","))
            }
            Err(e) => err(e),
        };
    }
    if let Some(rest) = line.strip_prefix("WRITE ") {
        let (path, text) = rest.split_once(' ').unwrap_or((rest, ""));
        return match std::fs::write(path, text) {
            Ok(()) => "{\"ok\":true}".to_string(),
            Err(e) => err(e),
        };
    }
    if let Some(path) = line.strip_prefix("READ ") {
        return match std::fs::read_to_string(path) {
            Ok(t) => format!("{{\"ok\":true,\"text\":{}}}", jstr(&t)),
            Err(e) => err(e),
        };
    }
    if let Some(code) = line.strip_prefix("EXIT ") {
        return match code.trim().parse::<i32>() {
            Ok(c) => {
                // Reply first, then exit shortly after so the client sees the answer.
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_millis(200));
                    std::process::exit(c);
                });
                "{\"ok\":true}".to_string()
            }
            Err(e) => err(e),
        };
    }
    if let Some(rest) = line.strip_prefix("HTTPGET ") {
        let p: Vec<&str> = rest.splitn(3, ' ').collect();
        return match p.as_slice() {
            [host, port, path] => http_get(host, port, path),
            _ => err("usage: HTTPGET <host> <port> <path>"),
        };
    }
    if let Some(rest) = line.strip_prefix("CONNECT ") {
        let p: Vec<&str> = rest.splitn(3, ' ').collect();
        return match p.as_slice() {
            [host, port, text] => connect_echo(host, port, text),
            _ => err("usage: CONNECT <host> <port> <text>"),
        };
    }
    if let Some(rest) = line.strip_prefix("TUNNEL ") {
        let p: Vec<&str> = rest.split(' ').collect();
        return match p.as_slice() {
            [host, port] => tunnel_open(host, port),
            _ => err("usage: TUNNEL <host> <port>"),
        };
    }
    if let Some(rest) = line.strip_prefix("SVC ") {
        let p: Vec<&str> = rest.splitn(2, ' ').collect();
        return match p.as_slice() {
            [port, text] => svc_echo(port, text),
            _ => err("usage: SVC <port> <text>"),
        };
    }
    if let Some(rest) = line.strip_prefix("SVCBIG ") {
        let p: Vec<&str> = rest.split(' ').collect();
        return match p.as_slice() {
            [port, n] => match n.parse::<usize>() {
                Ok(n) => svc_big(port, n),
                Err(e) => err(e),
            },
            _ => err("usage: SVCBIG <port> <bytes>"),
        };
    }
    if let Some(port) = line.strip_prefix("SVCOPEN ") {
        return svc_open(port.trim());
    }
    if let Some(id) = line.strip_prefix("PING ") {
        return match id.trim().parse::<usize>() {
            Ok(i) => tunnel_ping(i),
            Err(e) => err(e),
        };
    }
    format!("{{\"echo\":{}}}", jstr(line))
}

fn serve(stream: UnixStream) {
    let Ok(reader) = stream.try_clone() else { return };
    let mut writer = stream;
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { return };
        let reply = handle(line.trim_end_matches('\r'));
        if writeln!(writer, "{reply}").is_err() {
            return;
        }
    }
}

fn main() {
    let Ok(path) = std::env::var("VMAPP_SOCKET") else {
        let _ = writeln!(std::io::stderr(), "core-echo: VMAPP_SOCKET is not set");
        std::process::exit(2);
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "core-echo: cannot bind {path}: {e}");
            std::process::exit(2);
        }
    };
    let _ = writeln!(std::io::stdout(), "core-echo: listening on {path}");
    for stream in listener.incoming().flatten() {
        thread::spawn(move || serve(stream));
    }
}
