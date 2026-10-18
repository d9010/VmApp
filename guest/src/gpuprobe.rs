//! The GPU liveness probe of the experimental Vulkan backend (SPEC 8.7, only with `vmapp.gpu=1` on the kernel command line).
//!
//! The launcher's watchdog needs to know whether the host's virtio-gpu worker still answers. The control channel alone cannot
//! tell: when a Venus wait wedges the worker, the guest's other processes (this one included) keep running, and only the
//! processes that use the GPU block. So the probe uses the GPU the way an app does: the runtime ships a tiny Vulkan program,
//! `/usr/lib/vmapp/gpu-probe`, which every half second allocates and maps a small block of host-visible GPU memory (a request
//! that must be answered by the host's worker before the mapping exists) and frees it again. This module starts it with the
//! core's own restrictions (chroot, uid/gid 1000, no supplementary groups, `no_new_privs`; `appcore::spawn_unprivileged`) and
//! reads its output: the line `B` when a cycle begins and `E` when it ends. `hello` (SPEC 4) reports how long the cycle in flight
//! has been waiting (`gpu.stalledMs`, 0 when none is).
//!
//! Without the program in the runtime, or when it cannot get a first cycle done, the probe is off (`gpu.probe` false) and the
//! launcher falls back to the control channel alone. If it ends after it worked (the Vulkan device is gone), the cycle it was
//! in counts as stalled from then on, so the watchdog still fires.
//!
//! PID 1 must never panic: no `unwrap`, `expect`, indexing or print macros.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use crate::{appcore, NAME};

/// Where the runtime keeps the probe program (inside the runtime root). Only a developer's test build of the guest sets
/// `VMAPP_GPU_PROBE_PATH` at compile time (to try a probe from the test core when the runtime image is not rebuilt); the
/// shipped init does not.
const PROBE: &str = match option_env!("VMAPP_GPU_PROBE_PATH") {
    Some(p) => p,
    None => "/usr/lib/vmapp/gpu-probe",
};

static START: OnceLock<Instant> = OnceLock::new();
/// `start` was called: the launcher asked for a GPU (`vmapp.gpu=1`), so `hello` says how the probe is doing.
static ASKED: AtomicBool = AtomicBool::new(false);
/// The probe program has begun a cycle at least once (it printed `B`): its Vulkan setup worked, so what it does next is a
/// measure of the GPU.
static SEEN: AtomicBool = AtomicBool::new(false);
/// Milliseconds since `START` (plus one) at which the cycle in flight began; 0 = none in flight.
static PENDING_SINCE: AtomicU64 = AtomicU64::new(0);
/// Cycles that completed (`hello` says; the log does not).
static DONE: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    let start = START.get_or_init(Instant::now);
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX - 1).saturating_add(1)
}

/// `,"gpu":{...}` for `hello`, or an empty string when the probe was never asked for.
pub fn hello_member() -> String {
    if !ASKED.load(Ordering::SeqCst) {
        return String::new();
    }
    if !SEEN.load(Ordering::SeqCst) {
        return ",\"gpu\":{\"probe\":false}".to_owned();
    }
    let since = PENDING_SINCE.load(Ordering::SeqCst);
    let stalled = if since == 0 { 0 } else { now_ms().saturating_sub(since) };
    format!(",\"gpu\":{{\"probe\":true,\"stalledMs\":{stalled},\"probes\":{}}}", DONE.load(Ordering::SeqCst))
}

/// Applies one line of the probe's output.
fn on_line(line: &str) {
    match line.trim() {
        "B" => {
            if !SEEN.swap(true, Ordering::SeqCst) {
                log!("GPU probe running ({PROBE}): the launcher's watchdog can see the GPU worker");
            }
            PENDING_SINCE.store(now_ms(), Ordering::SeqCst);
        }
        "E" => {
            PENDING_SINCE.store(0, Ordering::SeqCst);
            DONE.fetch_add(1, Ordering::SeqCst);
        }
        other if !other.is_empty() => log!("gpu probe: {other}"),
        _ => {}
    }
}

fn run(id: &str) {
    let root = appcore::ROOT;
    if !Path::new(&format!("{root}{PROBE}")).is_file() {
        log!("GPU probe unavailable ({PROBE} is not in the runtime): the watchdog uses the control port only");
        return;
    }
    // The program needs no data folder and must not leave a shader cache in the app's.
    let env = vec!["HOME=/tmp".to_owned(), "MESA_SHADER_CACHE_DISABLE=true".to_owned()];
    let (_pid, out_r) = match appcore::spawn_unprivileged("gpu probe", &[PROBE.to_owned()], "/", &env, id, |_| {}) {
        Ok(p) => p,
        Err(e) => {
            log!("GPU probe off: {e}");
            return;
        }
    };
    // SAFETY: `out_r` is the read end of a pipe we own and nothing else uses.
    let reader = BufReader::new(unsafe { File::from_raw_fd(out_r) });
    for line in reader.lines() {
        match line {
            Ok(l) => on_line(&l),
            Err(_) => break,
        }
    }
    // The program ended. If its setup had worked, the GPU is gone: the cycle in flight counts as stalled from now on.
    if SEEN.load(Ordering::SeqCst) {
        if PENDING_SINCE.load(Ordering::SeqCst) == 0 {
            PENDING_SINCE.store(now_ms(), Ordering::SeqCst);
        }
        log!("GPU probe ended; the GPU counts as unresponsive from now on");
    } else {
        log!("GPU probe ended before its first cycle (no usable Vulkan device?): it is off");
    }
}

/// Starts the probe (call once, after the render node exists and is usable).
pub fn start(id: &str) {
    ASKED.store(true, Ordering::SeqCst);
    let id = id.to_owned();
    if let Err(e) = std::thread::Builder::new().name("gpu-probe".into()).spawn(move || run(&id)) {
        log!("cannot start the GPU probe thread: {e}");
    }
}
