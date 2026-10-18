'use strict';
/*
 * Notes: the core ("main process") of the vmapp sample app.
 *
 * Porting from Electron: only the require changed.
 *
 *     - const { app, BrowserWindow, ipcMain, dialog } = require('electron');
 *     + const { app, BrowserWindow, ipcMain, dialog, folders } = require('vmapp');
 *
 * Everything else below is ordinary Electron main-process code: app.whenReady, BrowserWindow#loadFile,
 * ipcMain.handle, dialog.showOpenDialog / showMessageBox, app.getPath('userData'), win.webContents.send.
 * The one real difference is *where files live*. An Electron app would call fs on any path; here the core runs in a
 * VM and sees only the folders the user granted: `folders.notes` (read/write) and `folders.export` (write only).
 * Both are `null` when the user declined, and the app shows an explanation instead of crashing.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, folders } = require('vmapp');
const { toHtmlDocument } = require('./markdown');

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let win = null;

// ---------------------------------------------------------------------------------------------------- settings

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = Object.assign(loadSettings(), patch);
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch (e) {
    // a convenience setting must never break the action that triggered it
    console.error(`could not save settings: ${e.message}`);
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------- notes

function notesDir() {
  if (!folders.notes) throw new Error('The notes folder has not been granted. Allow it in the permission sheet.');
  return folders.notes;
}

/** A note name is a plain file name ending in .md: no folders, no dots-only names, no control characters. */
function checkName(name) {
  const n = String(name || '');
  if (!n || n !== path.basename(n) || n.startsWith('.') || /[\u0000-\u001f/\\]/.test(n) || n.length > 120) {
    throw new Error('Invalid note name');
  }
  return n.endsWith('.md') ? n : n + '.md';
}

function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error('Too many notes with that name');
}

function listNotes() {
  if (!folders.notes) return [];
  return fs
    .readdirSync(folders.notes, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => {
      const st = fs.statSync(path.join(folders.notes, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function notifyChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('notes:changed', listNotes());
}

ipcMain.handle('notes:status', () => ({
  notesGranted: !!folders.notes,
  exportGranted: !!folders.export,
  last: loadSettings().last || null,
  notes: listNotes(),
}));

ipcMain.handle('notes:list', () => listNotes());

ipcMain.handle('notes:read', (event, name) => {
  const file = path.join(notesDir(), checkName(name));
  if (fs.statSync(file).size > MAX_NOTE_BYTES) throw new Error('That note is too large to edit here');
  saveSettings({ last: path.basename(file) });
  return fs.readFileSync(file, 'utf8');
});

ipcMain.handle('notes:save', (event, name, text) => {
  const n = checkName(name);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new Error('The note is too large');
  fs.writeFileSync(path.join(notesDir(), n), text);
  saveSettings({ last: n });
  notifyChanged();
  return { name: n };
});

ipcMain.handle('notes:create', (event, wanted) => {
  const dir = notesDir();
  const name = uniqueName(dir, checkName(wanted || 'Untitled'));
  fs.writeFileSync(path.join(dir, name), `# ${name.replace(/\.md$/, '')}\n\n`);
  saveSettings({ last: name });
  notifyChanged();
  return { name };
});

ipcMain.handle('notes:delete', async (event, name) => {
  const n = checkName(name);
  const file = path.join(notesDir(), n);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: `Delete "${n}"?`,
    detail: 'This removes the file from your notes folder.',
    buttons: ['Delete', 'Cancel'],
  });
  if (response !== 0) return { deleted: false };
  fs.unlinkSync(file);
  if (loadSettings().last === n) saveSettings({ last: null });
  notifyChanged();
  return { deleted: true };
});

ipcMain.handle('notes:export', (event, name, text) => {
  if (!folders.export) throw new Error('The export folder has not been granted. Allow it in the permission sheet.');
  const n = checkName(name);
  // export what the editor shows if it sent the text, otherwise what is saved on disk
  const source = typeof text === 'string' ? text : fs.readFileSync(path.join(notesDir(), n), 'utf8');
  const out = n.replace(/\.md$/, '') + '.html';
  const target = path.join(folders.export, out);
  // Write-only folders deliver a file once it settles; names ending in .partial wait until the rename.
  fs.writeFileSync(target + '.partial', toHtmlDocument(n.replace(/\.md$/, ''), source));
  fs.renameSync(target + '.partial', target);
  win.webContents.send('notes:exported', { file: out });
  return { file: out };
});

ipcMain.handle('notes:import', async () => {
  const dir = notesDir();
  const r = await dialog.showOpenDialog(win, { title: 'Import a file as a note', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const source = r.filePaths[0]; // /host/pick-N/<file name>, a read-only copy
  if (fs.statSync(source).size > MAX_NOTE_BYTES) throw new Error('That file is too large to import');
  const base = path.basename(source);
  // "ideas.txt" becomes the note "ideas.md"; a file without a text-like name just gets ".md" added
  const stem = base.endsWith('.md') ? base.slice(0, -3) : base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const content = fs.readFileSync(source);
  const name = uniqueName(dir, checkName((stem.replace(/^\.+/, '') || 'Imported') + '.md'));
  fs.writeFileSync(path.join(dir, name), content);
  saveSettings({ last: name });
  notifyChanged();
  return { canceled: false, name };
});

// ---------------------------------------------------------------------------------------------------- window

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 980, height: 660, minWidth: 640, minHeight: 420, title: 'Notes' });
  await win.loadFile('index.html');
});
