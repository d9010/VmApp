// vmapp-hostctl tests:  node tests/hostctl/run.mjs
//
// Safe on a live desktop: never moves the real mouse, clicks, scrolls or types (input ops run with
// dryRun:true only), never saves a capture (at most an 8x8 px region is held in memory, then dropped).
// If Screen Recording / Accessibility is not granted to the process running this, that is REPORTED, not
// worked around: the capture test then expects the "permission" error instead of a PNG.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const VMAPP = resolve(HERE, '..', '..');
const BIN = process.env.VMAPP_HOSTCTL || join(VMAPP, 'out', 'vmapp-hostctl');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}\n`);
}
function note(msg) { process.stdout.write(`NOTE  ${msg}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny client: one request in flight at a time is not required; replies are matched by id.
class Client {
  constructor() {
    this.proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.badLines = [];
    this.stderr = '';
    this.exited = new Promise((res) => this.proc.once('exit', (code, sig) => res({ code, sig })));
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { this.badLines.push(line); return; }
      if (m && m.event) { this.events.push(m); return; }
      if (!m || typeof m !== 'object' || !('id' in m) || typeof m.ok !== 'boolean') { this.badLines.push(line); return; }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); } else if (m.id === null) { this.nullReply?.(m); }
    });
  }
  // Sends {op, ...args} and resolves with the parsed reply (or rejects on timeout).
  req(op, args = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolveReq, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${op}`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolveReq(m); });
      this.proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }
  // Sends a raw line and resolves with the next reply whose id is null (or the given id).
  raw(line, expectId = null, timeoutMs = 5000) {
    return new Promise((resolveRaw, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for reply to raw line')), timeoutMs);
      if (expectId === null) this.nullReply = (m) => { clearTimeout(t); resolveRaw(m); };
      else this.pending.set(expectId, (m) => { clearTimeout(t); resolveRaw(m); });
      this.proc.stdin.write(line + '\n');
    });
  }
  close() { try { this.proc.stdin.end(); } catch { /* ignore */ } }
  kill() { try { this.proc.kill('SIGKILL'); } catch { /* ignore */ } }
}

function pngSize(b64) {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  if (typeof crc32 === 'function' && crc32(b.subarray(12, 29)) !== b.readUInt32BE(29)) return null;
  if (b.toString('latin1', b.length - 8, b.length - 4) !== 'IEND') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

async function main() {
  if (!existsSync(BIN)) {
    process.stdout.write(`FAIL  ${BIN} not found: build it with tools/build.sh (or host/hostctl/build.sh)\n`);
    process.exit(1);
  }
  const c = new Client();
  try {
    // ---- ping / status ---------------------------------------------------------------------------
    let r = await c.req('ping');
    check('ping', r.ok && r.result?.pong === true);

    r = await c.req('status');
    const st = r.result;
    check('status shape', r.ok && typeof st.screenRecording === 'boolean' && typeof st.accessibility === 'boolean' && /^\d+\.\d+$/.test(st.macos),
      JSON.stringify(st));
    note(`TCC status for the process running this test: screenRecording=${st?.screenRecording} accessibility=${st?.accessibility} macos=${st?.macos}`);

    // ---- displays / windows ----------------------------------------------------------------------
    r = await c.req('displays');
    const dl = r.result;
    // CGGetActiveDisplayList is empty while every display is asleep (or none is attached): that is the machine, not the
    // helper, so an empty list is reported as a NOTE and the shape is checked whenever there is a display.
    const shapeOk = (d) => Number.isInteger(d.display) && d.bounds.w > 0 && d.bounds.h > 0 && d.scale >= 1 && typeof d.main === 'boolean' &&
      typeof d.name === 'string' && d.name.length > 0 && typeof d.builtin === 'boolean';
    check('displays (shape: id, bounds, scale, main, name, builtin)', r.ok && Array.isArray(dl) && dl.every(shapeOk) &&
      (dl.length === 0 || dl.filter((d) => d.main).length === 1), `${dl?.length} display(s): ${(dl || []).map((d) => `${d.name} ${d.bounds.w}x${d.bounds.h}@${d.bounds.x},${d.bounds.y}`).join('; ')}`);
    if (Array.isArray(dl) && dl.length === 0) note('no active display (all asleep?): display names and display capture are not verified in this run.');

    r = await c.req('windows');
    const wl = r.result;
    check('windows (non-empty, default layer 0 only)', r.ok && Array.isArray(wl) && wl.length > 0 && wl.every((w) => w.layer === 0 &&
      Number.isInteger(w.windowId) && typeof w.app === 'string' && Number.isInteger(w.pid) && typeof w.title === 'string' &&
      typeof w.onScreen === 'boolean' && w.bounds && typeof w.bounds.x === 'number' && typeof w.bounds.w === 'number'),
      `${wl?.length} windows, ${wl?.filter((w) => w.title).length} with titles`);
    r = await c.req('windows', { all: true });
    check('windows {all:true} includes at least as many', r.ok && Array.isArray(r.result) && r.result.length >= (wl?.length ?? 0), `${r.result?.length}`);
    r = await c.req('windows', { all: 'yes' });
    check('windows rejects non-boolean all', !r.ok && r.error.code === 'bad-request');

    // ---- capture (tiny, in memory, discarded) ------------------------------------------------------
    // excludePids (the loader's own badge/overlay/pickers are never in a picture): validated before anything else
    for (const [name, bad] of [['not an array', 'x'], ['a zero pid', [0]], ['a negative pid', [-5]], ['a fractional pid', [1.5]], ['a string pid', ['12']],
      ['too many', Array.from({ length: 65 }, (_, i) => i + 1)]]) {
      r = await c.req('capture', { target: 'display', excludePids: bad });
      check(`capture excludePids ${name} -> bad-request`, !r.ok && r.error.code === 'bad-request', JSON.stringify(r.error ?? r.result).slice(0, 100));
    }
    // a good list is accepted (it then fails only on the missing Screen Recording grant, never on the list)
    r = await c.req('capture', { target: 'region', region: { x: 0, y: 0, w: 4, h: 4 }, excludePids: [process.pid, 1] });
    if (!st.screenRecording) check('capture with a valid excludePids -> permission (the list is not the problem)', !r.ok && r.error.code === 'permission', JSON.stringify(r.error ?? r.result).slice(0, 100));

    r = await c.req('capture', { target: 'region', region: { x: 0, y: 0, w: 4, h: 4 } });
    if (st.screenRecording) {
      const sz = r.ok ? pngSize(r.result.png) : null;
      check('capture 4x4 region -> valid PNG', r.ok && sz && sz.width === 4 && sz.height === 4 && r.result.width === 4 && r.result.height === 4,
        r.ok ? JSON.stringify(sz) : JSON.stringify(r.error));
      check('capture reports the display used and the captured bounds (global points)', r.ok && Number.isInteger(r.result.display) &&
        r.result.bounds && r.result.bounds.w === 4 && r.result.bounds.h === 4 && Number.isFinite(r.result.bounds.x) && Number.isFinite(r.result.bounds.y),
        JSON.stringify({ display: r.result?.display, bounds: r.result?.bounds }));
      // excludePids, for real (needs Screen Recording): a window owned by an excluded process cannot be captured at all,
      // and a display capture that excludes processes still succeeds. A tiny in-memory capture, nothing is saved.
      const owned = (wl || []).find((w) => w.bounds.w >= 20 && w.bounds.h >= 20);
      if (owned) {
        const plain = await c.req('capture', { target: 'window', windowId: owned.windowId, maxWidth: 8 });
        const excl = await c.req('capture', { target: 'window', windowId: owned.windowId, maxWidth: 8, excludePids: [owned.pid] });
        check('capture of a window owned by an excluded pid -> not-found (the window is not capturable)', !excl.ok && excl.error.code === 'not-found', JSON.stringify(excl.error ?? 'captured'));
        check('the same window without excludePids is capturable (or gone)', plain.ok || plain.error.code === 'not-found', JSON.stringify(plain.error ?? 'ok'));
      } else note('no window to test window exclusion with.');
      r = await c.req('capture', { target: 'region', region: { x: 0, y: 0, w: 4, h: 4 }, excludePids: [process.pid, 2147483647] });
      check('capture 4x4 region with excludePids -> still a valid PNG', r.ok && pngSize(r.result.png)?.width === 4, JSON.stringify(r.error ?? ''));
      r = await c.req('capture', { target: 'region', region: { x: 0, y: 0, w: 8, h: 8 }, maxWidth: 4 });
      const sz2 = r.ok ? pngSize(r.result.png) : null;
      check('capture 8x8 region with maxWidth 4 scales to 4x4', r.ok && sz2 && sz2.width === 4 && sz2.height === 4, r.ok ? '' : JSON.stringify(r.error));
      r = await c.req('capture', { target: 'region', region: { x: 0, y: 0, w: 4, h: 4 }, legacy: true });
      const sz3 = r.ok ? pngSize(r.result.png) : null;
      check('capture 4x4 region via legacy CGWindowList path', (r.ok && sz3 && sz3.width === 4 && sz3.height === 4) || (!r.ok && r.error.code === 'unavailable'),
        r.ok ? '' : JSON.stringify(r.error));
    } else {
      check('capture without Screen Recording -> error code "permission"', !r.ok && r.error.code === 'permission', JSON.stringify(r.error ?? r.result).slice(0, 120));
      note('capture NOT verified end-to-end: Screen Recording is not granted to this process. Grant it to the terminal/IDE running the tests and re-run.');
    }
    r = await c.req('capture', { target: 'bogus' });
    check('capture rejects unknown target', !r.ok && r.error.code === 'bad-request');
    r = await c.req('capture', { target: 'window' });
    check('capture window without windowId -> bad-request', !r.ok && r.error.code === 'bad-request');

    // ---- input, dry-run only -----------------------------------------------------------------------
    const dry = (extra) => ({ dryRun: true, ...extra });
    for (const a of [{ action: 'move', x: 10, y: 10 }, { action: 'down', x: 10, y: 10, button: 'right' }, { action: 'up', x: 10, y: 10, button: 'right' },
      { action: 'click', x: 5, y: 5, button: 'middle', clicks: 2 }, { action: 'scroll', x: 5, y: 5, dx: 0, dy: 120 }, { action: 'scroll', dy: -3 }]) {
      r = await c.req('mouse', dry(a));
      check(`mouse dryRun ${a.action}${a.button ? ' ' + a.button : ''}`, r.ok && r.result.posted === false && r.result.events >= 1, JSON.stringify(r.result ?? r.error));
    }
    r = await c.req('keys', dry({ text: 'Hello, wörld! 😀\n\tend' }));
    check('keys dryRun text (unicode, emoji, newline, tab)', r.ok && r.result.posted === false && r.result.events >= 4, JSON.stringify(r.result ?? r.error));
    r = await c.req('keys', dry({ key: 'return' }));
    check('keys dryRun key', r.ok && r.result.posted === false && r.result.events === 2);
    r = await c.req('keys', dry({ key: 'a', modifiers: ['cmd', 'shift', 'alt', 'ctrl'] }));
    check('keys dryRun key with all modifiers', r.ok && r.result.events === 2);
    for (const [name, args] of [
      ['mouse missing x', { action: 'move', y: 1 }],
      ['mouse bad action', { action: 'wiggle', x: 1, y: 1 }],
      ['mouse bad button', { action: 'click', x: 1, y: 1, button: 'thumb' }],
      ['mouse x as string', { action: 'move', x: '1', y: 1 }],
      ['mouse clicks out of range', { action: 'click', x: 1, y: 1, clicks: 99 }],
    ]) {
      r = await c.req('mouse', dry(args));
      check(`${name} -> bad-request`, !r.ok && r.error.code === 'bad-request');
    }
    for (const [name, args] of [
      ['keys neither text nor key', {}],
      ['keys both text and key', { text: 'a', key: 'a' }],
      ['keys unknown key', { key: 'flarp' }],
      ['keys unknown modifier', { key: 'a', modifiers: ['hyper'] }],
      ['keys modifiers with text', { text: 'a', modifiers: ['cmd'] }],
    ]) {
      r = await c.req('keys', dry(args));
      check(`${name} -> bad-request`, !r.ok && r.error.code === 'bad-request');
    }
    // (mouse/keys WITHOUT dryRun are deliberately not exercised: they would drive the owner's real desktop.)

    // ---- panic hotkey: register and immediately release (does not press anything) -------------------
    r = await c.req('panic-hotkey', { enable: true });
    const hkOk = r.ok && r.result.enabled === true;
    check('panic-hotkey enable (Ctrl-Opt-Cmd-.)', hkOk || (!r.ok && r.error.code === 'failed'), JSON.stringify(r.result ?? r.error));
    if (!hkOk) note('panic hotkey could not be registered (probably already held by another process, e.g. a running loader).');
    r = await c.req('panic-hotkey', { enable: false });
    check('panic-hotkey disable', r.ok && r.result.enabled === false);
    r = await c.req('panic-hotkey', {});
    check('panic-hotkey without enable -> bad-request', !r.ok && r.error.code === 'bad-request');
    note('firing the hotkey (an unsolicited {"event":"panic"} line) needs a real key press and is not tested here.');

    // ---- permissions op shape only (no prompts: both flags false/absent) ---------------------------
    r = await c.req('request-permissions', {});
    check('request-permissions {} (no prompt) returns status', r.ok && typeof r.result.screenRecording === 'boolean');
    r = await c.req('request-permissions', { screenRecording: 'yes' });
    check('request-permissions rejects non-boolean', !r.ok && r.error.code === 'bad-request');

    // ---- malformed requests: error replies, process survives --------------------------------------
    let m = await c.raw('this is not json');
    check('garbage line -> bad-request, id null', !m.ok && m.id === null && m.error.code === 'bad-request');
    m = await c.raw('[1,2,3]');
    check('JSON array -> bad-request', !m.ok && m.error.code === 'bad-request');
    m = await c.raw('{"id":501}', 501);
    check('missing op -> bad-request, id echoed', !m.ok && m.id === 501 && m.error.code === 'bad-request');
    m = await c.raw('{"id":502,"op":7}', 502);
    check('non-string op -> bad-request', !m.ok && m.error.code === 'bad-request');
    m = await c.raw('{"id":503,"op":"rm-rf"}', 503);
    check('unknown op -> unknown-op', !m.ok && m.error.code === 'unknown-op');
    m = await c.raw('{"id":"str-id","op":"ping"}', 'str-id');
    check('string ids are echoed', m.ok && m.id === 'str-id');
    c.proc.stdin.write('\n\n   \n');
    r = await c.req('ping');
    check('process survived all of the above (ping)', r.ok && r.result.pong === true);
    check('stdout carried only protocol lines', c.badLines.length === 0, c.badLines.slice(0, 2).join(' | '));
    check('no unsolicited events without a key press', c.events.length === 0);
    check('process still running', c.proc.exitCode === null && c.proc.signalCode === null);

    // ---- EOF -> exit -----------------------------------------------------------------------------
    c.close();
    const t0 = Date.now();
    const ex = await Promise.race([c.exited, sleep(3000).then(() => null)]);
    check('stdin EOF -> exits within 3 s', ex !== null && ex.code === 0, ex ? `exit ${ex.code} after ${Date.now() - t0} ms` : 'still running');
  } catch (e) {
    check('test run completed without exception', false, String(e && e.message || e));
  } finally {
    c.kill();
  }

  // ---- parent death -> exit (kqueue NOTE_EXIT), with stdin held open by this test via a FIFO ----------
  const work = resolve(process.env.VMAPP_WORK || join(VMAPP, 'out', 'work'), 'scratch');
  mkdirSync(work, { recursive: true });
  const dir = mkdtempSync(join(work, 'hostctl-test-'));
  const fifo = join(dir, 'stdin.fifo');
  let holder = null, parent = null;
  try {
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const { openSync, closeSync } = await import('node:fs');
    holder = openSync(fifo, 'r+');            // keeps the FIFO open: hostctl's stdin cannot hit EOF
    parent = spawn(process.execPath, [join(HERE, 'parent-helper.mjs'), BIN, fifo], { stdio: ['ignore', 'pipe', 'inherit'] });
    const pid = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('parent-helper did not report a pid')), 5000);
      parent.stdout.once('data', (d) => { clearTimeout(t); res(parseInt(String(d).trim(), 10)); });
    });
    await sleep(600);
    check('parent-death setup: hostctl is running under a child parent', Number.isInteger(pid) && alive(pid));
    parent.kill('SIGKILL');
    const t0 = Date.now();
    let gone = false;
    while (Date.now() - t0 < 3000) { if (!alive(pid)) { gone = true; break; } await sleep(50); }
    check('kill -9 of the parent -> hostctl exits within 3 s', gone, gone ? `${Date.now() - t0} ms` : 'still running');
    if (!gone) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
    closeSync(holder);
    holder = null;
  } catch (e) {
    check('parent-death test ran', false, String(e && e.message || e));
  } finally {
    try { parent?.kill('SIGKILL'); } catch { /* ignore */ }
    try { unlinkSync(fifo); } catch { /* ignore */ }
    try { rmdirSync(dir); } catch { /* ignore */ }
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${results.length - failures}/${results.length} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
