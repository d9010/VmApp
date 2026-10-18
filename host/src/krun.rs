//! EXPERIMENTAL: the libkrun backend (SPEC 8.7, `vmapp-vm-krun`). It runs an app's VM on Hypervisor.framework with
//! libkrun and a virtio-gpu (Venus) device, so the app can use the Mac's GPU through Vulkan.
//!
//! Two processes, one executable:
//!
//! * **the launcher** (this module's [`Krun`], a [`crate::Machine`]) is the same process as `vmapp-vm`'s equivalent: it
//!   owns the bridge socket, the network proxy, the shares and their delivery, and supervises the guest. It never loads
//!   libkrun, MoltenVK or Metal.
//! * **the VMM** is a child of the launcher (`vmapp-vm-krun __vmm <spec.json>`, [`vmm_main`]). It loads libkrun with
//!   `dlopen`, puts itself in a deny-by-default macOS sandbox (`gpu/krun/vmm.sb`: no network, no program to run, only
//!   the files and folders the VM was given) and runs the VM. `krun_start_enter` never returns: when the guest powers off
//!   libkrun exits the process, which is how the launcher learns that the VM is gone. Everything the guest can talk to
//!   (virtio devices, the Venus decoder, MoltenVK, Metal) is in this one sandboxed process.
//!
//! The guest's vsock ports 1022 to 1025 are libkrun "listening" Unix sockets in a private folder: connecting to one makes
//! libkrun open the vsock connection to the guest. That is how [`Krun::connect`] gives the launcher the same
//! "connect to a guest port" the Virtualization.framework backend has.
//!
//! Not supported on this backend (SPEC 8.7): runtime grants (libkrun cannot re-point a virtiofs share while the VM runs).

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::fd::OwnedFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{warn, Error, Machine, Result};

/// The host's page size (16 KiB on Apple silicon): host-visible GPU memory is mapped in units of it, so the guest kernel
/// must hand out blobs aligned to it (`virtio_gpu.blob_alignment=`, the gpu kernel flavour's patch).
pub const BLOB_ALIGNMENT: u32 = 16384;
/// The window of the guest's address space where host GPU memory is mapped ("vRAM"): bounds, in MiB.
pub const MIN_GPU_WINDOW_MIB: u64 = 256;
pub const MAX_GPU_WINDOW_MIB: u64 = 32768;
pub const DEFAULT_GPU_WINDOW_MIB: u64 = 8192;
/// How long the guest's control port may stay silent before the watchdog kills the VMM (`--watchdog`).
pub const DEFAULT_WATCHDOG: Duration = Duration::from_secs(30);
/// The guest vsock ports that become Unix sockets of the VMM (SPEC 4): network control, control, bridge, network data.
pub const VSOCK_PORTS: [u32; 4] = [1022, 1023, 1024, 1025];
/// At most this many read-only and read-write path parameters reach the sandbox profile (`RO0`.., `RW0`..).
pub const PROFILE_SLOTS: usize = 16;
/// A Unix socket path must be shorter than 104 bytes; leave some room.
const SOCKET_PATH_MAX: usize = 100;

/// Options of the libkrun backend (`vmapp-vm-krun` flags).
#[derive(Clone, Debug)]
pub struct KrunOptions {
    /// `--gpu-window MiB`.
    pub gpu_window_mib: u64,
    /// `--watchdog SECS` (0 = off). Silence of the guest's control port for this long kills the VMM, reason `gpu-hang`.
    pub watchdog: Option<Duration>,
    /// `--krun-dir DIR`: where `lib/libkrun.1.dylib` and `share/vmm.sb` are; default: the folder above this executable.
    pub dir: Option<PathBuf>,
    /// `--no-gpu`: run the VM without the virtio-gpu device (tests of the rest of the backend).
    pub gpu: bool,
    /// `--dev-no-sandbox`: no sandbox profile. For development only; the loader never passes it.
    pub sandbox: bool,
}

impl Default for KrunOptions {
    fn default() -> Self {
        KrunOptions { gpu_window_mib: DEFAULT_GPU_WINDOW_MIB, watchdog: Some(DEFAULT_WATCHDOG), dir: None, gpu: true, sandbox: true }
    }
}

/// One virtiofs device: libkrun exposes exactly one folder per device, so each static share (`appdata`, `f-<name>`) gets
/// a device whose tag is the share's name. The guest mounts it at `/host/<tag>` (SPEC 4, `vmapp.fs=` on the command line).
#[derive(Clone, Debug)]
pub struct FsDev {
    pub tag: String,
    pub path: PathBuf,
    pub read_only: bool,
}

/// What the launcher gives [`Krun::create`].
#[derive(Clone, Debug)]
pub struct KrunSpec {
    pub kernel: PathBuf,
    pub initramfs: PathBuf,
    pub cmdline: String,
    pub cpus: u32,
    pub memory_mib: u64,
    /// `(identifier, image, read_only)` in guest order (`vda`, `vdb`).
    pub disks: Vec<(String, PathBuf, bool)>,
    pub fs: Vec<FsDev>,
    pub console_log: PathBuf,
    pub id: String,
}

// ---------------------------------------------------------------------------------------------
// The spec the VMM child reads
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct VmmDisk {
    id: String,
    path: PathBuf,
    read_only: bool,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct VmmFs {
    tag: String,
    path: PathBuf,
    read_only: bool,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct VmmVsock {
    port: u32,
    path: PathBuf,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct VmmSandbox {
    /// The profile text (the loader's own `vmm.sb`, read by the launcher).
    profile: String,
    /// `(name, value)` parameters of `(param "name")`.
    params: Vec<(String, String)>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct VmmSpec {
    libkrun: PathBuf,
    kernel: PathBuf,
    initramfs: PathBuf,
    cmdline: String,
    cpus: u32,
    memory_mib: u64,
    disks: Vec<VmmDisk>,
    fs: Vec<VmmFs>,
    vsock: Vec<VmmVsock>,
    console: PathBuf,
    gpu_window_mib: Option<u64>,
    sandbox: Option<VmmSandbox>,
    log_level: u32,
    /// The launcher's pid: the VMM exits when it does.
    parent: i32,
}

/// The paths the sandbox profile names (`gpu/krun/vmm.sb`).
struct ProfilePaths<'a> {
    rundir: &'a Path,
    console: &'a Path,
    /// The folder of the VMM executable.
    exedir: &'a Path,
    /// The home folder (only its existence is visible).
    home: Option<&'a Path>,
    ro: &'a [&'a Path],
    rw: &'a [&'a Path],
    metal_cache: Option<&'a Path>,
}

/// The sandbox profile parameters for the paths the VM was given: `RUNDIR`, `CONSOLE`, `EXEDIR`, `HOME`, `METAL_CACHE`, and
/// `RO0`.. / `RW0`.. for every other file or folder (the profile reads each with `(when (param "ROn") ...)`). Fails if
/// there are more than [`PROFILE_SLOTS`] of either kind or a path is not absolute.
fn sandbox_params(p: &ProfilePaths) -> Result<Vec<(String, String)>> {
    if p.ro.len() > PROFILE_SLOTS || p.rw.len() > PROFILE_SLOTS {
        return Err(Error::new(format!(
            "too many paths for the sandbox profile ({} read-only, {} read-write; at most {PROFILE_SLOTS} each)",
            p.ro.len(),
            p.rw.len()
        )));
    }
    let text = |p: &Path| -> Result<String> {
        if !p.is_absolute() {
            return Err(Error::new(format!("sandbox path is not absolute: {}", p.display())));
        }
        p.to_str().map(str::to_string).ok_or_else(|| Error::new(format!("sandbox path is not UTF-8: {}", p.display())))
    };
    let mut out = vec![
        ("RUNDIR".to_string(), text(p.rundir)?),
        ("CONSOLE".to_string(), text(p.console)?),
        ("EXEDIR".to_string(), text(p.exedir)?),
    ];
    if let Some(h) = p.home {
        out.push(("HOME".to_string(), text(h)?));
    }
    for (i, f) in p.ro.iter().enumerate() {
        out.push((format!("RO{i}"), text(f)?));
    }
    for (i, f) in p.rw.iter().enumerate() {
        out.push((format!("RW{i}"), text(f)?));
    }
    if let Some(m) = p.metal_cache {
        out.push(("METAL_CACHE".to_string(), text(m)?));
    }
    Ok(out)
}

/// The user's home folder as a real path, for the profile (`None` if unknown).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).and_then(|h| h.canonicalize().ok())
}

/// The user's per-user cache folder (`confstr(_CS_DARWIN_USER_CACHE_DIR)`, real path, no trailing slash), where Metal keeps the
/// shaders it compiled for this user. `None` when it cannot be found: the VMM then compiles every shader again.
fn metal_cache_dir() -> Option<PathBuf> {
    let mut buf = [0 as c_char; 1024];
    // SAFETY: confstr writes at most `buf.len()` bytes, including the NUL.
    let n = unsafe { libc::confstr(libc::_CS_DARWIN_USER_CACHE_DIR, buf.as_mut_ptr(), buf.len()) };
    if n == 0 || n > buf.len() {
        return None;
    }
    // SAFETY: confstr NUL-terminated the buffer.
    let s = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_str().ok()?;
    PathBuf::from(s.trim_end_matches('/')).canonicalize().ok()
}

// ---------------------------------------------------------------------------------------------
// The launcher side: a Machine that is a sandboxed VMM child process
// ---------------------------------------------------------------------------------------------

/// The libkrun backend as seen by the launcher.
pub struct Krun {
    exe: PathBuf,
    rundir: PathBuf,
    spec_path: PathBuf,
    sockets: Vec<(u32, PathBuf)>,
    envs: Vec<(String, String)>,
    child: Mutex<Option<Child>>,
    exit: Mutex<Option<ExitStatus>>,
    /// The last time the guest's control port answered (or the start of the VM).
    last_ok: Mutex<Instant>,
    watchdog: Option<Duration>,
    /// The launcher killed the VMM (watchdog, force stop): its exit status is not a crash.
    killed: AtomicBool,
    hang: AtomicBool,
    /// What the watchdog saw, for the stopped line's `detail`.
    hang_note: Mutex<Option<String>>,
    pid: AtomicI32,
}

/// The folder above the running executable (`out/krun/bin/vmapp-vm-krun` -> `out/krun`).
fn default_dir() -> Result<PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    exe.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| Error::new("cannot find the folder of the libkrun backend"))
}

/// A private folder for the VMM's sockets and spec; short enough for Unix socket paths.
fn make_rundir(id: &str) -> Result<PathBuf> {
    let mut candidates = vec![std::env::temp_dir()];
    candidates.push(PathBuf::from("/tmp"));
    for base in candidates {
        let dir = base.join(format!("vmapp-{id}-k"));
        let longest = dir.join("v1025");
        if longest.as_os_str().len() >= SOCKET_PATH_MAX {
            continue;
        }
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).map_err(|e| Error::new(format!("cannot create {}: {e}", dir.display())))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        return Ok(dir.canonicalize()?);
    }
    Err(Error::new("no short enough folder for the VMM's sockets"))
}

impl Krun {
    /// Prepares the VMM: checks the installation, makes the run folder, writes the spec. [`Machine::start`] runs it.
    pub fn create(spec: &KrunSpec, opts: &KrunOptions) -> Result<Krun> {
        let dir = match &opts.dir {
            Some(d) => d.canonicalize().map_err(|e| Error::new(format!("--krun-dir {}: {e}", d.display())))?,
            None => default_dir()?,
        };
        let libkrun = dir.join("lib").join("libkrun.1.dylib");
        if !libkrun.is_file() {
            return Err(Error::new(format!(
                "the experimental GPU backend is not installed: {} is missing (build it with gpu/krun/build.sh)",
                libkrun.display()
            )));
        }
        let exe = std::env::current_exe()?.canonicalize()?;
        let rundir = make_rundir(&spec.id)?;
        // From here on a failure must not leave the run folder behind.
        let built = Self::create_in(spec, opts, &dir, &libkrun, &exe, &rundir);
        if built.is_err() {
            let _ = fs::remove_dir_all(&rundir);
        }
        built
    }

    fn create_in(spec: &KrunSpec, opts: &KrunOptions, dir: &Path, libkrun: &Path, exe: &Path, rundir: &Path) -> Result<Krun> {
        // The sandbox matches real paths (/var is /private/var): every path it names is resolved first.
        let real = |p: &Path| -> Result<PathBuf> {
            p.canonicalize().map_err(|e| Error::new(format!("{}: {e}", p.display())))
        };
        let spec = &KrunSpec {
            kernel: real(&spec.kernel)?,
            initramfs: real(&spec.initramfs)?,
            disks: spec
                .disks
                .iter()
                .map(|(id, p, ro)| Ok((id.clone(), real(p)?, *ro)))
                .collect::<Result<Vec<_>>>()?,
            fs: spec
                .fs
                .iter()
                .map(|f| Ok(FsDev { tag: f.tag.clone(), path: real(&f.path)?, read_only: f.read_only }))
                .collect::<Result<Vec<_>>>()?,
            ..spec.clone()
        };
        // The console log: created here (mode 0600) so its path can be named in the sandbox profile.
        let console_file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&spec.console_log)
            .map_err(|e| Error::new(format!("console log {}: {e}", spec.console_log.display())))?;
        drop(console_file);
        let console = spec.console_log.canonicalize()?;

        let sockets: Vec<(u32, PathBuf)> = VSOCK_PORTS.iter().map(|p| (*p, rundir.join(format!("v{p}")))).collect();

        let sandbox = if opts.sandbox {
            let profile_path = dir.join("share").join("vmm.sb");
            let profile = fs::read_to_string(&profile_path)
                .map_err(|e| Error::new(format!("sandbox profile {}: {e}", profile_path.display())))?;
            let mut ro: Vec<&Path> = vec![&spec.kernel, &spec.initramfs];
            let mut rw: Vec<&Path> = vec![];
            for (_, p, read_only) in &spec.disks {
                if *read_only {
                    ro.push(p);
                } else {
                    rw.push(p);
                }
            }
            for f in &spec.fs {
                if f.read_only {
                    ro.push(&f.path);
                } else {
                    rw.push(&f.path);
                }
            }
            let cache = metal_cache_dir();
            let home = home_dir();
            let exedir = exe.parent().ok_or_else(|| Error::new("the launcher has no folder"))?;
            let params = sandbox_params(&ProfilePaths {
                rundir,
                console: &console,
                exedir,
                home: home.as_deref(),
                ro: &ro,
                rw: &rw,
                metal_cache: cache.as_deref(),
            })?;
            Some(VmmSandbox { profile, params })
        } else {
            None
        };

        let vmm = VmmSpec {
            libkrun: libkrun.to_path_buf(),
            kernel: spec.kernel.clone(),
            initramfs: spec.initramfs.clone(),
            cmdline: spec.cmdline.clone(),
            cpus: spec.cpus,
            memory_mib: spec.memory_mib,
            disks: spec
                .disks
                .iter()
                .map(|(id, p, ro)| VmmDisk { id: id.clone(), path: p.clone(), read_only: *ro })
                .collect(),
            fs: spec.fs.iter().map(|f| VmmFs { tag: f.tag.clone(), path: f.path.clone(), read_only: f.read_only }).collect(),
            vsock: sockets.iter().map(|(port, path)| VmmVsock { port: *port, path: path.clone() }).collect(),
            console,
            gpu_window_mib: opts.gpu.then_some(opts.gpu_window_mib),
            sandbox,
            log_level: 1,
            // SAFETY: getpid has no preconditions.
            parent: unsafe { libc::getpid() },
        };
        let spec_path = rundir.join("vmm.json");
        let json = serde_json::to_vec(&vmm).map_err(|e| Error::new(format!("cannot encode the VMM spec: {e}")))?;
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&spec_path)
            .map_err(|e| Error::new(format!("cannot write {}: {e}", spec_path.display())))?;
        f.write_all(&json)?;
        drop(f);

        // MoltenVK, for the VMM only. Argument buffers must be off: with them MoltenVK and Venus lose the device while a
        // model generates (REPORT B2); it is also faster. Log level 1 = errors.
        let mut envs = vec![
            ("MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS".to_string(), "0".to_string()),
            ("MVK_CONFIG_LOG_LEVEL".to_string(), "1".to_string()),
            ("RUST_BACKTRACE".to_string(), "0".to_string()),
        ];
        for k in ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG"] {
            if let Ok(v) = std::env::var(k) {
                envs.push((k.to_string(), v));
            }
        }
        Ok(Krun {
            exe: exe.to_path_buf(),
            rundir: rundir.to_path_buf(),
            spec_path,
            sockets,
            envs,
            child: Mutex::new(None),
            exit: Mutex::new(None),
            last_ok: Mutex::new(Instant::now()),
            watchdog: opts.watchdog,
            killed: AtomicBool::new(false),
            hang: AtomicBool::new(false),
            hang_note: Mutex::new(None),
            pid: AtomicI32::new(0),
        })
    }

    /// Reaps the VMM if it has exited and remembers how.
    fn poll_exit(&self) -> Option<ExitStatus> {
        if let Some(s) = *self.exit.lock().unwrap_or_else(|e| e.into_inner()) {
            return Some(s);
        }
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                *self.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(status);
                Some(status)
            }
            Ok(None) => None,
            // waitpid failed (the child is not ours any more): treat the VM as gone
            Err(_) => {
                let status = ExitStatus::from_raw(0);
                *self.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(status);
                Some(status)
            }
        }
    }

    fn kill(&self, sig: c_int) {
        let pid = self.pid.load(Ordering::SeqCst);
        // Only a child that has not been reaped yet: a reaped pid could be reused by another process.
        if pid > 0 && self.poll_exit().is_none() {
            // SAFETY: signalling the child process we started and have not reaped.
            unsafe { libc::kill(pid, sig) };
        }
    }
}

impl Machine for Krun {
    fn start(&self) -> Result<()> {
        let mut cmd = Command::new(&self.exe);
        cmd.arg("__vmm")
            .arg(&self.spec_path)
            // The run folder is the one place the sandbox lets the VMM write; it is also where it should find itself.
            .current_dir(&self.rundir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .env_clear();
        for (k, v) in &self.envs {
            cmd.env(k, v);
        }
        let child = cmd.spawn().map_err(|e| Error::new(format!("cannot start the VMM {}: {e}", self.exe.display())))?;
        self.pid.store(child.id() as i32, Ordering::SeqCst);
        *self.last_ok.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        Ok(())
    }

    fn is_stopped(&self) -> bool {
        self.poll_exit().is_some()
    }

    fn connect(&self, port: u32, timeout: Duration) -> Result<OwnedFd> {
        let Some((_, path)) = self.sockets.iter().find(|(p, _)| *p == port) else {
            return Err(Error::new(format!("vsock port {port} is not mapped on this backend")));
        };
        let deadline = Instant::now() + timeout;
        loop {
            match UnixStream::connect(path) {
                Ok(s) => return Ok(OwnedFd::from(s)),
                Err(e) => {
                    // The VMM creates the sockets when it starts: wait for them, until the VM is gone or time is up.
                    if self.is_stopped() {
                        return Err(Error::new(format!("vsock connect to port {port}: the VMM has exited")));
                    }
                    if Instant::now() >= deadline {
                        return Err(Error::new(format!("vsock connect to port {port} failed: {e}")));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }

    fn request_stop(&self) -> Result<()> {
        self.kill(libc::SIGTERM);
        Ok(())
    }

    fn force_stop(&self, timeout: Duration) -> Result<()> {
        self.killed.store(true, Ordering::SeqCst);
        self.kill(libc::SIGKILL);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.is_stopped() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(Error::new("the VMM did not exit"))
    }

    fn set_share_for_tag(&self, _tag: &str, _shares: &[crate::vz::Share]) -> Result<()> {
        Err(Error::new("not supported on the gpu backend"))
    }

    fn supports_runtime_grants(&self) -> bool {
        false
    }

    fn watchdog(&self) -> Option<Duration> {
        self.watchdog
    }

    fn poll_interval(&self) -> Duration {
        // each connection the host closes lingers in libkrun for about 5 s (its reaper): fewer, then
        Duration::from_millis(500)
    }

    fn heartbeat(&self, answered: bool, gpu_stalled: Option<Duration>) -> bool {
        let now = Instant::now();
        if answered {
            *self.last_ok.lock().unwrap_or_else(|e| e.into_inner()) = now;
        }
        let Some(limit) = self.watchdog else { return false };
        let silent = now.duration_since(*self.last_ok.lock().unwrap_or_else(|e| e.into_inner()));
        // Two ways to be hung: the guest's control port is silent (the VMM or the guest kernel is wedged), or the guest's GPU
        // probe (an empty submission with a fence, answered only when the host's virtio-gpu worker has handled it) has been
        // waiting too long (the worker is wedged, REPORT B3/B4/B7: the guest's other processes keep running then).
        let (what, waited) = match gpu_stalled {
            Some(s) if s >= limit => ("the GPU worker has not answered a probe", s),
            _ if silent >= limit => ("the guest has not answered the control port", silent),
            _ => return false,
        };
        if self.is_stopped() {
            return false;
        }
        warn(format_args!("vmapp-vm-krun: {what} for {} s; the VM is hung, killing the VMM", waited.as_secs()));
        *self.hang_note.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("{what} for {} s; the VMM was killed", waited.as_secs()));
        self.hang.store(true, Ordering::SeqCst);
        self.killed.store(true, Ordering::SeqCst);
        self.kill(libc::SIGKILL);
        true
    }

    fn stop_reason(&self) -> Option<&'static str> {
        if self.hang.load(Ordering::SeqCst) {
            return Some("gpu-hang");
        }
        let status = self.poll_exit()?;
        if self.killed.load(Ordering::SeqCst) || status.success() {
            return None;
        }
        Some("vmm-crashed")
    }

    fn stop_detail(&self) -> Option<String> {
        if self.hang.load(Ordering::SeqCst) {
            let note = self.hang_note.lock().unwrap_or_else(|e| e.into_inner()).clone();
            return Some(note.unwrap_or_else(|| "the guest stopped answering; the VMM was killed".into()));
        }
        let status = self.poll_exit()?;
        if self.killed.load(Ordering::SeqCst) || status.success() {
            return None;
        }
        Some(match (status.signal(), status.code()) {
            (Some(s), _) => format!("the VMM was killed by signal {s}"),
            (None, Some(c)) => format!("the VMM exited with status {c}"),
            _ => "the VMM ended abnormally".to_string(),
        })
    }

    fn cleanup(&self) {
        for (_, p) in &self.sockets {
            let _ = fs::remove_file(p);
        }
        let _ = fs::remove_file(&self.spec_path);
        let _ = fs::remove_dir(&self.rundir);
    }
}

impl Drop for Krun {
    fn drop(&mut self) {
        // The launcher is going away: the VMM must not outlive it.
        self.killed.store(true, Ordering::SeqCst);
        self.kill(libc::SIGKILL);
        self.cleanup();
    }
}

// ---------------------------------------------------------------------------------------------
// The VMM child
// ---------------------------------------------------------------------------------------------

extern "C" {
    fn sandbox_init_with_parameters(
        profile: *const c_char,
        flags: u64,
        parameters: *const *const c_char,
        errorbuf: *mut *mut c_char,
    ) -> c_int;
    fn sandbox_free_error(errorbuf: *mut c_char);
}

/// `VIRGLRENDERER_VENUS | VIRGLRENDERER_NO_VIRGL`: Venus (Vulkan) only, no OpenGL path.
const GPU_FLAGS: u32 = (1 << 6) | (1 << 7);
const KRUN_KERNEL_FORMAT_RAW: u32 = 0;
const KRUN_DISK_FORMAT_RAW: u32 = 0;
const KRUN_SYNC_RELAXED: u32 = 1;
const KRUN_SEMANTICS_LINUX_SIMPLIFIED: u32 = 1;

/// The few libkrun entry points the VMM uses, resolved with dlsym.
struct Api {
    set_log_level: unsafe extern "C" fn(u32) -> i32,
    create_ctx: unsafe extern "C" fn() -> i32,
    set_vm_config: unsafe extern "C" fn(u32, u8, u32) -> i32,
    set_kernel: unsafe extern "C" fn(u32, *const c_char, u32, *const c_char, *const c_char) -> i32,
    add_disk3: unsafe extern "C" fn(u32, *const c_char, *const c_char, u32, bool, bool, u32) -> i32,
    add_virtiofs4: unsafe extern "C" fn(u32, *const c_char, *const c_char, u64, bool, u32) -> i32,
    disable_implicit_vsock: unsafe extern "C" fn(u32) -> i32,
    add_vsock: unsafe extern "C" fn(u32, u32) -> i32,
    add_vsock_port2: unsafe extern "C" fn(u32, u32, *const c_char, bool) -> i32,
    set_gpu_options2: unsafe extern "C" fn(u32, u32, u64) -> i32,
    set_console_output: unsafe extern "C" fn(u32, *const c_char) -> i32,
    start_enter: unsafe extern "C" fn(u32) -> i32,
}

fn cstr(s: &str) -> std::result::Result<CString, String> {
    CString::new(s).map_err(|_| format!("string contains NUL: {s:?}"))
}

fn path_cstr(p: &Path) -> std::result::Result<CString, String> {
    cstr(p.to_str().ok_or_else(|| format!("path is not UTF-8: {}", p.display()))?)
}

fn dl_error() -> String {
    // SAFETY: dlerror returns null or a NUL-terminated string valid until the next dl call.
    let p = unsafe { libc::dlerror() };
    if p.is_null() {
        "unknown error".to_string()
    } else {
        // SAFETY: checked non-null above.
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

impl Api {
    fn load(path: &Path) -> std::result::Result<Api, String> {
        let p = path_cstr(path)?;
        // SAFETY: dlopen of the libkrun that ships next to this launcher; RTLD_LOCAL keeps its symbols to itself.
        let lib = unsafe { libc::dlopen(p.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if lib.is_null() {
            return Err(format!("cannot load {}: {}", path.display(), dl_error()));
        }
        macro_rules! sym {
            ($name:literal) => {{
                // SAFETY: `lib` is a live handle; the symbol is cast to the signature libkrun.h declares for it.
                let s = unsafe { libc::dlsym(lib, concat!($name, "\0").as_ptr().cast()) };
                if s.is_null() {
                    return Err(format!("libkrun has no {}: {}", $name, dl_error()));
                }
                // SAFETY: see above; the field type is the function's signature.
                unsafe { std::mem::transmute::<*mut c_void, _>(s) }
            }};
        }
        Ok(Api {
            set_log_level: sym!("krun_set_log_level"),
            create_ctx: sym!("krun_create_ctx"),
            set_vm_config: sym!("krun_set_vm_config"),
            set_kernel: sym!("krun_set_kernel"),
            add_disk3: sym!("krun_add_disk3"),
            add_virtiofs4: sym!("krun_add_virtiofs4"),
            disable_implicit_vsock: sym!("krun_disable_implicit_vsock"),
            add_vsock: sym!("krun_add_vsock"),
            add_vsock_port2: sym!("krun_add_vsock_port2"),
            set_gpu_options2: sym!("krun_set_gpu_options2"),
            set_console_output: sym!("krun_set_console_output"),
            start_enter: sym!("krun_start_enter"),
        })
    }
}

/// Puts the process in the sandbox profile. After this the VMM can only do what the profile allows.
fn enter_sandbox(sb: &VmmSandbox) -> std::result::Result<(), String> {
    let profile = cstr(&sb.profile)?;
    let mut strings: Vec<CString> = Vec::with_capacity(sb.params.len() * 2);
    for (k, v) in &sb.params {
        strings.push(cstr(k)?);
        strings.push(cstr(v)?);
    }
    let mut ptrs: Vec<*const c_char> = strings.iter().map(|s| s.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let mut err: *mut c_char = std::ptr::null_mut();
    // SAFETY: `profile` and the parameter array (NULL-terminated, alternating names and values) outlive the call;
    // `err` is an out-parameter that sandbox_free_error releases.
    let rc = unsafe { sandbox_init_with_parameters(profile.as_ptr(), 0, ptrs.as_ptr(), &mut err) };
    if rc != 0 {
        let msg = if err.is_null() {
            "sandbox_init_with_parameters failed".to_string()
        } else {
            // SAFETY: on failure `err` points to a NUL-terminated message.
            let m = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
            // SAFETY: `err` came from sandbox_init_with_parameters.
            unsafe { sandbox_free_error(err) };
            m
        };
        return Err(format!("cannot enter the sandbox: {msg}"));
    }
    Ok(())
}

fn check(what: &str, rc: i32) -> std::result::Result<(), String> {
    if rc < 0 {
        let reason = std::io::Error::from_raw_os_error(-rc);
        Err(format!("{what} failed: {rc} ({reason})"))
    } else {
        Ok(())
    }
}

/// Configures libkrun and runs the VM. Only returns on an error: a running VM ends with `exit()` inside libkrun.
fn run_vmm(spec: &VmmSpec, api: &Api) -> std::result::Result<(), String> {
    let kernel = path_cstr(&spec.kernel)?;
    let initramfs = path_cstr(&spec.initramfs)?;
    let cmdline = cstr(&spec.cmdline)?;
    // SAFETY (the whole block): every call goes to the libkrun entry points resolved in `Api::load`, with C strings that
    // live until the end of this function and plain integers.
    unsafe {
        check("krun_set_log_level", (api.set_log_level)(spec.log_level))?;
        let ctx = (api.create_ctx)();
        if ctx < 0 {
            return Err(format!("krun_create_ctx failed: {ctx}"));
        }
        let ctx = ctx as u32;
        let cpus = u8::try_from(spec.cpus).map_err(|_| format!("too many vCPUs: {}", spec.cpus))?;
        let mem = u32::try_from(spec.memory_mib).map_err(|_| format!("too much memory: {} MiB", spec.memory_mib))?;
        check("krun_set_vm_config", (api.set_vm_config)(ctx, cpus, mem))?;
        check(
            "krun_set_kernel",
            (api.set_kernel)(ctx, kernel.as_ptr(), KRUN_KERNEL_FORMAT_RAW, initramfs.as_ptr(), cmdline.as_ptr()),
        )?;
        for d in &spec.disks {
            let id = cstr(&d.id)?;
            let path = path_cstr(&d.path)?;
            check(
                "krun_add_disk3",
                (api.add_disk3)(ctx, id.as_ptr(), path.as_ptr(), KRUN_DISK_FORMAT_RAW, d.read_only, false, KRUN_SYNC_RELAXED),
            )?;
        }
        for f in &spec.fs {
            let tag = cstr(&f.tag)?;
            let path = path_cstr(&f.path)?;
            // Simplified semantics: ownership bits are ignored and every file belongs to the guest process that asks, so the
            // app user (uid 1000) can use a share whatever uid the Mac user has (the Virtualization.framework backend behaves alike).
            check(
                "krun_add_virtiofs4",
                (api.add_virtiofs4)(ctx, tag.as_ptr(), path.as_ptr(), 0, f.read_only, KRUN_SEMANTICS_LINUX_SIMPLIFIED),
            )?;
        }
        // A plain vsock device (no TSI socket hijacking): the guest only uses vsock ports (SPEC 4), and the VM has no
        // network device (INV-D1).
        check("krun_disable_implicit_vsock", (api.disable_implicit_vsock)(ctx))?;
        check("krun_add_vsock", (api.add_vsock)(ctx, 0))?;
        for v in &spec.vsock {
            let path = path_cstr(&v.path)?;
            check("krun_add_vsock_port2", (api.add_vsock_port2)(ctx, v.port, path.as_ptr(), true))?;
        }
        if let Some(mib) = spec.gpu_window_mib {
            check("krun_set_gpu_options2", (api.set_gpu_options2)(ctx, GPU_FLAGS, mib * 1024 * 1024))?;
        }
        let console = path_cstr(&spec.console)?;
        check("krun_set_console_output", (api.set_console_output)(ctx, console.as_ptr()))?;
        check("krun_start_enter", (api.start_enter)(ctx))?;
    }
    Ok(())
}

/// The VMM child's `main` (`vmapp-vm-krun __vmm <spec.json>`). Reads the spec, follows the launcher, enters the sandbox
/// and runs the VM; libkrun exits the process when the guest powers off.
pub fn vmm_main(spec_path: Option<String>) -> ExitCode {
    let Some(spec_path) = spec_path else {
        warn(format_args!("vmapp-vm-krun: __vmm needs a spec file"));
        return ExitCode::from(2);
    };
    let spec: VmmSpec = match fs::read(&spec_path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
        Ok(s) => s,
        Err(e) => {
            warn(format_args!("vmapp-vm-krun: cannot read the VMM spec {spec_path}: {e}"));
            return ExitCode::from(2);
        }
    };
    // The VMM never outlives the launcher (INV-E1): when it exits, so do we.
    crate::cli::watch_process_exit(spec.parent, "vmapp-vmm", || {
        // SAFETY: _exit ends the process at once without running destructors; that is the point.
        unsafe { libc::_exit(1) };
    });
    // No core dumps: they would hold the guest's memory.
    let no_core = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: setrlimit with a valid struct.
    unsafe { libc::setrlimit(libc::RLIMIT_CORE, &no_core) };
    // libkrun keeps the end of a vsock connection that the host closed for about 5 s, one file descriptor each: with the
    // default soft limit (256) a burst of short connections through the network proxy could run out of them.
    let mut nofile = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit/setrlimit with valid structs.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut nofile) == 0 {
            nofile.rlim_cur = nofile.rlim_max.min(10240);
            libc::setrlimit(libc::RLIMIT_NOFILE, &nofile);
        }
    }

    // Load libkrun (and with it virglrenderer, MoltenVK, libepoxy) before the sandbox: the profile need not allow reading
    // the library folder.
    let api = match Api::load(&spec.libkrun) {
        Ok(a) => a,
        Err(e) => {
            warn(format_args!("vmapp-vm-krun: {e}"));
            return ExitCode::from(70);
        }
    };
    if let Some(sb) = &spec.sandbox {
        if let Err(e) = enter_sandbox(sb) {
            warn(format_args!("vmapp-vm-krun: {e}"));
            return ExitCode::from(71);
        }
    }
    match run_vmm(&spec, &api) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            warn(format_args!("vmapp-vm-krun: {e}"));
            ExitCode::from(72)
        }
    }
}

// Only the pure parts are tested here; the VM itself is tested by tests/gpu-vulkan/ and tests/e2e.sh.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_params_name_every_path() {
        let ro = [Path::new("/a/kernel"), Path::new("/a/rt.img")];
        let rw = [Path::new("/a/data")];
        let p = sandbox_params(&ProfilePaths {
            rundir: Path::new("/tmp/run"),
            console: Path::new("/tmp/console.log"),
            exedir: Path::new("/k/bin"),
            home: Some(Path::new("/Users/u")),
            ro: &ro,
            rw: &rw,
            metal_cache: Some(Path::new("/c/cache")),
        })
        .unwrap();
        let get = |k: &str| p.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("EXEDIR"), Some("/k/bin"));
        assert_eq!(get("HOME"), Some("/Users/u"));
        assert_eq!(get("RUNDIR"), Some("/tmp/run"));
        assert_eq!(get("CONSOLE"), Some("/tmp/console.log"));
        assert_eq!(get("RO0"), Some("/a/kernel"));
        assert_eq!(get("RO1"), Some("/a/rt.img"));
        assert_eq!(get("RW0"), Some("/a/data"));
        assert_eq!(get("RO2"), None);
        assert_eq!(get("METAL_CACHE"), Some("/c/cache"));
    }

    #[test]
    fn sandbox_params_refuse_relative_paths_and_overflow() {
        let with = |ro: &[&Path], rw: &[&Path]| {
            sandbox_params(&ProfilePaths {
                rundir: Path::new("/r"),
                console: Path::new("/c"),
                exedir: Path::new("/e"),
                home: None,
                ro,
                rw,
                metal_cache: None,
            })
        };
        assert!(with(&[Path::new("rel")], &[]).is_err());
        let many: Vec<PathBuf> = (0..=PROFILE_SLOTS).map(|i| PathBuf::from(format!("/x/{i}"))).collect();
        let refs: Vec<&Path> = many.iter().map(|p| p.as_path()).collect();
        assert!(with(&refs, &[]).is_err());
        assert!(with(&[], &refs).is_err());
    }

    #[test]
    fn vmm_spec_round_trips_through_json() {
        let spec = VmmSpec {
            libkrun: "/k/lib/libkrun.1.dylib".into(),
            kernel: "/k/Image-gpu".into(),
            initramfs: "/k/initramfs.cpio".into(),
            cmdline: "console=hvc0 vmapp.fs=appdata".into(),
            cpus: 2,
            memory_mib: 1024,
            disks: vec![VmmDisk { id: "runtime".into(), path: "/k/rt.img".into(), read_only: true }],
            fs: vec![VmmFs { tag: "appdata".into(), path: "/k/data".into(), read_only: false }],
            vsock: vec![VmmVsock { port: 1023, path: "/tmp/r/v1023".into() }],
            console: "/tmp/c.log".into(),
            gpu_window_mib: Some(4096),
            sandbox: Some(VmmSandbox { profile: "(version 1)".into(), params: vec![("RUNDIR".into(), "/tmp/r".into())] }),
            log_level: 1,
            parent: 42,
        };
        let back: VmmSpec = serde_json::from_slice(&serde_json::to_vec(&spec).unwrap()).unwrap();
        assert_eq!(back, spec);
    }

    #[test]
    fn make_rundir_is_private_and_short() {
        let id = format!("t{:07x}", std::process::id());
        let d = make_rundir(&id).unwrap();
        assert!(d.join("v1025").as_os_str().len() < SOCKET_PATH_MAX);
        assert_eq!(fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        fs::remove_dir(&d).unwrap();
    }

    #[test]
    fn default_options_match_the_documented_defaults() {
        let o = KrunOptions::default();
        assert_eq!(o.gpu_window_mib, DEFAULT_GPU_WINDOW_MIB);
        assert_eq!(o.watchdog, Some(DEFAULT_WATCHDOG));
        assert!(o.gpu && o.sandbox);
    }
}
