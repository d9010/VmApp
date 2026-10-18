'use strict';
// =====================================================================================================================
// core/main.js: the CORE of the Starter app (what Electron calls the "main process").
//
// WHERE THIS RUNS: inside a small Linux VM, not on your Mac. The VM has no network, and it can only see two
// kinds of places on your computer:
//   * /data     the app's private storage (app.getPath('userData')), always available
//   * folders   the folders the USER chose to share when the app was first opened (see "permissions" in vmapp.json)
// So even if this code were malicious, it could not read your files, because they are not there.
//
// WHAT THIS FILE DOES: it answers questions from the UI (the window you see) and does the things the UI is not
// allowed to do itself: read files, show native dialogs, keep state. The UI talks to this file only through the
// bridge: window.vmapp.invoke('channel') in the UI arrives at ipcMain.handle('channel') here.
//
// Read the numbered STEPs from top to bottom; TEMPLATE.md walks through them too.
// =====================================================================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

// STEP 1. Load the SDK.
// 'vmapp' is a module that is pre-installed in the node22 runtime (NODE_PATH points at it), so there is nothing to
// `npm install`. Its API copies Electron's main process on purpose, so Electron code ports with little change.
// `folders` is an object { <folder name from vmapp.json>: path | null }. The value is null when the user said no.
const { app, BrowserWindow, ipcMain, dialog, shell, folders } = require('vmapp');

// The window title. `vmapp new` replaces the quoted word 'Starter' in the next line with your app's name.
const WINDOW_TITLE = 'Starter';

// How often (ms) we push a 'tick' event to the UI, to show core -> UI messages (see STEP 5).
const TICK_MS = 2000;

// STEP 2. State that survives restarts.
// Everything outside /data and the granted folders disappears when the VM stops (the VM's disk is read-only and
// /tmp is memory). So anything you want to keep goes under app.getPath('userData'), which is /data in the VM and a
// private folder for this app on the host. It is kept across restarts and across app updates.
const STATE_FILE = path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {}; // first run (no file yet), or a damaged file: start fresh
  }
}

const state = Object.assign({ counter: 0, launches: 0, lastTick: 0 }, loadState());
state.launches += 1; // how many times the app has been started; shown in the UI, and checked by the test

function saveState() {
  // Write a temp file, then rename it over the real one: if the VM is stopped half-way through the write, the old
  // state.json is still intact instead of being cut in half.
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

// STEP 3. Handlers: the questions the UI can ask.
// ipcMain.handle(channel, fn) answers window.vmapp.invoke(channel, ...args). `fn` gets (event, ...args); whatever it
// returns (or the promise it resolves) goes back to the UI. Both arguments and results must be JSON data (no
// functions, no Buffers, no class instances). If `fn` throws, the UI's promise rejects with the message only.

// 'info': proves where the code runs. In the UI you will see a Linux kernel and uid 1000, not your Mac.
ipcMain.handle('info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  node: process.version,
  uid: process.getuid(), // 1000: the unprivileged "app" user of the VM
  kernel: os.release(), // the VM's Linux kernel, not macOS
  platform: `${process.platform}/${process.arch}`,
  userData: app.getPath('userData'),
}));

// 'documents:list': the user-granted folder. folders.documents is a path like /host/f-documents when the user
// shared it, or null when they skipped it. ALWAYS handle null: users are allowed to say no.
ipcMain.handle('documents:list', () => {
  if (!folders.documents) return null; // the UI turns this into "you did not share a folder"
  return fs
    .readdirSync(folders.documents, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    .sort()
    .slice(0, 200); // keep the reply small: a bridge message is at most 16 MiB
});

// 'counter:get' / 'counter:increment': a tiny persisted value, to show that /data survives restarts.
ipcMain.handle('counter:get', () => ({ value: state.counter, launches: state.launches }));
ipcMain.handle('counter:increment', () => {
  state.counter += 1;
  saveState(); // save right away so a crash or kill loses nothing
  return { value: state.counter, launches: state.launches };
});

// 'file:open': a native "Open" dialog. The dialog itself is drawn by the HOST (the loader), never by this code, and
// the USER picks the file. The host then puts a read-only copy of just that file into the VM and tells us where.
// You can only ever read what the user picked; you cannot see the folder around it.
ipcMain.handle('file:open', async () => {
  const picked = await dialog.showOpenDialog({ title: 'Choose a text file', properties: ['openFile'] });
  if (picked.canceled) return { canceled: true };
  const file = picked.filePaths[0]; // e.g. /host/pick-0/notes.txt
  // Read only the first 2 KB. Never read huge files into one bridge message.
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { canceled: false, name: path.basename(file), size: fs.fstatSync(fd).size, preview: buf.subarray(0, n).toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
});

// 'file:save': a native "Save" dialog. The user chooses where the file goes; we are given a path inside the VM
// (/host/save-0/<name>) and write there. The host then delivers the file to the chosen place a moment later. We
// never learn the real location. For big files, write "<name>.partial" first and rename it when done, so the host
// does not deliver a half-written file.
ipcMain.handle('file:save', async (event, text) => {
  const picked = await dialog.showSaveDialog({ title: 'Save your note', defaultPath: 'starter-note.txt' });
  if (picked.canceled) return { canceled: true };
  fs.writeFileSync(picked.filePath, String(text));
  return { canceled: false, bytes: Buffer.byteLength(String(text)) };
});

// 'link:open': ask the host to open a web address in the user's own browser. This is the only way out to the web
// (the VM and the UI have no network). The user is asked to confirm each time, and only https: links are allowed.
// It needs "external": true in vmapp.json. Returns true if the user agreed, false if they said no.
ipcMain.handle('link:open', () => shell.openExternal('https://example.com'));

// STEP 4. Create the window once the app is ready.
// app.whenReady() resolves after the host has sent us its startup info (this also fills `folders`). Only then may you
// create windows. loadFile() is relative to the UI folder (ui.root in vmapp.json, "ui" here).
// `win` and `ticker` are declared outside so the code in STEP 5 and STEP 6 can reach them.
let win = null;
let ticker = null;

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 760, height: 820, minWidth: 520, minHeight: 480, title: WINDOW_TITLE });
  await win.loadFile('index.html'); // resolves when the host has created the window

  // STEP 5. Core -> UI events.
  // The UI only asks questions when the user clicks, but the core can push a message at any time.
  // win.webContents.send(channel, ...args) arrives in the UI at window.vmapp.on(channel, listener).
  let tick = 0;
  ticker = setInterval(() => {
    tick += 1;
    state.lastTick = tick; // kept in memory only; STEP 6 writes it to disk when the app quits
    win.webContents.send('tick', tick);
  }, TICK_MS);

  // When the user closes the window, stop pushing events to it.
  win.on('closed', () => {
    clearInterval(ticker);
    win = null;
  });
});

// STEP 6. Quitting.
// 'before-quit' runs when the app is about to stop: the user chose Quit, the window closed, or the loader is
// shutting down. You have about 3 seconds. This is the place to flush anything you only keep in memory
// (here `lastTick`; the counter is already saved).
app.on('before-quit', () => {
  clearInterval(ticker);
  saveState();
});

// STEP 7. What to do when the last window closes.
// This is Electron's rule ("you decide"). Calling app.quit() is also the DEFAULT when you register no listener, so this
// is only here to show the choice. An app that lives on without windows would register a listener that does not quit.
// Quitting matters in vmapp: when the core exits, the whole VM powers off, so nothing is left running.
app.on('window-all-closed', () => {
  app.quit();
});
