# Notes (`dev.vmapp.notes`, runtime `node22`)

Markdown notes in a folder you choose. The core is an Electron-style main process written with `require('vmapp')`:
`core/main.js` starts with a "Porting from Electron: only the require changed" comment block.

## What it shows

- **Folder grants.** `notes` (readwrite) is listed, read, saved, created and deleted under `/host/f-notes`.
  `export` (writeonly) receives `<name>.html`, written as `.partial` and renamed so the host delivers it complete.
  If `notes` was declined, the UI shows an explanation instead of a broken list.
- **Dialogs.** `dialog.showMessageBox` confirms a delete. `dialog.showOpenDialog({properties:['openFile']})` imports a
  file: the core reads the read-only copy at `/host/pick-N/<file>` and adds it as a note.
- **App data.** The last opened note is stored in `app.getPath('userData')/settings.json` (`/data`).
- **IPC.** `ipcMain.handle` for everything the UI calls through `window.vmapp.invoke`; `webContents.send` for
  `notes:changed` and `notes:exported`.
- A small Markdown to HTML converter (`core/markdown.js`: headings, paragraphs, bold, italic, code, lists, fenced code;
  all text escaped).

## Build, pack, run

No compile step.

```
vmapp/tools/vmapp pack vmapp/apps/notes -o notes.vmapp
vmapp/tools/vmapp install notes.vmapp
vmapp/tools/vmapp grant dev.vmapp.notes notes ~/Notes
vmapp/tools/vmapp grant dev.vmapp.notes export ~/Notes-export
vmapp/tools/vmapp run dev.vmapp.notes --headless --script vmapp/tests/apps/notes.mjs --open some-file.txt
```

In the D9010 VmApp Launcher, choose *Install...* and pick the `.vmapp`; the permission sheet asks for the two folders.
`vmapp/tests/apps/run-all.sh` does all of this against real VMs.
