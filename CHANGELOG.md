# Changelog

What changed in each version of the D9010 VmApp Launcher, newest first. The launcher shows the latest entry on its update card, the
website's download page links here, and each GitHub release carries the same text.

## [0.1.4] - 2026-10-18

The launcher checks for updates every time you open it, explains itself when it cannot update, and apps now follow Electron's rules for files and messages.

### Changed

- The launcher now looks for a newer version every time it starts, and at least once a day while it stays open, and tells you with the update card.
- Pictures, fonts, sounds, videos and style sheets that an app's own server provides now load the way they do in an Electron app: the launcher answers the page's requests for them itself, with streaming and `Range` support for audio and video. Apps whose window needed a workaround for this (the icons of the Code - OSS sample, for one) no longer do.
- Messages between an app's window and its core now carry everything Electron's IPC carries: dates, maps, sets, typed arrays, big integers, errors, `undefined` and shared or cyclic references. A handler that returns nothing now gives `undefined` (it gave `null`).
- When a handler fails, the window's promise now rejects with Electron's text: `Error invoking remote method '<channel>': <error>`.
- In an app's core, `ipcMain` is now a real `EventEmitter` (`once`, `eventNames`, `listenerCount`, …), its events carry `reply`, `type`, `processId` and `frameId` as in Electron, and `ipcMain.handle` reports the same errors Electron does. The sample runtimes are rebuilt with it.
- In an app's window, `window.vmapp.ipcRenderer` now has `once`, `addListener`, `removeAllListeners`, `eventNames` and `listenerCount`. `off`, `removeListener` and `sendSync` exist and explain, in their error, why they cannot work across the window's context bridge.

### Fixed

- A launcher opened straight from Downloads could not update itself and ended with a "read-only volume" error. It now says why (macOS runs it from a temporary read-only copy) and offers **Move to Applications**, which copies it there and opens it from there.

## [0.1.3] - 2026-10-18

Icons now show in the Code - OSS sample app.

### Fixed

- In the Code - OSS (VS Code) sample, the icons of installed extensions now appear: the activity bar, file and tab icons, and icon fonts were blank before.

### Changed

- The sample apps now list "D9010 VmApp samples" as their publisher.

## [0.1.2] - 2026-10-18

The launcher now uses one app registry, ours, and shows the newest apps first.

### Changed

- **Browse registry…** always lists the D9010 VmApp registry, newest apps first. You can search it and sort it by newest, most downloaded, recently updated or name.
- There is no longer a registry address to type: **Install from registry…** and **Type an app id or link…** are gone. To install an app, find it in **Browse registry…**, or use **Install from file…**.

## [0.1.1] - 2026-10-18

Fixes the launcher quitting as soon as it was opened. Version 0.1.0 does not start; please use this version instead.

### Fixed

- The launcher no longer quits right after you open it on a Mac: version 0.1.0 could not find its own helper programs and stopped at start.
- Downloading and unzipping the launcher no longer leaves stray `._` files inside it, which made macOS refuse to open it.

## [0.1.0] - 2026-10-18

The first public release, for macOS 13 or later on Apple silicon.

### Added

- The launcher: every app's engine runs in its own small virtual machine and its window in a sandbox on your Mac, and you choose which folders and which websites each app may reach.
- Fourteen sample apps come with the launcher: **Load examples** installs the ones you pick, and nothing is allowed until you say so.
- The Inspector shows every message between an app's window and its engine, and every internet connection an app tries, live.
- The launcher tells you when a newer version is available and can update itself. A card shows what changed and offers **Update now**, **Later** or **Skip this version**; **Check for Updates…** in the launcher's menu asks at any time, and a switch in Host Capabilities turns the automatic check off. Nothing is downloaded or restarted without your click, and the check sends nothing about you.
- Browse an app registry, install an app from it, and publish your own app from the launcher.
- Apps can ask to see your screen, use the mouse and keyboard, run tools you registered, use the microphone, or use your Mac's GPU. Each is off until you allow it, can be stopped at any time with one shortcut, and the experimental GPU path stays off until you turn it on.
