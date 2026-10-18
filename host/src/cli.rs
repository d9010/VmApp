// Adapted from agent-vm/host/src/bin/avm.rs (agent-vm commit 8f0c069)
//
//! The launcher's command line, stdin protocol and main loop, shared by `vmapp-vm` (Virtualization.framework, the default
//! backend) and `vmapp-vm-krun` (the experimental libkrun backend, SPEC 8.7):
//!
//! ```text
//! vmapp-vm run --kernel IMAGE --initramfs CPIO --runtime RUNTIME.img --core CORE.cpio --appdata DIR
//!              [--share NAME:ACCESS:DIR]... --start JSON --socket PATH
//!              [--memory MiB] [--cpus N] [--console LOG] [--id HEX8] [--no-follow-parent]
//!              [--net RULE]... [--service NAME=127.0.0.1:PORT]... [--dev-allow-loopback] [--dev-resolve NAME=IP]...
//! ```
//!
//! `vmapp-vm-krun run` takes the same flags plus `--gpu-window MiB`, `--watchdog SECS`, `--krun-dir DIR`, `--no-gpu` and
//! `--dev-no-sandbox` (SPEC 8.7).
//!
//! The launcher contract is in vmapp/SPEC.md section 5. stdout carries JSON lines, stdin carries JSON-line
//! commands from the parent. Never use println!/eprintln!/print! here: they panic when the parent's pipe
//! is closed, and the shutdown and the write-only delivery must still run.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::net::{NetRule, ServiceSpec};
use crate::{warn, Access, ShareSpec, VmConfig};

/// Which backend a launcher binary drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Virtualization.framework: `vmapp-vm`.
    Vz,
    /// The experimental libkrun backend: `vmapp-vm-krun` (SPEC 8.7).
    Krun,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Vz => "vmapp-vm",
            Kind::Krun => "vmapp-vm-krun",
        }
    }
}

/// SIGINT / SIGTERM / SIGHUP arrived.
static SIGNALED: AtomicBool = AtomicBool::new(false);
/// The parent process exited (kqueue) or stdin reached EOF.
static PARENT_GONE: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    SIGNALED.store(true, Ordering::SeqCst);
}

fn usage(kind: Kind) -> String {
    let mut s = format!(
        "usage: {} run --kernel IMAGE --initramfs CPIO --runtime RUNTIME.img --core CORE.cpio --appdata DIR\n\
         \x20                  [--share NAME:ACCESS:DIR]... --start JSON --socket PATH\n\
         \x20                  [--memory MiB] [--cpus N] [--console LOG] [--id HEX8] [--no-follow-parent]\n\
         \x20                  [--net HOST[:PORT,...]]... [--service NAME=127.0.0.1:PORT]...\n\
         \x20                  [--dev-allow-loopback] [--dev-resolve NAME=IP]...",
        kind.name()
    );
    if kind == Kind::Krun {
        s.push_str(
            "\n                  [--gpu-window MiB] [--watchdog SECS] [--krun-dir DIR] [--no-gpu] [--dev-no-sandbox]",
        );
    }
    s
}

/// Writes one JSON line to stdout, ignoring failures (the parent may be gone and its pipe closed).
fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn emit_error(op: &str, message: &str) {
    emit(&json!({"error": {"op": op, "message": message}}));
}

/// Calls `on_exit` once when the process `pid` exits (kqueue `NOTE_EXIT`). Returns at once when it already has.
/// Used for the parent of the launcher and, in the VMM child, for the launcher.
pub fn watch_process_exit(pid: libc::pid_t, name: &str, on_exit: impl FnOnce() + Send + 'static) {
    let name = name.to_string();
    let spawned = thread::Builder::new().name(format!("{name}-watch")).spawn(move || {
        // SAFETY: plain kqueue/kevent calls on a descriptor owned by this thread, with a zeroed event buffer.
        let died = unsafe {
            let kq = libc::kqueue();
            if kq < 0 {
                return;
            }
            let change = libc::kevent {
                ident: pid as libc::uintptr_t,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            let mut ev: libc::kevent = std::mem::zeroed();
            let n = libc::kevent(kq, &change, 1, &mut ev, 1, std::ptr::null());
            let died = if n > 0 && (ev.flags & libc::EV_ERROR) != 0 {
                // Registration failed: ESRCH means the process is already gone.
                ev.data == libc::ESRCH as libc::intptr_t
            } else {
                n > 0 && (ev.fflags & libc::NOTE_EXIT) != 0
            };
            libc::close(kq);
            died
        };
        if died {
            on_exit();
        }
    });
    if let Err(e) = spawned {
        warn(format_args!("{name}: cannot watch process {pid}: {e}"));
    }
}

/// Gracefully stop (same path as a signal) when the parent process exits. Skipped when the parent is
/// already launchd (pid 1): there is nobody to follow.
fn follow_parent(name: &'static str) {
    // SAFETY: getppid has no preconditions.
    let ppid = unsafe { libc::getppid() };
    if ppid <= 1 {
        return;
    }
    watch_process_exit(ppid, "vmapp-parent", move || {
        // The parent can also have died between getppid() and the registration; either way it is gone now.
        PARENT_GONE.store(true, Ordering::SeqCst);
        warn(format_args!("{name}: parent process {ppid} exited; shutting down"));
    });
}

struct Cli {
    cfg: VmConfig,
    start: Value,
    follow: bool,
}

fn parse(kind: Kind, args: Vec<String>) -> Result<Cli, String> {
    let mut it = args.into_iter();
    match it.next().as_deref() {
        Some("run") => {}
        _ => return Err(usage(kind)),
    }
    let (mut kernel, mut initramfs, mut runtime, mut core, mut appdata) = (None, None, None, None, None);
    let (mut socket, mut console, mut id, mut start) = (None, None, None, None);
    let mut shares = vec![];
    let (mut memory, mut cpus) = (None, None);
    let mut follow = true;
    let mut net_rules: Vec<NetRule> = vec![];
    let mut services: Vec<ServiceSpec> = vec![];
    let mut net_opts = crate::net::NetOptions::default();
    let mut krun_opts = crate::krun::KrunOptions::default();
    while let Some(flag) = it.next() {
        let mut val = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--kernel" => kernel = Some(PathBuf::from(val("--kernel")?)),
            "--initramfs" => initramfs = Some(PathBuf::from(val("--initramfs")?)),
            "--runtime" => runtime = Some(PathBuf::from(val("--runtime")?)),
            "--core" => core = Some(PathBuf::from(val("--core")?)),
            "--appdata" => appdata = Some(PathBuf::from(val("--appdata")?)),
            "--share" => shares.push(ShareSpec::parse(&val("--share")?).map_err(|e| e.to_string())?),
            "--start" => start = Some(val("--start")?),
            "--socket" => socket = Some(PathBuf::from(val("--socket")?)),
            "--console" => console = Some(PathBuf::from(val("--console")?)),
            "--id" => id = Some(val("--id")?),
            "--memory" => memory = Some(val("--memory")?.parse::<u64>().map_err(|_| "--memory must be a number of MiB")?),
            "--cpus" => cpus = Some(val("--cpus")?.parse::<u32>().map_err(|_| "--cpus must be a number")?),
            "--no-follow-parent" => follow = false,
            "--net" => {
                let rule = NetRule::parse(&val("--net")?).map_err(|e| e.to_string())?;
                // one rule per pattern: a later --net for the same host replaces the earlier one
                net_rules.retain(|r| r.pattern() != rule.pattern());
                net_rules.push(rule);
            }
            "--service" => {
                // A host service (SPEC 8.6): loopback only, given by the loader on the command line and nowhere else.
                let s = ServiceSpec::parse(&val("--service")?).map_err(|e| e.to_string())?;
                if services.iter().any(|x| x.name == s.name) {
                    return Err(format!("--service {} is given twice", s.name));
                }
                services.push(s);
            }
            "--dev-allow-loopback" => net_opts.allow_loopback = true,
            "--dev-resolve" => {
                let v = val("--dev-resolve")?;
                let (name, ip) = v.split_once('=').ok_or("--dev-resolve needs NAME=IP")?;
                let ip = ip.parse().map_err(|_| "--dev-resolve: the address is not an IP address")?;
                net_opts.resolve.push((name.to_ascii_lowercase(), ip));
            }
            // The libkrun backend's own flags (SPEC 8.7).
            "--gpu-window" if kind == Kind::Krun => {
                let mib = val("--gpu-window")?.parse::<u64>().map_err(|_| "--gpu-window must be a number of MiB")?;
                if !(crate::krun::MIN_GPU_WINDOW_MIB..=crate::krun::MAX_GPU_WINDOW_MIB).contains(&mib) {
                    return Err(format!(
                        "--gpu-window must be {} to {} MiB",
                        crate::krun::MIN_GPU_WINDOW_MIB,
                        crate::krun::MAX_GPU_WINDOW_MIB
                    ));
                }
                krun_opts.gpu_window_mib = mib;
            }
            "--watchdog" if kind == Kind::Krun => {
                let s = val("--watchdog")?.parse::<u64>().map_err(|_| "--watchdog must be a number of seconds")?;
                krun_opts.watchdog = if s == 0 { None } else { Some(Duration::from_secs(s)) };
            }
            "--krun-dir" if kind == Kind::Krun => krun_opts.dir = Some(PathBuf::from(val("--krun-dir")?)),
            "--no-gpu" if kind == Kind::Krun => krun_opts.gpu = false,
            "--dev-no-sandbox" if kind == Kind::Krun => krun_opts.sandbox = false,
            "-h" | "--help" => return Err(usage(kind)),
            other => return Err(format!("unknown argument: {other}\n{}", usage(kind))),
        }
    }
    let need = |v: Option<PathBuf>, name: &str| v.ok_or_else(|| format!("{name} is required\n{}", usage(kind)));
    let start_text = start.ok_or_else(|| format!("--start is required\n{}", usage(kind)))?;
    let start: Value = serde_json::from_str(&start_text).map_err(|e| format!("--start is not valid JSON: {e}"))?;
    if !start.is_object() {
        return Err("--start must be a JSON object".into());
    }
    let mut cfg = VmConfig::new(
        need(kernel, "--kernel")?,
        need(initramfs, "--initramfs")?,
        need(runtime, "--runtime")?,
        need(core, "--core")?,
        need(appdata, "--appdata")?,
    );
    if let Some(id) = id {
        let tmp = std::env::temp_dir();
        cfg.socket = tmp.join(format!("vmapp-{id}.sock"));
        cfg.console_log = tmp.join(format!("vmapp-{id}.console.log"));
        cfg.id = id;
    }
    cfg.shares = shares;
    if let Some(m) = memory {
        cfg.memory_mib = m;
    }
    if let Some(c) = cpus {
        cfg.cpus = c;
    }
    if let Some(s) = socket {
        cfg.socket = s;
    }
    if let Some(c) = console {
        cfg.console_log = c;
    }
    if net_rules.len() > crate::net::MAX_RULES {
        return Err(format!("at most {} --net rules", crate::net::MAX_RULES));
    }
    cfg.net_rules = net_rules;
    cfg.net_options = net_opts;
    cfg.services = services;
    if kind == Kind::Krun {
        cfg.krun = Some(krun_opts);
    }
    Ok(Cli { cfg, start, follow })
}

/// One line from the parent's stdin.
enum Cmd {
    Line(String),
    Eof,
}

fn spawn_stdin_reader(follow: bool) -> mpsc::Receiver<Cmd> {
    let (tx, rx) = mpsc::channel();
    let _ = thread::Builder::new().name("vmapp-stdin".into()).spawn(move || {
        let stdin = std::io::stdin();
        let mut lock = stdin.lock();
        loop {
            let mut line = String::new();
            match lock.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    // EOF on stdin means the parent is gone (unless parent following is disabled).
                    if follow {
                        PARENT_GONE.store(true, Ordering::SeqCst);
                    }
                    let _ = tx.send(Cmd::Eof);
                    return;
                }
                Ok(_) => {
                    let l = line.trim();
                    if !l.is_empty() && tx.send(Cmd::Line(l.to_string())).is_err() {
                        return;
                    }
                }
            }
        }
    });
    rx
}

fn prints_batches(vm: &crate::Vm) {
    for (share, files) in vm.take_batches() {
        emit(&json!({"exported": {"share": share, "files": files}}));
    }
    // Network events (SPEC 8.3): one line per closed or refused connection.
    for ev in vm.take_net_events() {
        emit(&json!({"net": ev.to_json()}));
    }
    // Host service events (SPEC 8.6): open, traffic (counters) and close of each tunnel. Names and byte counts only.
    for ev in vm.take_service_events() {
        emit(&json!({"service": ev.to_json()}));
    }
    // Port-forward events (SPEC 8.8): listen, one per forwarded connection, stop. Ports and counts only.
    for ev in vm.take_forward_events() {
        emit(&json!({"forward": ev.to_json()}));
    }
}

/// Handles one stdin command. Returns true when a graceful shutdown was requested.
fn handle_command(vm: &crate::Vm, line: &str) -> bool {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            emit_error("command", &format!("invalid JSON: {e}"));
            return false;
        }
    };
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    match op {
        "grant" => {
            let (Some(name), Some(access), Some(path)) = (text("name"), text("access"), text("path")) else {
                emit_error("grant", "grant needs name, access and path");
                return false;
            };
            let result = Access::parse(&access)
                .and_then(|a| vm.grant(&ShareSpec { name: name.clone(), access: a, path: PathBuf::from(path) }));
            match result {
                Ok(()) => emit(&json!({"granted": {"name": name, "access": access}})),
                Err(e) => emit_error("grant", &e.to_string()),
            }
            false
        }
        "revoke" => {
            let Some(name) = text("name") else {
                emit_error("revoke", "revoke needs a name");
                return false;
            };
            match vm.revoke(&name) {
                Ok(()) => {
                    // The share's final delivery (if any) comes before the revoked line.
                    prints_batches(vm);
                    emit(&json!({"revoked": {"name": name}}));
                }
                Err(e) => emit_error("revoke", &e.to_string()),
            }
            false
        }
        "net-allow" => {
            let Some(rule_text) = text("rule") else {
                emit_error("net-allow", "net-allow needs a rule");
                return false;
            };
            match NetRule::parse(&rule_text).and_then(|rule| vm.net_allow(rule.clone()).map(|()| rule)) {
                Ok(rule) => emit(&json!({"net-allowed": {"rule": rule.spec()}})),
                Err(e) => emit_error("net-allow", &e.to_string()),
            }
            false
        }
        "net-revoke" => {
            let Some(rule_text) = text("rule") else {
                emit_error("net-revoke", "net-revoke needs a rule");
                return false;
            };
            match crate::net::parse_pattern(&rule_text) {
                Ok(pattern) => {
                    let closed = vm.net_revoke(&pattern);
                    // The closed connections report themselves a moment later (their relay threads finish first).
                    emit(&json!({"net-revoked": {"rule": pattern, "closed": closed}}));
                }
                Err(e) => emit_error("net-revoke", &e.to_string()),
            }
            false
        }
        "port-forward" | "port-close" => {
            // SPEC 5 / 8.8: hostlib checks the user's grant before it sends either
            let Some(port) = v.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0) else {
                emit_error(op, &format!("{op} needs a port (1 to 65535)"));
                return false;
            };
            if op == "port-forward" {
                match vm.forward(port) {
                    Ok(host_port) => emit(&json!({"port-forwarded": {"port": port, "hostPort": host_port}})),
                    Err(e) => emit_error(op, &e.to_string()),
                }
            } else {
                let closed = vm.forward_close(port);
                prints_batches(vm); // the stop event before the answer
                emit(&json!({"port-closed": {"port": port, "closed": closed}}));
            }
            false
        }
        "window-proxy" => {
            // SPEC 5 / 8.3 "The app's windows": the secret comes on stdin only, and is never printed back.
            let Some(secret) = text("secret") else {
                emit_error("window-proxy", "window-proxy needs a secret");
                return false;
            };
            match vm.serve_window(&secret) {
                Ok(port) => emit(&json!({"window-proxy": {"port": port}})),
                Err(e) => emit_error("window-proxy", &e.to_string()),
            }
            false
        }
        "service-revoke" => {
            let Some(name) = text("name") else {
                emit_error("service-revoke", "service-revoke needs a name");
                return false;
            };
            let closed = vm.service_revoke(&name);
            // The closed tunnels report themselves a moment later (their relay threads finish first).
            emit(&json!({"service-revoked": {"name": name, "closed": closed}}));
            false
        }
        "shutdown" => true,
        other => {
            emit_error("command", &format!("unknown op '{other}'"));
            false
        }
    }
}

/// The launcher's `main`: parses the command line, boots the VM, prints the ready line, serves stdin until the VM stops
/// and prints the stopped line.
pub fn run(kind: Kind) -> ExitCode {
    let name = kind.name();
    let cli = match parse(kind, std::env::args().skip(1).collect()) {
        Ok(c) => c,
        Err(m) => {
            warn(format_args!("{m}"));
            return ExitCode::from(2);
        }
    };

    // SAFETY: the handler only stores to an atomic.
    unsafe {
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
    }
    if cli.follow {
        follow_parent(name);
    }
    let rx = spawn_stdin_reader(cli.follow);

    let cancelled = || SIGNALED.load(Ordering::SeqCst) || PARENT_GONE.load(Ordering::SeqCst);
    let vm = match crate::launch_cancellable(cli.cfg, &cancelled) {
        Ok(vm) => vm,
        Err(e) => {
            warn(format_args!("{name}: {e}"));
            emit_error("launch", &e.to_string());
            return ExitCode::from(1);
        }
    };

    let pid = match vm.start_core(&cli.start) {
        Ok(pid) => pid,
        Err(e) => {
            warn(format_args!("{name}: start failed: {e}"));
            emit_error("start", &e.to_string());
            vm.shutdown(Duration::from_secs(5));
            return ExitCode::from(1);
        }
    };

    emit(&json!({
        "ready": true,
        "socket": vm.socket_path().to_string_lossy(),
        "hello": vm.hello(),
        "pid": pid,
    }));

    // Run until the guest powers off or we are asked to stop.
    let mut reason = "core-exited";
    let mut last_poll = Instant::now();
    let mut stdin_open = true;
    loop {
        prints_batches(&vm);
        if vm.is_stopped() {
            break;
        }
        if SIGNALED.load(Ordering::SeqCst) {
            reason = "signal";
            break;
        }
        if PARENT_GONE.load(Ordering::SeqCst) {
            reason = "parent-exited";
            break;
        }
        let mut shutdown = false;
        while stdin_open {
            match rx.try_recv() {
                Ok(Cmd::Line(l)) => {
                    if handle_command(&vm, &l) {
                        shutdown = true;
                        break;
                    }
                }
                Ok(Cmd::Eof) => stdin_open = false,
                Err(_) => break,
            }
        }
        if shutdown {
            reason = "shutdown";
            break;
        }
        if last_poll.elapsed() >= vm.poll_interval() {
            vm.poll_core_exit();
            last_poll = Instant::now();
        }
        thread::sleep(Duration::from_millis(30));
    }

    let exported = if vm.is_stopped() { vm.wait() } else { vm.shutdown(Duration::from_secs(5)) };
    prints_batches(&vm); // deliveries made while stopping, before the stopped line
    let exit_code: Value = match vm.core_exit() {
        Some(c) => json!(c),
        None => Value::Null,
    };
    // The backend's own verdict (`gpu-hang`, `vmm-crashed`, SPEC 8.7) wins over the default `core-exited`.
    let reason = vm.stop_reason().unwrap_or(reason);
    let mut stopped = json!({"stopped": true, "reason": reason, "exitCode": exit_code, "exported": exported});
    if let (Some(detail), Some(obj)) = (vm.stop_detail(), stopped.as_object_mut()) {
        obj.insert("detail".into(), json!(detail));
    }
    emit(&stopped);
    ExitCode::SUCCESS
}
