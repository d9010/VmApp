//! `vmapp-init`: PID 1 of the vmapp guest (SPEC section 4).
//!
//! Mounts the runtime image (`/dev/vda`, EROFS) at `/rt`, mounts the app's `core.erofs` (`/dev/vdb`) at `/rt/app` or
//! extracts its `core.cpio` into a tmpfs there, mounts the host shares, then serves vsock port 1023 (control) and 1024 (bridge), plus the
//! network proxy of SPEC 8.3 (`127.0.0.1:3128`, vsock 1022 and 1025; `netproxy.rs`). The
//! core process is started by the host's `start` request. The VM is the app: when the core exits, or the host
//! asks for a shutdown, the machine powers off. On a fatal error it logs and powers off.
//!
//! Adapted from agent-vm/guest/src/main.rs (commit 8f0c069).
//!
//! PID 1 must never panic (panic=abort): no `unwrap`, `expect`, indexing or `println!`/`eprintln!`.

mod cpio;
mod erofs;
mod json;

use std::ffi::CString;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const NAME: &str = "vmapp-init";
const VERSION: &str = "0.1.0";
const CONTROL_PORT: u32 = 1023;
const BRIDGE_PORT: u32 = 1024;
/// Network permission (SPEC 8.3): the host's persistent control connection, and one data connection per tunnel.
const NETCTL_PORT: u32 = 1022;
const NETDATA_PORT: u32 = 1025;
/// Port forwarding (SPEC 8.8): one vsock connection per forwarded TCP connection, to the VM's own loopback.
const PORTFWD_PORT: u32 = 1026;
/// Where the core sees host folders (inside the chroot: `/host`): a tmpfs holding binds and slot mounts.
const HOST_DIR: &str = "/rt/host";
/// Grant slot devices `vmapp-s0` .. `vmapp-s7`.
const SLOTS: usize = 8;
/// The static `vmapp` device plus the slot devices.
const FS_DEVICES: usize = SLOTS + 1;
/// Longest accepted request line.
const MAX_LINE: u64 = 1024 * 1024;

static VMAPP_ID: OnceLock<String> = OnceLock::new();

/// Write a line to the console (stderr is /dev/console); errors are ignored.
macro_rules! log {
    ($($arg:tt)*) => {{
        let _ = writeln!(io::stderr(), "{}: {}", NAME, format_args!($($arg)*));
    }};
}

// Declared after `log!` so the modules can use it.
mod appcore;
mod gpuprobe;
mod netproxy;
mod portfwd;

// ---------------------------------------------------------------------------
// system setup
// ---------------------------------------------------------------------------

fn mount(source: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: Option<&str>) -> io::Result<()> {
    let bad = |_| io::Error::new(io::ErrorKind::InvalidInput, "string contains NUL");
    let src = CString::new(source).map_err(bad)?;
    let tgt = CString::new(target).map_err(bad)?;
    let fst = CString::new(fstype).map_err(bad)?;
    let dat = data.map(CString::new).transpose().map_err(bad)?;
    // SAFETY: all pointers are valid NUL-terminated strings (or null) for the call.
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            tgt.as_ptr(),
            fst.as_ptr(),
            flags,
            dat.as_ref().map_or(std::ptr::null(), |d| d.as_ptr().cast()),
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Mount `fstype` on `target`, creating the directory if needed. Failures are logged; EBUSY (already
/// mounted) is fine.
fn mount_logged(source: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: Option<&str>) -> bool {
    if let Err(e) = std::fs::create_dir_all(target) {
        log!("cannot create {target}: {e}");
    }
    match mount(source, target, fstype, flags, data) {
        Ok(()) => true,
        Err(e) if e.raw_os_error() == Some(libc::EBUSY) => true,
        Err(e) => {
            log!("mount {fstype} on {target} failed: {e}");
            false
        }
    }
}

/// Recursive bind mount of `src` on `target`.
fn bind(src: &str, target: &str, recursive: bool) -> bool {
    if let Err(e) = std::fs::create_dir_all(target) {
        log!("cannot create {target}: {e}");
    }
    let flags = if recursive { libc::MS_BIND | libc::MS_REC } else { libc::MS_BIND };
    match mount(src, target, "", flags, None) {
        Ok(()) => true,
        Err(e) => {
            log!("bind mount {src} on {target} failed: {e}");
            false
        }
    }
}

/// Point fds 0-2 at the console so the log reaches hvc0.
fn reopen_console() {
    // SAFETY: open/dup2/close on descriptors owned by this process.
    unsafe {
        let path = c"/dev/console";
        let fd = libc::open(path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
        if fd >= 0 {
            for target in 0..3 {
                libc::dup2(fd, target);
            }
            if fd > 2 {
                libc::close(fd);
            }
        }
    }
}

fn poweroff(reason: &str) -> ! {
    log!("powering off: {reason}");
    // SAFETY: sync(2) takes no arguments.
    unsafe { libc::sync() };
    // SAFETY: reboot(2) with a plain command; only returns on failure.
    let rc = unsafe { libc::reboot(libc::RB_POWER_OFF) };
    if rc != 0 {
        log!("reboot(POWER_OFF) failed: {}", io::Error::last_os_error());
    }
    loop {
        // Never exit PID 1 (kernel panic).
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// `struct ifreq` for the flags ioctls: 16-byte name, then a 24-byte union of which only `ifr_flags` is used.
#[repr(C)]
struct IfReq {
    name: [u8; 16],
    flags: libc::c_short,
    _pad: [u8; 22],
}

/// Bring the loopback interface up (the kernel then adds 127.0.0.1/8 and ::1 itself).
fn bring_up_lo() {
    // SAFETY: plain socket(2); closed below.
    let s = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if s < 0 {
        log!("loopback: cannot create a socket: {}", io::Error::last_os_error());
        return;
    }
    let mut ifr = IfReq { name: [0; 16], flags: 0, _pad: [0; 22] };
    for (slot, b) in ifr.name.iter_mut().zip(b"lo") {
        *slot = *b;
    }
    // SAFETY: `ifr` is a valid, correctly sized struct ifreq for these ioctls.
    let got = unsafe { libc::ioctl(s, libc::SIOCGIFFLAGS as _, &mut ifr as *mut IfReq) };
    if got != 0 {
        log!("loopback: SIOCGIFFLAGS failed: {}", io::Error::last_os_error());
    } else {
        ifr.flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
        // SAFETY: as above.
        let set = unsafe { libc::ioctl(s, libc::SIOCSIFFLAGS as _, &mut ifr as *mut IfReq) };
        if set != 0 {
            log!("loopback: SIOCSIFFLAGS failed: {}", io::Error::last_os_error());
        } else {
            log!("loopback up");
        }
    }
    // SAFETY: closing the socket we created.
    unsafe { libc::close(s) };
}

fn kernel_release() -> String {
    // SAFETY: utsname is plain bytes; uname(2) fills it.
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    // SAFETY: valid out-pointer.
    if unsafe { libc::uname(&mut u) } != 0 {
        return String::new();
    }
    let bytes: Vec<u8> = u.release.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Wait until every path exists, at most `max`. Returns the first missing path, if any.
fn wait_for(paths: &[&str], max: Duration) -> Option<String> {
    let deadline = Instant::now() + max;
    loop {
        let missing = paths.iter().find(|p| !Path::new(p).exists());
        match missing {
            None => return None,
            Some(p) if Instant::now() >= deadline => return Some((*p).to_owned()),
            Some(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// The first `n` bytes of a disk (fewer when the disk is smaller): enough to tell an EROFS image from a cpio.
fn read_head(path: &str, n: usize) -> Result<Vec<u8>, String> {
    let disk = File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let mut head = Vec::with_capacity(n);
    disk.take(n as u64).read_to_end(&mut head).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(head)
}

/// The gid of the group `tty` in the text of an `/etc/group` file (5 in Debian), or 0 when there is none.
fn parse_tty_gid(group_file: &str) -> u32 {
    group_file
        .lines()
        .find_map(|line| {
            let mut fields = line.split(':');
            if fields.next()? == "tty" {
                fields.nth(1)?.parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

/// Pseudo-terminals for the core (SPEC section 4): a devpts instance at `/rt/dev/pts` (nosuid, noexec; ptys mode 0620,
/// group `tty`, openable by every user through `ptmxmode=0666`) and `/dev/ptmx` as a symlink to that instance's
/// `pts/ptmx`, so `openpty()` and `node-pty` work. The devtmpfs `/dev` has neither. Not fatal when it fails: the core
/// then simply has no terminals.
fn mount_devpts() {
    let group_file = std::fs::read_to_string("/rt/etc/group").unwrap_or_default();
    let data = format!("newinstance,ptmxmode=0666,mode=0620,gid={}", parse_tty_gid(&group_file));
    if !mount_logged("devpts", "/rt/dev/pts", "devpts", libc::MS_NOSUID | libc::MS_NOEXEC, Some(&data)) {
        log!("ERROR: no pseudo-terminals (devpts mount failed); the core cannot open terminals");
        return;
    }
    let link = "/rt/dev/ptmx";
    match std::fs::remove_file(link) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => log!("cannot remove {link}: {e}"),
    }
    match std::os::unix::fs::symlink("pts/ptmx", link) {
        Ok(()) => log!("devpts mounted at /rt/dev/pts, {link} -> pts/ptmx"),
        Err(e) => log!("ERROR: cannot link {link} to pts/ptmx: {e}"),
    }
}

/// Everything between the base mounts and the vsock listeners. Err = fatal (caller powers off).
fn setup_root() -> Result<(), String> {
    let nsde = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
    let nsd = libc::MS_NOSUID | libc::MS_NODEV;
    let root = appcore::ROOT;

    // 2. Root: the runtime image.
    if let Some(missing) = wait_for(&["/dev/vda", "/dev/vdb"], Duration::from_secs(5)) {
        return Err(format!("{missing} did not appear within 5 s (runtime and core disks are required)"));
    }
    std::fs::create_dir_all(root).map_err(|e| format!("cannot create {root}: {e}"))?;
    mount("/dev/vda", root, "erofs", libc::MS_RDONLY | nsd, None)
        .map_err(|e| format!("cannot mount the runtime image (/dev/vda as erofs) at {root}: {e}"))?;
    log!("runtime image mounted at {root}");

    // 3. App files from /dev/vdb: a core.erofs is mounted as it is; a core.cpio is extracted into a tmpfs.
    let app = "/rt/app";
    let head = read_head("/dev/vdb", 4096)?;
    if erofs::is_erofs(&head) {
        mount("/dev/vdb", app, "erofs", libc::MS_RDONLY | nsd, None)
            .map_err(|e| format!("cannot mount the core image (/dev/vdb as erofs) at {app}: {e}"))?;
        let stats = erofs::check_tree(Path::new(app)).map_err(|e| format!("invalid core.erofs: {e}"))?;
        FILES.store(stats.files, std::sync::atomic::Ordering::SeqCst);
        BYTES.store(stats.bytes, std::sync::atomic::Ordering::SeqCst);
        log!("mounted core.erofs at {app}: {} files, {} bytes", stats.files, stats.bytes);
    } else {
        mount("tmpfs", app, "tmpfs", nsd, Some("mode=0755,size=80%"))
            .map_err(|e| format!("cannot mount a tmpfs at {app} (does the runtime image have an /app folder?): {e}"))?;
        let disk = File::open("/dev/vdb").map_err(|e| format!("cannot open /dev/vdb: {e}"))?;
        let stats = cpio::extract(BufReader::with_capacity(1 << 20, disk), Path::new(app))
            .map_err(|e| format!("invalid core.cpio: {e}"))?;
        FILES.store(stats.files, std::sync::atomic::Ordering::SeqCst);
        BYTES.store(stats.bytes, std::sync::atomic::Ordering::SeqCst);
        log!("extracted core.cpio into {app}: {} files, {} bytes", stats.files, stats.bytes);
        mount("", app, "", libc::MS_REMOUNT | libc::MS_RDONLY | nsd, None)
            .map_err(|e| format!("cannot remount {app} read-only: {e}"))?;
    }

    // 4. Host shares: the static device `vmapp` (the grant slots `vmapp-s0`..`s7` are mounted on demand). On the libkrun
    //    backend (SPEC 8.7) the kernel command line names one virtiofs device per static share instead.
    let tags = share_tags();
    log_virtiofs_devices(tags.as_ref().map_or(FS_DEVICES, |t| t.len()));
    if let Err(e) = std::fs::create_dir_all("/host") {
        log!("cannot create /host: {e}");
    }
    let host_mounted = match &tags {
        Some(names) => mount_share_tags(names, nsd),
        None => match mount("vmapp", "/host", "virtiofs", nsd, None) {
            Ok(()) => {
                log!("virtiofs 'vmapp' mounted at /host, shares: {:?}", shares());
                true
            }
            Err(e) => {
                log!("ERROR: no host shares (virtiofs mount failed: {e}); continuing without shares");
                false
            }
        },
    };

    // 5. Mounts inside /rt.
    let m = |ok: bool, what: &str| if ok { Ok(()) } else { Err(format!("cannot mount {what} inside {root}")) };
    m(mount_logged("proc", "/rt/proc", "proc", nsde, None), "proc")?;
    m(mount_logged("sysfs", "/rt/sys", "sysfs", nsde, None), "sysfs")?;
    m(bind("/dev", "/rt/dev", true), "dev")?;
    m(mount_logged("tmpfs", "/rt/dev/shm", "tmpfs", nsd, Some("mode=1777")), "dev/shm")?;
    mount_devpts();
    m(mount_logged("tmpfs", "/rt/tmp", "tmpfs", nsd, Some("mode=1777")), "tmp")?;
    m(mount_logged("tmpfs", "/rt/run", "tmpfs", nsd, Some("mode=0755")), "run")?;

    // /run/vmapp: where the core creates its socket; owned by the app user, 0700.
    let run_vmapp = "/rt/run/vmapp";
    std::fs::create_dir_all(run_vmapp).map_err(|e| format!("cannot create {run_vmapp}: {e}"))?;
    {
        use std::os::unix::fs::{chown, PermissionsExt};
        chown(run_vmapp, Some(appcore::APP_UID), Some(appcore::APP_GID))
            .map_err(|e| format!("cannot chown {run_vmapp}: {e}"))?;
        std::fs::set_permissions(run_vmapp, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot chmod {run_vmapp}: {e}"))?;
    }

    // /rt/host is a tmpfs: the top-level folders of the static `vmapp` device (appdata, f-*) are bound into
    // it now; runtime grants are mounted into it later by the control `mount` op (each from its own slot
    // device, so replacing a slot's share never touches these binds).
    if !mount_logged("tmpfs", HOST_DIR, "tmpfs", nsd, Some("mode=0755")) {
        return Err(format!("cannot mount a tmpfs at {HOST_DIR}"));
    }
    let mut data_ok = false;
    if host_mounted {
        for name in shares_dirs() {
            let src = format!("/host/{name}");
            let dst = format!("{HOST_DIR}/{name}");
            if !bind(&src, &dst, true) {
                log!("ERROR: cannot bind {src} at {dst}; the core will not see that folder");
            }
        }
        if Path::new("/host/appdata").is_dir() {
            data_ok = bind("/host/appdata", "/rt/data", false);
        } else {
            log!("ERROR: /host/appdata is missing; the app's /data will not persist");
        }
    }
    if !data_ok {
        // The core still needs a writable /data; it just won't survive the VM.
        if !mount_logged("tmpfs", "/rt/data", "tmpfs", nsd, Some("mode=1777")) {
            return Err("cannot provide /data".to_owned());
        }
    }
    Ok(())
}

static FILES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn shares() -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/host") {
        for e in rd.flatten() {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    names
}

/// The top-level directories of the static `/host` mount.
fn shares_dirs() -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/host") {
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                names.push(e.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    names
}

/// Tags of the virtiofs devices the kernel has probed (`/sys/fs/virtiofs/<n>/tag`), sorted.
fn virtiofs_tags() -> Vec<String> {
    let mut tags = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/sys/fs/virtiofs") {
        for e in rd.flatten() {
            if let Ok(t) = std::fs::read_to_string(e.path().join("tag")) {
                tags.push(t.trim().to_owned());
            }
        }
    }
    tags.sort();
    tags
}

/// Log the probed virtiofs devices (waits up to 2 s for all `expected`; the probe is normally done by now).
fn log_virtiofs_devices(expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut tags = virtiofs_tags();
    while tags.len() < expected && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        tags = virtiofs_tags();
    }
    if tags.len() < expected {
        log!("ERROR: only {} of {expected} virtiofs devices probed: {:?}", tags.len(), tags);
    } else {
        log!("virtiofs devices probed ({}): {}", tags.len(), tags.join(" "));
    }
}

/// The value of `key=` on the kernel command line, if present.
fn cmdline_value(cmdline: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    cmdline.split_whitespace().find_map(|t| t.strip_prefix(prefix.as_str())).map(str::to_owned)
}

/// A virtiofs tag the libkrun backend names: the share's own name (`appdata`, `f-<name>`), at most 36 bytes (the virtio-fs
/// limit), lower-case letters, digits and `-`.
fn valid_share_tag(tag: &str) -> bool {
    let b = tag.as_bytes();
    b.len() <= 36
        && b.first().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// The static shares of the libkrun backend: `vmapp.fs=appdata,f-notes` on the command line (SPEC 4, 8.7). `None` means the
/// ordinary layout, one device `vmapp` holding all of them.
fn share_tags() -> Option<Vec<String>> {
    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    let list = cmdline_value(&cmdline, "vmapp.fs")?;
    Some(list.split(',').filter(|t| !t.is_empty()).map(str::to_owned).collect())
}

/// Mounts one virtiofs device per share name at `/host/<name>` on a tmpfs `/host`. Returns whether `/host` is usable.
fn mount_share_tags(names: &[String], nsd: libc::c_ulong) -> bool {
    if let Err(e) = mount("hostshares", "/host", "tmpfs", nsd, Some("mode=0755")) {
        log!("ERROR: cannot mount a tmpfs at /host: {e}; continuing without shares");
        return false;
    }
    for name in names {
        if !valid_share_tag(name) {
            log!("ERROR: ignoring the invalid share name {name:?}");
            continue;
        }
        let target = format!("/host/{name}");
        if let Err(e) = std::fs::create_dir_all(&target) {
            log!("ERROR: cannot create {target}: {e}");
            continue;
        }
        if let Err(e) = mount(name, &target, "virtiofs", nsd, None) {
            log!("ERROR: cannot mount virtiofs '{name}' at {target}: {e}");
        }
    }
    log!("virtiofs shares mounted under /host: {:?}", shares());
    true
}

/// The libkrun backend's virtio-gpu (`vmapp.gpu=1`, SPEC 8.7): the render node must be openable by the core, which runs as
/// uid/gid 1000 with no supplementary groups. Waits for the node (the DRM driver is built in and has probed by now), then
/// gives it to group 1000 with mode 0660. The KMS node `card0` stays root-only: Vulkan needs only the render node. Not fatal:
/// without the node the core simply has no GPU.
fn prepare_gpu(cmdline: &str) {
    if cmdline_value(cmdline, "vmapp.gpu").as_deref() != Some("1") {
        return;
    }
    let node = "/dev/dri/renderD128";
    if let Some(missing) = wait_for(&[node], Duration::from_secs(5)) {
        log!("WARNING: the GPU was requested but {missing} did not appear; the core will have no GPU");
        return;
    }
    use std::os::unix::fs::{chown, PermissionsExt};
    match chown(node, Some(0), Some(appcore::APP_GID)).and_then(|()| std::fs::set_permissions(node, std::fs::Permissions::from_mode(0o660))) {
        Ok(()) => log!("GPU render node {node} is usable by the core (group {})", appcore::APP_GID),
        Err(e) => log!("WARNING: cannot give the core access to {node}: {e}"),
    }
    // The launcher's watchdog (SPEC 8.7) learns from `hello` whether the host's GPU worker still answers.
    gpuprobe::start(vmapp_id());
}

// ---------------------------------------------------------------------------
// runtime grants: slot mounts under /rt/host
// ---------------------------------------------------------------------------

/// Serialises `mount` / `umount` so two grants cannot race on the same mount point.
static GRANT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `^(pick|save)-[0-9]{1,4}$`
fn valid_grant_name(name: &str) -> bool {
    let Some(n) = name.strip_prefix("pick-").or_else(|| name.strip_prefix("save-")) else { return false };
    (1..=4).contains(&n.len()) && n.bytes().all(|c| c.is_ascii_digit())
}

/// Control `mount`: virtiofs tag `vmapp-s<slot>` at `/rt/host/<name>` (nosuid, nodev, read-only if `ro`).
fn host_mount(slot: u64, name: &str, ro: bool) -> Result<(), String> {
    if !valid_grant_name(name) {
        return Err("name must match ^(pick|save)-[0-9]{1,4}$".to_owned());
    }
    if slot >= SLOTS as u64 {
        return Err(format!("slot must be 0..{}", SLOTS - 1));
    }
    let _guard = GRANT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = format!("{HOST_DIR}/{name}");
    match std::fs::create_dir(&target) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(format!("{name} is already mounted")),
        Err(e) => return Err(format!("cannot create {target}: {e}")),
    }
    let flags = libc::MS_NOSUID | libc::MS_NODEV | if ro { libc::MS_RDONLY } else { 0 };
    if let Err(e) = mount(&format!("vmapp-s{slot}"), &target, "virtiofs", flags, None) {
        let _ = std::fs::remove_dir(&target);
        return Err(format!("mount vmapp-s{slot} at {target} failed: {e}"));
    }
    log!("mounted slot {slot} at {target}{}", if ro { " (read-only)" } else { "" });
    Ok(())
}

/// Control `umount`: lazy unmount of `/rt/host/<name>` and removal of the mount point. Idempotent.
fn host_umount(name: &str) -> Result<(), String> {
    if !valid_grant_name(name) {
        return Err("name must match ^(pick|save)-[0-9]{1,4}$".to_owned());
    }
    let _guard = GRANT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = format!("{HOST_DIR}/{name}");
    let c = CString::new(target.as_str()).map_err(|_| "bad name".to_owned())?;
    // SAFETY: umount2 with a valid NUL-terminated path.
    if unsafe { libc::umount2(c.as_ptr(), libc::MNT_DETACH) } != 0 {
        let e = io::Error::last_os_error();
        // Not a mount point / not there: already unmounted.
        if !matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOENT)) {
            return Err(format!("umount {target} failed: {e}"));
        }
    }
    match std::fs::remove_dir(&target) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => log!("cannot remove {target}: {e}"),
    }
    log!("unmounted {target}");
    Ok(())
}

// ---------------------------------------------------------------------------
// vsock
// ---------------------------------------------------------------------------

fn vsock_listen(port: u32) -> io::Result<OwnedFd> {
    // SAFETY: plain socket(2); the descriptor is wrapped immediately.
    let raw = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `raw` is a fresh descriptor we own.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: port,
        svm_cid: libc::VMADDR_CID_ANY,
        svm_zero: [0; 4],
    };
    // SAFETY: `addr` is a valid sockaddr_vm of the stated length.
    let rc = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_vm).cast(),
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: listen(2) on a bound socket.
    if unsafe { libc::listen(fd.as_raw_fd(), 16) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fd)
}

/// `verbose`: log every connection (the network data port has one per tunnel and stays quiet).
fn accept_loop(listener: OwnedFd, name: &'static str, handler: fn(File, u64), verbose: bool) {
    let mut conn_no: u64 = 0;
    loop {
        // SAFETY: accept4 with null address pointers is valid.
        let c = unsafe { libc::accept4(listener.as_raw_fd(), std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
        if c < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted || e.raw_os_error() == Some(libc::ECONNABORTED) {
                continue;
            }
            log!("{name}: accept failed: {e}");
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        conn_no += 1;
        // SAFETY: fresh descriptor from accept4.
        let file = File::from(unsafe { OwnedFd::from_raw_fd(c) });
        let n = conn_no;
        if verbose {
            log!("{name}: connection #{n} opened");
        }
        let spawned = std::thread::Builder::new().name(format!("{name}-{n}")).spawn(move || {
            handler(file, n);
            if verbose {
                log!("{name}: connection #{n} closed");
            }
        });
        if let Err(e) = spawned {
            log!("{name}: cannot start a thread: {e}");
        }
    }
}

enum Line {
    Eof,
    TooLong,
    Text(String),
}

fn read_line(r: &mut BufReader<File>) -> io::Result<Line> {
    let mut buf = Vec::new();
    let n = r.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(Line::Eof);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    } else if buf.len() as u64 > MAX_LINE {
        return Ok(Line::TooLong);
    }
    Ok(Line::Text(String::from_utf8_lossy(&buf).into_owned()))
}

fn send(w: &mut File, reply: &str) -> io::Result<()> {
    let mut out = String::with_capacity(reply.len() + 1);
    out.push_str(reply);
    out.push('\n');
    w.write_all(out.as_bytes())
}

// ---------------------------------------------------------------------------
// control port (1023)
// ---------------------------------------------------------------------------

fn vmapp_id() -> &'static str {
    VMAPP_ID.get().map_or("", |s| s.as_str())
}

fn hello() -> String {
    format!(
        "{{\"ok\":true,\"name\":{},\"version\":{},\"id\":{},\"kernel\":{},\"app\":{{\"files\":{},\"bytes\":{}}},\"core\":{}{}}}",
        json::quote(NAME),
        json::quote(VERSION),
        json::quote(vmapp_id()),
        json::quote(&kernel_release()),
        FILES.load(std::sync::atomic::Ordering::SeqCst),
        BYTES.load(std::sync::atomic::Ordering::SeqCst),
        appcore::hello_json(),
        gpuprobe::hello_member(),
    )
}

fn fail_reply(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", json::quote(msg))
}

fn control_conn(stream: File, _n: u64) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            log!("control: cannot duplicate the socket: {e}");
            return;
        }
    };
    let mut reader = BufReader::new(stream);
    loop {
        let line = match read_line(&mut reader) {
            Ok(Line::Text(l)) => l,
            Ok(Line::Eof) | Err(_) => return,
            Ok(Line::TooLong) => {
                let _ = send(&mut writer, &fail_reply("line too long"));
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Some(req) = json::parse_object(&line) else {
            if send(&mut writer, &fail_reply("bad request")).is_err() {
                return;
            }
            continue;
        };
        let reply = match json::find_str(&req, "op") {
            Some("hello") => {
                log!("control: hello");
                hello()
            }
            Some("start") => {
                log!("control: start");
                match appcore::start(&req, vmapp_id()) {
                    Ok(pid) => format!("{{\"ok\":true,\"pid\":{pid}}}"),
                    Err(e) => {
                        log!("control: start failed: {e}");
                        fail_reply(&e)
                    }
                }
            }
            Some("mount") => {
                let slot = json::find_uint(&req, "slot");
                let name = json::find_str(&req, "name");
                let ro = json::find_bool(&req, "ro").unwrap_or(false);
                match (slot, name) {
                    (Some(slot), Some(name)) => {
                        log!("control: mount slot {slot} as {name}");
                        match host_mount(slot, name, ro) {
                            Ok(()) => "{\"ok\":true}".to_owned(),
                            Err(e) => {
                                log!("control: mount failed: {e}");
                                fail_reply(&e)
                            }
                        }
                    }
                    _ => fail_reply("mount needs slot and name"),
                }
            }
            Some("umount") => match json::find_str(&req, "name") {
                Some(name) => {
                    log!("control: umount {name}");
                    match host_umount(name) {
                        Ok(()) => "{\"ok\":true}".to_owned(),
                        Err(e) => {
                            log!("control: umount failed: {e}");
                            fail_reply(&e)
                        }
                    }
                }
                None => fail_reply("umount needs name"),
            },
            // Host services (SPEC 8.6): the host asks for the loopback listener of a service it started, and takes it away.
            Some(op @ ("service" | "service-stop")) => match json::find_str(&req, "name") {
                Some(name) => {
                    log!("control: {op} {name}");
                    let result = if op == "service" { netproxy::start_service(name) } else { netproxy::stop_service(name) };
                    match result {
                        Ok(()) => "{\"ok\":true}".to_owned(),
                        Err(e) => {
                            log!("control: {op} failed: {e}");
                            fail_reply(&e)
                        }
                    }
                }
                None => fail_reply("service needs a name"),
            },
            Some("shutdown") => {
                log!("control: shutdown requested");
                let _ = send(&mut writer, "{\"ok\":true}");
                // SAFETY: shutdown(2) on our descriptor; lets the peer see the reply and EOF.
                unsafe { libc::shutdown(writer.as_raw_fd(), libc::SHUT_WR) };
                appcore::terminate();
                appcore::drain_output();
                poweroff("shutdown requested by the host");
            }
            Some(_) => fail_reply("unknown op"),
            None => fail_reply("bad request"),
        };
        if send(&mut writer, &reply).is_err() {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// bridge port (1024)
// ---------------------------------------------------------------------------

fn bridge_conn(stream: File, _n: u64) {
    appcore::bridge(stream);
}

// ---------------------------------------------------------------------------
// network proxy (SPEC 8.3): loopback proxy, vsock 1022 (control) and 1025 (data)
// ---------------------------------------------------------------------------

fn start_network_listeners() {
    for (port, name, handler, verbose) in [
        (NETCTL_PORT, "netctl", netproxy::control_conn as fn(File, u64), true),
        (NETDATA_PORT, "netdata", netproxy::data_conn as fn(File, u64), false),
        (PORTFWD_PORT, "portfwd", portfwd::forward_conn as fn(File, u64), false),
    ] {
        match vsock_listen(port) {
            Ok(fd) => {
                let spawned = std::thread::Builder::new().name(name.into()).spawn(move || accept_loop(fd, name, handler, verbose));
                if let Err(e) = spawned {
                    log!("cannot start the {name} listener thread: {e}");
                }
            }
            Err(e) => log!("cannot listen on vsock port {port}: {e}; the app will have no network"),
        }
    }
    netproxy::start_proxy();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    let nsde = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
    // 1. Base mounts.
    mount_logged("devtmpfs", "/dev", "devtmpfs", libc::MS_NOSUID, Some("mode=0755"));
    reopen_console();
    mount_logged("proc", "/proc", "proc", nsde, None);
    mount_logged("sysfs", "/sys", "sysfs", nsde, None);
    mount_logged("tmpfs", "/tmp", "tmpfs", libc::MS_NOSUID | libc::MS_NODEV, Some("mode=1777"));
    log!("version {VERSION} starting");
    bring_up_lo();

    let cmdline = std::fs::read_to_string("/proc/cmdline").unwrap_or_default();
    let id = cmdline
        .split_whitespace()
        .find_map(|t| t.strip_prefix("vmapp.id="))
        .unwrap_or("")
        .to_owned();
    log!("instance id: {}", if id.is_empty() { "(none)" } else { &id });
    let _ = VMAPP_ID.set(id);

    if let Err(e) = setup_root() {
        log!("ERROR: {e}");
        poweroff(&e);
    }
    prepare_gpu(&cmdline);

    // The network listeners come first, so a `hello` on the control port means they are ready too. Without them
    // the app simply has no network (the host then fails to open its channel); that is not fatal.
    start_network_listeners();

    let control = match vsock_listen(CONTROL_PORT) {
        Ok(fd) => fd,
        Err(e) => poweroff(&format!("cannot listen on vsock port {CONTROL_PORT}: {e}")),
    };
    let bridge_l = match vsock_listen(BRIDGE_PORT) {
        Ok(fd) => fd,
        Err(e) => poweroff(&format!("cannot listen on vsock port {BRIDGE_PORT}: {e}")),
    };
    let t1 = std::thread::Builder::new().name("control".into()).spawn(move || accept_loop(control, "control", control_conn, true));
    let t2 = std::thread::Builder::new().name("bridge".into()).spawn(move || accept_loop(bridge_l, "bridge", bridge_conn, true));
    if let Err(e) = t1.and(t2) {
        poweroff(&format!("cannot start listener threads: {e}"));
    }
    log!("ready: control on vsock {CONTROL_PORT}, bridge on vsock {BRIDGE_PORT}");

    // PID 1 duty: reap children (orphans included) forever; the core's exit ends the VM.
    loop {
        let (r, status) = appcore::reap_once();
        if r > 0 {
            if r == appcore::pid() && !appcore::has_exited() {
                let how = appcore::describe_status(status);
                appcore::mark_exited(status);
                appcore::drain_output();
                log!("core (pid {r}) {how}");
                poweroff(&format!("core {how}"));
            }
            continue;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::{cmdline_value, parse_tty_gid, valid_share_tag};

    #[test]
    fn command_line_values_and_share_tags() {
        let line = "console=hvc0 vmapp.id=ab12 vmapp.fs=appdata,f-notes vmapp.gpu=1\n";
        assert_eq!(cmdline_value(line, "vmapp.fs").as_deref(), Some("appdata,f-notes"));
        assert_eq!(cmdline_value(line, "vmapp.gpu").as_deref(), Some("1"));
        assert_eq!(cmdline_value(line, "vmapp.nothing"), None);
        // a key that is only the end of another one is not matched
        assert_eq!(cmdline_value("xvmapp.fs=a", "vmapp.fs"), None);
        assert!(valid_share_tag("appdata") && valid_share_tag("f-export-2"));
        assert!(!valid_share_tag("") && !valid_share_tag("-x") && !valid_share_tag("F-x") && !valid_share_tag("a/b"));
        assert!(!valid_share_tag(&"a".repeat(37)) && valid_share_tag(&"a".repeat(36)));
    }

    #[test]
    fn tty_group_gid_comes_from_etc_group() {
        let debian = "root:x:0:\ndaemon:x:1:\ntty:x:5:\ndisk:x:6:\n";
        assert_eq!(parse_tty_gid(debian), 5);
        assert_eq!(parse_tty_gid("tty:x:42:app,other\n"), 42);
    }

    #[test]
    fn missing_or_odd_tty_group_gives_root() {
        assert_eq!(parse_tty_gid(""), 0);
        assert_eq!(parse_tty_gid("root:x:0:\nttyS:x:9:\n"), 0);
        assert_eq!(parse_tty_gid("tty:x:notanumber:\n"), 0);
        assert_eq!(parse_tty_gid("tty\n"), 0);
    }
}
