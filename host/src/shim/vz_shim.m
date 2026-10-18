/*
 * Adapted from agent-vm/host/src/shim/vz_shim.m (agent-vm commit 8f0c069), which was adapted from
 * d9010-native/platform/macos/vm-helper. vmapp_vz_vm_set_shares is re-added from d9010-native's
 * d9010_vz_vm_set_shares.
 *
 * vz_shim.m -- Objective-C (ARC) implementation of the narrow C API in vz_shim.h.
 *
 * Rules enforced here (see the header for the contract):
 *   1. Every Virtualization.framework call happens on the VM's private serial queue.
 *   2. No Objective-C exception escapes: every entry point and every block it
 *      schedules is wrapped in @try/@catch and reported as VMAPP_VZ_EXCEPTION.
 *   3. Completion callbacks are invoked exactly once.
 *   4. The configuration contains no network, graphics, keyboard, pointing,
 *      audio or USB device; this is asserted before the VM is created.
 */
#import <Foundation/Foundation.h>
#import <Security/SecTask.h>
#import <Virtualization/Virtualization.h>

#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <string.h>
#include <unistd.h>

#include "vz_shim.h"

#define VMAPP_ENTITLEMENT_NAME "com.apple.security.virtualization"
#define VMAPP_MIB (1024ull * 1024ull)

/* Address of this object marks "currently running on the VM queue". */
static char kVmQueueKey;

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

static void set_err(char *buf, size_t len, NSString *msg) {
    if (buf == NULL || len == 0) {
        return;
    }
    const char *u = msg.UTF8String;
    strlcpy(buf, u != NULL ? u : "", len);
}

static NSString *describe_error(NSError *e) {
    if (e == nil) {
        return @"unknown error";
    }
    NSMutableString *s = [NSMutableString stringWithString:e.localizedDescription ?: @"(no description)"];
    NSString *reason = e.localizedFailureReason;
    if (reason.length > 0) {
        [s appendFormat:@": %@", reason];
    }
    id under = e.userInfo[NSUnderlyingErrorKey];
    if ([under isKindOfClass:[NSError class]]) {
        [s appendFormat:@" (underlying: %@)", ((NSError *)under).localizedDescription];
    }
    [s appendFormat:@" [%@:%ld]", e.domain, (long)e.code];
    return s;
}

static NSString *describe_exception(NSException *e) {
    return [NSString stringWithFormat:@"Objective-C exception %@: %@", e.name, e.reason ?: @"(no reason)"];
}

static void deliver(vmapp_vz_done_cb cb, void *ctx, int32_t status, int fd, NSString *msg) {
    const char *u = msg.UTF8String;
    cb(ctx, status, fd, u != NULL ? u : "");
}

static int32_t map_state(VZVirtualMachineState s) {
    switch (s) {
    case VZVirtualMachineStateStopped:
        return VMAPP_VZ_STATE_STOPPED;
    case VZVirtualMachineStateRunning:
        return VMAPP_VZ_STATE_RUNNING;
    case VZVirtualMachineStateStarting:
        return VMAPP_VZ_STATE_STARTING;
    case VZVirtualMachineStateStopping:
        return VMAPP_VZ_STATE_STOPPING;
    case VZVirtualMachineStateError:
        return VMAPP_VZ_STATE_ERROR;
    default:
        /* Paused/pausing/resuming/saving/restoring are never entered: this host
         * never calls those APIs. Anything else is unexpected -> error. */
        return VMAPP_VZ_STATE_ERROR;
    }
}

/* 1 = entitlement present, 0 = absent, -1 = could not be determined. */
static int entitlement_state(void) {
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    if (task == NULL) {
        return -1;
    }
    CFStringRef name = CFStringCreateWithCString(kCFAllocatorDefault, VMAPP_ENTITLEMENT_NAME, kCFStringEncodingUTF8);
    CFErrorRef cferr = NULL;
    CFTypeRef value = (name != NULL) ? SecTaskCopyValueForEntitlement(task, name, &cferr) : NULL;
    int result;
    if (value != NULL) {
        result = (CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value)) ? 1 : 0;
        CFRelease(value);
    } else if (cferr != NULL) {
        result = -1;
        CFRelease(cferr);
    } else {
        result = (name != NULL) ? 0 : -1;
    }
    if (name != NULL) {
        CFRelease(name);
    }
    CFRelease(task);
    return result;
}

/* Exactly-once latch (connect completion vs. its timeout). */
@interface VmappOnce : NSObject
- (BOOL)fire;
@end

@implementation VmappOnce {
    atomic_bool _fired;
}
- (BOOL)fire {
    return !atomic_exchange(&_fired, true);
}
@end

/* ------------------------------------------------------------------------- */
/* VM wrapper                                                                 */
/* ------------------------------------------------------------------------- */

@interface VmappVm : NSObject <VZVirtualMachineDelegate> {
@public
    vmapp_vz_event_cb _eventCb;
    void *_eventCtx;
}
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) VZVirtualMachine *vm;
/* tag -> @(single) for every virtiofs device in the configuration (immutable after create). */
@property(nonatomic, strong) NSDictionary<NSString *, NSNumber *> *fsKinds;
/* Confined to `queue`: */
@property(nonatomic) BOOL starting;
@property(nonatomic, strong) NSMutableArray<void (^)(void)> *afterStart;

- (void)runSync:(void (^)(void))block;
- (void)forceStopWithCb:(vmapp_vz_done_cb)cb ctx:(void *)ctx attempt:(int)attempt;
@end

@implementation VmappVm

- (instancetype)init {
    self = [super init];
    if (self) {
        _afterStart = [NSMutableArray array];
    }
    return self;
}

/* Run `block` on the VM queue and wait; runs inline when already on that queue so
 * synchronous entry points may be used from inside callbacks. */
- (void)runSync:(void (^)(void))block {
    if (dispatch_get_specific(&kVmQueueKey) == &kVmQueueKey) {
        block();
    } else {
        dispatch_sync(self.queue, block);
    }
}

- (void)emit:(int32_t)kind message:(NSString *)message {
    if (_eventCb != NULL) {
        const char *u = message.UTF8String;
        _eventCb(_eventCtx, kind, u != NULL ? u : "");
    }
}

/* VZVirtualMachineDelegate (invoked on the VM queue). */
- (void)guestDidStopVirtualMachine:(VZVirtualMachine *)virtualMachine {
    @autoreleasepool {
        @try {
            [self emit:VMAPP_VZ_EVENT_GUEST_STOPPED message:@"guest stopped the virtual machine"];
        } @catch (NSException *e) {
        }
    }
}

- (void)virtualMachine:(VZVirtualMachine *)virtualMachine didStopWithError:(NSError *)error {
    @autoreleasepool {
        @try {
            [self emit:VMAPP_VZ_EVENT_STOPPED_WITH_ERROR message:describe_error(error)];
        } @catch (NSException *e) {
        }
    }
}

/* Queue-confined. */
- (void)forceStopWithCb:(vmapp_vz_done_cb)cb ctx:(void *)ctx attempt:(int)attempt {
    VZVirtualMachineState st = self.vm.state;
    if (st == VZVirtualMachineStateStopped || st == VZVirtualMachineStateError) {
        deliver(cb, ctx, VMAPP_VZ_OK, -1, @"already stopped");
        return;
    }
    if (self.starting) {
        /* A start is in flight and cannot be cancelled: stop as soon as it completes. */
        __weak VmappVm *weak_self = self;
        [self.afterStart addObject:^{
            VmappVm *strong_self = weak_self;
            [strong_self forceStopWithCb:cb ctx:ctx attempt:attempt];
        }];
        return;
    }
    if (self.vm.canStop) {
        [self.vm stopWithCompletionHandler:^(NSError *error) {
            @autoreleasepool {
                int32_t status = VMAPP_VZ_OK;
                NSString *msg = nil;
                if (error != nil) {
                    status = VMAPP_VZ_STOP_FAILED;
                    msg = describe_error(error);
                }
                deliver(cb, ctx, status, -1, msg);
            }
        }];
        return;
    }
    if (st == VZVirtualMachineStateStopping && attempt < 100) {
        /* A stop is already in progress: poll for its end (max ~10 s). */
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), self.queue, ^{
            @autoreleasepool {
                @try {
                    [self forceStopWithCb:cb ctx:ctx attempt:attempt + 1];
                } @catch (NSException *e) {
                    deliver(cb, ctx, VMAPP_VZ_EXCEPTION, -1, describe_exception(e));
                }
            }
        });
        return;
    }
    deliver(cb, ctx, VMAPP_VZ_BAD_STATE, -1,
            [NSString stringWithFormat:@"virtual machine cannot be stopped in state %ld", (long)st]);
}

@end

/* ------------------------------------------------------------------------- */
/* Configuration                                                              */
/* ------------------------------------------------------------------------- */

/* A single-directory share from exactly one entry (its name is ignored). */
static VZSingleDirectoryShare *make_single_share(const vmapp_vz_share *shares, size_t count, NSString **msg) {
    if (count != 1 || shares == NULL || shares[0].path == NULL) {
        *msg = @"a single-directory share needs exactly one folder";
        return nil;
    }
    NSString *path = [NSString stringWithUTF8String:shares[0].path];
    if (path == nil) {
        *msg = @"share path is not valid UTF-8";
        return nil;
    }
    NSURL *url = [NSURL fileURLWithPath:path isDirectory:YES];
    VZSharedDirectory *dir = [[VZSharedDirectory alloc] initWithURL:url readOnly:(shares[0].read_only != 0)];
    return [[VZSingleDirectoryShare alloc] initWithDirectory:dir];
}

static VZMultipleDirectoryShare *make_share(const vmapp_vz_share *shares, size_t count, NSString **msg) {
    NSMutableDictionary<NSString *, VZSharedDirectory *> *dirs = [NSMutableDictionary dictionaryWithCapacity:count];
    for (size_t i = 0; i < count; i++) {
        if (shares[i].name == NULL || shares[i].path == NULL) {
            *msg = @"share with null name or path";
            return nil;
        }
        NSString *name = [NSString stringWithUTF8String:shares[i].name];
        NSString *path = [NSString stringWithUTF8String:shares[i].path];
        if (name == nil || path == nil) {
            *msg = @"share name or path is not valid UTF-8";
            return nil;
        }
        NSError *err = nil;
        if (![VZMultipleDirectoryShare validateName:name error:&err]) {
            *msg = [NSString stringWithFormat:@"invalid share name: %@", describe_error(err)];
            return nil;
        }
        if (dirs[name] != nil) {
            *msg = @"duplicate share name";
            return nil;
        }
        NSURL *url = [NSURL fileURLWithPath:path isDirectory:YES];
        dirs[name] = [[VZSharedDirectory alloc] initWithURL:url readOnly:(shares[i].read_only != 0)];
    }
    return [[VZMultipleDirectoryShare alloc] initWithDirectories:dirs];
}

/* The device classes this host must never configure. */
static BOOL assert_minimal_devices(VZVirtualMachineConfiguration *cfg, NSString **msg) {
    NSMutableArray<NSString *> *bad = [NSMutableArray array];
    if (cfg.networkDevices.count > 0) {
        [bad addObject:@"network"];
    }
    if (cfg.graphicsDevices.count > 0) {
        [bad addObject:@"graphics"];
    }
    if (cfg.keyboards.count > 0) {
        [bad addObject:@"keyboard"];
    }
    if (cfg.pointingDevices.count > 0) {
        [bad addObject:@"pointing"];
    }
    if (cfg.audioDevices.count > 0) {
        [bad addObject:@"audio"];
    }
    /* usbControllers exists from macOS 15; a selector probe avoids @available, whose runtime
     * support (__isPlatformVersionAtLeast) is not part of what the Rust link pulls in. */
    SEL usb = NSSelectorFromString(@"usbControllers");
    if ([cfg respondsToSelector:usb]) {
        id controllers = [cfg valueForKey:@"usbControllers"];
        if ([controllers isKindOfClass:[NSArray class]] && ((NSArray *)controllers).count > 0) {
            [bad addObject:@"usb"];
        }
    }
    if (bad.count > 0) {
        *msg = [NSString stringWithFormat:@"configuration contains forbidden devices: %@",
                                          [bad componentsJoinedByString:@", "]];
        return NO;
    }
    return YES;
}

/* Builds (but does not validate) the configuration. On failure returns nil and fills the
 * status and message out-parameters. */
static VZVirtualMachineConfiguration *build_config(const vmapp_vz_vm_spec *s, int32_t *status, NSString **msg,
                                                   NSDictionary<NSString *, NSNumber *> **kindsOut) {
    if (s == NULL || s->kernel_path == NULL || s->initramfs_path == NULL || s->cmdline == NULL ||
        (s->fsdev_count > 0 && s->fsdevs == NULL) || (s->disk_count > 0 && s->disks == NULL)) {
        *status = VMAPP_VZ_INVALID_CONFIG;
        *msg = @"incomplete virtual machine specification";
        return nil;
    }

    /* CPU / memory against the framework's limits. */
    uint64_t min_cpu = VZVirtualMachineConfiguration.minimumAllowedCPUCount;
    uint64_t max_cpu = VZVirtualMachineConfiguration.maximumAllowedCPUCount;
    uint64_t min_mem = VZVirtualMachineConfiguration.minimumAllowedMemorySize;
    uint64_t max_mem = VZVirtualMachineConfiguration.maximumAllowedMemorySize;
    if (s->cpu_count < min_cpu || s->cpu_count > max_cpu) {
        *status = VMAPP_VZ_RESOURCE_LIMIT;
        *msg = [NSString stringWithFormat:@"cpu count %llu outside the framework limits [%llu, %llu]",
                                          (unsigned long long)s->cpu_count, (unsigned long long)min_cpu,
                                          (unsigned long long)max_cpu];
        return nil;
    }
    if (s->memory_bytes < min_mem || s->memory_bytes > max_mem || (s->memory_bytes % VMAPP_MIB) != 0) {
        *status = VMAPP_VZ_RESOURCE_LIMIT;
        *msg = [NSString stringWithFormat:@"memory %llu MiB outside the framework limits [%llu, %llu] MiB (or not a "
                                          @"whole number of MiB)",
                                          (unsigned long long)(s->memory_bytes / VMAPP_MIB),
                                          (unsigned long long)(min_mem / VMAPP_MIB),
                                          (unsigned long long)(max_mem / VMAPP_MIB)];
        return nil;
    }

    VZVirtualMachineConfiguration *cfg = [[VZVirtualMachineConfiguration alloc] init];
    cfg.CPUCount = (NSUInteger)s->cpu_count;
    cfg.memorySize = s->memory_bytes;
    cfg.platform = [[VZGenericPlatformConfiguration alloc] init];

    /* Boot loader: uncompressed arm64 Image + initramfs + command line. */
    NSString *kernel = [NSString stringWithUTF8String:s->kernel_path];
    NSString *initrd = [NSString stringWithUTF8String:s->initramfs_path];
    NSString *cmdline = [NSString stringWithUTF8String:s->cmdline];
    if (kernel == nil || initrd == nil || cmdline == nil) {
        *status = VMAPP_VZ_INVALID_CONFIG;
        *msg = @"kernel path, initramfs path or command line is not valid UTF-8";
        return nil;
    }
    VZLinuxBootLoader *boot = [[VZLinuxBootLoader alloc] initWithKernelURL:[NSURL fileURLWithPath:kernel
                                                                                       isDirectory:NO]];
    boot.initialRamdiskURL = [NSURL fileURLWithPath:initrd isDirectory:NO];
    boot.commandLine = cmdline;
    cfg.bootLoader = boot;

    /* Block devices, in the given order (vda, vdb, ...). */
    NSMutableArray<VZStorageDeviceConfiguration *> *storage = [NSMutableArray array];
    for (size_t i = 0; i < s->disk_count; i++) {
        const vmapp_vz_disk *d = &s->disks[i];
        NSString *path = d->path != NULL ? [NSString stringWithUTF8String:d->path] : nil;
        if (path == nil) {
            *status = VMAPP_VZ_INVALID_CONFIG;
            *msg = [NSString stringWithFormat:@"disk %zu has a missing or non-UTF-8 path", i];
            return nil;
        }
        NSError *err = nil;
        BOOL ro = d->read_only != 0;
        VZDiskImageStorageDeviceAttachment *att =
            [[VZDiskImageStorageDeviceAttachment alloc] initWithURL:[NSURL fileURLWithPath:path isDirectory:NO]
                                                           readOnly:ro
                                                        cachingMode:VZDiskImageCachingModeAutomatic
                                                synchronizationMode:VZDiskImageSynchronizationModeFull
                                                              error:&err];
        if (att == nil) {
            *status = VMAPP_VZ_INVALID_CONFIG;
            *msg = [NSString stringWithFormat:@"disk %zu attachment failed: %@", i, describe_error(err)];
            return nil;
        }
        VZVirtioBlockDeviceConfiguration *blk = [[VZVirtioBlockDeviceConfiguration alloc] initWithAttachment:att];
        if (d->identifier != NULL) {
            NSString *ident = [NSString stringWithUTF8String:d->identifier];
            NSError *ierr = nil;
            if (ident == nil || ![VZVirtioBlockDeviceConfiguration validateBlockDeviceIdentifier:ident error:&ierr]) {
                *status = VMAPP_VZ_INVALID_CONFIG;
                *msg = [NSString stringWithFormat:@"disk %zu identifier rejected: %@", i, describe_error(ierr)];
                return nil;
            }
            blk.blockDeviceIdentifier = ident;
        }
        [storage addObject:blk];
    }
    cfg.storageDevices = storage;

    /* Virtio socket (control + bridge). */
    cfg.socketDevices = @[ [[VZVirtioSocketDeviceConfiguration alloc] init] ];

    /* VirtioFS devices, each with its own tag and share (multi- or single-directory). */
    if (s->fsdev_count > 0) {
        NSMutableArray<VZDirectorySharingDeviceConfiguration *> *fsdevs = [NSMutableArray array];
        NSMutableDictionary<NSString *, NSNumber *> *kinds = [NSMutableDictionary dictionary];
        for (size_t i = 0; i < s->fsdev_count; i++) {
            const vmapp_vz_fsdev *d = &s->fsdevs[i];
            NSString *tag = d->tag != NULL ? [NSString stringWithUTF8String:d->tag] : nil;
            NSError *terr = nil;
            if (tag == nil || ![VZVirtioFileSystemDeviceConfiguration validateTag:tag error:&terr]) {
                *status = VMAPP_VZ_INVALID_CONFIG;
                *msg = [NSString stringWithFormat:@"virtiofs tag rejected: %@", describe_error(terr)];
                return nil;
            }
            if (kinds[tag] != nil) {
                *status = VMAPP_VZ_INVALID_CONFIG;
                *msg = [NSString stringWithFormat:@"duplicate virtiofs tag %@", tag];
                return nil;
            }
            VZVirtioFileSystemDeviceConfiguration *fs = [[VZVirtioFileSystemDeviceConfiguration alloc] initWithTag:tag];
            NSString *share_msg = nil;
            VZDirectoryShare *share = d->single != 0 ? (VZDirectoryShare *)make_single_share(d->shares, d->share_count, &share_msg)
                                                     : (VZDirectoryShare *)make_share(d->shares, d->share_count, &share_msg);
            if (share == nil) {
                *status = VMAPP_VZ_INVALID_CONFIG;
                *msg = share_msg ?: @"share construction failed";
                return nil;
            }
            fs.share = share;
            kinds[tag] = @(d->single != 0);
            [fsdevs addObject:fs];
        }
        cfg.directorySharingDevices = fsdevs;
        *kindsOut = kinds;
    }

    /* Console: guest -> host only. No reading handle, so nothing can be typed into
     * the guest; diagnostic output only, never a management shell. */
    if (s->console_fd >= 0) {
        int cfd = fcntl(s->console_fd, F_DUPFD_CLOEXEC, 3);
        if (cfd < 0) {
            *status = VMAPP_VZ_INVALID_CONFIG;
            *msg = @"console descriptor is not valid";
            return nil;
        }
        NSFileHandle *fh = [[NSFileHandle alloc] initWithFileDescriptor:cfd closeOnDealloc:YES];
        VZVirtioConsoleDeviceSerialPortConfiguration *port = [[VZVirtioConsoleDeviceSerialPortConfiguration alloc] init];
        port.attachment = [[VZFileHandleSerialPortAttachment alloc] initWithFileHandleForReading:nil
                                                                            fileHandleForWriting:fh];
        cfg.serialPorts = @[ port ];
    }

    cfg.entropyDevices = @[ [[VZVirtioEntropyDeviceConfiguration alloc] init] ];
    cfg.memoryBalloonDevices = @[ [[VZVirtioTraditionalMemoryBalloonDeviceConfiguration alloc] init] ];
    return cfg;
}

/* ------------------------------------------------------------------------- */
/* Public C API                                                               */
/* ------------------------------------------------------------------------- */

uint32_t vmapp_vz_abi_version(void) {
    return VMAPP_VZ_ABI_VERSION;
}

int32_t vmapp_vz_abi_check(size_t spec_size, size_t disk_size, size_t share_size, size_t fsdev_size) {
    if (spec_size != sizeof(vmapp_vz_vm_spec) || disk_size != sizeof(vmapp_vz_disk) ||
        share_size != sizeof(vmapp_vz_share) || fsdev_size != sizeof(vmapp_vz_fsdev)) {
        return 1;
    }
    return 0;
}

int32_t vmapp_vz_vm_create(const vmapp_vz_vm_spec *spec, vmapp_vz_event_cb event_cb, void *event_ctx,
                           vmapp_vz_vm **out, char *err, size_t errlen) {
    if (out == NULL) {
        set_err(err, errlen, @"null output pointer");
        return VMAPP_VZ_INTERNAL;
    }
    *out = NULL;
    int32_t status = VMAPP_VZ_OK;
    NSString *msg = nil;
    @autoreleasepool {
        @try {
            if (![VZVirtualMachine isSupported]) {
                status = VMAPP_VZ_UNSUPPORTED;
                msg = @"Virtualization.framework reports that virtualization is not supported on this host";
            } else if (entitlement_state() == 0) {
                status = VMAPP_VZ_ENTITLEMENT;
                msg = @"the process lacks the " VMAPP_ENTITLEMENT_NAME " entitlement";
            } else {
                NSDictionary<NSString *, NSNumber *> *kinds = @{};
                VZVirtualMachineConfiguration *cfg = build_config(spec, &status, &msg, &kinds);
                if (cfg != nil) {
                    NSError *verr = nil;
                    if (![cfg validateWithError:&verr]) {
                        NSString *d = describe_error(verr);
                        if ([d containsString:@VMAPP_ENTITLEMENT_NAME]) {
                            status = VMAPP_VZ_ENTITLEMENT;
                            msg = [NSString stringWithFormat:@"the process lacks the " VMAPP_ENTITLEMENT_NAME
                                                             @" entitlement (%@)",
                                                             d];
                        } else {
                            status = VMAPP_VZ_INVALID_CONFIG;
                            msg = [NSString stringWithFormat:@"configuration validation failed: %@", d];
                        }
                    } else if (!assert_minimal_devices(cfg, &msg)) {
                        status = VMAPP_VZ_INVALID_CONFIG;
                    } else {
                        VmappVm *obj = [[VmappVm alloc] init];
                        obj->_eventCb = event_cb;
                        obj->_eventCtx = event_ctx;
                        obj.fsKinds = kinds;
                        obj.queue = dispatch_queue_create("com.vmapp.host.vz", DISPATCH_QUEUE_SERIAL);
                        dispatch_queue_set_specific(obj.queue, &kVmQueueKey, &kVmQueueKey, NULL);
                        __block VZVirtualMachine *vm = nil;
                        dispatch_sync(obj.queue, ^{
                            @try {
                                vm = [[VZVirtualMachine alloc] initWithConfiguration:cfg queue:obj.queue];
                                vm.delegate = obj;
                            } @catch (NSException *e) {
                                vm = nil;
                            }
                        });
                        if (vm == nil) {
                            status = VMAPP_VZ_EXCEPTION;
                            msg = @"VZVirtualMachine creation failed";
                        } else {
                            obj.vm = vm;
                            *out = (vmapp_vz_vm *)CFBridgingRetain(obj);
                        }
                    }
                }
            }
        } @catch (NSException *e) {
            status = VMAPP_VZ_EXCEPTION;
            msg = describe_exception(e);
        }
    }
    if (status != VMAPP_VZ_OK) {
        set_err(err, errlen, msg);
    }
    return status;
}

void vmapp_vz_vm_start(vmapp_vz_vm *vm, vmapp_vz_done_cb cb, void *ctx) {
    if (vm == NULL) {
        cb(ctx, VMAPP_VZ_INTERNAL, -1, "null virtual machine");
        return;
    }
    VmappVm *obj = (__bridge VmappVm *)vm;
    dispatch_async(obj.queue, ^{
        @autoreleasepool {
            @try {
                if (!obj.vm.canStart) {
                    deliver(cb, ctx, VMAPP_VZ_BAD_STATE, -1, @"virtual machine cannot be started in its current state");
                    return;
                }
                obj.starting = YES;
                [obj.vm startWithCompletionHandler:^(NSError *error) {
                    @autoreleasepool {
                        @try {
                            obj.starting = NO;
                            if (error != nil) {
                                deliver(cb, ctx, VMAPP_VZ_START_FAILED, -1, describe_error(error));
                            } else {
                                deliver(cb, ctx, VMAPP_VZ_OK, -1, nil);
                            }
                        } @catch (NSException *e) {
                            deliver(cb, ctx, VMAPP_VZ_EXCEPTION, -1, describe_exception(e));
                        }
                        /* Run stops that were requested while the start was in flight. */
                        NSArray<void (^)(void)> *pending = [obj.afterStart copy];
                        [obj.afterStart removeAllObjects];
                        for (void (^blk)(void) in pending) {
                            @try {
                                blk();
                            } @catch (NSException *e) {
                            }
                        }
                    }
                }];
            } @catch (NSException *e) {
                obj.starting = NO;
                deliver(cb, ctx, VMAPP_VZ_EXCEPTION, -1, describe_exception(e));
            }
        }
    });
}

int32_t vmapp_vz_vm_request_stop(vmapp_vz_vm *vm, char *err, size_t errlen) {
    if (vm == NULL) {
        set_err(err, errlen, @"null virtual machine");
        return VMAPP_VZ_INTERNAL;
    }
    VmappVm *obj = (__bridge VmappVm *)vm;
    __block int32_t status = VMAPP_VZ_OK;
    __block NSString *msg = nil;
    @autoreleasepool {
        [obj runSync:^{
            @try {
                if (!obj.vm.canRequestStop) {
                    status = VMAPP_VZ_BAD_STATE;
                    msg = @"the guest cannot be asked to stop in the current state";
                    return;
                }
                NSError *e = nil;
                if (![obj.vm requestStopWithError:&e]) {
                    status = VMAPP_VZ_STOP_FAILED;
                    msg = describe_error(e);
                }
            } @catch (NSException *ex) {
                status = VMAPP_VZ_EXCEPTION;
                msg = describe_exception(ex);
            }
        }];
    }
    if (status != VMAPP_VZ_OK) {
        set_err(err, errlen, msg);
    }
    return status;
}

void vmapp_vz_vm_force_stop(vmapp_vz_vm *vm, vmapp_vz_done_cb cb, void *ctx) {
    if (vm == NULL) {
        cb(ctx, VMAPP_VZ_INTERNAL, -1, "null virtual machine");
        return;
    }
    VmappVm *obj = (__bridge VmappVm *)vm;
    dispatch_async(obj.queue, ^{
        @autoreleasepool {
            @try {
                [obj forceStopWithCb:cb ctx:ctx attempt:0];
            } @catch (NSException *e) {
                deliver(cb, ctx, VMAPP_VZ_EXCEPTION, -1, describe_exception(e));
            }
        }
    });
}

int32_t vmapp_vz_vm_state(vmapp_vz_vm *vm) {
    if (vm == NULL) {
        return VMAPP_VZ_STATE_ERROR;
    }
    VmappVm *obj = (__bridge VmappVm *)vm;
    __block int32_t state = VMAPP_VZ_STATE_ERROR;
    @autoreleasepool {
        [obj runSync:^{
            @try {
                state = map_state(obj.vm.state);
            } @catch (NSException *e) {
                state = VMAPP_VZ_STATE_ERROR;
            }
        }];
    }
    return state;
}

void vmapp_vz_vm_connect(vmapp_vz_vm *vm, uint32_t port, uint32_t timeout_ms, vmapp_vz_done_cb cb, void *ctx) {
    if (vm == NULL) {
        cb(ctx, VMAPP_VZ_INTERNAL, -1, "null virtual machine");
        return;
    }
    VmappVm *obj = (__bridge VmappVm *)vm;
    dispatch_async(obj.queue, ^{
        @autoreleasepool {
            @try {
                if (obj.vm.state != VZVirtualMachineStateRunning) {
                    deliver(cb, ctx, VMAPP_VZ_BAD_STATE, -1, @"virtual machine is not running");
                    return;
                }
                VZVirtioSocketDevice *dev = nil;
                for (VZSocketDevice *d in obj.vm.socketDevices) {
                    if ([d isKindOfClass:[VZVirtioSocketDevice class]]) {
                        dev = (VZVirtioSocketDevice *)d;
                        break;
                    }
                }
                if (dev == nil) {
                    deliver(cb, ctx, VMAPP_VZ_VSOCK_FAILED, -1, @"no virtio socket device");
                    return;
                }
                VmappOnce *once = [[VmappOnce alloc] init];
                [dev connectToPort:port
                 completionHandler:^(VZVirtioSocketConnection *connection, NSError *error) {
                     @autoreleasepool {
                         @try {
                             if (![once fire]) {
                                 /* Timed out earlier: the connection must not be delivered. */
                                 [connection close];
                                 return;
                             }
                             if (connection == nil || error != nil) {
                                 deliver(cb, ctx, VMAPP_VZ_VSOCK_FAILED, -1,
                                         error != nil ? describe_error(error) : @"connection failed");
                                 return;
                             }
                             /* The framework owns connection.fileDescriptor and closes it when the
                              * object dies; hand out an independent close-on-exec duplicate. */
                             int fd = fcntl(connection.fileDescriptor, F_DUPFD_CLOEXEC, 3);
                             int saved = errno;
                             [connection close];
                             if (fd < 0) {
                                 deliver(cb, ctx, VMAPP_VZ_VSOCK_FAILED, -1,
                                         [NSString stringWithFormat:@"could not duplicate the connection descriptor "
                                                                    @"(errno %d)",
                                                                    saved]);
                                 return;
                             }
                             deliver(cb, ctx, VMAPP_VZ_OK, fd, nil);
                         } @catch (NSException *e) {
                             deliver(cb, ctx, VMAPP_VZ_EXCEPTION, -1, describe_exception(e));
                         }
                     }
                 }];
                uint64_t wait_ms = timeout_ms != 0 ? timeout_ms : 10000;
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait_ms * NSEC_PER_MSEC)), obj.queue, ^{
                    @autoreleasepool {
                        if ([once fire]) {
                            deliver(cb, ctx, VMAPP_VZ_VSOCK_FAILED, -1,
                                    @"timed out waiting for the guest to accept the connection");
                        }
                    }
                });
            } @catch (NSException *e) {
                deliver(cb, ctx, VMAPP_VZ_EXCEPTION, -1, describe_exception(e));
            }
        }
    });
}

int32_t vmapp_vz_vm_set_share_for_tag(vmapp_vz_vm *vm, const char *tag_c, const vmapp_vz_share *shares, size_t count,
                                      char *err, size_t errlen) {
    if (vm == NULL || tag_c == NULL || (count > 0 && shares == NULL)) {
        set_err(err, errlen, @"invalid arguments");
        return VMAPP_VZ_INTERNAL;
    }
    NSString *tag = [NSString stringWithUTF8String:tag_c];
    if (tag == nil) {
        set_err(err, errlen, @"virtiofs tag is not valid UTF-8");
        return VMAPP_VZ_INTERNAL;
    }
    VmappVm *obj = (__bridge VmappVm *)vm;
    __block int32_t status = VMAPP_VZ_OK;
    __block NSString *msg = nil;
    @autoreleasepool {
        [obj runSync:^{
            @try {
                if (obj.vm.state != VZVirtualMachineStateRunning) {
                    status = VMAPP_VZ_BAD_STATE;
                    msg = @"virtual machine is not running";
                    return;
                }
                NSNumber *kind = obj.fsKinds[tag];
                if (kind == nil) {
                    status = VMAPP_VZ_SHARES_FAILED;
                    msg = [NSString stringWithFormat:@"no virtiofs device with tag %@", tag];
                    return;
                }
                NSString *share_msg = nil;
                VZDirectoryShare *share = kind.boolValue ? (VZDirectoryShare *)make_single_share(shares, count, &share_msg)
                                                         : (VZDirectoryShare *)make_share(shares, count, &share_msg);
                if (share == nil) {
                    status = VMAPP_VZ_INVALID_CONFIG;
                    msg = share_msg ?: @"share construction failed";
                    return;
                }
                VZVirtioFileSystemDevice *dev = nil;
                for (VZDirectorySharingDevice *d in obj.vm.directorySharingDevices) {
                    if ([d isKindOfClass:[VZVirtioFileSystemDevice class]] &&
                        [((VZVirtioFileSystemDevice *)d).tag isEqualToString:tag]) {
                        dev = (VZVirtioFileSystemDevice *)d;
                        break;
                    }
                }
                if (dev == nil) {
                    status = VMAPP_VZ_SHARES_FAILED;
                    msg = @"the virtiofs device is not present";
                    return;
                }
                dev.share = share;
            } @catch (NSException *e) {
                status = VMAPP_VZ_EXCEPTION;
                msg = describe_exception(e);
            }
        }];
    }
    if (status != VMAPP_VZ_OK) {
        set_err(err, errlen, msg);
    }
    return status;
}

void vmapp_vz_vm_release(vmapp_vz_vm *vm) {
    if (vm != NULL) {
        CFRelease((CFTypeRef)vm);
    }
}
