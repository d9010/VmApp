// Adapted from agent-vm/host/src/vz.rs (agent-vm commit 8f0c069); set_shares added after
// d9010-native/platform/macos/vm-helper/src/vz.rs.
//
//! Rust FFI + safe wrapper over the Objective-C shim (`src/shim/vz_shim.h`).
//!
//! Ownership rules at the FFI boundary:
//! * Completion contexts are `Box<RawDone>` leaked into the shim and reclaimed by `done_trampoline`;
//!   the shim invokes every completion exactly once.
//! * The event context is leaked for the life of the process on purpose: the framework may deliver
//!   delegate callbacks after the Rust handle is gone.
//! * Descriptors delivered by `connect` are owned by the completion.

use std::ffi::{c_char, c_void, CStr, CString};
use std::mem;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use crate::Error;

mod ffi {
    #![allow(non_camel_case_types, dead_code)]
    use std::ffi::{c_char, c_void};

    pub const ABI_VERSION: u32 = 2;

    pub const OK: i32 = 0;
    pub const STATE_STOPPED: i32 = 0;
    pub const STATE_STARTING: i32 = 1;
    pub const STATE_RUNNING: i32 = 2;
    pub const STATE_STOPPING: i32 = 3;
    pub const EVENT_GUEST_STOPPED: i32 = 1;
    pub const EVENT_STOPPED_WITH_ERROR: i32 = 2;

    #[repr(C)]
    pub struct vmapp_vz_disk {
        pub path: *const c_char,
        pub read_only: i32,
        pub identifier: *const c_char,
    }

    #[repr(C)]
    pub struct vmapp_vz_share {
        pub name: *const c_char,
        pub path: *const c_char,
        pub read_only: i32,
    }

    #[repr(C)]
    pub struct vmapp_vz_fsdev {
        pub tag: *const c_char,
        pub single: i32,
        pub shares: *const vmapp_vz_share,
        pub share_count: usize,
    }

    #[repr(C)]
    pub struct vmapp_vz_vm_spec {
        pub kernel_path: *const c_char,
        pub initramfs_path: *const c_char,
        pub cmdline: *const c_char,
        pub cpu_count: u64,
        pub memory_bytes: u64,
        pub disks: *const vmapp_vz_disk,
        pub disk_count: usize,
        pub fsdevs: *const vmapp_vz_fsdev,
        pub fsdev_count: usize,
        pub console_fd: i32,
    }

    #[repr(C)]
    pub struct vmapp_vz_vm {
        _private: [u8; 0],
    }

    pub type vmapp_vz_event_cb = unsafe extern "C" fn(ctx: *mut c_void, kind: i32, message: *const c_char);
    pub type vmapp_vz_done_cb = unsafe extern "C" fn(ctx: *mut c_void, status: i32, fd: i32, message: *const c_char);

    extern "C" {
        pub fn vmapp_vz_abi_version() -> u32;
        pub fn vmapp_vz_abi_check(spec_size: usize, disk_size: usize, share_size: usize, fsdev_size: usize) -> i32;
        pub fn vmapp_vz_vm_create(
            spec: *const vmapp_vz_vm_spec,
            event_cb: Option<vmapp_vz_event_cb>,
            event_ctx: *mut c_void,
            out: *mut *mut vmapp_vz_vm,
            err: *mut c_char,
            errlen: usize,
        ) -> i32;
        pub fn vmapp_vz_vm_start(vm: *mut vmapp_vz_vm, cb: vmapp_vz_done_cb, ctx: *mut c_void);
        pub fn vmapp_vz_vm_request_stop(vm: *mut vmapp_vz_vm, err: *mut c_char, errlen: usize) -> i32;
        pub fn vmapp_vz_vm_force_stop(vm: *mut vmapp_vz_vm, cb: vmapp_vz_done_cb, ctx: *mut c_void);
        pub fn vmapp_vz_vm_state(vm: *mut vmapp_vz_vm) -> i32;
        pub fn vmapp_vz_vm_connect(
            vm: *mut vmapp_vz_vm,
            port: u32,
            timeout_ms: u32,
            cb: vmapp_vz_done_cb,
            ctx: *mut c_void,
        );
        pub fn vmapp_vz_vm_set_share_for_tag(
            vm: *mut vmapp_vz_vm,
            tag: *const c_char,
            shares: *const vmapp_vz_share,
            count: usize,
            err: *mut c_char,
            errlen: usize,
        ) -> i32;
        pub fn vmapp_vz_vm_release(vm: *mut vmapp_vz_vm);
    }
}

const ERR_BUF: usize = 1024;

type RawDone = Box<dyn FnOnce(i32, i32, String) + Send + 'static>;

/// One named directory in a virtiofs device.
#[derive(Clone, Debug)]
pub struct Share {
    pub name: String,
    pub path: PathBuf,
    pub read_only: bool,
}

/// One virtiofs device: a tag and its share(s). `single` devices expose exactly one folder's contents
/// directly (the share name is ignored); the others expose one sub-folder per share name.
#[derive(Clone, Debug)]
pub struct FsDevice {
    pub tag: String,
    pub single: bool,
    pub shares: Vec<Share>,
}

/// One virtio block device (guest `/dev/vda`, `vdb`, ... in the given order).
#[derive(Clone, Debug)]
pub struct Disk {
    pub path: PathBuf,
    pub read_only: bool,
    /// virtio-blk identifier (at most 20 ASCII bytes).
    pub identifier: Option<String>,
}

/// Everything the shim needs to build the VM.
#[derive(Debug)]
pub struct Spec {
    pub kernel: PathBuf,
    pub initramfs: PathBuf,
    pub cmdline: String,
    pub cpus: u64,
    pub memory_bytes: u64,
    pub fs_devices: Vec<FsDevice>,
    pub disks: Vec<Disk>,
    /// Descriptor receiving the guest console (the shim dups it). -1 = none.
    pub console_fd: i32,
}

#[derive(Clone, Debug)]
pub enum Event {
    GuestStopped,
    StoppedWithError(String),
}

pub type EventSink = Arc<dyn Fn(Event) + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

/// # Safety
/// `p` must be null or point to a NUL-terminated string valid for the call.
unsafe fn cstr_lossy(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
}

fn err_buf_to_string(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

unsafe extern "C" fn done_trampoline(ctx: *mut c_void, status: i32, fd: i32, message: *const c_char) {
    // SAFETY: `ctx` is the `Box<RawDone>` leaked by `leak`; the shim calls each completion once.
    let boxed = Box::from_raw(ctx.cast::<RawDone>());
    let msg = cstr_lossy(message);
    let f: RawDone = *boxed;
    f(status, fd, msg);
}

unsafe extern "C" fn event_trampoline(ctx: *mut c_void, kind: i32, message: *const c_char) {
    // SAFETY: `ctx` is a leaked `Box<EventSink>` that is never freed.
    let sink = &*ctx.cast::<EventSink>();
    let msg = cstr_lossy(message);
    match kind {
        ffi::EVENT_GUEST_STOPPED => sink(Event::GuestStopped),
        ffi::EVENT_STOPPED_WITH_ERROR => sink(Event::StoppedWithError(msg)),
        _ => {}
    }
}

fn cstring(field: &str, bytes: &[u8]) -> Result<CString, Error> {
    CString::new(bytes).map_err(|_| Error::new(format!("{field}: contains NUL")))
}

/// C strings of a share list plus the raw structs pointing into them (keep both alive for the call).
struct RawShares {
    _strings: Vec<(CString, CString, bool)>,
    raw: Vec<ffi::vmapp_vz_share>,
}

fn raw_shares(shares: &[Share]) -> Result<RawShares, Error> {
    let mut strings = Vec::with_capacity(shares.len());
    for s in shares {
        strings.push((
            cstring("share name", s.name.as_bytes())?,
            cstring("share path", s.path.as_os_str().as_bytes())?,
            s.read_only,
        ));
    }
    let raw = strings
        .iter()
        .map(|(n, p, ro)| ffi::vmapp_vz_share { name: n.as_ptr(), path: p.as_ptr(), read_only: i32::from(*ro) })
        .collect();
    Ok(RawShares { _strings: strings, raw })
}

/// Safe handle over one Virtualization.framework VM.
pub struct Vz {
    raw: *mut ffi::vmapp_vz_vm,
}

// SAFETY: the shim serializes every use of the VM on its private dispatch queue; the handle itself is an
// immutable, reference-counted Objective-C object pointer.
unsafe impl Send for Vz {}
unsafe impl Sync for Vz {}

impl Drop for Vz {
    fn drop(&mut self) {
        // SAFETY: `raw` holds the +1 reference returned by vmapp_vz_vm_create; pending blocks keep their own.
        unsafe { ffi::vmapp_vz_vm_release(self.raw) };
    }
}

impl Vz {
    pub fn create(spec: &Spec, events: EventSink) -> Result<Vz, Error> {
        // SAFETY: both functions are pure and take plain integers.
        let (version, mismatch) = unsafe {
            (
                ffi::vmapp_vz_abi_version(),
                ffi::vmapp_vz_abi_check(
                    mem::size_of::<ffi::vmapp_vz_vm_spec>(),
                    mem::size_of::<ffi::vmapp_vz_disk>(),
                    mem::size_of::<ffi::vmapp_vz_share>(),
                    mem::size_of::<ffi::vmapp_vz_fsdev>(),
                ),
            )
        };
        if version != ffi::ABI_VERSION || mismatch != 0 {
            return Err(Error::new(format!("shim ABI mismatch (version {version}, layout check {mismatch})")));
        }

        let kernel = cstring("kernel", spec.kernel.as_os_str().as_bytes())?;
        let initrd = cstring("initramfs", spec.initramfs.as_os_str().as_bytes())?;
        let cmdline = cstring("cmdline", spec.cmdline.as_bytes())?;
        let mut fs_tags = Vec::with_capacity(spec.fs_devices.len());
        let mut fs_shares = Vec::with_capacity(spec.fs_devices.len());
        for d in &spec.fs_devices {
            fs_tags.push(cstring("fs tag", d.tag.as_bytes())?);
            fs_shares.push(raw_shares(&d.shares)?);
        }
        let fsdevs: Vec<ffi::vmapp_vz_fsdev> = spec
            .fs_devices
            .iter()
            .zip(fs_tags.iter().zip(fs_shares.iter()))
            .map(|(d, (t, s))| ffi::vmapp_vz_fsdev {
                tag: t.as_ptr(),
                single: i32::from(d.single),
                shares: s.raw.as_ptr(),
                share_count: s.raw.len(),
            })
            .collect();

        let mut disk_strings = Vec::with_capacity(spec.disks.len());
        for d in &spec.disks {
            let ident = match &d.identifier {
                Some(i) => Some(cstring("disk identifier", i.as_bytes())?),
                None => None,
            };
            disk_strings.push((cstring("disk path", d.path.as_os_str().as_bytes())?, ident, d.read_only));
        }
        let disks: Vec<ffi::vmapp_vz_disk> = disk_strings
            .iter()
            .map(|(p, i, ro)| ffi::vmapp_vz_disk {
                path: p.as_ptr(),
                read_only: i32::from(*ro),
                identifier: i.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            })
            .collect();

        let raw_spec = ffi::vmapp_vz_vm_spec {
            kernel_path: kernel.as_ptr(),
            initramfs_path: initrd.as_ptr(),
            cmdline: cmdline.as_ptr(),
            cpu_count: spec.cpus,
            memory_bytes: spec.memory_bytes,
            disks: if disks.is_empty() { std::ptr::null() } else { disks.as_ptr() },
            disk_count: disks.len(),
            fsdevs: if fsdevs.is_empty() { std::ptr::null() } else { fsdevs.as_ptr() },
            fsdev_count: fsdevs.len(),
            console_fd: spec.console_fd,
        };

        let sink_ctx = Box::into_raw(Box::new(events));
        let mut out: *mut ffi::vmapp_vz_vm = std::ptr::null_mut();
        let mut err = [0 as c_char; ERR_BUF];
        // SAFETY: every pointer in `raw_spec` stays valid for the call; `out` and `err` are valid
        // out-parameters; the event context is leaked on success.
        let status = unsafe {
            ffi::vmapp_vz_vm_create(
                &raw_spec,
                Some(event_trampoline),
                sink_ctx.cast::<c_void>(),
                &mut out,
                err.as_mut_ptr(),
                err.len(),
            )
        };
        if status != ffi::OK || out.is_null() {
            // SAFETY: on failure the shim kept no reference to the event context.
            drop(unsafe { Box::from_raw(sink_ctx) });
            let msg = err_buf_to_string(&err);
            return Err(Error::new(if msg.is_empty() { format!("vm create failed (status {status})") } else { msg }));
        }
        Ok(Vz { raw: out })
    }

    fn leak(done: RawDone) -> *mut c_void {
        Box::into_raw(Box::new(done)).cast::<c_void>()
    }

    /// Starts the VM and waits for the completion.
    pub fn start_sync(&self) -> Result<(), Error> {
        let (tx, rx) = mpsc::channel();
        let ctx = Self::leak(Box::new(move |status, fd, msg| {
            close_fd(fd);
            let _ = tx.send(if status == ffi::OK { Ok(()) } else { Err(Error::new(format!("start failed: {msg}"))) });
        }));
        // SAFETY: valid VM handle; `ctx` is reclaimed by done_trampoline.
        unsafe { ffi::vmapp_vz_vm_start(self.raw, done_trampoline, ctx) };
        rx.recv_timeout(Duration::from_secs(60)).map_err(|_| Error::new("start timed out"))?
    }

    /// Destructive stop; waits (up to `timeout`) for completion.
    pub fn force_stop_sync(&self, timeout: Duration) -> Result<(), Error> {
        let (tx, rx) = mpsc::channel();
        let ctx = Self::leak(Box::new(move |status, fd, msg| {
            close_fd(fd);
            let _ = tx.send(if status == ffi::OK { Ok(()) } else { Err(Error::new(format!("stop failed: {msg}"))) });
        }));
        // SAFETY: as for start.
        unsafe { ffi::vmapp_vz_vm_force_stop(self.raw, done_trampoline, ctx) };
        rx.recv_timeout(timeout).map_err(|_| Error::new("force stop timed out"))?
    }

    /// Asks the guest to power off through the framework (ACPI-style); needs guest cooperation.
    pub fn request_stop(&self) -> Result<(), Error> {
        let mut err = [0 as c_char; ERR_BUF];
        // SAFETY: valid VM handle and error buffer.
        let status = unsafe { ffi::vmapp_vz_vm_request_stop(self.raw, err.as_mut_ptr(), err.len()) };
        if status == ffi::OK {
            Ok(())
        } else {
            Err(Error::new(err_buf_to_string(&err)))
        }
    }

    pub fn state(&self) -> State {
        // SAFETY: valid VM handle.
        match unsafe { ffi::vmapp_vz_vm_state(self.raw) } {
            ffi::STATE_STOPPED => State::Stopped,
            ffi::STATE_STARTING => State::Starting,
            ffi::STATE_RUNNING => State::Running,
            ffi::STATE_STOPPING => State::Stopping,
            _ => State::Error,
        }
    }

    /// Replaces the share of the running virtiofs device `tag` (all-or-nothing); every other device keeps
    /// its share untouched. A single-directory device takes exactly one share.
    pub fn set_share_for_tag(&self, tag: &str, shares: &[Share]) -> Result<(), Error> {
        let raw = raw_shares(shares)?;
        let tag_c = cstring("fs tag", tag.as_bytes())?;
        let mut err = [0 as c_char; ERR_BUF];
        // SAFETY: `raw`, `tag_c` and their strings outlive the (synchronous) call.
        let status = unsafe {
            ffi::vmapp_vz_vm_set_share_for_tag(
                self.raw,
                tag_c.as_ptr(),
                raw.raw.as_ptr(),
                raw.raw.len(),
                err.as_mut_ptr(),
                err.len(),
            )
        };
        if status == ffi::OK {
            Ok(())
        } else {
            let msg = err_buf_to_string(&err);
            Err(Error::new(if msg.is_empty() { format!("set_shares failed (status {status})") } else { msg }))
        }
    }

    /// Connects to a guest vsock port and returns the connected descriptor.
    pub fn connect_sync(&self, port: u32, timeout: Duration) -> Result<OwnedFd, Error> {
        let (tx, rx) = mpsc::channel();
        let ctx = Self::leak(Box::new(move |status, fd, msg| {
            if status == ffi::OK && fd >= 0 {
                // SAFETY: on success the shim hands over a fresh duplicate that nobody else owns.
                let _ = tx.send(Ok(unsafe { OwnedFd::from_raw_fd(fd) }));
            } else {
                close_fd(fd);
                let _ = tx.send(Err(Error::new(format!("vsock connect to port {port} failed: {msg}"))));
            }
        }));
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: as for start.
        unsafe { ffi::vmapp_vz_vm_connect(self.raw, port, ms, done_trampoline, ctx) };
        rx.recv_timeout(timeout + Duration::from_secs(5))
            .map_err(|_| Error::new(format!("vsock connect to port {port} timed out")))?
    }
}

fn close_fd(fd: i32) {
    if fd >= 0 {
        // SAFETY: a descriptor delivered to a completion that does not expect one is ours to close.
        drop(unsafe { OwnedFd::from_raw_fd(fd) });
    }
}
