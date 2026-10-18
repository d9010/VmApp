'use strict';
// A fake vmapp-hostctl for the tests (protocol: host/hostctl/README.md). It never touches the desktop: windows and
// captures are canned, mouse and keys only echo whether they were asked to dry-run.
//   FAKE_HOSTCTL_LOG=<file>   every request is appended as one JSON line {op, args}
//   FAKE_HOSTCTL_BIG=1        capture answers with a 13 MB image unless maxWidth <= 1920 (tests the size fallback)
//   FAKE_HOSTCTL_PANIC_FILE=<file>  when this file appears it is deleted and the panic event is emitted (the loader
//                                   tests press the "hotkey" this way: the helper is the loader's child, so they cannot
//                                   send it a request)
// Test-only ops: {"op":"__panic"} makes it emit the panic event; {"op":"__exit"} makes it exit.
const fs = require('fs');
const readline = require('readline');

const LOG = process.env.FAKE_HOSTCTL_LOG;
const PANIC_FILE = process.env.FAKE_HOSTCTL_PANIC_FILE;
if (PANIC_FILE) {
  setInterval(() => {
    if (!fs.existsSync(PANIC_FILE)) return;
    try {
      fs.rmSync(PANIC_FILE, { force: true });
    } catch {
      /* gone */
    }
    process.stdout.write(JSON.stringify({ event: 'panic' }) + '\n');
  }, 50).unref();
}
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Canned desktop (global points, origin top left of the main display): two displays side by side and three windows. The
// third window belongs to the PARENT process of this helper, i.e. the loader (or the test process): like the loader's real
// badge / overlay / picker it must never be listed to an app or appear in a capture, which `excludePids` asks for.
const DISPLAYS = [
  { display: 1, bounds: { x: 0, y: 0, w: 1440, h: 900 }, scale: 2, main: true, name: 'Built-in Retina Display', builtin: true },
  { display: 2, bounds: { x: 1440, y: 0, w: 1920, h: 1080 }, scale: 1, main: false, name: 'External Monitor', builtin: false },
];
const WINDOWS = [
  { windowId: 7, app: 'FakeApp', pid: 1, title: 'Fake window', bounds: { x: 0, y: 0, w: 100, h: 80 }, onScreen: true, layer: 0 },
  { windowId: 8, app: 'Notes', pid: 2, title: 'Shopping list', bounds: { x: 1500, y: 100, w: 500, h: 400 }, onScreen: true, layer: 0 },
  { windowId: 99, app: 'D9010 VmApp Launcher', pid: process.ppid, title: 'D9010 VmApp control badge', bounds: { x: 400, y: 0, w: 540, h: 46 }, onScreen: true, layer: 0 },
];
const area = (r) => (r.w > 0 && r.h > 0 ? r.w * r.h : 0);
const overlap = (a, b) => area({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) });
const clip = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
};
const bestDisplay = (r) => DISPLAYS.map((d) => [overlap(d.bounds, r), d]).sort((p, q) => q[0] - p[0])[0];

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return reply({ id: null, ok: false, error: { code: 'bad-request', message: 'not JSON' } });
  }
  const { id, op, ...args } = req;
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ op, args }) + '\n');
  const ok = (result) => reply({ id, ok: true, result });
  switch (op) {
    case 'ping':
      return ok({ pong: true });
    case 'status':
      return ok({ screenRecording: true, accessibility: true, macos: '15.7' });
    case 'request-permissions': // the real one shows the system prompts; the fake only answers with the (fake) status
      return ok({ screenRecording: true, accessibility: true, macos: '15.7' });
    case 'windows':
      return ok(WINDOWS);
    case 'displays':
      return ok(DISPLAYS);
    case 'capture': {
      const err = (code, message) => reply({ id, ok: false, error: { code, message } });
      const excluded = Array.isArray(args.excludePids) ? args.excludePids : [];
      // what the real helper reports: the display used and the captured area in global points (the area is clipped)
      let display;
      let bounds;
      if (args.target === 'window') {
        const w = WINDOWS.find((x) => x.windowId === args.windowId);
        if (!w || excluded.includes(w.pid)) return err('not-found', 'window not found'); // a window of an excluded process cannot be captured
        bounds = w.bounds;
        display = bestDisplay(bounds)[1].display;
      } else if (args.target === 'region') {
        const r = args.region || {};
        const [best, d] = bestDisplay(r);
        if (!(best > 0)) return err('bad-request', 'region is outside every display');
        display = d.display;
        bounds = clip(r, d.bounds);
      } else {
        const d = args.display === undefined ? DISPLAYS[0] : DISPLAYS.find((x) => x.display === args.display);
        if (!d) return err('not-found', 'display not found');
        display = d.display;
        bounds = d.bounds;
      }
      if (process.env.FAKE_HOSTCTL_BIG && (args.maxWidth === undefined || args.maxWidth > 1920)) return ok({ png: 'A'.repeat(13 * 1024 * 1024), width: 4000, height: 3000, display, bounds });
      // `omitted` (test-only, not a real field): the canned windows the picture would have left out because of excludePids
      const omitted = args.target === 'window' ? [] : WINDOWS.filter((w) => excluded.includes(w.pid)).map((w) => w.windowId);
      return ok({ png: PNG_B64, width: args.maxWidth || 1, height: 1, display, bounds, omitted });
    }
    case 'mouse':
    case 'keys':
      return ok({ posted: !args.dryRun, events: 1 });
    case 'panic-hotkey':
      return ok({ enabled: !!args.enable });
    case '__panic':
      ok({});
      return reply({ event: 'panic' });
    case '__exit':
      ok({});
      return process.exit(0);
    default:
      return reply({ id, ok: false, error: { code: 'unknown-op', message: `unknown op ${op}` } });
  }
}).on('close', () => process.exit(0));
