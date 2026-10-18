// Adapted from agent-vm/host/src/lib.rs (agent-vm commit 8f0c069)
//
//! vmapp host library.
//!
//! Boots the app's core VM with Virtualization.framework (runtime image + core image as read-only disks,
//! a static virtiofs device `vmapp` with `appdata` and the launch-time shares, which never changes after
//! boot, plus [`SLOT_COUNT`] single-directory slot devices `vmapp-s0`..`vmapp-s7` for runtime grants),
//! talks to the guest control port (vsock 1023), bridges a private Unix socket to the guest bridge port
//! (vsock 1024), and handles write-only (`wo`) shares: the guest writes into a private staging folder, the
//! host delivers settled files live and the rest at stop.
//!
//! A runtime grant replaces the share of ONE free slot device only and asks the guest (control `mount`) to
//! mount that slot at `/rt/host/<name>`; nothing else in the guest ever goes stale.
//!
//! The VM has no network device. The network permission (SPEC 8.3) is the allowlist proxy in [`net`]: the guest asks
//! over vsock (ports 1022 and 1025), the host checks the rules and the resolved addresses, connects and relays.
//!
//! The VM belongs to the process that created it: when the process exits or is killed, the framework's
//! XPC service tears the VM down.

#![cfg(target_os = "macos")]

pub mod cli;
pub mod krun;
pub mod net;
pub mod vz;

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// vsock port of the control protocol (hello / start / shutdown).
pub const CONTROL_PORT: u32 = 1023;
/// vsock port of the bridge.
pub const BRIDGE_PORT: u32 = 1024;
/// Tag of the static virtiofs device the guest mounts at `/host` (appdata + launch-time shares).
pub const FS_TAG: &str = "vmapp";
/// Number of slot devices (`vmapp-s0`..) for runtime grants: at most this many grants exist at once.
pub const SLOT_COUNT: usize = 8;

/// Tag of slot device `k`.
pub fn slot_tag(k: usize) -> String {
    format!("{FS_TAG}-s{k}")
}
/// How long `launch` waits for the guest to answer `hello`.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the live exporter looks at the staging folders.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// What `Vm` needs from the machine underneath it: Virtualization.framework ([`vz::Vz`], the default backend) or the
/// experimental libkrun backend ([`krun::Krun`], SPEC 8.7). Everything above this trait (the control channel, the bridge,
/// the network proxy, the shares and their delivery) is shared by both.
pub trait Machine: Send + Sync {
    /// Starts the machine (boots the guest).
    fn start(&self) -> Result<()>;
    /// Has the machine stopped (the guest powered off, the VMM exited, or it died)?
    fn is_stopped(&self) -> bool;
    /// Opens a connection to a guest vsock port; the descriptor reads and writes like a socket.
    fn connect(&self, port: u32, timeout: Duration) -> Result<OwnedFd>;
    /// Asks the machine to stop without the guest's help (used when the control `shutdown` could not be sent).
    fn request_stop(&self) -> Result<()>;
    /// Destroys the machine; waits up to `timeout`.
    fn force_stop(&self, timeout: Duration) -> Result<()>;
    /// Replaces the share of the running virtiofs device `tag` (runtime grants). A backend that cannot says so.
    fn set_share_for_tag(&self, tag: &str, shares: &[vz::Share]) -> Result<()>;
    /// Whether runtime grants (SPEC 5 stdin `grant`) work on this backend. They need slot devices whose share can be
    /// replaced while the VM runs (SPEC 4); libkrun cannot (SPEC 8.7).
    fn supports_runtime_grants(&self) -> bool {
        true
    }
    /// A backend's own supervision: the control channel answered (`true`) or did not (`false`) a heartbeat probe, and, when
    /// the guest reported one, how long its GPU probe has been waiting for the host (`gpu_stalled`; see `guest/src/gpuprobe.rs`).
    /// Returns `true` when the machine must be considered hung and was killed (the stop reason is then
    /// [`Machine::stop_reason`]).
    fn heartbeat(&self, _answered: bool, _gpu_stalled: Option<Duration>) -> bool {
        false
    }
    /// How often the launcher's main loop asks the guest `hello` (for the core's exit code). libkrun keeps the end of a connection
    /// that the host closed for about 5 s, so its backend asks less often.
    fn poll_interval(&self) -> Duration {
        Duration::from_millis(100)
    }
    /// Whether the launcher should probe the guest's control channel on its own, and how long silence is tolerated.
    fn watchdog(&self) -> Option<Duration> {
        None
    }
    /// Why the backend itself stopped the machine, if it did (`gpu-hang`, `vmm-crashed`).
    fn stop_reason(&self) -> Option<&'static str> {
        None
    }
    /// A short note for the stopped line (exit status of the VMM and so on).
    fn stop_detail(&self) -> Option<String> {
        None
    }
    /// Removes what the machine left on disk (sockets, a run folder). Idempotent.
    fn cleanup(&self) {}
}

impl Machine for vz::Vz {
    fn start(&self) -> Result<()> {
        self.start_sync()
    }
    fn is_stopped(&self) -> bool {
        matches!(self.state(), vz::State::Stopped | vz::State::Error)
    }
    fn connect(&self, port: u32, timeout: Duration) -> Result<OwnedFd> {
        self.connect_sync(port, timeout)
    }
    fn request_stop(&self) -> Result<()> {
        vz::Vz::request_stop(self)
    }
    fn force_stop(&self, timeout: Duration) -> Result<()> {
        self.force_stop_sync(timeout)
    }
    fn set_share_for_tag(&self, tag: &str, shares: &[vz::Share]) -> Result<()> {
        vz::Vz::set_share_for_tag(self, tag, shares)
    }
}

/// Writes one line to stderr, ignoring failures. `eprintln!` panics when stderr is a pipe whose reader
/// (a crashed parent) is gone, which would skip the shutdown and the write-only delivery.
pub fn warn(msg: fmt::Arguments) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// Simple string error (keeps the dependency list minimal).
#[derive(Debug, Clone)]
pub struct Error(String);

impl Error {
    pub fn new(msg: impl Into<String>) -> Self {
        Error(msg.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Ro,
    Rw,
    Wo,
}

impl Access {
    pub fn parse(s: &str) -> Result<Access> {
        match s {
            "ro" => Ok(Access::Ro),
            "rw" => Ok(Access::Rw),
            "wo" => Ok(Access::Wo),
            other => Err(Error::new(format!("access must be ro, rw or wo (got '{other}')"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Access::Ro => "ro",
            Access::Rw => "rw",
            Access::Wo => "wo",
        }
    }
}

/// One folder the host shares with the guest (what `--share NAME:ACCESS:DIR` and the stdin `grant` say).
#[derive(Clone, Debug)]
pub struct ShareSpec {
    pub name: String,
    pub access: Access,
    pub path: PathBuf,
}

impl ShareSpec {
    /// Parses `NAME:ACCESS:DIR` (DIR may contain colons).
    pub fn parse(s: &str) -> Result<ShareSpec> {
        let mut it = s.splitn(3, ':');
        let (Some(name), Some(access), Some(dir)) = (it.next(), it.next(), it.next()) else {
            return Err(Error::new(format!("--share needs NAME:ACCESS:DIR (got '{s}')")));
        };
        Ok(ShareSpec { name: name.to_string(), access: Access::parse(access)?, path: PathBuf::from(dir) })
    }
}

/// Everything `launch` needs. Build one with [`VmConfig::new`] and adjust the public fields.
#[derive(Clone, Debug)]
pub struct VmConfig {
    pub kernel: PathBuf,
    pub initramfs: PathBuf,
    /// Runtime image (EROFS): read-only disk with identifier `runtime` (guest `/dev/vda`).
    pub runtime: PathBuf,
    /// Core image (raw newc cpio): read-only disk with identifier `core` (guest `/dev/vdb`).
    pub core: PathBuf,
    /// The app's private data folder, shared read-write as `appdata`.
    pub appdata: PathBuf,
    /// Further shares present from the first boot.
    pub shares: Vec<ShareSpec>,
    pub cpus: u32,
    pub memory_mib: u64,
    /// Unix socket bridged to the guest bridge port (mode 0600).
    pub socket: PathBuf,
    /// File receiving the guest console.
    pub console_log: PathBuf,
    /// Instance id (passed to the guest as `vmapp.id=`).
    pub id: String,
    /// Network rules the app starts with (`--net`). None means no network channel is opened at all.
    pub net_rules: Vec<net::NetRule>,
    /// Test and developer switches of the network proxy (`--dev-allow-loopback`, `--dev-resolve`); see [`net::NetOptions`].
    pub net_options: net::NetOptions,
    /// Host services the app may reach by name (`--service NAME=127.0.0.1:PORT`, SPEC 8.6): loopback endpoints the loader
    /// started. Each opens a listener in the guest and the network channel; none means neither.
    pub services: Vec<net::ServiceSpec>,
    /// `Some`: boot with the experimental libkrun backend (`vmapp-vm-krun`, SPEC 8.7) instead of Virtualization.framework.
    pub krun: Option<krun::KrunOptions>,
}

impl VmConfig {
    /// Defaults: 1 CPU, 256 MiB, random id, socket and console log under the temp dir.
    pub fn new(
        kernel: impl Into<PathBuf>,
        initramfs: impl Into<PathBuf>,
        runtime: impl Into<PathBuf>,
        core: impl Into<PathBuf>,
        appdata: impl Into<PathBuf>,
    ) -> Self {
        let id = random_id();
        let tmp = std::env::temp_dir();
        VmConfig {
            kernel: kernel.into(),
            initramfs: initramfs.into(),
            runtime: runtime.into(),
            core: core.into(),
            appdata: appdata.into(),
            shares: vec![],
            cpus: 1,
            memory_mib: 256,
            socket: tmp.join(format!("vmapp-{id}.sock")),
            console_log: tmp.join(format!("vmapp-{id}.console.log")),
            id,
            net_rules: vec![],
            net_options: net::NetOptions::default(),
            services: vec![],
            krun: None,
        }
    }
}

/// 8 random lowercase hex characters.
pub fn random_id() -> String {
    let mut b = [0u8; 4];
    let ok = File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)).is_ok();
    if !ok {
        let n = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        b = (n ^ std::process::id()).to_le_bytes();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn staging_dir(id: &str, share: &str) -> PathBuf {
    std::env::temp_dir().join(format!("vmapp-{id}-{share}-staging"))
}

/// Share names are what the guest sees under `/host`.
pub fn valid_share_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Runtime grants are named `pick-N` or `save-N` (N: 1 to 4 digits), the only names the guest's `mount` op accepts.
pub fn valid_grant_name(name: &str) -> bool {
    let Some(n) = name.strip_prefix("pick-").or_else(|| name.strip_prefix("save-")) else { return false };
    (1..=4).contains(&n.len()) && n.bytes().all(|c| c.is_ascii_digit())
}

fn existing_dir(d: &Path) -> Result<PathBuf> {
    let c = d.canonicalize().map_err(|e| Error::new(format!("folder {}: {e}", d.display())))?;
    if !c.is_dir() {
        return Err(Error::new(format!("not a folder: {}", d.display())));
    }
    Ok(c)
}

// ---------------------------------------------------------------------------------------------
// Shares and write-only delivery
// ---------------------------------------------------------------------------------------------

/// Where a `wo` share is delivered.
#[derive(Clone, Debug)]
enum Target {
    /// Settled files move into the folder under a free name (`name (1).ext` on a clash).
    Dir(PathBuf),
    /// Save grant: only the file named like this path's file name is delivered, onto exactly this path,
    /// overwriting it (the user confirmed the overwrite in the save dialog).
    File(PathBuf),
}

type Sig = (u64, Option<SystemTime>);

struct ShareEntry {
    access: Access,
    /// The folder the guest sees (the real folder for ro/rw, the private staging folder for wo).
    host_path: PathBuf,
    target: Option<Target>,
    /// The slot device carrying this share; `None` for launch-time shares (on the static device).
    slot: Option<usize>,
    /// Live exporter state: files seen at the previous poll.
    seen: HashMap<OsString, Sig>,
}

#[derive(Default)]
struct ShareState {
    map: BTreeMap<String, ShareEntry>,
    /// Which share name occupies each slot device (`None` = free, its share is the placeholder).
    slots: [Option<String>; SLOT_COUNT],
    /// Every name delivered per wo share during the run, including revoked shares.
    delivered: BTreeMap<String, Vec<String>>,
    /// Live deliveries not yet taken: (share, names).
    batches: Vec<(String, Vec<String>)>,
}

/// Resolves a share spec into the folder to share and (for `wo`) the delivery target.
/// A `wo` path that is a folder delivers into it; a path that is an existing file, or does not exist but
/// has an existing parent folder, is a save grant.
fn resolve(spec: &ShareSpec, id: &str) -> Result<(PathBuf, Option<Target>)> {
    if !spec.path.is_absolute() {
        return Err(Error::new(format!("share path must be absolute: {}", spec.path.display())));
    }
    match spec.access {
        Access::Ro | Access::Rw => Ok((existing_dir(&spec.path)?, None)),
        Access::Wo => {
            let target = if spec.path.is_dir() {
                Target::Dir(spec.path.canonicalize()?)
            } else if spec.path.exists() {
                Target::File(spec.path.canonicalize()?)
            } else {
                let parent = spec.path.parent().filter(|p| !p.as_os_str().is_empty());
                let name = spec.path.file_name();
                match (parent, name) {
                    (Some(p), Some(n)) if p.is_dir() => Target::File(p.canonicalize()?.join(n)),
                    _ => return Err(Error::new(format!("destination not found: {}", spec.path.display()))),
                }
            };
            let s = staging_dir(id, &spec.name);
            let _ = fs::remove_dir_all(&s);
            fs::create_dir_all(&s)?;
            fs::set_permissions(&s, fs::Permissions::from_mode(0o700))?;
            Ok((s.canonicalize()?, Some(target)))
        }
    }
}

/// First free name in `dest`: `name`, then `stem (1).ext`, `stem (2).ext`, ...
fn unique_name(dest: &Path, name: &str) -> String {
    if fs::symlink_metadata(dest.join(name)).is_err() {
        return name.to_string();
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1u32..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|c| fs::symlink_metadata(dest.join(c)).is_err())
        .expect("a free name exists")
}

fn is_regular(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_file()).unwrap_or(false)
}

/// Moves one staged regular file into the folder `dest` under a free name; returns that name.
fn move_to_dir(staging: &Path, dest: &Path, n: &OsStr) -> Option<String> {
    let src = staging.join(n);
    // Re-check right before the move: the guest may have swapped the file for a link meanwhile.
    if !is_regular(&src) {
        return None;
    }
    if let Err(e) = fs::create_dir_all(dest) {
        warn(format_args!("D9010 VmApp: cannot create destination {}: {e}", dest.display()));
        return None;
    }
    let target_name = unique_name(dest, &n.to_string_lossy());
    let dst = dest.join(&target_name);
    let moved = fs::rename(&src, &dst).or_else(|_| {
        // Different volume: copy without overwriting, then remove the source.
        let mut from = File::open(&src)?;
        let mut to = OpenOptions::new().write(true).create_new(true).open(&dst)?;
        std::io::copy(&mut from, &mut to)?;
        fs::remove_file(&src)
    });
    match moved {
        Ok(()) => Some(target_name),
        Err(e) => {
            warn(format_args!("D9010 VmApp: could not export {}: {e}", n.to_string_lossy()));
            None
        }
    }
}

/// Moves one staged regular file onto exactly `dst`, replacing what is there; returns its file name.
fn move_onto(staging: &Path, dst: &Path, n: &OsStr) -> Option<String> {
    let src = staging.join(n);
    if !is_regular(&src) {
        return None;
    }
    // A link at the destination is replaced, never followed.
    let moved = fs::rename(&src, dst).or_else(|_| {
        // Different volume: copy next to the destination, then rename over it (atomic replace).
        let tmp = dst.with_file_name(format!(".{}.vmapp-{}.tmp", n.to_string_lossy(), std::process::id()));
        let mut from = File::open(&src)?;
        let mut to = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
        std::io::copy(&mut from, &mut to)?;
        drop(to);
        let r = fs::rename(&tmp, dst);
        if r.is_err() {
            let _ = fs::remove_file(&tmp);
            return r;
        }
        fs::remove_file(&src)
    });
    match moved {
        Ok(()) => dst.file_name().map(|f| f.to_string_lossy().into_owned()),
        Err(e) => {
            warn(format_args!("D9010 VmApp: could not save {}: {e}", dst.display()));
            None
        }
    }
}

fn deliver_one(staging: &Path, target: &Target, n: &OsStr) -> Option<String> {
    match target {
        Target::Dir(dest) => move_to_dir(staging, dest, n),
        Target::File(path) => {
            if path.file_name() == Some(n) {
                move_onto(staging, path, n)
            } else {
                None
            }
        }
    }
}

/// Whether the live exporter may deliver a file with this name once it has settled.
fn live_deliverable(name: &str) -> bool {
    !name.starts_with('.') && !name.ends_with(".partial")
}

/// One live poll of one wo share: delivers regular files whose size and mtime are unchanged since the
/// previous poll (and whose name is deliverable). Returns the delivered names.
fn poll_share(e: &mut ShareEntry) -> Vec<String> {
    let Some(target) = e.target.clone() else { return vec![] };
    let Ok(rd) = fs::read_dir(&e.host_path) else { return vec![] };
    let mut current: HashMap<OsString, Sig> = HashMap::new();
    let mut ready = vec![];
    for ent in rd.filter_map(|x| x.ok()) {
        let name = ent.file_name();
        let Ok(m) = fs::symlink_metadata(ent.path()) else { continue };
        if !m.file_type().is_file() {
            continue;
        }
        let ok = match &target {
            Target::Dir(_) => live_deliverable(&name.to_string_lossy()),
            Target::File(p) => p.file_name() == Some(name.as_os_str()),
        };
        if !ok {
            continue;
        }
        let sig = (m.len(), m.modified().ok());
        if e.seen.get(&name) == Some(&sig) {
            ready.push(name);
        } else {
            current.insert(name, sig);
        }
    }
    ready.sort();
    let mut batch = vec![];
    for n in &ready {
        batch.extend(deliver_one(&e.host_path, &target, n));
    }
    // Files not delivered this round (new or changed) wait for the next poll; failed moves are retried
    // after one more poll.
    e.seen = current;
    batch
}

/// Final delivery of one wo share (stop or revoke): everything regular in the staging folder goes to
/// the destination (dir mode) or just the named file (save mode); the staging folder is removed.
fn final_export(e: &ShareEntry, name: &str) -> Vec<String> {
    let mut out = vec![];
    let Some(target) = &e.target else { return out };
    if let Ok(rd) = fs::read_dir(&e.host_path) {
        let mut names: Vec<OsString> = rd.filter_map(|x| x.ok()).map(|x| x.file_name()).collect();
        names.sort();
        let mut dropped = 0usize;
        for n in names {
            if !is_regular(&e.host_path.join(&n)) {
                continue;
            }
            match deliver_one(&e.host_path, target, &n) {
                Some(d) => out.push(d),
                None => {
                    if matches!(target, Target::File(p) if p.file_name() != Some(n.as_os_str())) {
                        dropped += 1;
                    }
                }
            }
        }
        if dropped > 0 {
            warn(format_args!("D9010 VmApp: save share {name}: dropped {dropped} other file(s) written next to the saved file"));
        }
    }
    let _ = fs::remove_dir_all(&e.host_path);
    out
}

// ---------------------------------------------------------------------------------------------
// The running VM
// ---------------------------------------------------------------------------------------------

struct Shared {
    stopped: Mutex<Option<String>>,
    cv: Condvar,
}

struct Inner {
    machine: Box<dyn Machine>,
    /// Set when a stop was asked for: the watchdog stops probing, and a silent guest is expected.
    stopping: AtomicBool,
    shared: Arc<Shared>,
    cfg: VmConfig,
    /// Empty read-only folder every free slot device shares (removed at stop).
    placeholder: PathBuf,
    shares: Mutex<ShareState>,
    hello: OnceLock<serde_json::Value>,
    halt: AtomicBool,
    finished: Mutex<Option<BTreeMap<String, Vec<String>>>>,
    poll_stop: AtomicBool,
    poller: Mutex<Option<thread::JoinHandle<()>>>,
    core_exit: Mutex<Option<i64>>,
    /// Padded copies of disk images whose size is not a multiple of 512 (removed at stop).
    temp_files: Vec<PathBuf>,
    /// The network allowlist proxy (SPEC 8.3). Its channel to the guest is opened only when there are rules.
    net: Arc<net::NetProxy>,
}

impl Inner {
    fn is_stopped(&self) -> bool {
        if self.shared.stopped.lock().map(|g| g.is_some()).unwrap_or(true) {
            return true;
        }
        self.machine.is_stopped()
    }

    /// Waits until the VM has stopped; `None` waits forever. Returns whether it stopped.
    fn wait_stopped(&self, timeout: Option<Duration>) -> bool {
        let deadline = timeout.map(|t| Instant::now() + t);
        loop {
            if self.is_stopped() {
                return true;
            }
            let step = match deadline {
                Some(d) => {
                    let now = Instant::now();
                    if now >= d {
                        return false;
                    }
                    (d - now).min(Duration::from_millis(100))
                }
                None => Duration::from_millis(100),
            };
            if let Ok(g) = self.shared.stopped.lock() {
                if g.is_none() {
                    let _ = self.shared.cv.wait_timeout(g, step);
                }
            }
        }
    }

    /// One request/response on the control port (a fresh connection each time).
    fn control(&self, request: &str) -> Result<String> {
        let fd = self.machine.connect(CONTROL_PORT, Duration::from_millis(1500))?;
        let mut s = UnixStream::from(fd);
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        s.set_write_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(request.as_bytes())?;
        s.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(&s).read_line(&mut line)?;
        if line.is_empty() {
            return Err(Error::new("control connection closed without a reply"));
        }
        Ok(line.trim_end().to_string())
    }

    fn connect_bridge_fd(&self) -> Result<OwnedFd> {
        self.machine.connect(BRIDGE_PORT, Duration::from_secs(5))
    }

    /// A control request that must answer `{"ok":true}`.
    fn control_ok(&self, request: &serde_json::Value) -> Result<()> {
        let line = self.control(&request.to_string())?;
        let v: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| Error::new(format!("bad control reply: {e}")))?;
        if v.get("ok") == Some(&serde_json::Value::Bool(true)) {
            Ok(())
        } else {
            let msg = v.get("error").and_then(|e| e.as_str()).unwrap_or("the guest refused the request");
            Err(Error::new(msg.to_string()))
        }
    }

    /// Opens the network control connection to the guest (port 1022) and hands it to the proxy. A no-op when it is
    /// open already.
    fn net_attach(&self) -> Result<()> {
        if self.net.attached() {
            return Ok(());
        }
        let fd = self.machine.connect(net::NET_CONTROL_PORT, Duration::from_secs(5))?;
        self.net.attach(UnixStream::from(fd))
    }

    /// Points slot device `k` back at the empty read-only placeholder folder.
    fn reset_slot(&self, k: usize) -> Result<()> {
        self.machine.set_share_for_tag(
            &slot_tag(k),
            &[vz::Share { name: "placeholder".into(), path: self.placeholder.clone(), read_only: true }],
        )
    }

    /// Stops accepting, removes the socket, delivers staged output. Idempotent. Returns the delivered
    /// names per wo share.
    fn finish(&self) -> BTreeMap<String, Vec<String>> {
        let mut done = self.finished.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = done.as_ref() {
            return v.clone();
        }
        self.halt.store(true, Ordering::SeqCst);
        let _ = fs::remove_file(&self.cfg.socket);
        // Stop the live exporter first (and wait for a poll in progress), so the final delivery below
        // is the only thing touching the staging folders.
        self.poll_stop.store(true, Ordering::SeqCst);
        // Network tunnels end with the VM; their events are queued before the caller prints the stopped line.
        self.net.close_all("stopped");
        let handle = self.poller.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(h) = handle {
            let _ = h.join();
        }
        {
            let mut st = self.shares.lock().unwrap_or_else(|e| e.into_inner());
            let names: Vec<String> = st.map.keys().cloned().collect();
            for name in names {
                if let Some(e) = st.map.remove(&name) {
                    if e.target.is_some() {
                        let last = final_export(&e, &name);
                        if !last.is_empty() {
                            st.delivered.entry(name.clone()).or_default().extend(last.iter().cloned());
                            st.batches.push((name, last));
                        }
                    }
                }
            }
        }
        for t in &self.temp_files {
            let _ = fs::remove_file(t);
        }
        let _ = fs::remove_dir(&self.placeholder);
        self.machine.cleanup();
        let all =self.shares.lock().unwrap_or_else(|e| e.into_inner()).delivered.clone();
        *done = Some(all.clone());
        all
    }

    fn stop(&self, timeout: Duration) -> BTreeMap<String, Vec<String>> {
        self.stopping.store(true, Ordering::SeqCst);
        if !self.is_stopped() {
            if !timeout.is_zero() && self.control(r#"{"op":"shutdown"}"#).is_err() {
                let _ = self.machine.request_stop();
            }
            if !self.wait_stopped(Some(timeout)) {
                let _ = self.machine.force_stop(Duration::from_secs(10));
                self.wait_stopped(Some(Duration::from_secs(3)));
            }
        }
        self.finish()
    }

    /// The launcher's own supervision of a backend that asks for it (`Machine::watchdog`, the libkrun backend): every
    /// second a `hello` goes to the guest's control port, and the backend is told whether it answered. A backend that
    /// finds the guest silent for too long kills the machine (SPEC 8.7, reason `gpu-hang`).
    fn watchdog_loop(&self) {
        let Some(_limit) = self.machine.watchdog() else { return };
        loop {
            thread::sleep(Duration::from_millis(1000));
            if self.halt.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) || self.is_stopped() {
                return;
            }
            let reply = self.control(r#"{"op":"hello"}"#);
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            let stalled = reply.as_ref().ok().and_then(|line| gpu_stalled(line));
            if self.machine.heartbeat(reply.is_ok(), stalled) {
                return;
            }
        }
    }
}

/// A running VM. Dropping it force-stops the VM if it is still running.
pub struct Vm {
    inner: Arc<Inner>,
}

impl Vm {
    /// The guest's first answer to `{"op":"hello"}` (before the core was started).
    pub fn hello(&self) -> &serde_json::Value {
        self.inner.hello.get().expect("hello is set before launch returns")
    }

    pub fn id(&self) -> &str {
        &self.inner.cfg.id
    }

    pub fn socket_path(&self) -> &Path {
        &self.inner.cfg.socket
    }

    pub fn console_log(&self) -> &Path {
        &self.inner.cfg.console_log
    }

    /// Opens a new connection to the guest bridge (vsock 1024). Reads and writes like a socket.
    pub fn connect_bridge(&self) -> Result<UnixStream> {
        Ok(UnixStream::from(self.inner.connect_bridge_fd()?))
    }

    /// Has the guest powered off (or the VM died)?
    pub fn is_stopped(&self) -> bool {
        self.inner.is_stopped()
    }

    /// How often the main loop should call [`Vm::poll_core_exit`].
    pub fn poll_interval(&self) -> Duration {
        self.inner.machine.poll_interval()
    }

    /// Why the backend itself stopped the VM (`gpu-hang`: the watchdog killed it; `vmm-crashed`: the VMM died on its own),
    /// when it did. `None` for an ordinary stop.
    pub fn stop_reason(&self) -> Option<&'static str> {
        self.inner.machine.stop_reason()
    }

    /// A note for the stopped line about how the backend ended (the VMM's exit status), when there is one.
    pub fn stop_detail(&self) -> Option<String> {
        self.inner.machine.stop_detail()
    }

    /// Sends the control `start` op. `start` is the JSON object of the op minus `"op"`. Returns the core's pid.
    pub fn start_core(&self, start: &serde_json::Value) -> Result<i64> {
        let mut obj = match start {
            serde_json::Value::Object(m) => m.clone(),
            _ => return Err(Error::new("--start must be a JSON object")),
        };
        obj.insert("op".into(), "start".into());
        let line = self.inner.control(&serde_json::Value::Object(obj).to_string())?;
        let v: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| Error::new(format!("bad start reply: {e}")))?;
        if v.get("ok") == Some(&serde_json::Value::Bool(true)) {
            Ok(v.get("pid").and_then(|p| p.as_i64()).unwrap_or(0))
        } else {
            let msg = v.get("error").and_then(|e| e.as_str()).unwrap_or("start failed");
            Err(Error::new(msg.to_string()))
        }
    }

    /// Asks the guest for hello and remembers the core's exit code once the core has exited.
    pub fn poll_core_exit(&self) {
        if self.inner.core_exit.lock().map(|g| g.is_some()).unwrap_or(true) {
            return;
        }
        let Ok(line) = self.inner.control(r#"{"op":"hello"}"#) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { return };
        if let Some(code) = v.get("core").and_then(|c| c.get("exit")).and_then(|c| c.as_i64()) {
            if let Ok(mut g) = self.inner.core_exit.lock() {
                *g = Some(code);
            }
        }
    }

    /// The core's exit code, when known: the value the guest reported in a `hello` (polled while the VM
    /// runs), else, once the VM is stopped, the status line `vmapp-init` wrote to the console log
    /// (the guest can power off between two polls).
    pub fn core_exit(&self) -> Option<i64> {
        if let Some(c) = self.inner.core_exit.lock().ok().and_then(|g| *g) {
            return Some(c);
        }
        if self.inner.is_stopped() {
            return exit_from_console(&self.inner.cfg.console_log);
        }
        None
    }

    /// Adds a share to the running VM on one free slot device: the slot's share is replaced (no other
    /// device changes), then the guest is told to mount it at `/rt/host/<name>`. On any failure the slot
    /// is reset to the placeholder and stays free.
    pub fn grant(&self, spec: &ShareSpec) -> Result<()> {
        if !self.inner.machine.supports_runtime_grants() {
            // The libkrun backend has no slot devices whose share can be replaced while the VM runs (SPEC 8.7, B8).
            return Err(Error::new("not supported on the gpu backend"));
        }
        if !valid_share_name(&spec.name) {
            return Err(Error::new(format!("invalid share name '{}'", spec.name)));
        }
        if spec.name == "appdata" {
            return Err(Error::new("'appdata' is reserved"));
        }
        if !valid_grant_name(&spec.name) {
            return Err(Error::new(format!("runtime grants must be named pick-N or save-N (got '{}')", spec.name)));
        }
        let mut st = self.inner.shares.lock().unwrap_or_else(|e| e.into_inner());
        if st.map.contains_key(&spec.name) {
            return Err(Error::new(format!("share '{}' already exists", spec.name)));
        }
        if self.inner.is_stopped() {
            return Err(Error::new("the VM is not running"));
        }
        let Some(k) = st.slots.iter().position(|s| s.is_none()) else {
            return Err(Error::new(format!("all {SLOT_COUNT} grant slots are in use; revoke a share first")));
        };
        let (host_path, target) = resolve(spec, &self.inner.cfg.id)?;
        let drop_staging = |target: &Option<Target>| {
            if target.is_some() {
                let _ = fs::remove_dir_all(&host_path);
            }
        };
        let read_only = spec.access == Access::Ro;
        let share = vz::Share { name: spec.name.clone(), path: host_path.clone(), read_only };
        if let Err(e) = self.inner.machine.set_share_for_tag(&slot_tag(k), &[share]) {
            drop_staging(&target);
            return Err(e);
        }
        let mount = serde_json::json!({"op": "mount", "slot": k, "name": spec.name, "ro": read_only});
        if let Err(e) = self.inner.control_ok(&mount) {
            // Roll back: make sure nothing stays mounted, put the placeholder back, free the slot.
            let _ = self.inner.control_ok(&serde_json::json!({"op": "umount", "name": spec.name}));
            if let Err(e2) = self.inner.reset_slot(k) {
                warn(format_args!("D9010 VmApp: could not reset grant slot {k} after a failed mount: {e2}"));
            }
            drop_staging(&target);
            return Err(Error::new(format!("the guest could not mount the share: {e}")));
        }
        st.slots[k] = Some(spec.name.clone());
        st.map.insert(
            spec.name.clone(),
            ShareEntry { access: spec.access, host_path, target, slot: Some(k), seen: HashMap::new() },
        );
        if spec.access == Access::Wo {
            st.delivered.entry(spec.name.clone()).or_default();
        }
        Ok(())
    }

    /// Removes a runtime grant: the guest unmounts it, the slot goes back to the placeholder and is freed.
    /// A wo share is delivered one last time after that. Launch-time shares cannot be revoked.
    pub fn revoke(&self, name: &str) -> Result<()> {
        if name == "appdata" {
            return Err(Error::new("'appdata' cannot be revoked"));
        }
        let mut st = self.inner.shares.lock().unwrap_or_else(|e| e.into_inner());
        let Some(k) = st.map.get(name).map(|e| e.slot) else {
            return Err(Error::new(format!("no such share '{name}'")));
        };
        let Some(k) = k else {
            return Err(Error::new(format!("share '{name}' is a launch-time share and cannot be revoked")));
        };
        self.inner.control_ok(&serde_json::json!({"op": "umount", "name": name}))?;
        // The entry stays in place if the reset fails, so the revoke can be retried (umount is idempotent).
        self.inner.reset_slot(k)?;
        st.slots[k] = None;
        let Some(entry) = st.map.remove(name) else { return Ok(()) };
        if entry.target.is_some() {
            let last = final_export(&entry, name);
            if !last.is_empty() {
                st.delivered.entry(name.to_string()).or_default().extend(last.iter().cloned());
                st.batches.push((name.to_string(), last));
            }
        }
        Ok(())
    }

    /// Allows the app to reach one more destination (SPEC 8.3). A rule with the same pattern is replaced. The first
    /// rule opens the network channel to the guest.
    pub fn net_allow(&self, rule: net::NetRule) -> Result<()> {
        if self.inner.is_stopped() {
            return Err(Error::new("the VM is not running"));
        }
        self.inner.net.allow(rule)?;
        self.inner.net_attach()
    }

    /// Removes the rule with this pattern (`api.example.com` or `*.example.com`) and closes every open connection
    /// that no remaining rule allows. Returns how many connections were closed.
    pub fn net_revoke(&self, pattern: &str) -> usize {
        self.inner.net.revoke(pattern)
    }

    /// The current network rules.
    pub fn net_rules(&self) -> Vec<net::NetRule> {
        self.inner.net.rules()
    }

    /// Starts the window endpoint (SPEC 8.3 "The app's windows"): a loopback `CONNECT` proxy for the app's windows, under
    /// the same rules as the guest, answering only clients that authenticate with `secret`. Returns its port. Once per run.
    pub fn serve_window(&self, secret: &str) -> Result<u16> {
        if self.inner.is_stopped() {
            return Err(Error::new("the VM is not running"));
        }
        self.inner.net.serve_window(secret)
    }

    /// Forwards the VM's `port` to the Mac's `127.0.0.1` (SPEC 8.8). Returns the Mac's port.
    pub fn forward(&self, port: u16) -> Result<u16> {
        if self.inner.is_stopped() {
            return Err(Error::new("the VM is not running"));
        }
        self.inner.net.forward(port)
    }

    /// Stops forwarding `port` and closes its open connections. Returns how many were closed.
    pub fn forward_close(&self, port: u16) -> usize {
        self.inner.net.forward_close(port, "closed")
    }

    /// Port-forward events not yet taken, oldest first.
    pub fn take_forward_events(&self) -> Vec<net::ForwardEvent> {
        self.inner.net.take_forward_events()
    }

    /// Network events (one per closed or refused connection) not yet taken, oldest first.
    pub fn take_net_events(&self) -> Vec<net::NetEvent> {
        self.inner.net.take_events()
    }

    /// The host services the app was started with.
    pub fn services(&self) -> Vec<net::ServiceSpec> {
        self.inner.net.services()
    }

    /// Takes a host service away (SPEC 8.6): no new tunnel opens, the open ones are closed at once, and the guest stops
    /// listening for it. Returns how many tunnels were closed. A name the app was not started with closes nothing.
    pub fn service_revoke(&self, name: &str) -> usize {
        let closed = self.inner.net.service_revoke(name);
        if !self.inner.is_stopped() {
            // best effort: if the guest cannot be told, the host already refuses every new tunnel
            let _ = self.inner.control_ok(&serde_json::json!({"op": "service-stop", "name": name}));
        }
        closed
    }

    /// Service events (SPEC 5 `{"service":{...}}`: open, traffic, close) not yet taken, oldest first.
    pub fn take_service_events(&self) -> Vec<net::ServiceEvent> {
        self.inner.net.take_service_events()
    }

    /// Live deliveries not yet taken: one `(share, names)` per poll that delivered something (this
    /// includes the final deliveries made by `revoke` and by stop).
    pub fn take_batches(&self) -> Vec<(String, Vec<String>)> {
        std::mem::take(&mut self.inner.shares.lock().unwrap_or_else(|e| e.into_inner()).batches)
    }

    /// Asks the guest to shut down; force-stops it after `timeout`. Then delivers the write-only output
    /// and removes the socket. Returns every name delivered per wo share during the run.
    pub fn shutdown(&self, timeout: Duration) -> BTreeMap<String, Vec<String>> {
        self.inner.stop(timeout)
    }

    /// Blocks until the guest powers off, then delivers the write-only output and removes the socket.
    pub fn wait(&self) -> BTreeMap<String, Vec<String>> {
        self.inner.wait_stopped(None);
        self.inner.finish()
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        // Not shut down explicitly: tear it down now (force, no grace period).
        self.inner.stop(Duration::ZERO);
    }
}

/// How long the guest's GPU probe has been waiting for the host, from a `hello` reply (`"gpu":{"probe":true,"stalledMs":N}`,
/// SPEC 4/8.7). `None` when the guest runs no probe.
fn gpu_stalled(hello_line: &str) -> Option<Duration> {
    let v: serde_json::Value = serde_json::from_str(hello_line).ok()?;
    let g = v.get("gpu")?;
    if g.get("probe")?.as_bool()? {
        Some(Duration::from_millis(g.get("stalledMs")?.as_u64()?))
    } else {
        None
    }
}

/// Parses the guest's own status line: `vmapp-init: core (pid N) exited with status X` or
/// `... killed by signal S` (reported as 128+S, like a shell).
fn exit_from_console(log: &Path) -> Option<i64> {
    let text = fs::read(log).ok()?;
    let text = String::from_utf8_lossy(&text);
    let line = text.lines().rev().find(|l| l.starts_with("vmapp-init: core (pid "))?;
    if let Some(i) = line.find("exited with status ") {
        return line[i + "exited with status ".len()..].trim().parse().ok();
    }
    if let Some(i) = line.find("killed by signal ") {
        return line[i + "killed by signal ".len()..].trim().parse::<i64>().ok().map(|s| 128 + s);
    }
    None
}

/// A disk image must be a multiple of 512 bytes; pad a private copy when it is not.
fn disk_path(p: &Path, what: &str, id: &str, temps: &mut Vec<PathBuf>) -> Result<PathBuf> {
    let meta = fs::metadata(p).map_err(|e| Error::new(format!("{what} image not found: {} ({e})", p.display())))?;
    if !meta.is_file() {
        return Err(Error::new(format!("{what} image is not a file: {}", p.display())));
    }
    let c = p.canonicalize()?;
    if meta.len() % 512 == 0 {
        return Ok(c);
    }
    let padded = std::env::temp_dir().join(format!("vmapp-{id}-{what}.img"));
    fs::copy(&c, &padded)?;
    let f = OpenOptions::new().write(true).open(&padded)?;
    f.set_len(meta.len().div_ceil(512) * 512)?;
    temps.push(padded.clone());
    Ok(padded)
}

/// Boots the VM and waits until the guest answers `hello`.
pub fn launch(cfg: VmConfig) -> Result<Vm> {
    launch_cancellable(cfg, &|| false)
}

/// Like [`launch`], but aborts (stopping the VM) with an error as soon as `cancel()` returns true.
pub fn launch_cancellable(cfg: VmConfig, cancel: &dyn Fn() -> bool) -> Result<Vm> {
    for (what, p) in [("kernel", &cfg.kernel), ("initramfs", &cfg.initramfs)] {
        if !p.is_file() {
            return Err(Error::new(format!("{what} not found: {}", p.display())));
        }
    }
    let kernel = cfg.kernel.canonicalize()?;
    let initramfs = cfg.initramfs.canonicalize()?;
    let appdata = existing_dir(&cfg.appdata)?;

    let mut temps = vec![];
    let placeholder = std::env::temp_dir().join(format!("vmapp-{}-placeholder", cfg.id));
    let cleanup = |temps: &Vec<PathBuf>, st: &ShareState| {
        for t in temps {
            let _ = fs::remove_file(t);
        }
        let _ = fs::remove_dir(&placeholder);
        for e in st.map.values() {
            if e.target.is_some() {
                let _ = fs::remove_dir_all(&e.host_path);
            }
        }
    };
    let disks = vec![
        vz::Disk {
            path: disk_path(&cfg.runtime, "runtime", &cfg.id, &mut temps)?,
            read_only: true,
            identifier: Some("runtime".into()),
        },
        vz::Disk {
            path: disk_path(&cfg.core, "core", &cfg.id, &mut temps)?,
            read_only: true,
            identifier: Some("core".into()),
        },
    ];

    // Shares: appdata (always) plus the configured ones.
    let mut state = ShareState::default();
    for spec in &cfg.shares {
        let r = if !valid_share_name(&spec.name) {
            Err(Error::new(format!("invalid share name '{}'", spec.name)))
        } else if spec.name == "appdata" || state.map.contains_key(&spec.name) {
            Err(Error::new(format!("duplicate share name '{}'", spec.name)))
        } else {
            resolve(spec, &cfg.id)
        };
        match r {
            Ok((host_path, target)) => {
                if spec.access == Access::Wo {
                    state.delivered.entry(spec.name.clone()).or_default();
                }
                state.map.insert(
                    spec.name.clone(),
                    ShareEntry { access: spec.access, host_path, target, slot: None, seen: HashMap::new() },
                );
            }
            Err(e) => {
                cleanup(&temps, &state);
                return Err(e);
            }
        }
    }

    // The empty folder every free slot device shares.
    let _ = fs::remove_dir(&placeholder);
    if let Err(e) = fs::create_dir(&placeholder) {
        cleanup(&temps, &state);
        return Err(Error::new(format!("cannot create {}: {e}", placeholder.display())));
    }
    let _ = fs::set_permissions(&placeholder, fs::Permissions::from_mode(0o700));
    let placeholder = match placeholder.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            cleanup(&temps, &state);
            return Err(Error::new(format!("cannot resolve {}: {e}", placeholder.display())));
        }
    };

    let console = match OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&cfg.console_log)
    {
        Ok(f) => f,
        Err(e) => {
            cleanup(&temps, &state);
            return Err(Error::new(format!("console log {}: {e}", cfg.console_log.display())));
        }
    };

    let shared = Arc::new(Shared { stopped: Mutex::new(None), cv: Condvar::new() });
    let machine: Box<dyn Machine> = if let Some(k) = &cfg.krun {
        // The experimental libkrun backend (SPEC 8.7): one virtiofs device per static share (libkrun cannot expose several
        // named folders through one device), no slot devices, no runtime grants.
        drop(console); // the VMM opens the console log itself
        let mut fs = vec![krun::FsDev { tag: "appdata".into(), path: appdata, read_only: false }];
        for (name, e) in &state.map {
            fs.push(krun::FsDev { tag: name.clone(), path: e.host_path.clone(), read_only: e.access == Access::Ro });
        }
        let names: Vec<&str> = fs.iter().map(|f| f.tag.as_str()).collect();
        let spec = krun::KrunSpec {
            kernel,
            initramfs,
            cmdline: format!(
                "console=hvc0 rdinit=/init panic=-1 quiet vmapp.id={} virtio_gpu.blob_alignment={} vmapp.fs={}{}",
                cfg.id,
                krun::BLOB_ALIGNMENT,
                names.join(","),
                if k.gpu { " vmapp.gpu=1" } else { "" }
            ),
            cpus: cfg.cpus,
            memory_mib: cfg.memory_mib,
            disks: disks.iter().map(|d| (d.identifier.clone().unwrap_or_default(), d.path.clone(), d.read_only)).collect(),
            fs,
            console_log: cfg.console_log.clone(),
            id: cfg.id.clone(),
        };
        match krun::Krun::create(&spec, k) {
            Ok(m) => Box::new(m),
            Err(e) => {
                cleanup(&temps, &state);
                return Err(e);
            }
        }
    } else {
        // The static device `vmapp`: appdata plus the launch-time shares. It is never changed after boot.
        let mut static_shares = vec![vz::Share { name: "appdata".into(), path: appdata, read_only: false }];
        for (name, e) in &state.map {
            static_shares.push(vz::Share { name: name.clone(), path: e.host_path.clone(), read_only: e.access == Access::Ro });
        }
        let mut fs_devices = vec![vz::FsDevice { tag: FS_TAG.into(), single: false, shares: static_shares }];
        // The slot devices `vmapp-s0`..: each shares the empty placeholder folder until a runtime grant takes it.
        for k in 0..SLOT_COUNT {
            fs_devices.push(vz::FsDevice {
                tag: slot_tag(k),
                single: true,
                shares: vec![vz::Share { name: "placeholder".into(), path: placeholder.clone(), read_only: true }],
            });
        }
        let spec = vz::Spec {
            kernel,
            initramfs,
            cmdline: format!("console=hvc0 rdinit=/init panic=-1 quiet vmapp.id={}", cfg.id),
            cpus: u64::from(cfg.cpus),
            memory_bytes: cfg.memory_mib * 1024 * 1024,
            fs_devices,
            disks,
            console_fd: std::os::fd::AsRawFd::as_raw_fd(&console),
        };
        let sink_shared = shared.clone();
        let sink: vz::EventSink = Arc::new(move |ev| {
            let why = match ev {
                vz::Event::GuestStopped => "guest stopped".to_string(),
                vz::Event::StoppedWithError(m) => format!("stopped with error: {m}"),
            };
            if let Ok(mut g) = sink_shared.stopped.lock() {
                *g = Some(why);
            }
            sink_shared.cv.notify_all();
        });
        let vz = match vz::Vz::create(&spec, sink) {
            Ok(v) => v,
            Err(e) => {
                cleanup(&temps, &state);
                return Err(e);
            }
        };
        drop(console); // the shim holds its own duplicate
        Box::new(vz)
    };
    let net_rules = cfg.net_rules.clone();
    let mut net_options = cfg.net_options.clone();
    // libkrun cannot pass on a half-close from the host (SPEC 8.7): the tunnels close in both directions when the target is done
    net_options.close_both_on_target_eof = cfg.krun.is_some();
    let services = cfg.services.clone();
    let inner = Arc::new_cyclic(|weak: &Weak<Inner>| {
        // The proxy opens its data connections through the VM without owning it (no reference cycle).
        let me = weak.clone();
        let connector: net::Connector = Arc::new(move |port| match me.upgrade() {
            Some(i) => i.machine.connect(port, Duration::from_secs(5)),
            None => Err(Error::new("the VM is gone")),
        });
        Inner {
            machine,
            stopping: AtomicBool::new(false),
            shared,
            cfg,
            placeholder,
            shares: Mutex::new(state),
            hello: OnceLock::new(),
            halt: AtomicBool::new(false),
            finished: Mutex::new(None),
            poll_stop: AtomicBool::new(false),
            poller: Mutex::new(None),
            core_exit: Mutex::new(None),
            temp_files: temps,
            net: net::NetProxy::with_services(net_rules, services, net_options, connector),
        }
    });
    // From here on, dropping `vm` (any error path below) force-stops the VM and cleans up.
    let vm = Vm { inner: inner.clone() };
    {
        let poller_inner = inner.clone();
        let h = thread::Builder::new()
            .name("vmapp-export".into())
            .spawn(move || live_export_loop(&poller_inner))?;
        *inner.poller.lock().unwrap_or_else(|e| e.into_inner()) = Some(h);
    }
    inner.machine.start()?;

    // Wait for the guest control port to answer hello.
    let deadline = Instant::now() + HELLO_TIMEOUT;
    #[allow(unused_assignments)]
    let mut last_err = String::new();
    loop {
        if cancel() {
            return Err(Error::new("cancelled"));
        }
        if inner.is_stopped() {
            return Err(Error::new(format!(
                "the guest stopped before answering hello (see {})",
                inner.cfg.console_log.display()
            )));
        }
        match inner.control(r#"{"op":"hello"}"#) {
            Ok(line) => match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) if v.get("ok") == Some(&serde_json::Value::Bool(true)) => {
                    let _ = inner.hello.set(v);
                    break;
                }
                Ok(v) => last_err = format!("unexpected hello reply: {v}"),
                Err(e) => last_err = format!("bad hello reply: {e}"),
            },
            Err(e) => last_err = e.to_string(),
        }
        if Instant::now() >= deadline {
            return Err(Error::new(format!(
                "the guest did not answer hello within {}s ({last_err}); see {}",
                HELLO_TIMEOUT.as_secs(),
                inner.cfg.console_log.display()
            )));
        }
        thread::sleep(Duration::from_millis(100));
    }

    // Host services (SPEC 8.6): the guest opens a loopback listener for each (before the core starts, so the endpoint
    // exists when the core looks for it). Fail closed: a service that cannot be set up fails the launch.
    for s in inner.net.services() {
        inner
            .control_ok(&serde_json::json!({"op": "service", "name": s.name}))
            .map_err(|e| Error::new(format!("cannot set up the {} service in the guest: {e}", s.name)))?;
    }
    // Network: only an app that has rules (or a service) gets a channel (fail closed: if it cannot be opened, the launch fails).
    if !inner.net.rules().is_empty() || !inner.net.services().is_empty() {
        inner.net_attach().map_err(|e| Error::new(format!("cannot open the network channel: {e}")))?;
    }

    // A backend that supervises its guest (the libkrun backend, SPEC 8.7) gets a heartbeat probe of its own.
    if inner.machine.watchdog().is_some() {
        let dog = inner.clone();
        thread::Builder::new().name("vmapp-watchdog".into()).spawn(move || dog.watchdog_loop())?;
    }

    // Unix socket -> guest bridge.
    let _ = fs::remove_file(&inner.cfg.socket);
    // SAFETY: umask is process-global but only briefly narrowed so the socket is created 0600.
    let old = unsafe { libc::umask(0o177) };
    let listener = UnixListener::bind(&inner.cfg.socket);
    unsafe { libc::umask(old) };
    let listener = listener
        .map_err(|e| Error::new(format!("cannot bind socket {}: {e}", inner.cfg.socket.display())))?;
    let _ = fs::set_permissions(&inner.cfg.socket, fs::Permissions::from_mode(0o600));
    listener.set_nonblocking(true)?;
    let acc = inner.clone();
    thread::Builder::new().name("vmapp-accept".into()).spawn(move || accept_loop(acc, listener))?;
    Ok(vm)
}

// ---------------------------------------------------------------------------------------------
// Socket <-> vsock bridge
// ---------------------------------------------------------------------------------------------

fn accept_loop(inner: Arc<Inner>, listener: UnixListener) {
    while !inner.halt.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((client, _)) => {
                let inner = inner.clone();
                let _ = thread::Builder::new().name("vmapp-bridge".into()).spawn(move || bridge(&inner, client));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(50)),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn bridge(inner: &Inner, mut client: UnixStream) {
    // Accepted sockets can inherit O_NONBLOCK from the listener on macOS.
    let _ = client.set_nonblocking(false);
    let guest = match inner.connect_bridge_fd() {
        Ok(fd) => UnixStream::from(fd),
        Err(e) => {
            let msg = serde_json::json!({"ok": false, "error": e.to_string()});
            let _ = writeln!(client, "{msg}");
            return;
        }
    };
    let (Ok(mut client_r), Ok(mut guest_w)) = (client.try_clone(), guest.try_clone()) else {
        return;
    };
    let mut guest_r = guest;
    // client -> guest
    let up = thread::spawn(move || {
        let _ = std::io::copy(&mut client_r, &mut guest_w);
        let _ = guest_w.shutdown(std::net::Shutdown::Write);
    });
    // guest -> client
    let _ = std::io::copy(&mut guest_r, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Both);
    let _ = up.join();
}

// ---------------------------------------------------------------------------------------------
// Live delivery
// ---------------------------------------------------------------------------------------------

/// Every [`POLL_INTERVAL`], polls each wo share and delivers what has settled.
fn live_export_loop(inner: &Inner) {
    'outer: loop {
        // Sleep in small steps so a stop request is noticed quickly.
        let until = Instant::now() + POLL_INTERVAL;
        while Instant::now() < until {
            if inner.poll_stop.load(Ordering::SeqCst) {
                break 'outer;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let mut st = inner.shares.lock().unwrap_or_else(|e| e.into_inner());
        let names: Vec<String> = st.map.iter().filter(|(_, e)| e.target.is_some()).map(|(n, _)| n.clone()).collect();
        for name in names {
            if inner.poll_stop.load(Ordering::SeqCst) {
                break 'outer;
            }
            let batch = match st.map.get_mut(&name) {
                Some(e) => poll_share(e),
                None => continue,
            };
            if !batch.is_empty() {
                st.delivered.entry(name.clone()).or_default().extend(batch.iter().cloned());
                st.batches.push((name, batch));
            }
        }
    }
}
