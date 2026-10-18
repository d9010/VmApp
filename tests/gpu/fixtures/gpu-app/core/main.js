'use strict';
// Runs inside the VM (node22 runtime). What a llama.cpp client does first when it is pointed at $VMAPP_GPU_RPC, spoken by hand: the
// RPC protocol of ggml (HELLO, DEVICE_COUNT, GET_DEVICE_MEMORY), over 127.0.0.1:50052, which the platform tunnels to the host's
// sandboxed Metal server (SPEC 8.6). The test script asks for 'probe' and checks what came back.
const net = require('net');
const { app, BrowserWindow, ipcMain } = require('vmapp');

const CMD = { GET_DEVICE_MEMORY: 11, HELLO: 14, DEVICE_COUNT: 15 };
const CAPS = 24; // RPC_CONN_CAPS_SIZE

function connect(addr) {
  const [host, port] = addr.split(':');
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port: Number(port) });
    s.setNoDelay(true);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** One request/response of the RPC protocol: | cmd (1) | size (8, LE) | data | -> | size (8, LE) | data |. */
function makeCaller(sock) {
  let buf = Buffer.alloc(0);
  let closed = null;
  let wake = null;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (wake) wake();
  });
  const end = (e) => {
    closed = e || new Error('the connection was closed');
    if (wake) wake();
  };
  sock.once('close', () => end());
  sock.once('error', end);
  const need = (n) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (buf.length >= n) {
          wake = null;
          resolve();
        } else if (closed) {
          wake = null;
          reject(closed);
        }
      };
      wake = check;
      check();
    });
  return async (cmd, req, rspLen) => {
    const head = Buffer.alloc(9);
    head[0] = cmd;
    head.writeBigUInt64LE(BigInt(req.length), 1);
    sock.write(Buffer.concat([head, req]));
    await need(8);
    const n = Number(buf.readBigUInt64LE(0));
    if (n !== rspLen) throw new Error(`unexpected response size ${n}`);
    await need(8 + n);
    const out = buf.subarray(8, 8 + n);
    buf = buf.subarray(8 + n);
    return out;
  };
}

async function probe(rounds) {
  const addr = process.env.VMAPP_GPU_RPC;
  if (!addr) return { ok: false, error: 'VMAPP_GPU_RPC is not set' };
  let sock;
  try {
    sock = await connect(addr);
  } catch (e) {
    return { ok: false, addr, error: `connect: ${e.code || e.message}` };
  }
  try {
    const call = makeCaller(sock);
    const hello = await call(CMD.HELLO, Buffer.alloc(CAPS), 4 + CAPS);
    const count = (await call(CMD.DEVICE_COUNT, Buffer.alloc(0), 4)).readUInt32LE(0);
    const dev = Buffer.alloc(4);
    const mem = await call(CMD.GET_DEVICE_MEMORY, dev, 16);
    const free = Number(mem.readBigUInt64LE(0));
    const total = Number(mem.readBigUInt64LE(8));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < rounds; i++) await call(CMD.GET_DEVICE_MEMORY, dev, 16);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / Math.max(1, rounds);
    return { ok: true, addr, proto: `${hello[0]}.${hello[1]}.${hello[2]}`, devices: count, freeMiB: Math.round(free / 1048576), totalMiB: Math.round(total / 1048576), rounds, avgRoundTripUs: Math.round(us) };
  } catch (e) {
    return { ok: false, addr, error: e.message };
  } finally {
    sock.destroy();
  }
}

ipcMain.handle('probe', (_e, rounds) => probe(Number.isInteger(rounds) ? rounds : 0));
ipcMain.handle('env', () => ({ gpu: process.env.VMAPP_GPU_RPC === undefined ? null : process.env.VMAPP_GPU_RPC }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, title: 'GPU test' });
  await win.loadFile('index.html');
});
