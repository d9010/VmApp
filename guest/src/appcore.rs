//! The app's core process: start it inside the `/rt` chroot as uid/gid 1000, relay its output to the console,
//! bridge vsock port 1024 to its Unix socket, and track its exit.
//!
//! Adapted from agent-vm/guest/src/agent.rs (commit 8f0c069). Differences: the start command comes from a
//! control-port request instead of `agent.json`; exec failures are reported back synchronously through a
//! close-on-exec pipe; stdout/stderr are relayed line by line with a `core: ` prefix; the child is a session
//! leader whose whole process group is signalled on shutdown.
//!
//! PID 1 must never panic (panic=abort): no `unwrap`, `expect` or indexing, and no `println!`.

use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::json::{self, Value};
use crate::NAME;

/// The chroot of the core.
pub const ROOT: &str = "/rt";
/// Where the core listens, as seen from inside the chroot.
pub const SOCKET_IN_ROOT: &str = "/run/vmapp/core.sock";
const SOCKET_ON_HOST: &str = "/rt/run/vmapp/core.sock";
const CONNECT_RETRY: Duration = Duration::from_secs(15);
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
pub const APP_UID: u32 = 1000;
pub const APP_GID: u32 = 1000;
/// Longest console line relayed in one piece (longer lines are split).
const MAX_OUT_LINE: usize = 16 * 1024;

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const EXITED: u8 = 2;
const STARTING: u8 = 3;

static STATE: AtomicU8 = AtomicU8::new(IDLE);
static PID: AtomicI32 = AtomicI32::new(0);
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);
static OUT_DONE: AtomicBool = AtomicBool::new(true);
/// Held around `waitpid` in the PID 1 loop and around fork+registration in `start`, so that a core that
/// exits immediately cannot be reaped before its pid is known.
static REAP: Mutex<()> = Mutex::new(());

fn reap_lock() -> MutexGuard<'static, ()> {
    REAP.lock().unwrap_or_else(|e| e.into_inner())
}

/// `{...}` value of `"core"` in the hello reply.
pub fn hello_json() -> String {
    match STATE.load(Ordering::SeqCst) {
        RUNNING => format!("{{\"running\":true,\"pid\":{}}}", PID.load(Ordering::SeqCst)),
        EXITED => format!("{{\"running\":false,\"exit\":{}}}", EXIT_CODE.load(Ordering::SeqCst)),
        _ => "{\"running\":false}".to_owned(),
    }
}

pub fn pid() -> i32 {
    PID.load(Ordering::SeqCst)
}

pub fn is_running() -> bool {
    STATE.load(Ordering::SeqCst) == RUNNING
}

pub fn has_exited() -> bool {
    STATE.load(Ordering::SeqCst) == EXITED
}

/// Human description of a wait status.
pub fn describe_status(status: i32) -> String {
    if libc::WIFEXITED(status) {
        format!("exited with status {}", libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        format!("killed by signal {}", libc::WTERMSIG(status))
    } else {
        format!("ended (raw status {status})")
    }
}

/// One `waitpid(-1, WNOHANG)`. Returns `(pid, status)`; `pid <= 0` when nothing was reaped.
pub fn reap_once() -> (i32, i32) {
    let _guard = reap_lock();
    let mut status = 0;
    // SAFETY: waitpid with a valid out-parameter.
    let r = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
    (r, status)
}

/// Record the core's exit (called by the PID 1 loop when it reaped `pid()`).
pub fn mark_exited(status: i32) {
    let code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        -1
    };
    EXIT_CODE.store(code, Ordering::SeqCst);
    STATE.store(EXITED, Ordering::SeqCst);
}

/// Give the output relay a moment to flush what the core wrote just before it exited.
pub fn drain_output() {
    let deadline = Instant::now() + Duration::from_millis(500);
    while !OUT_DONE.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn kill_group(sig: libc::c_int) {
    let pid = PID.load(Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: kill(2) with plain integers; the core is a session/group leader (setsid in the child).
        unsafe {
            libc::kill(-pid, sig);
            libc::kill(pid, sig);
        }
    }
}

/// SIGTERM, wait up to 2 s for the PID 1 loop to see the exit, then SIGKILL.
pub fn terminate() {
    if !is_running() {
        return;
    }
    kill_group(libc::SIGTERM);
    for _ in 0..100 {
        if has_exited() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    log!("core did not stop within 2 s; sending SIGKILL");
    kill_group(libc::SIGKILL);
    for _ in 0..25 {
        if has_exited() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/// Where `tools/mkruntime` stores the image's own environment (`Config.Env` of the Docker image, e.g.
/// `NODE_PATH` for node22), as `K=V` lines. Not part of SPEC section 4's start rules: it only fills in what
/// neither the start request nor the defaults set (see `build_env`).
const RUNTIME_ENV_FILE: &str = "/rt/etc/vmapp/runtime.env";
const RUNTIME_ENV_MAX: u64 = 64 * 1024;

/// `K=V` lines of the runtime env file; blank lines, comments and `VMAPP_*` names are dropped.
pub fn parse_runtime_env(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('=') && l.contains('='))
        .filter(|l| !l.starts_with("VMAPP_"))
        .map(str::to_owned)
        .collect()
}

fn read_runtime_env() -> Vec<String> {
    match std::fs::metadata(RUNTIME_ENV_FILE) {
        Ok(md) if md.is_file() && md.len() <= RUNTIME_ENV_MAX => {
            std::fs::read_to_string(RUNTIME_ENV_FILE).map(|t| parse_runtime_env(&t)).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// Environment for the core: the given entries, then the image's env, then the defaults; an earlier source
/// wins over a later one for the same name.
pub fn build_env(given: &[String], image: &[String], id: &str) -> Vec<String> {
    let mut env: Vec<String> = given.to_vec();
    let has = |env: &[String], k: &str| env.iter().any(|e| e.split('=').next() == Some(k));
    for e in image {
        let k = e.split('=').next().unwrap_or("");
        if !has(&env, k) {
            env.push(e.clone());
        }
    }
    let defaults = [
        ("VMAPP_SOCKET", SOCKET_IN_ROOT),
        ("VMAPP_ID", id),
        ("VMAPP_DATA", "/data"),
        ("HOME", "/data"),
        ("TMPDIR", "/tmp"),
        ("PATH", DEFAULT_PATH),
    ];
    for (k, v) in defaults {
        if !has(&env, k) {
            env.push(format!("{k}={v}"));
        }
    }
    // The network permission's proxy variables (SPEC 8.3): defaults like the ones above, set whether or not the
    // app has any grant (without one, the proxy answers 403).
    for (k, v) in crate::netproxy::ENV_DEFAULTS {
        if !has(&env, k) {
            env.push(format!("{k}={v}"));
        }
    }
    env
}

/// Resolve `command[0]`: a name with a `/` is used as is (relative to the workdir); a bare name is searched in
/// the core's PATH inside `root` (symlinks are not followed on the way: they may point at absolute paths
/// that only make sense inside the chroot).
pub fn resolve_program(prog: &str, env: &[String], root: &str) -> Result<String, String> {
    if prog.contains('/') {
        return Ok(prog.to_owned());
    }
    let path = env.iter().find_map(|e| e.strip_prefix("PATH=")).unwrap_or(DEFAULT_PATH);
    for dir in path.split(':').filter(|d| d.starts_with('/')) {
        let cand = format!("{}/{prog}", dir.trim_end_matches('/'));
        let on_disk = format!("{root}{cand}");
        if let Ok(md) = std::fs::symlink_metadata(&on_disk) {
            use std::os::unix::fs::PermissionsExt;
            if md.file_type().is_symlink() || (md.is_file() && md.permissions().mode() & 0o111 != 0) {
                return Ok(cand);
            }
        }
    }
    Err(format!("command not found in PATH: {prog}"))
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "the start request contains a NUL byte".to_owned())
}

fn pipe2() -> Result<(i32, i32), String> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` is a valid array of two ints.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(format!("pipe2 failed: {}", io::Error::last_os_error()));
    }
    Ok((fds[0], fds[1]))
}

fn close(fd: i32) {
    // SAFETY: closing a descriptor we own.
    unsafe { libc::close(fd) };
}

/// Failure stages reported by the child through the error pipe.
fn stage_name(stage: u8) -> &'static str {
    match stage {
        1 => "chroot",
        2 => "chdir to the workdir",
        3 => "setgroups",
        4 => "setgid",
        5 => "setuid",
        6 => "execve (is the command present and executable in the image?)",
        _ => "setup",
    }
}

/// Handle a `start` request. Returns the core's pid.
pub fn start(req: &[(String, Value)], id: &str) -> Result<i32, String> {
    if STATE.compare_exchange(IDLE, STARTING, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("already started".to_owned());
    }
    let result = start_inner(req, id);
    if result.is_err() {
        // Nothing is running: allow another attempt.
        STATE.store(IDLE, Ordering::SeqCst);
    }
    result
}

fn start_inner(req: &[(String, Value)], id: &str) -> Result<i32, String> {
    let command = json::find_strs(req, "command").ok_or("\"command\" must be an array of strings")?;
    let workdir = match json::find_str(req, "workdir") {
        None => "/app",
        Some(w) if w.starts_with('/') => w,
        Some(_) => return Err("\"workdir\" must be an absolute path".to_owned()),
    };
    let given_env = json::find_strs(req, "env").unwrap_or(&[]);
    if given_env.iter().any(|e| e.starts_with('=') || !e.contains('=')) {
        return Err("\"env\" entries must look like K=V".to_owned());
    }
    let (pid, out_r) = spawn_unprivileged("core", command, workdir, given_env, id, |pid| {
        PID.store(pid, Ordering::SeqCst);
        EXIT_CODE.store(0, Ordering::SeqCst);
        STATE.store(RUNNING, Ordering::SeqCst);
        OUT_DONE.store(false, Ordering::SeqCst);
    })?;
    // SAFETY: `out_r` is a descriptor we own and nothing else uses.
    let reader = unsafe { File::from_raw_fd(out_r) };
    if std::thread::Builder::new().name("core-out".into()).spawn(move || relay_output(reader)).is_err() {
        log!("cannot start the output relay thread; the core's output will be lost");
        OUT_DONE.store(true, Ordering::SeqCst);
    }
    Ok(pid)
}

/// Starts `command` in the runtime root exactly like the core: chroot, uid/gid 1000, no supplementary groups, `no_new_privs`,
/// stdin from /dev/null, stdout and stderr into a pipe. Returns the pid and the read end of that pipe. `started(pid)` runs
/// right after the exec succeeded, while the reaper is held off, so the caller can record the pid before anything can reap it.
/// `what` names the process in the log ("core", or the helper of the experimental GPU backend).
pub fn spawn_unprivileged(
    what: &str,
    command: &[String],
    workdir: &str,
    given_env: &[String],
    id: &str,
    started: impl FnOnce(i32),
) -> Result<(i32, i32), String> {
    let prog_name = match command.first() {
        Some(p) if !p.is_empty() => p.as_str(),
        _ => return Err("\"command\" is empty".to_owned()),
    };
    let mut image_env = read_runtime_env();
    // The runtime's CA bundle, for clients that read SSL_CERT_FILE (the image's own env and the manifest win).
    if Path::new(&format!("{ROOT}{}", crate::netproxy::CA_BUNDLE)).is_file() {
        image_env.push(format!("SSL_CERT_FILE={}", crate::netproxy::CA_BUNDLE));
    }
    let env = build_env(given_env, &image_env, id);
    let prog = resolve_program(prog_name, &env, ROOT)?;

    // Everything the child needs is prepared before fork: it may only call async-signal-safe functions.
    let mut argv_s: Vec<&str> = command.iter().map(String::as_str).collect();
    if let Some(a0) = argv_s.first_mut() {
        *a0 = prog.as_str();
    }
    let argv: Vec<CString> = argv_s.iter().map(|s| cstr(s)).collect::<Result<_, _>>()?;
    let envp: Vec<CString> = env.iter().map(|s| cstr(s)).collect::<Result<_, _>>()?;
    let mut argv_p: Vec<*const libc::c_char> = argv.iter().map(|s| s.as_ptr()).collect();
    argv_p.push(std::ptr::null());
    let mut envp_p: Vec<*const libc::c_char> = envp.iter().map(|s| s.as_ptr()).collect();
    envp_p.push(std::ptr::null());
    let root = cstr(ROOT)?;
    let workdir_c = cstr(workdir)?;
    let devnull = cstr("/dev/null")?;
    let prog_c = cstr(&prog)?;

    let (out_r, out_w) = pipe2()?;
    let (err_r, err_w) = match pipe2() {
        Ok(p) => p,
        Err(e) => {
            close(out_r);
            close(out_w);
            return Err(e);
        }
    };

    log!("starting {what} {:?} (workdir {workdir}) as {APP_UID}:{APP_GID} in {ROOT}", argv_s);

    let guard = reap_lock();
    // SAFETY: fork(2) in a multi-threaded process; the child only makes async-signal-safe calls on data
    // prepared above (no allocation, no locks).
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        let e = io::Error::last_os_error();
        close(out_r);
        close(out_w);
        close(err_r);
        close(err_w);
        return Err(format!("fork failed: {e}"));
    }
    if pid == 0 {
        // SAFETY: child side of fork.
        unsafe { child(&root, &workdir_c, &devnull, &prog_c, &argv_p, &envp_p, out_r, out_w, err_w) };
    }
    close(out_w);
    close(err_w);

    // The error pipe closes on a successful execve; otherwise the child writes 5 bytes (stage, errno).
    let mut report = [0u8; 5];
    let mut got = 0usize;
    while got < report.len() {
        let rest = report.get_mut(got..).unwrap_or(&mut []);
        // SAFETY: reading into a valid buffer of `rest.len()` bytes.
        let n = unsafe { libc::read(err_r, rest.as_mut_ptr().cast(), rest.len()) };
        if n > 0 {
            got += n as usize;
        } else if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        } else {
            break;
        }
    }
    close(err_r);
    if got > 0 {
        let stage = report.first().copied().unwrap_or(0);
        let errno = i32::from_le_bytes([
            report.get(1).copied().unwrap_or(0),
            report.get(2).copied().unwrap_or(0),
            report.get(3).copied().unwrap_or(0),
            report.get(4).copied().unwrap_or(0),
        ]);
        let mut status = 0;
        // SAFETY: waitpid on our own child; the reaper cannot interfere while `guard` is held.
        unsafe { libc::waitpid(pid, &mut status, 0) };
        close(out_r);
        drop(guard);
        return Err(format!("{} failed: {}", stage_name(stage), io::Error::from_raw_os_error(errno)));
    }

    started(pid);
    drop(guard);
    Ok((pid, out_r))
}

/// Runs in the forked child. Never returns.
///
/// # Safety
/// Must only be called right after `fork`; all pointers must be valid NUL-terminated arrays.
#[allow(clippy::too_many_arguments)]
unsafe fn child(
    root: &CString,
    workdir: &CString,
    devnull: &CString,
    prog: &CString,
    argv: &[*const libc::c_char],
    envp: &[*const libc::c_char],
    out_r: i32,
    out_w: i32,
    err_w: i32,
) -> ! {
    // Report (stage, errno) through the error pipe and leave.
    unsafe fn fail(err_w: i32, stage: u8) -> ! {
        let e = *libc::__errno_location();
        let b = e.to_le_bytes();
        let msg = [stage, b[0], b[1], b[2], b[3]];
        libc::write(err_w, msg.as_ptr().cast(), msg.len());
        libc::_exit(127)
    }
    libc::setsid();
    // stdin <- /dev/null; stdout and stderr -> the relay pipe.
    let nul = libc::open(devnull.as_ptr(), libc::O_RDONLY);
    if nul >= 0 {
        libc::dup2(nul, 0);
        if nul > 2 {
            libc::close(nul);
        }
    }
    libc::dup2(out_w, 1);
    libc::dup2(out_w, 2);
    libc::close(out_r);
    libc::close(out_w);
    if libc::chroot(root.as_ptr()) != 0 {
        fail(err_w, 1);
    }
    if libc::chdir(workdir.as_ptr()) != 0 {
        fail(err_w, 2);
    }
    if libc::setgroups(0, std::ptr::null()) != 0 {
        fail(err_w, 3);
    }
    if libc::setgid(APP_GID) != 0 {
        fail(err_w, 4);
    }
    if libc::setuid(APP_UID) != 0 {
        fail(err_w, 5);
    }
    libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    libc::execve(prog.as_ptr(), argv.as_ptr(), envp.as_ptr());
    fail(err_w, 6)
}

// ---------------------------------------------------------------------------
// output relay
// ---------------------------------------------------------------------------

fn emit_line(bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end_matches('\r');
    log_raw(&format!("core: {text}\n"));
}

/// Read the core's stdout+stderr and write each line to the console as `core: <line>`.
fn relay_output(mut pipe: File) {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                for &b in chunk.get(..n).unwrap_or(&[]) {
                    if b == b'\n' {
                        emit_line(&buf);
                        buf.clear();
                    } else {
                        buf.push(b);
                        if buf.len() >= MAX_OUT_LINE {
                            emit_line(&buf);
                            buf.clear();
                        }
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    if !buf.is_empty() {
        emit_line(&buf);
    }
    OUT_DONE.store(true, Ordering::SeqCst);
}

/// Write `s` to the console in one go, ignoring errors.
fn log_raw(s: &str) {
    let _ = io::stderr().write_all(s.as_bytes());
}

// ---------------------------------------------------------------------------
// bridge (vsock port 1024 <-> the core's Unix socket)
// ---------------------------------------------------------------------------

/// One vsock bridge connection <-> a new connection to the core's socket (retried for up to 15 s).
pub fn bridge(vsock: File) {
    let started = Instant::now();
    let unix = loop {
        match UnixStream::connect(Path::new(SOCKET_ON_HOST)) {
            Ok(s) => break s,
            Err(e) => {
                if started.elapsed() >= CONNECT_RETRY || has_exited() {
                    log!("bridge: cannot reach the core socket: {e}");
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    let (Ok(mut vsock_r), Ok(mut unix_w)) = (vsock.try_clone(), unix.try_clone()) else {
        log!("bridge: cannot duplicate descriptors");
        return;
    };
    let mut vsock_w = vsock;
    let mut unix_r = unix;
    // vsock -> core. After the host's EOF only the write side of the core socket is closed, so a peer that
    // half-closes still receives the rest.
    let up = std::thread::Builder::new().name("bridge-up".into()).spawn(move || {
        let _ = io::copy(&mut vsock_r, &mut unix_w);
        let _ = unix_w.shutdown(std::net::Shutdown::Write);
    });
    // core -> vsock. When the core closes, the whole connection ends.
    let _ = io::copy(&mut unix_r, &mut vsock_w);
    // SAFETY: shutdown(2) on descriptors we own; unblocks the other direction.
    unsafe {
        libc::shutdown(vsock_w.as_raw_fd(), libc::SHUT_RDWR);
    }
    let _ = unix_r.shutdown(std::net::Shutdown::Both);
    if let Ok(h) = up {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_defaults() {
        let given = vec!["NODE_ENV=production".to_owned(), "HOME=/x".to_owned()];
        let image = parse_runtime_env("# c\nNODE_PATH=/x\nPATH=/img/bin\nHOME=/nope\nVMAPP_ID=evil\n\n=bad\nnoeq\n");
        assert_eq!(image, ["NODE_PATH=/x", "PATH=/img/bin", "HOME=/nope"]);
        let env = build_env(&given, &image, "ab12cd34");
        assert!(env.contains(&"NODE_PATH=/x".to_owned()));
        assert!(env.contains(&"PATH=/img/bin".to_owned()));
        assert!(!env.iter().any(|e| e.starts_with("PATH=/usr")));
        assert!(env.contains(&"NODE_ENV=production".to_owned()));
        assert!(env.contains(&"HOME=/x".to_owned()));
        assert!(!env.contains(&"HOME=/data".to_owned()));
        assert!(env.contains(&"VMAPP_SOCKET=/run/vmapp/core.sock".to_owned()));
        assert!(env.contains(&"VMAPP_ID=ab12cd34".to_owned()));
        assert!(env.contains(&"VMAPP_DATA=/data".to_owned()));
        assert!(env.contains(&"TMPDIR=/tmp".to_owned()));
        let plain = build_env(&given, &[], "ab12cd34");
        assert!(plain.iter().any(|e| e.starts_with("PATH=/usr/local/sbin")));
    }

    #[test]
    fn proxy_env_defaults() {
        let env = build_env(&["NO_PROXY=example.com".to_owned()], &[], "ab12cd34");
        for want in [
            "HTTPS_PROXY=http://127.0.0.1:3128",
            "HTTP_PROXY=http://127.0.0.1:3128",
            "ALL_PROXY=http://127.0.0.1:3128",
            "https_proxy=http://127.0.0.1:3128",
            "no_proxy=localhost,127.0.0.1",
            "NODE_USE_ENV_PROXY=1",
        ] {
            assert!(env.contains(&want.to_owned()), "{want} missing in {env:?}");
        }
        // an app's own setting wins over the platform default
        assert!(env.contains(&"NO_PROXY=example.com".to_owned()));
        assert!(!env.contains(&"NO_PROXY=localhost,127.0.0.1".to_owned()));
    }

    /// Needs root, a chroot at /rt with a shell, and /dev/null: run it in a container (see PM.md / report).
    #[test]
    #[ignore]
    fn start_in_chroot() {
        let req = json::parse_object(r#"{"op":"start","command":["/nonexistent"],"workdir":"/","env":[]}"#).unwrap();
        let e = start(&req, "t").unwrap_err();
        assert!(e.contains("execve"), "{e}");
        let req = json::parse_object(
            r#"{"op":"start","command":["sh","-c","echo out; echo err >&2; echo uid=$(id -u) gid=$(id -g) env=$VMAPP_ID; exit 3"],"workdir":"/","env":[]}"#,
        )
        .unwrap();
        let pid = start(&req, "t0t0t0t0").unwrap();
        assert!(start(&req, "x").unwrap_err().contains("already started"));
        loop {
            let (r, st) = reap_once();
            if r == pid {
                mark_exited(st);
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drain_output();
        assert!(has_exited());
        assert_eq!(hello_json(), "{\"running\":false,\"exit\":3}");
    }

    #[test]
    fn program_resolution() {
        let env = build_env(&[], &[], "x");
        assert_eq!(resolve_program("./x", &env, "/nonexistent").unwrap(), "./x");
        assert_eq!(resolve_program("/app/x", &env, "/nonexistent").unwrap(), "/app/x");
        assert!(resolve_program("nope", &env, "/nonexistent").is_err());
        // /bin/sh exists on every Linux the tests run on, here as the "root" /.
        assert!(resolve_program("sh", &env, "").is_ok());
    }
}
