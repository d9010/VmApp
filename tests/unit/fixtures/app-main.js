'use strict';
// A tiny SDK app used by the unit tests (runs as a plain child process; VMAPP_SOCKET is set by the test).
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, folders, host } = require('../../../sdk/node/vmapp.js');

const marks = process.env.APP_MARKS; // optional file the app appends marker lines to
function mark(s) {
  if (marks) fs.appendFileSync(marks, s + '\n');
}

let win = null;
const order = [];

app.on('ready', () => order.push('ready-event'));
app.on('before-quit', async () => {
  await new Promise((r) => setTimeout(r, 50));
  mark('before-quit');
});

app.whenReady().then(async () => {
  order.push('whenReady');
  win = new BrowserWindow({ width: 640, height: 480, title: 'Fixture' });
  // sent before the window exists on the host: must be queued and delivered after creation
  win.webContents.send('early', 1, 2);
  await win.loadFile('index.html');
  win.webContents.send('hello', { name: app.getName(), version: app.getVersion(), data: app.getPath('userData') });
});

// host capabilities (SPEC 8.2) through the SDK: 'host' calls host.<a>.<b>(...args); Buffers come back as {bytes, magic}
ipcMain.handle('host', async (e, name, ...args) => {
  const fn = name.split('.').reduce((o, k) => o[k], host);
  const r = await fn(...args);
  return r && Buffer.isBuffer(r.png) ? { ...r, png: undefined, bytes: r.png.length, magic: r.png.subarray(1, 4).toString() } : r;
});
ipcMain.handle('host-input', async (e, reason, steps) => {
  const s = await host.input.start(reason);
  const out = [];
  for (const [kind, p] of steps) out.push(await s[kind](p));
  return { id: s.id, out };
});
ipcMain.handle('echo', (e, ...args) => args);
ipcMain.handle('api-keys:set', (e, ...args) => ({ success: true, saved: args.length })); // a channel whose name suggests a secret
ipcMain.handle('nothing', () => undefined);
ipcMain.handle('fail', () => {
  throw new Error('boom');
});
ipcMain.handle('fail-async', async () => {
  throw new Error('async boom');
});
ipcMain.handle('circular', () => {
  const o = {};
  o.self = o;
  return o;
});
ipcMain.handle('folders', () => folders);
ipcMain.handle('order', () => order);
ipcMain.handle('who', (e) => ({ win: e.senderWindow && e.senderWindow.id, same: e.sender === win.webContents }));
// app links (SPEC 8.9): every vmapp:// link the host delivers, as Electron's open-url
const links = [];
app.on('open-url', (event, url) => links.push({ url, preventDefault: typeof event.preventDefault === 'function' }));
ipcMain.handle('links', () => links);
ipcMain.handle('windows', () => BrowserWindow.getAllWindows().map((w) => w.id));
ipcMain.handle('from-id', (e, id) => (BrowserWindow.fromId(id) === win ? 'win' : BrowserWindow.fromId(id) === null ? 'null' : 'other'));
ipcMain.handle('emit', (e, channel, ...args) => {
  win.webContents.send(channel, ...args);
});
ipcMain.handle('title', (e, t) => {
  win.setTitle(t);
});
ipcMain.handle('focus', () => {
  win.focus();
});
ipcMain.handle('second-window', async () => {
  // devTools is the one webPreferences key the SDK honours; the others are ignored with one warning per run
  const w2 = new BrowserWindow({ width: 300, height: 200, webPreferences: { devTools: true, preload: '/x.js', sandbox: false } });
  await w2.loadFile('second.html');
  return w2.id;
});
ipcMain.handle('third-window', async () => {
  const w3 = new BrowserWindow({ width: 300, height: 200, webPreferences: { devTools: 'yes', nodeIntegration: true } });
  await w3.loadFile('third.html');
  return w3.id;
});
ipcMain.handle('close-win', () => {
  win.close();
});
ipcMain.handle('quit', () => {
  setTimeout(() => app.quit(), 10);
});
ipcMain.handle('dialog:open', async (e, dir, multiple, access) => {
  const props = [dir ? 'openDirectory' : 'openFile'];
  if (multiple) props.push('multiSelections');
  return dialog.showOpenDialog(win, { title: 'Pick', properties: props, access });
});
ipcMain.handle('dialog:save', (e, p) => dialog.showSaveDialog({ title: 'Save', defaultPath: p }));
ipcMain.handle('dialog:msg', () => dialog.showMessageBox(win, { type: 'question', message: 'Sure?', detail: 'really', buttons: ['No', 'Yes'] }));
ipcMain.handle('external', (e, url) => shell.openExternal(url));
// an Electron-style application menu: composite and loader-owned roles, a checkbox, click handlers that record what ran
const menuRuns = [];
ipcMain.handle('menu:set', () =>
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [{ label: 'New', accelerator: 'CmdOrCtrl+N', click: () => menuRuns.push('new') }, { type: 'separator' }, { role: 'quit' }, { id: 'save', label: 'Save', click: (item) => menuRuns.push(`save:${item.id}`) }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ id: 'wrap', label: 'Word Wrap', type: 'checkbox', checked: false, click: (item) => menuRuns.push(`wrap:${item.checked}`) }, { role: 'toggleDevTools' }, { label: 'Quit Me', accelerator: 'Cmd+Q', click: () => menuRuns.push('quit-me') }] },
    ]),
  ),
);
ipcMain.handle('menu:runs', () => menuRuns.slice());
ipcMain.handle('menu:get', () => !!Menu.getApplicationMenu() && Menu.getApplicationMenu().getMenuItemById('wrap').checked);
ipcMain.handle('menu:bad', () => Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'X', submenu: [{ label: 'Y', accelerator: 'Cmd+Nope' }] }])));
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (e, text) => clipboard.writeText(text).then(() => 'written'));
ipcMain.handle('write-file', (e, p, text) => {
  fs.writeFileSync(p, text);
  return path.basename(p);
});
ipcMain.on('ping', (e, x) => {
  win.webContents.send('pong', x);
});
ipcMain.on('throws', () => {
  throw new Error('listener failure');
});

// ---- Electron's ipcMain / IpcMainEvent contract (tests/electron-conformance/MAPPING.md) ----
ipcMain.on('test-echo', (e, arg) => {
  e.reply('test-echo', arg); // spec/api-ipc-main-spec.ts "can be replied to"
});
ipcMain.on('event-shape', (e) => {
  win.webContents.send('shape', {
    keys: Object.keys(e).sort(),
    type: e.type,
    processId: e.processId,
    frameId: e.frameId,
    sender: e.sender === win.webContents,
    reply: typeof e.reply,
    ports: Array.isArray(e.ports),
  });
});
ipcMain.handle('invoke-shape', (e) => ({ keys: Object.keys(e).sort(), type: e.type, processId: e.processId, frameId: e.frameId, reply: typeof e.reply, ports: typeof e.ports }));
ipcMain.handle('main-api', () => ({
  emitter: ipcMain instanceof require('events').EventEmitter,
  names: ipcMain.eventNames().filter((n) => typeof n === 'string').sort(),
}));
ipcMain.handle('register-twice', () => {
  ipcMain.handle('twice', () => 1);
  const out = {};
  try {
    ipcMain.handle('twice', () => 2);
  } catch (e) {
    out.second = e.message;
  }
  try {
    ipcMain.handle('not-a-function', 5);
  } catch (e) {
    out.notFn = [e.constructor.name, e.message];
  }
  ipcMain.removeHandler('twice');
  out.afterRemove = ipcMain.listenerCount('twice');
  return out;
});
ipcMain.handleOnce('once-only', () => 'first');
ipcMain.handle('throw-type', () => {
  throw new TypeError('bad type');
});
ipcMain.handle('throw-string', () => {
  throw 'just a string'; // eslint-disable-line no-throw-literal
});
ipcMain.handle('typed', () => [new Uint8Array([1, 2, 3]), new Date(0), new Map([[1, { a: 2 }]]), undefined, 10n, NaN, -0, new Set(['s']), new Error('inner')]);
ipcMain.handle('typed-self', () => {
  const o = { name: 'o' };
  o.self = o;
  return o;
});
ipcMain.handle('result-fn', () => () => 1);
ipcMain.handle('send-typed', (e, ...args) => {
  win.webContents.send('typed', ...args);
});
ipcMain.handle('send-bad', () => {
  try {
    win.webContents.send('x', { f: () => 1 });
    return 'sent';
  } catch (e) {
    return [e.constructor.name, e.message];
  }
});
ipcMain.on('async-fail', async () => {
  throw new Error('async listener failure');
});
ipcMain.on('seq', (e, x) => (global.__seq = (global.__seq || []).concat(`a${x}`)));
ipcMain.on('seq', (e, x) => (global.__seq = (global.__seq || []).concat(`b${x}`)));
ipcMain.handle('seq-seen', () => global.__seq || []);
ipcMain.once('one-shot', (e, x) => win.webContents.send('pong', `once:${x}`));
ipcMain.on('error', (e, x) => win.webContents.send('pong', `error-channel:${x}`));
