#!/usr/bin/env python3
"""Host side of the libkrun vsock check (guest side: guest/scripts/tests/vsock.sh).

Maps (see spike-vm --vsock PORT=PATH[:listen]):
  guest port 1024  host connects  (libkrun creates the unix socket, we connect and talk to the guest's echo server)
  guest port 1025  host connects  (bulk host -> guest, guest prints MiB/s)
  guest port 2000  guest connects (we listen on the unix socket; libkrun connects to us when the guest calls connect())
  guest port 2001  guest connects (bulk guest -> host, we measure MiB/s)

usage: VMAPP_WORK=/abs/scratch python3 -I vsock-host-test.py
"""
import os, socket, subprocess, sys, threading, time

WORK = os.environ["VMAPP_WORK"]
HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(WORK, "run")
S = {p: os.path.join("/tmp", f"vmapp-spike-vsock-{os.getpid()}-{p}.sock") for p in (1024, 1025, 2000, 2001)}
results = {}

def serve_hello():
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(S[2000]); srv.listen(1)
    c, _ = srv.accept()
    data = c.recv(4096)
    results["guest->host hello"] = data.decode().strip()
    c.sendall(b"hello-from-host\n"); c.close()

def serve_sink():
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(S[2001]); srv.listen(1)
    c, _ = srv.accept()
    t0 = None; total = 0
    while True:
        b = c.recv(1 << 20)
        if not b: break
        if t0 is None: t0 = time.time()
        total += len(b)
    dt = time.time() - t0
    results["guest->host bulk"] = f"{total/1048576:.0f} MiB in {dt:.2f} s = {total/1048576/dt:.0f} MiB/s"

def connect_retry(path, tries=200):
    for _ in range(tries):
        try:
            c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            c.connect(path); return c
        except OSError:
            c.close(); time.sleep(0.1)
    raise RuntimeError("cannot connect " + path)

def host_to_guest():
    time.sleep(3)  # guest boot
    # echo round trips (latency)
    c = connect_retry(S[1024])
    t0 = time.time(); n = 2000
    for i in range(n):
        c.sendall(b"ping\n"); r = c.recv(64)
        assert r == b"ping\n", r
    dt = time.time() - t0
    results["host->guest echo"] = f"{n} round trips, {dt/n*1e6:.0f} us each"
    c.close()
    # bulk
    c = connect_retry(S[1025])
    buf = b"\xa5" * (1 << 20)
    for _ in range(256): c.sendall(buf)
    c.close()

for p in S.values():
    try: os.unlink(p)
    except FileNotFoundError: pass
ths = [threading.Thread(target=f, daemon=True) for f in (serve_hello, serve_sink, host_to_guest)]
for t in ths: t.start()
env = dict(os.environ)
cmd = [os.path.join(HERE, "run-guest.sh"), "vsock", "vsock", "timeout=120", "gpu=0", "mem=1024", "cpus=2",
       f"vsock=1024={S[1024]}:listen", f"vsock=1025={S[1025]}:listen", f"vsock=2000={S[2000]}", f"vsock=2001={S[2001]}"]
subprocess.run(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for t in ths: t.join(timeout=5)
for k, v in results.items(): print(f"{k}: {v}")
for p in S.values():
    try: os.unlink(p)
    except FileNotFoundError: pass
