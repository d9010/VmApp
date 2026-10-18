/*
 * Adapted from agent-vm/host/src/shim/vz_shim.h (agent-vm commit 8f0c069), which was adapted from
 * d9010-native/platform/macos/vm-helper. vmapp_vz_vm_set_shares is re-added from d9010-native's
 * d9010_vz_vm_set_shares.
 *
 * vz_shim.h -- narrow C API over Apple Virtualization.framework.
 *
 * Scope: one Linux guest per host process with exactly
 *   - VZLinuxBootLoader (uncompressed arm64 kernel Image + initramfs + cmdline)
 *   - VZGenericPlatformConfiguration
 *   - N x VZVirtioBlockDeviceConfiguration (VZDiskImageStorageDeviceAttachment)
 *   - VZVirtioSocketDeviceConfiguration
 *   - any number of VZVirtioFileSystemDeviceConfiguration devices, each with its own tag and either a
 *     VZMultipleDirectoryShare (the guest sees one folder per share name) or a VZSingleDirectoryShare (the
 *     guest sees the folder's contents directly). The share of one device (looked up by tag) can be replaced
 *     while the VM runs without touching the other devices.
 *   - VZVirtioConsoleDeviceSerialPortConfiguration (output only, to a file handle)
 *   - VZVirtioEntropyDeviceConfiguration
 *   - VZVirtioTraditionalMemoryBalloonDeviceConfiguration
 * and NO network, graphics, keyboard, pointing, audio or USB device. The shim
 * asserts that after building the configuration.
 *
 * Threading: every Virtualization.framework call happens on one private serial
 * dispatch queue. Completion handlers and event callbacks are invoked on that
 * queue (or, for early failures, on the calling thread BEFORE the function
 * returns); they must be short and must not block. Calling the synchronous entry
 * points (request_stop, state, set_shares) from inside a callback is supported
 * (re-entrancy on the VM queue is detected). No main run loop is needed.
 *
 * Exceptions: no Objective-C exception ever crosses this boundary. Every entry
 * point (and every block it schedules) catches NSException and converts it to
 * VMAPP_VZ_EXCEPTION.
 *
 * Strings passed to callbacks are valid only for the duration of the call.
 * "err"/"errlen" out-parameters receive a NUL-terminated UTF-8 message
 * (truncated to errlen - 1 bytes; may be cut inside a multi-byte sequence).
 */
#ifndef VMAPP_VZ_SHIM_H
#define VMAPP_VZ_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VMAPP_VZ_ABI_VERSION 2u

/* Status codes. Mirrored by src/vz.rs. */
enum vmapp_vz_status {
    VMAPP_VZ_OK = 0,
    VMAPP_VZ_UNSUPPORTED = 1,    /* VZVirtualMachine.isSupported == NO */
    VMAPP_VZ_ENTITLEMENT = 2,    /* com.apple.security.virtualization missing */
    VMAPP_VZ_INVALID_CONFIG = 3, /* configuration rejected by validation */
    VMAPP_VZ_RESOURCE_LIMIT = 4, /* cpu / memory outside the framework limits */
    VMAPP_VZ_BAD_STATE = 5,      /* operation invalid in the current VM state */
    VMAPP_VZ_START_FAILED = 6,
    VMAPP_VZ_STOP_FAILED = 7,
    VMAPP_VZ_VSOCK_FAILED = 8,
    VMAPP_VZ_SHARES_FAILED = 9,  /* the virtiofs device could not be updated */
    VMAPP_VZ_EXCEPTION = 10,     /* an Objective-C exception was caught */
    VMAPP_VZ_INTERNAL = 11
};

/* VM states (the framework's pause/save/restore states are never entered). */
enum vmapp_vz_state {
    VMAPP_VZ_STATE_STOPPED = 0,
    VMAPP_VZ_STATE_STARTING = 1,
    VMAPP_VZ_STATE_RUNNING = 2,
    VMAPP_VZ_STATE_STOPPING = 3,
    VMAPP_VZ_STATE_ERROR = 4
};

/* Asynchronous VM events (delegate callbacks). */
enum vmapp_vz_event_kind {
    VMAPP_VZ_EVENT_GUEST_STOPPED = 1,      /* guestDidStopVirtualMachine: */
    VMAPP_VZ_EVENT_STOPPED_WITH_ERROR = 2  /* virtualMachine:didStopWithError: */
};

typedef struct {
    const char *path;
    int32_t read_only;
    const char *identifier; /* virtio block device id (ASCII, <= 20 bytes) or NULL */
} vmapp_vz_disk;

typedef struct {
    const char *name; /* directory name inside the share (what the guest sees) */
    const char *path; /* absolute host directory */
    int32_t read_only;
} vmapp_vz_share;

/* One virtiofs device. single == 0: a multiple-directory share (share_count >= 1, one folder per name).
 * single != 0: a single-directory share (share_count == 1, the name is ignored). */
typedef struct {
    const char *tag;
    int32_t single;
    const vmapp_vz_share *shares;
    size_t share_count;
} vmapp_vz_fsdev;

typedef struct {
    const char *kernel_path;
    const char *initramfs_path;
    const char *cmdline;
    uint64_t cpu_count;
    uint64_t memory_bytes;
    const vmapp_vz_disk *disks;
    size_t disk_count;
    const vmapp_vz_fsdev *fsdevs;  /* may be NULL when fsdev_count == 0 */
    size_t fsdev_count;
    /* Write end of a pipe/file receiving the guest console. The shim dup()s it;
     * the caller keeps (and should close) its own descriptor. -1 = no console. */
    int32_t console_fd;
} vmapp_vz_vm_spec;

typedef struct vmapp_vz_vm vmapp_vz_vm; /* opaque, reference counted */

typedef void (*vmapp_vz_event_cb)(void *ctx, int32_t kind, const char *message);
/* Completion of an asynchronous operation. Invoked exactly once per call.
 * fd is only meaningful for connect (a close-on-exec descriptor owned by the
 * callee) and is -1 otherwise. */
typedef void (*vmapp_vz_done_cb)(void *ctx, int32_t status, int32_t fd, const char *message);

/* ABI self-check: returns 0 when the caller's struct sizes match this header. */
uint32_t vmapp_vz_abi_version(void);
int32_t vmapp_vz_abi_check(size_t spec_size, size_t disk_size, size_t share_size, size_t fsdev_size);

/* Build + validate (-validateWithError:) the configuration and create the VM
 * (state STOPPED). On success *out holds a +1 reference released with
 * vmapp_vz_vm_release. event_cb/event_ctx stay registered for the VM's life
 * (event_ctx must outlive every callback; the host leaks it on purpose). */
int32_t vmapp_vz_vm_create(const vmapp_vz_vm_spec *spec, vmapp_vz_event_cb event_cb, void *event_ctx,
                           vmapp_vz_vm **out, char *err, size_t errlen);

void vmapp_vz_vm_start(vmapp_vz_vm *vm, vmapp_vz_done_cb cb, void *ctx);
/* Ask the guest to power off (guest cooperation required). Synchronous. */
int32_t vmapp_vz_vm_request_stop(vmapp_vz_vm *vm, char *err, size_t errlen);
/* Destructive stop. Idempotent: already stopped -> OK. Deferred until a start in
 * flight completes. */
void vmapp_vz_vm_force_stop(vmapp_vz_vm *vm, vmapp_vz_done_cb cb, void *ctx);
int32_t vmapp_vz_vm_state(vmapp_vz_vm *vm);
/* Connect to a guest virtio-socket port. On success the callback receives a
 * dup()ed, close-on-exec descriptor; the framework's own descriptor is closed.
 * A connection that completes after timeout_ms is closed and never delivered. */
void vmapp_vz_vm_connect(vmapp_vz_vm *vm, uint32_t port, uint32_t timeout_ms, vmapp_vz_done_cb cb, void *ctx);
/* Replace the share of the running virtiofs device with this tag (all-or-nothing); the other devices are
 * untouched. A single-directory device takes exactly one share (its name is ignored). Synchronous. */
int32_t vmapp_vz_vm_set_share_for_tag(vmapp_vz_vm *vm, const char *tag, const vmapp_vz_share *shares, size_t count,
                                      char *err, size_t errlen);
void vmapp_vz_vm_release(vmapp_vz_vm *vm);

#ifdef __cplusplus
}
#endif

#endif /* VMAPP_VZ_SHIM_H */
