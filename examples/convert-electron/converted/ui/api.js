'use strict';
// ui/api.js: replaces the Electron preload.js. It recreates `window.api` on top of `window.vmapp`, so renderer.js
// (and every other file of the original renderer) runs without a single changed line.
//
// How it maps (compare with original/preload.js, which this file follows line by line):
//   contextBridge.exposeInMainWorld('api', {...})  ->  window.api = {...}
//   ipcRenderer (from require('electron'))         ->  window.vmapp.ipcRenderer  { invoke, send, on }
//   ipcRenderer.on(ch, fn) + removeListener        ->  vmapp.on(ch, fn) returns the unsubscribe function
// Channel names are the same, so the core's ipcMain.handle('open-file' ...) etc. need no change either.
(function () {
  var ipcRenderer = window.vmapp.ipcRenderer;

  window.api = Object.freeze({
    // Asks the core to read a Markdown file. No argument: the core shows the native open dialog.
    // Resolves to { path, name, content }, or null if the dialog was cancelled.
    openFile: function (filePath) {
      return filePath === undefined ? ipcRenderer.invoke('open-file') : ipcRenderer.invoke('open-file', filePath);
    },
    // The recent-files list: [{ path, name, openedAt }], newest first.
    recent: function () {
      return ipcRenderer.invoke('recent:list');
    },
    addRecent: function (entry) {
      return ipcRenderer.invoke('recent:add', entry);
    },
    // "File > Open…". Format 1 apps have no application menu, so this is now a UI feature:
    //  - the core could still push 'menu:open' (nothing does today), and
    //  - Cmd/Ctrl+O is handled here, which is what the menu accelerator used to do.
    // Returns a function that removes both listeners.
    onMenuOpen: function (callback) {
      var offPush = ipcRenderer.on('menu:open', function () { callback(); });
      function onKey(e) {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          callback();
        }
      }
      window.addEventListener('keydown', onKey);
      return function () {
        offPush();
        window.removeEventListener('keydown', onKey);
      };
    },
  });
})();
