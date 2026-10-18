/*
 * vsock-test: tiny AF_VSOCK helper for the libkrun spike (checks that vmapp's host<->guest channel model maps onto
 * libkrun's vsock-to-unix-socket bridge).
 *
 *   vsock-test echo PORT            listen on PORT (guest side), accept ONE connection, echo bytes back
 *   vsock-test sink PORT            listen on PORT, read until EOF, print byte count and MiB/s
 *   vsock-test source PORT MIB      connect to the host (CID 2) on PORT, send MIB MiB, print MiB/s
 *   vsock-test hello PORT           connect to the host (CID 2) on PORT, send "hello-from-guest\n", print the reply
 *
 * Apache-2.0, spike tool.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }

static int listen_on(unsigned port) {
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (s < 0) { perror("socket"); exit(2); }
    struct sockaddr_vm a = {.svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_ANY, .svm_port = port};
    if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); exit(2); }
    if (listen(s, 4) < 0) { perror("listen"); exit(2); }
    fprintf(stderr, "vsock-test: listening on vsock port %u\n", port);
    return s;
}

static int connect_host(unsigned port) {
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (s < 0) { perror("socket"); exit(2); }
    struct sockaddr_vm a = {.svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = port};
    if (connect(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("connect"); exit(2); }
    return s;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: vsock-test echo|sink|source|hello PORT [MIB]\n"); return 2; }
    unsigned port = (unsigned)atoi(argv[2]);
    static char buf[1 << 16];
    if (!strcmp(argv[1], "echo")) {
        int c = accept(listen_on(port), NULL, NULL);
        ssize_t n;
        while ((n = read(c, buf, sizeof buf)) > 0) if (write(c, buf, (size_t)n) != n) break;
        return 0;
    } else if (!strcmp(argv[1], "sink")) {
        int c = accept(listen_on(port), NULL, NULL);
        double t0 = 0; unsigned long long total = 0; ssize_t n;
        while ((n = read(c, buf, sizeof buf)) > 0) { if (!t0) t0 = now(); total += (unsigned long long)n; }
        double dt = now() - t0;
        printf("sink: %llu bytes in %.3f s = %.1f MiB/s\n", total, dt, total / 1048576.0 / dt);
        return 0;
    } else if (!strcmp(argv[1], "source")) {
        unsigned long long mib = argc > 3 ? strtoull(argv[3], NULL, 10) : 64, sent = 0;
        int c = connect_host(port);
        memset(buf, 0x5a, sizeof buf);
        double t0 = now();
        while (sent < mib * 1048576ull) { ssize_t n = write(c, buf, sizeof buf); if (n <= 0) break; sent += (unsigned long long)n; }
        close(c);
        double dt = now() - t0;
        printf("source: %llu bytes in %.3f s = %.1f MiB/s\n", sent, dt, sent / 1048576.0 / dt);
        return 0;
    } else if (!strcmp(argv[1], "hello")) {
        int c = connect_host(port);
        const char *m = "hello-from-guest\n";
        if (write(c, m, strlen(m)) < 0) return 2;
        ssize_t n = read(c, buf, sizeof buf - 1);
        if (n > 0) { buf[n] = 0; printf("guest got reply: %s", buf); }
        return 0;
    }
    return 2;
}
