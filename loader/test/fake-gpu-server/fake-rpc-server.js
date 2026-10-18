'use strict';
// A stand-in for the GPU capability's sandboxed llama.cpp `rpc-server` (SPEC 8.6), for the loader CDP test (run J) ONLY. The real
// one needs a built llama.cpp and a Metal GPU; the loader's behaviour around it (the grant, the chip, the pill, the Inspector rows,
// switching it off) does not. The loader finds its server through cfg.gpuServer, which a development loader takes from
// $VMAPP_GPU_SERVER and a packaged one never does (loader/src/config.js), so this file cannot stand in for the real server in
// a shipped loader.
//
// Started by a wrapper the test writes (see runJ):  node fake-rpc-server.js --test-log FILE --test-control FILE --host H --port P --device D
// It listens on H:P and echoes every byte, like a server that answers each request with a reply of the same size. It records what
// it was started with and each connection in --test-log (JSON lines). If --test-control names a file that says `fail`, it exits
// at once with a message, as a real server does when it cannot create its Metal device.
const net = require('net');
const fs = require('fs');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const logFile = opt('--test-log');
const control = opt('--test-control');
const host = opt('--host');
const port = Number(opt('--port'));
const note = (o) => {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify(Object.assign({ ts: Date.now(), pid: process.pid }, o)) + '\n');
  } catch {
    /* the log is only for the test */
  }
};

note({ event: 'start', host, port, device: opt('--device'), argv });
if (control && fs.existsSync(control) && fs.readFileSync(control, 'utf8').trim() === 'fail') {
  console.error('simulated failure: cannot create the Metal device');
  note({ event: 'fail' });
  process.exit(3);
}

const server = net.createServer((sock) => {
  let bytes = 0;
  note({ event: 'connection' });
  sock.on('data', (d) => {
    bytes += d.length;
    sock.write(d);
  });
  sock.on('error', () => {});
  sock.on('close', () => note({ event: 'closed', bytes }));
});
server.on('error', (e) => {
  note({ event: 'error', message: e.message });
  process.exit(4);
});
server.listen(port, host, () => note({ event: 'listening' }));
process.on('SIGTERM', () => {
  note({ event: 'sigterm' });
  process.exit(0);
});
