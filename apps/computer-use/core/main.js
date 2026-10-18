'use strict';
/*
 * Desk Helper: the core of the computer-use sample app (SPEC 8.2, docs/HOST-CAPABILITIES.md).
 *
 * Everything that touches the user's computer goes through the SDK's `host` object:
 *   host.screen.windows() / host.screen.capture()   needs the `screen` grant
 *   host.input.start() -> session.mouse / keys / stop   needs the `input` grant (and shows the control badge)
 *   host.tool.list() / host.tool.run()               needs `tool:*` (the user picks which tools)
 *   host.mcp.list() / host.mcp.call()                needs `mcp:*` (the user picks which servers)
 *
 * Each of these is DENIED by default. A denied call rejects with "permission denied: ..." (not granted, or the user
 * said no in the dialog). So every handler below goes through `attempt`, which turns any failure into
 * {ok:false, denied, cap, error} for the UI to show, instead of crashing or hanging.
 *
 * Nothing here runs by itself: each handler is called by a button the user pressed in the window.
 */

const { app, BrowserWindow, ipcMain, host } = require('vmapp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000;

/**
 * Runs `fn`; success -> {ok:true, ...fn's object}. Failure -> {ok:false, cap, denied, error}.
 * `denied` is true for "permission denied: ..." (no grant, the user answered no, the app is stopping).
 */
async function attempt(cap, fn) {
  try {
    return Object.assign({ ok: true }, await fn());
  } catch (e) {
    const error = String(e && e.message !== undefined ? e.message : e);
    return { ok: false, cap, denied: /^permission denied/.test(error), error };
  }
}

/** One input session for one short job. Always stopped, even when a step fails, so the badge goes away at once. */
async function withInput(reason, job) {
  const session = await host.input.start(reason); // the user may be asked here; the badge appears when it starts
  try {
    return await job(session);
  } finally {
    await session.stop().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------ screen

// What the user picked last time, as the SUGGESTION for the next screenshot. The parameters of host.screen.capture are only a
// suggestion: the loader asks the user what to share (a display, a window or a region) and the app gets only that. In `ask`
// mode the user's last choice is preselected in that question; in `session` mode (no question) this is what is captured,
// or the main display when it no longer exists. Nothing here assumes the suggestion was honoured: `target` says what was.
let lastTarget = null;
function suggestionFor(t) {
  if (!t) return { target: 'display' };
  if (t.kind === 'window') return { target: 'window', windowId: t.windowId };
  if (t.kind === 'region') return { target: 'region', region: t.region };
  return t.display === undefined ? { target: 'display' } : { target: 'display', display: t.display };
}

// Look at my screen: a screenshot (at most 1024 points wide) of what the user shares, plus the window list.
// The PNG travels to the UI as base64 (the UI turns it into a blob: URL; its CSP allows img-src blob:).
// `target` is what was ACTUALLY captured: {kind: 'display' | 'window' | 'region', display?, windowId?, region?, bounds, by}.
// `bounds` is the captured area in global desktop points, which is what the UI needs to turn a click on the picture into a
// point for the mouse (input coordinates are always global points, whatever was captured).
ipcMain.handle('desk:look', () =>
  attempt('screen', async () => {
    const shot = await host.screen.capture(Object.assign({ maxWidth: 1024 }, suggestionFor(lastTarget)));
    lastTarget = shot.target || null;
    // the window list is a separate question; saying no to it must not lose the screenshot
    let windows = [];
    let windowsError = null;
    try {
      windows = (await host.screen.windows()).slice(0, 60).map((w) => ({ windowId: w.windowId, app: w.app, title: w.title, bounds: w.bounds }));
    } catch (e) {
      windowsError = String(e && e.message !== undefined ? e.message : e);
    }
    return {
      shot: { png: shot.png.toString('base64'), width: shot.width, height: shot.height },
      target: shot.target || null,
      windows,
      windowsError,
    };
  }),
);

// ------------------------------------------------------------------------------------------ input

// Point and click demo: a fixed, scripted sequence at a point the user chose (global desktop points).
// start -> move -> (short pause) -> click -> stop. The user is asked first (mode `ask`) and sees the badge.
ipcMain.handle('desk:click', (_e, p) =>
  attempt('input', async () => {
    const x = p && p.x;
    const y = p && p.y;
    if (!isNum(x) || !isNum(y)) throw new Error('Pick a point on the screenshot first.');
    await withInput(`Desk Helper demo: move the pointer to (${Math.round(x)}, ${Math.round(y)}) and click once`, async (s) => {
      await s.mouse({ action: 'move', x, y });
      await sleep(400); // lets you see where it is going
      await s.mouse({ action: 'click', x, y, button: 'left', clicks: 1 });
    });
    return { steps: ['input.start', 'mouse move', 'mouse click', 'input.stop'], x, y };
  }),
);

// Type text into whatever app has the keyboard focus. The UI counts down 3 s before it calls this, so you can click
// into the target app first. Only the length is shown in the permission question and the Inspector.
ipcMain.handle('desk:type', (_e, p) =>
  attempt('input', async () => {
    const text = p && p.text;
    if (typeof text !== 'string' || !text.length) throw new Error('Type some text to send first.');
    if ([...text].length > 2000) throw new Error('The demo types at most 2000 characters.');
    const n = [...text].length;
    await withInput(`Desk Helper demo: type ${n} character${n === 1 ? '' : 's'} into the focused app`, (s) => s.keys({ text }));
    return { typed: n };
  }),
);

// ------------------------------------------------------------------------------------------ tools

// The tools the user registered AND granted to this app. The list never contains host paths, only id, name, kind,
// description and the argument patterns.
ipcMain.handle('desk:tools', () => attempt('tool:*', async () => ({ tools: await host.tool.list() })));

ipcMain.handle('desk:tool-run', (_e, p) =>
  attempt(`tool:${p && p.id}`, async () => {
    if (!p || typeof p.id !== 'string' || !p.id) throw new Error('Pick a tool first.');
    const args = Array.isArray(p.args) ? p.args.map(String) : [];
    const opts = typeof p.stdin === 'string' && p.stdin.length ? { stdin: p.stdin } : undefined;
    // No shell: every argument is one argv entry, checked against the tool's patterns by the host.
    return { result: await host.tool.run(p.id, args, opts) };
  }),
);

// ------------------------------------------------------------------------------------------ MCP

// Granted MCP servers with their tools (the host starts each server on first use and answers tools/list).
ipcMain.handle('desk:mcp-list', () =>
  attempt('mcp:*', async () => {
    const servers = await host.mcp.list();
    return {
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        error: s.error,
        tools: (s.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })),
    };
  }),
);

ipcMain.handle('desk:mcp-call', (_e, p) =>
  attempt(`mcp:${p && p.server}`, async () => {
    if (!p || typeof p.server !== 'string' || typeof p.tool !== 'string' || !p.server || !p.tool) throw new Error('Pick a server and a tool first.');
    const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args : {};
    return { result: await host.mcp.call(p.server, 'tools/call', { name: p.tool, arguments: args }) };
  }),
);

// ------------------------------------------------------------------------------------------ window

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 780, minWidth: 720, minHeight: 520, title: 'Desk Helper' });
  await win.loadFile('index.html');
});
