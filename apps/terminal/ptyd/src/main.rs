//! `ptyd`: a tiny PTY bridge for the vmapp Terminal app.
//!
//! ```text
//! ptyd [--cwd DIR] [--rows N] [--cols N] -- PROGRAM [ARGS...]
//! ```
//!
//! Runs PROGRAM on a fresh pseudo-terminal (it becomes a session leader with the terminal as its controlling terminal)
//! and relays the terminal over this process's stdin and stdout as **frames**: one type byte, a 4-byte big-endian payload
//! length, then the payload. The environment of ptyd is the environment of PROGRAM.
//!
//! From the parent (stdin):
//! * `D` data: bytes typed by the user, written to the terminal;
//! * `W` resize: rows then columns, two big-endian u16, applied with TIOCSWINSZ (the foreground program gets SIGWINCH);
//! * `K` signal: one byte, the signal number (1, 2, 3, 9 or 15), sent to PROGRAM's process group.
//!
//! To the parent (stdout):
//! * `R` started: the pid of PROGRAM as a big-endian u32;
//! * `D` data: bytes the terminal produced, in order;
//! * `M` message: a UTF-8 diagnostic line (a failure to start, for example);
//! * `E` exit: PROGRAM's exit code as a big-endian i32 (128 + the signal number when a signal ended it), always the last
//!   frame; all terminal output is delivered before it.
//!
//! When stdin reaches EOF (the parent is gone) PROGRAM's process group gets SIGHUP, then SIGKILL after a second. Nothing is
//! ever written to stderr except fatal start-up errors, and ptyd keeps no state on disk.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Largest accepted frame payload from the parent.
const MAX_FRAME: usize = 4 * 1024 * 1024;
/// One read from the terminal becomes one `D` frame of at most this size.
const READ_CHUNK: usize = 16 * 1024;

const IN_DATA: u8 = b'D';
const IN_RESIZE: u8 = b'W';
const IN_SIGNAL: u8 = b'K';
const OUT_DATA: u8 = b'D';
const OUT_STARTED: u8 = b'R';
const OUT_MESSAGE: u8 = b'M';
const OUT_EXIT: u8 = b'E';

type Out = Arc<Mutex<File>>;

#[derive(Debug, PartialEq)]
struct Options {
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    program: String,
    args: Vec<String>,
}

fn parse_size(flag: &str, value: Option<&String>) -> Result<u16, String> {
    let v = value.ok_or_else(|| format!("{flag} needs a number"))?;
    match v.parse::<u16>() {
        Ok(n) if (1..=2000).contains(&n) => Ok(n),
        _ => Err(format!("{flag} must be a number from 1 to 2000, got {v:?}")),
    }
}

fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut opts = Options { cwd: None, rows: 24, cols: 80, program: String::new(), args: Vec::new() };
    let mut i = 0;
    while let Some(a) = args.get(i) {
        match a.as_str() {
            "--cwd" => {
                i += 1;
                opts.cwd = Some(args.get(i).ok_or("--cwd needs a folder")?.clone());
            }
            "--rows" => {
                i += 1;
                opts.rows = parse_size("--rows", args.get(i))?;
            }
            "--cols" => {
                i += 1;
                opts.cols = parse_size("--cols", args.get(i))?;
            }
            "--" => {
                let rest = args.get(i + 1..).unwrap_or(&[]);
                let (program, tail) = rest.split_first().ok_or("no program after --")?;
                opts.program = program.clone();
                opts.args = tail.to_vec();
                return Ok(opts);
            }
            other => return Err(format!("unknown argument {other:?} (usage: ptyd [--cwd DIR] [--rows N] [--cols N] -- PROGRAM [ARGS...])")),
        }
        i += 1;
    }
    Err("usage: ptyd [--cwd DIR] [--rows N] [--cols N] -- PROGRAM [ARGS...]".to_owned())
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(5 + payload.len());
    v.push(kind);
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

fn send(out: &Out, kind: u8, payload: &[u8]) -> io::Result<()> {
    let bytes = frame(kind, payload);
    let mut f = out.lock().unwrap_or_else(|e| e.into_inner());
    f.write_all(&bytes)
}

/// Reads one frame; `None` at a clean EOF.
fn read_frame(r: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some((head[0], payload)))
}

fn fatal(msg: &str) -> ! {
    let _ = writeln!(io::stderr(), "ptyd: {msg}");
    std::process::exit(2);
}

fn set_cloexec(fd: RawFd) {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
        }
    }
}

/// A new pseudo-terminal of the given size, in UTF-8 mode. Both ends are close-on-exec; `Stdio` dups the slave onto the
/// child's 0, 1 and 2.
fn open_pty(rows: u16, cols: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut m: libc::c_int = -1;
    let mut s: libc::c_int = -1;
    let mut ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: valid out-pointers; no name buffer and no termios are requested.
    let rc = unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty returned two fresh descriptors that we now own.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
    set_cloexec(master.as_raw_fd());
    set_cloexec(slave.as_raw_fd());
    // SAFETY: termios is plain data; tcgetattr fills it.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(slave.as_raw_fd(), &mut t) == 0 {
            t.c_iflag |= libc::IUTF8;
            libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &t);
        }
    }
    Ok((master, slave))
}

fn write_all_fd(fd: RawFd, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        // SAFETY: the pointer and length describe `data`.
        let n = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        data = data.get(n as usize..).unwrap_or(&[]);
    }
    Ok(())
}

/// Terminal output to `D` frames. Ends when the terminal is closed (EIO: nothing holds the slave any more), or when
/// `exited` is set and the terminal has been idle for a moment (a leftover background process may still hold the slave).
fn pump_output(master: RawFd, out: &Out, exited: &AtomicBool) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let mut p = libc::pollfd { fd: master, events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd.
        let n = unsafe { libc::poll(&mut p, 1, 100) };
        if n < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        if n == 0 {
            if exited.load(Ordering::SeqCst) {
                return;
            }
            continue;
        }
        // SAFETY: the pointer and length describe `buf`.
        let r = unsafe { libc::read(master, buf.as_mut_ptr().cast(), buf.len()) };
        if r > 0 {
            if send(out, OUT_DATA, buf.get(..r as usize).unwrap_or(&[])).is_err() {
                // The parent is gone; stdin EOF handles the rest.
                return;
            }
        } else if r == 0 {
            return;
        } else {
            let e = io::Error::last_os_error();
            if matches!(e.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                continue;
            }
            return;
        }
    }
}

fn kill_group(pid: i32, sig: libc::c_int) {
    // SAFETY: kill(2) with plain integers. The child is a session leader, so its pid is also its process group id.
    unsafe {
        libc::kill(-pid, sig);
        libc::kill(pid, sig);
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    match (status.code(), status.signal()) {
        (Some(c), _) => c,
        (None, Some(s)) => 128 + s,
        _ => -1,
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse_args(&argv) {
        Ok(o) => o,
        Err(e) => fatal(&e),
    };
    // SAFETY: fds 0 and 1 are the pipes the parent gave us; the Files own them from here on.
    let (mut stdin, stdout) = unsafe { (File::from_raw_fd(0), File::from_raw_fd(1)) };
    let out: Out = Arc::new(Mutex::new(stdout));

    let (master, slave) = match open_pty(opts.rows, opts.cols) {
        Ok(p) => p,
        Err(e) => fatal(&format!("cannot open a pseudo-terminal: {e} (is devpts mounted at /dev/pts?)")),
    };
    let master = Arc::new(master);

    let mut cmd = Command::new(&opts.program);
    cmd.args(&opts.args);
    if let Some(dir) = &opts.cwd {
        cmd.current_dir(dir);
    }
    let dup = |fd: &OwnedFd| fd.try_clone().map(Stdio::from);
    let (si, so) = match (dup(&slave), dup(&slave)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => fatal("cannot duplicate the terminal"),
    };
    cmd.stdin(si).stdout(so).stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls (setsid, ioctl) run between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let spawned = cmd.spawn();
    // Close our copies of the slave: the terminal now ends when the child's session is gone.
    drop(cmd);
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            let dir = opts.cwd.as_deref().map_or(String::new(), |d| format!(" in {d}"));
            let _ = send(&out, OUT_MESSAGE, format!("cannot start {}{dir}: {e}", opts.program).as_bytes());
            let _ = send(&out, OUT_EXIT, &127i32.to_be_bytes());
            return;
        }
    };
    let pid = child.id() as i32;
    let _ = send(&out, OUT_STARTED, &(pid as u32).to_be_bytes());

    let exited = Arc::new(AtomicBool::new(false));
    let pump = {
        let (master, out, exited) = (Arc::clone(&master), Arc::clone(&out), Arc::clone(&exited));
        std::thread::spawn(move || pump_output(master.as_raw_fd(), &out, &exited))
    };
    {
        // Waits for the child, lets the output drain, reports the exit and ends the process.
        let (out, exited) = (Arc::clone(&out), Arc::clone(&exited));
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(s) => exit_code(s),
                Err(_) => -1,
            };
            exited.store(true, Ordering::SeqCst);
            let _ = pump.join();
            let _ = send(&out, OUT_EXIT, &code.to_be_bytes());
            std::process::exit(0);
        });
    }

    // The parent's frames. Writes to the terminal block while the program is not reading; resize and signal frames wait
    // behind them, which matches what a terminal emulator does.
    let mfd = master.as_raw_fd();
    loop {
        match read_frame(&mut stdin) {
            Ok(Some((IN_DATA, data))) => {
                let _ = write_all_fd(mfd, &data);
            }
            Ok(Some((IN_RESIZE, p))) if p.len() == 4 => {
                let ws = libc::winsize {
                    ws_row: u16::from_be_bytes([p[0], p[1]]),
                    ws_col: u16::from_be_bytes([p[2], p[3]]),
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                // SAFETY: TIOCSWINSZ with a valid winsize on the terminal's master.
                unsafe { libc::ioctl(mfd, libc::TIOCSWINSZ as _, &ws) };
            }
            Ok(Some((IN_SIGNAL, p))) if p.len() == 1 && matches!(p[0], 1 | 2 | 3 | 9 | 15) => {
                kill_group(pid, p[0] as libc::c_int);
            }
            Ok(Some(_)) => {} // an unknown or malformed frame is ignored
            Ok(None) | Err(_) => break,
        }
    }

    // The parent is gone: hang the program up, and kill it if it does not go.
    kill_group(pid, libc::SIGHUP);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !exited.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !exited.load(Ordering::SeqCst) {
        kill_group(pid, libc::SIGKILL);
        std::thread::sleep(Duration::from_millis(200));
    }
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn parses_options_and_command() {
        let o = parse_args(&v(&["--cwd", "/x", "--rows", "30", "--cols", "100", "--", "bash", "-l", "-i"])).unwrap();
        assert_eq!(o, Options { cwd: Some("/x".into()), rows: 30, cols: 100, program: "bash".into(), args: v(&["-l", "-i"]) });
        let o = parse_args(&v(&["--", "ls"])).unwrap();
        assert_eq!((o.rows, o.cols, o.cwd), (24, 80, None));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_args(&v(&[])).is_err());
        assert!(parse_args(&v(&["--", ])).is_err());
        assert!(parse_args(&v(&["--rows", "0", "--", "ls"])).is_err());
        assert!(parse_args(&v(&["--cols", "x", "--", "ls"])).is_err());
        assert!(parse_args(&v(&["--bogus", "--", "ls"])).is_err());
        assert!(parse_args(&v(&["ls"])).is_err());
    }

    #[test]
    fn frames_round_trip() {
        let f = frame(b'D', b"hello");
        assert_eq!(f, [b'D', 0, 0, 0, 5, b'h', b'e', b'l', b'l', b'o']);
        let mut r = io::Cursor::new(f);
        assert_eq!(read_frame(&mut r).unwrap(), Some((b'D', b"hello".to_vec())));
        assert_eq!(read_frame(&mut r).unwrap(), None);
        let mut big = io::Cursor::new(vec![b'D', 0xff, 0xff, 0xff, 0xff]);
        assert!(read_frame(&mut big).is_err());
    }
}
