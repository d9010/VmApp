/*
 * spike-vm: a minimal libkrun launcher for the Venus GPU spike (research only, not product code).
 *
 * Boots a Linux guest on Hypervisor.framework through libkrun's C API with a virtio-gpu (Venus) device.
 *
 *   Direct-kernel mode (our own kernel):
 *     spike-vm --kernel Image [--initrd cpio] --cmdline "console=hvc0 root=/dev/vda rw ..." --disk root.ext4 ...
 *   Stock mode (libkrunfw's kernel + libkrun's init.krun):
 *     spike-vm --root-disk /dev/vda --disk root.ext4 --exec /spike/run.sh ...
 *
 * Options
 *   --cpus N             vCPUs (default 4)
 *   --mem MiB            guest RAM (default 4096)
 *   --gpu[=MiB]          virtio-gpu with Venus; MiB = size of the host-visible window ("vRAM", default 8192)
 *   --kernel PATH        raw arm64 Image (KRUN_KERNEL_FORMAT_RAW)
 *   --initrd PATH        initramfs for --kernel
 *   --cmdline STR        kernel command line for --kernel
 *   --disk PATH[:ro]     raw virtio-blk disk (vda, vdb, ... in order)
 *   --virtiofs TAG=PATH[:ro]
 *   --vsock PORT=SOCKPATH[:listen]   map a guest vsock port to a host unix socket (listen = host connects to guest)
 *   --root-disk DEV      stock mode: remount root from DEV (e.g. /dev/vda) after init.krun starts
 *   --fstype T           filesystem of --root-disk (default ext4)
 *   --exec PATH          stock mode: program to run in the guest (args after "--")
 *   --env K=V            stock mode: environment (repeatable)
 *   --log N              libkrun log level (0 off .. 5 trace; default 2)
 *   --no-tsi             do not create the TSI vsock device implicitly; add a plain vsock device
 *
 * Build: see BUILD.md. Needs the com.apple.security.hypervisor entitlement (ad-hoc signed).
 * Licence of this file: Apache-2.0 (same as libkrun, whose public C API it uses).
 */
#include <errno.h>
#include <getopt.h>
#include <libkrun.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAXN 32

static void die(const char *what, int rc) {
    fprintf(stderr, "spike-vm: %s failed: %d (%s)\n", what, rc, rc < 0 ? strerror(-rc) : "?");
    exit(1);
}
#define CHECK(call)                                                                                                    \
    do {                                                                                                               \
        int32_t rc_ = (call);                                                                                          \
        if (rc_ < 0)                                                                                                   \
            die(#call, rc_);                                                                                           \
    } while (0)

static bool strip_suffix(char *s, const char *suf) {
    size_t n = strlen(s), m = strlen(suf);
    if (n >= m && strcmp(s + n - m, suf) == 0) {
        s[n - m] = 0;
        return true;
    }
    return false;
}

int main(int argc, char **argv) {
    int cpus = 4, mem = 4096, loglevel = 2;
    long gpu_mib = -1;
    const char *kernel = NULL, *initrd = NULL, *cmdline = "console=hvc0 panic=-1";
    const char *root_disk = NULL, *fstype = "ext4", *exec_path = NULL;
    char *disks[MAXN]; int ndisks = 0;
    char *fss[MAXN]; int nfs = 0;
    char *vsocks[MAXN]; int nvsock = 0;
    const char *envs[MAXN + 1]; int nenv = 0;
    bool no_tsi = false;

    static const struct option opts[] = {
        {"cpus", required_argument, 0, 'c'}, {"mem", required_argument, 0, 'm'},
        {"gpu", optional_argument, 0, 'g'},  {"kernel", required_argument, 0, 'k'},
        {"initrd", required_argument, 0, 'i'}, {"cmdline", required_argument, 0, 'a'},
        {"disk", required_argument, 0, 'd'}, {"virtiofs", required_argument, 0, 'f'},
        {"vsock", required_argument, 0, 'v'}, {"root-disk", required_argument, 0, 'r'},
        {"fstype", required_argument, 0, 't'}, {"exec", required_argument, 0, 'x'},
        {"env", required_argument, 0, 'e'},  {"log", required_argument, 0, 'l'},
        {"no-tsi", no_argument, 0, 'T'},     {0, 0, 0, 0}};
    int c;
    while ((c = getopt_long(argc, argv, "+", opts, NULL)) != -1) {
        switch (c) {
        case 'c': cpus = atoi(optarg); break;
        case 'm': mem = atoi(optarg); break;
        case 'g': gpu_mib = optarg ? atol(optarg) : 8192; break;
        case 'k': kernel = optarg; break;
        case 'i': initrd = optarg; break;
        case 'a': cmdline = optarg; break;
        case 'd': if (ndisks < MAXN) disks[ndisks++] = optarg; break;
        case 'f': if (nfs < MAXN) fss[nfs++] = optarg; break;
        case 'v': if (nvsock < MAXN) vsocks[nvsock++] = optarg; break;
        case 'r': root_disk = optarg; break;
        case 't': fstype = optarg; break;
        case 'x': exec_path = optarg; break;
        case 'e': if (nenv < MAXN) envs[nenv++] = optarg; break;
        case 'l': loglevel = atoi(optarg); break;
        case 'T': no_tsi = true; break;
        default: fprintf(stderr, "bad option\n"); return 2;
        }
    }
    envs[nenv] = NULL;

    CHECK(krun_set_log_level((uint32_t)loglevel));
    int32_t ctx = krun_create_ctx();
    if (ctx < 0) die("krun_create_ctx", ctx);
    CHECK(krun_set_vm_config((uint32_t)ctx, (uint8_t)cpus, (uint32_t)mem));

    if (kernel) {
        CHECK(krun_set_kernel((uint32_t)ctx, kernel, KRUN_KERNEL_FORMAT_RAW, initrd, cmdline));
    }

    for (int i = 0; i < ndisks; i++) {
        char *p = disks[i];
        bool ro = strip_suffix(p, ":ro");
        char id[16];
        snprintf(id, sizeof id, "vd%c", 'a' + i);
        CHECK(krun_add_disk3((uint32_t)ctx, id, p, KRUN_DISK_FORMAT_RAW, ro, false, KRUN_SYNC_RELAXED));
    }

    for (int i = 0; i < nfs; i++) {
        char *eq = strchr(fss[i], '=');
        if (!eq) { fprintf(stderr, "--virtiofs TAG=PATH\n"); return 2; }
        *eq = 0;
        bool ro = strip_suffix(eq + 1, ":ro");
        CHECK(krun_add_virtiofs3((uint32_t)ctx, fss[i], eq + 1, 0, ro));
    }

    if (kernel || no_tsi || nvsock) {
        /* Plain vsock (no TSI socket hijacking): our guests use vsock ports only. */
        CHECK(krun_disable_implicit_vsock((uint32_t)ctx));
        CHECK(krun_add_vsock((uint32_t)ctx, 0));
    }
    for (int i = 0; i < nvsock; i++) {
        char *eq = strchr(vsocks[i], '=');
        if (!eq) { fprintf(stderr, "--vsock PORT=SOCKPATH\n"); return 2; }
        *eq = 0;
        bool listen = strip_suffix(eq + 1, ":listen");
        CHECK(krun_add_vsock_port2((uint32_t)ctx, (uint32_t)atoi(vsocks[i]), eq + 1, listen));
    }

    if (gpu_mib >= 0) {
        /* Venus only (no GL): same flags as krunkit. The window is where host-visible blobs get mapped. */
        uint32_t flags = VIRGLRENDERER_VENUS | VIRGLRENDERER_NO_VIRGL;
        CHECK(krun_set_gpu_options2((uint32_t)ctx, flags, (uint64_t)gpu_mib * 1024 * 1024));
    }

    if (!kernel) {
        if (root_disk) CHECK(krun_set_root_disk_remount((uint32_t)ctx, root_disk, fstype, NULL));
        if (exec_path) {
            const char *av[MAXN] = {0};
            int n = 0;
            for (int i = optind; i < argc && n < MAXN - 1; i++) av[n++] = argv[i];
            CHECK(krun_set_exec((uint32_t)ctx, exec_path, av, nenv ? envs : NULL));
        }
    }

    int32_t rc = krun_start_enter((uint32_t)ctx); /* only returns on error */
    die("krun_start_enter", rc);
    return 1;
}
