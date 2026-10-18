# Code - OSS (`dev.vmapp.vscode`, runtime `node22`)

**VS Code 1.142.0**, built from its MIT source as Code - OSS, in a D9010 VmApp VM: the VS Code Server with its built-in extensions, its
terminal, its search and git run in the VM; VS Code's own web workbench runs in the sandboxed window. Nothing of VS Code was rewritten:
the window is the workbench bundle of the `vscode-reh-web` build target and the backend is the server of the same build, both from the
pinned tag. Four source files changed (+23 / -3 lines), each explained in [`patches/PATCHES.md`](patches/PATCHES.md); everything else is
listed in [`CONVERSION.md`](CONVERSION.md).

The editor sees only the folder you share with it (and folders you pick in a dialog), and cannot touch your Mac otherwise: the window has
no network, no files and no Node of its own (CSP `script-src 'self'` plus the declared window features), and the VM's only way out is the
host's allowlist proxy. The app asks for **any internet server** (`"host": "*"`, any port) so that git, npm, pip and the rest work from its
terminal; that stays off until you allow it in the permission sheet, and even then your local network and this Mac are never reachable.

## What you can do

- **Edit** with VS Code's editor: TextMate syntax highlighting for every built-in language (VS Code's Oniguruma WebAssembly, tokenized in
  a web worker), IntelliSense, diagnostics, go to definition, refactorings for TypeScript and JavaScript (tsserver in the VM), JSON, CSS,
  HTML, Markdown, PHP, Emmet.
- **Webviews**: the Markdown preview, extension pages and every extension's webview panels run in isolated frames (`vmapp-frame://`, one
  origin each, no access to the page or the platform).
- **The explorer, search and Quick Open** on the folder you shared at the first launch (it opens by default) or on **Open Folder from Your
  Mac…** (Command Palette, or the VM indicator in the status bar): a native dialog, the folder is shared read-write for this run. Files
  you change in Finder or another app show up within about 3 seconds.
- **The integrated terminal**: bash in the VM, in the shared folder, with `node` (Node 24.21.0, the server's), `git`, `code-oss <file>` (opens
  the file in the window) and the runtime's usual tools. Programs you run there can read and write the shared folder and nothing else of
  your Mac, and reach the internet only if you allowed it (never your local network).
- **Source Control** with git (local operations: commit, branch, diff, stash, history).
- **Run and Debug**: js-debug (a built-in) is installed and runs in the VM with the server's Node; debugging itself is not exercised by the
  tests yet.
- **Settings, keybindings, themes, profiles.**
- **Ports**: allow **Open its servers on this Mac (localhost)** and a server you start in the terminal (`npm run dev`, a preview) shows
  up in the Ports view and opens in your browser at `http://localhost:<port>`. Only this Mac can connect; the ports close with the app.
- **The menu bar is the Mac's**: File, Edit, Selection, View, Go, Run, Terminal and Help sit in the Mac menu bar while the window is
  focused, with VS Code's shortcuts next to their items (and your own keybindings once you change them). ⌘Q, ⌘H and ⌥⌘H stay the
  loader's.
- **The clipboard**: keyboard copy and paste always work; allow **Read and change what you copy** in the permission sheet for the
  Paste and Copy menu items and for pasting into the terminal.
- **Extensions from a marketplace** (with network allowed): the **Open VSX Registry** by default; **Extensions: Use the Visual Studio
  Marketplace** switches to Microsoft's (whose terms limit its extensions to Microsoft's own products: your call), and **Extensions: Use
  the Open VSX Registry** back. Extensions install into the VM. Code - OSS cannot verify their signatures (Microsoft's verifier is not
  redistributable) and asks you before installing, as upstream Code - OSS does. **Install from VSIX…** works too.

## How it works

```
window (ui/)                                            VM (core/)
  VS Code's web workbench (ui/static/out)                 core/main.js (Node 22, the D9010 VmApp SDK)
    WebSocket ws://vm:8000/…  ─ vscode-vmapp-shim.js ─►     ws-bridge.js ──► 127.0.0.1:8000  VS Code Server (core/vscode, Node 24.21.0)
    fetch /vscode-remote-resource, /static/  ─ vmapp-fetch.js ─► http-bridge.js ──┘             ├ extension host, built-in extensions
                                                                                                  ├ pty host (node-pty, bash), ripgrep
                                                                                                  └ file watcher (polls /host/…)
```

The server's one WebSocket (VS Code's remote protocol: files, extension host, terminals, everything) travels over the bridge, and the
server is asked for raw sockets (`skipWebSocketFrames`). Static files and extension resources travel over the streamed HTTP bridge. The
page gets the configuration the server would have rendered from the core (`vscode:config`).

## Build, pack, run

```sh
apps/vscode/build.sh            # Docker, linux/arm64; about 15 minutes the first time; caches in $VMAPP_WORK
apps/vscode/build.sh --check    # verify the pins and the clone, run nothing
tools/vmapp pack apps/vscode -o vscode.vmapp
tools/vmapp verify vscode.vmapp
```

Then install `vscode.vmapp` in the D9010 VmApp Launcher and launch it. Recommended size: **2 vCPUs, 3 GB**.

## Tests

- `tests/apps/vscode.mjs` (headless, real VM; run by `tests/apps/run-all.sh` when the build exists): VS Code's own protocol over the
  app's bridges, every testable inventory row, persistence across a restart, and the refused network, paths and links.
- `tests/apps/vscode-ui.mjs` (the real loader over CDP): the workbench, highlighting, TypeScript, the terminal, search, source control,
  the web workers, an edit made on the Mac, a theme, a link, the Markdown preview in a webview, Open Folder from Your Mac, the console
  (no CSP violation), the Inspector, a restart.

## Limits

Every built-in extension of VS Code ships except Copilot. The window itself loads data from the internet (extension icons, pictures
in a README) through the app's own proxy and the same network permission (DEV-APPS C3); sign-in and Settings Sync come with C8; one window; git over ssh needs the developer runtime (C6), git over
HTTPS works. The core is a read-only image mounted in the VM (`core.image: "erofs"`), so its 299 MiB cost
no memory. The full list, and what the platform would need, is in
[`CONVERSION.md`](CONVERSION.md) §5.

## Licences

VS Code (Code - OSS) is MIT, Copyright (c) Microsoft Corporation: `ui/LICENSE.vscode.txt`, `ui/ThirdPartyNotices.vscode.txt`,
`core/vscode/LICENSE`. git is GPL-2.0 (`core/git/share/doc/git/copyright`; Debian's source package is on snapshot.debian.org at the date
in `pins.env`).
"Visual Studio Code" is a trademark of Microsoft; this is the open-source build, without Microsoft's branding or services.
