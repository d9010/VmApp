'use strict';
// Markdown Viewer: main process.
const { app, BrowserWindow, ipcMain, dialog } = require('vmapp');
const path = require('path');
const fs = require('fs/promises');

const RECENT_MAX = 8;
let mainWindow = null;

// ---- recent files, persisted in <userData>/recent.json -----------------------------------------------------

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');

async function readRecent() {
  try {
    const list = JSON.parse(await fs.readFile(recentFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // no file yet, or unreadable: start empty
  }
}

async function writeRecent(list) {
  await fs.mkdir(path.dirname(recentFile()), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(list, null, 2));
}

// ---- IPC ---------------------------------------------------------------------------------------------------

// open-file: with a path, reads that file; without one, asks the user with the native open dialog.
// Returns null when the dialog is cancelled, otherwise { path, name, content }.
ipcMain.handle('open-file', async (_event, requestedPath) => {
  let filePath = requestedPath;
  if (!filePath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Markdown file',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    filePath = result.filePaths[0];
  }
  const content = await fs.readFile(filePath, 'utf8');
  return { path: filePath, name: path.basename(filePath), content };
});

ipcMain.handle('recent:list', () => readRecent());

ipcMain.handle('recent:add', async (_event, entry) => {
  if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string') {
    throw new Error('recent:add needs { path, name }');
  }
  const list = (await readRecent()).filter((e) => e.path !== entry.path);
  list.unshift({ path: entry.path, name: entry.name, openedAt: new Date().toISOString() });
  const trimmed = list.slice(0, RECENT_MAX);
  await writeRecent(trimmed);
  return trimmed;
});

// ---- window ------------------------------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 480,
    minHeight: 320,
    title: 'Markdown Viewer',
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
