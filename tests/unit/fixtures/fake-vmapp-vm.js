#!/usr/bin/env node
'use strict';
// A stand-in for `vmapp-vm` for unit tests. Same CLI and stdout/stdin protocol (SPEC 5), but instead of a VM it
// runs the SDK app $FAKE_VM_APP as a child process listening on --socket.
//   FAKE_VM_LOG   file; every received arg list and stdin command is appended as a JSON line
//   FAKE_VM_FAIL_GRANT=1  answer grant commands with an error line
//   FAKE_VM_NO_READY=1    never print the ready line
//   FAKE_VM_NET_EVENTS    JSON array of objects, each printed as a {"net":{...}} line once the app is ready (SPEC 8.3)
//   FAKE_VM_FAIL_NET=1    answer net-allow / net-revoke with an error line
//   FAKE_VM_SERVICE_EVENTS  JSON array of objects, each printed as a {"service":{...}} line once the app is ready (SPEC 8.6);
//                         a service-revoke command is answered with a service-revoked line
//   FAKE_VM_FAIL_WINDOW_PROXY=1  answer window-proxy with an error line (otherwise {"window-proxy":{"port":54321}}); the log
//                         records whether the secret had the right form, never the secret itself
//   port-forward P is answered with a listen event and {"port-forwarded":{"port":P,"hostPort":P+10000}} (FAKE_VM_FAIL_PORTS=1: an
//                         error line); port-close P with a stop event and {"port-closed":{"port":P,"closed":0}}
const fs = require('fs');
const cp = require('child_process');
const readline = require('readline');

const argv = process.argv.slice(2);
const opts = { shares: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--share') opts.shares.push(argv[++i]);
  else if (a.startsWith('--') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) opts[a.slice(2)] = true;
}
const out = (o) => {
  try {
    process.stdout.write(JSON.stringify(o) + '\n');
  } catch {
    /* ignore */
  }
};
const log = (o) => {
  if (process.env.FAKE_VM_LOG) fs.appendFileSync(process.env.FAKE_VM_LOG, JSON.stringify(o) + '\n');
};
log({ argv, opts });

let child = null;
let stopping = null;
let finished = false;

function finish(reason, exitCode) {
  if (finished) return;
  finished = true;
  const line = { stopped: true, reason, exitCode: exitCode === undefined ? null : exitCode, exported: {} };
  // the experimental Vulkan backend's own verdicts (SPEC 8.7) come with a detail
  if (reason === 'gpu-hang' || reason === 'vmm-crashed') line.detail = 'stopped by the test';
  out(line);
  process.exit(0);
}

// FAKE_VM_REASON_AFTER_MS=300 FAKE_VM_REASON=gpu-hang: the launcher stops the VM by itself with that verdict (SPEC 8.7, the watchdog)
if (process.env.FAKE_VM_REASON) {
  setTimeout(() => {
    stopping = process.env.FAKE_VM_REASON;
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }, Number(process.env.FAKE_VM_REASON_AFTER_MS || 300));
}

child = cp.spawn(process.execPath, [process.env.FAKE_VM_APP], {
  env: Object.assign({}, process.env, { VMAPP_SOCKET: opts.socket }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const consoleLog = opts.console ? fs.createWriteStream(opts.console, { flags: 'a' }) : null;
child.stdout.on('data', (d) => consoleLog && consoleLog.write(d));
child.stderr.on('data', (d) => consoleLog && consoleLog.write(d));
child.on('exit', (code) => finish(stopping || 'core-exited', code));

if (!process.env.FAKE_VM_NO_READY) {
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (fs.existsSync(opts.socket)) {
      clearInterval(poll);
      out({ ready: true, socket: opts.socket, hello: { ok: true }, pid: child.pid });
      if (process.env.FAKE_VM_NET_EVENTS) for (const n of JSON.parse(process.env.FAKE_VM_NET_EVENTS)) out({ net: n });
      if (process.env.FAKE_VM_SERVICE_EVENTS) for (const n of JSON.parse(process.env.FAKE_VM_SERVICE_EVENTS)) out({ service: n });
    } else if (Date.now() - t0 > 10000) {
      clearInterval(poll);
      out({ error: { op: 'start', message: 'socket never appeared' } });
    }
  }, 20);
}

function shutdown(reason) {
  if (!stopping) stopping = reason;
  if (child && child.exitCode === null) child.kill('SIGTERM');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd.op === 'window-proxy') {
    log({ stdin: { op: cmd.op, secretOk: /^[0-9a-f]{64}$/.test(String(cmd.secret)) } });
    if (process.env.FAKE_VM_FAIL_WINDOW_PROXY) out({ error: { op: 'window-proxy', message: 'refused by test' } });
    else out({ 'window-proxy': { port: 54321 } });
    return;
  }
  log({ stdin: cmd });
  if (cmd.op === 'port-forward') {
    if (process.env.FAKE_VM_FAIL_PORTS) return out({ error: { op: 'port-forward', message: 'refused by test' } });
    out({ forward: { id: 0, port: cmd.port, hostPort: cmd.port + 10000, phase: 'listen', bytesUp: 0, bytesDown: 0, durationMs: 0 } });
    return out({ 'port-forwarded': { port: cmd.port, hostPort: cmd.port + 10000 } });
  }
  if (cmd.op === 'port-close') {
    out({ forward: { id: 0, port: cmd.port, hostPort: cmd.port + 10000, phase: 'stop', bytesUp: 0, bytesDown: 0, durationMs: 5, reason: 'closed' } });
    return out({ 'port-closed': { port: cmd.port, closed: 0 } });
  }
  if (cmd.op === 'grant') {
    if (process.env.FAKE_VM_FAIL_GRANT) out({ error: { op: 'grant', message: 'refused by test' } });
    else out({ granted: { name: cmd.name, access: cmd.access } });
  } else if (cmd.op === 'revoke') out({ revoked: { name: cmd.name } });
  else if (cmd.op === 'net-allow' || cmd.op === 'net-revoke') {
    if (process.env.FAKE_VM_FAIL_NET) out({ error: { op: cmd.op, message: 'refused by test' } });
    else if (cmd.op === 'net-allow') out({ 'net-allowed': { rule: cmd.rule } });
    else out({ 'net-revoked': { rule: cmd.rule.split(':')[0], closed: 0 } });
  } else if (cmd.op === 'service-revoke') out({ 'service-revoked': { name: cmd.name, closed: 0 } });
  else if (cmd.op === 'shutdown') shutdown('shutdown');
}).on('close', () => shutdown('parent-exited'));
