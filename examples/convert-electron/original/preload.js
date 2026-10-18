'use strict';
// Preload: the only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Asks the main process to read a Markdown file. No argument: shows the native open dialog.
  // Resolves to { path, name, content }, or null if the dialog was cancelled.
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  // The recent-files list: [{ path, name, openedAt }], newest first.
  recent: () => ipcRenderer.invoke('recent:list'),
  addRecent: (entry) => ipcRenderer.invoke('recent:add', entry),
  // File > Open… in the application menu. Returns a function that removes the listener.
  onMenuOpen: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu:open', listener);
    return () => ipcRenderer.removeListener('menu:open', listener);
  },
});
