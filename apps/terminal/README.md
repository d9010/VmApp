# Terminal (`dev.vmapp.terminal`, runtime `node22`)

A terminal window with two profiles: a **Shell** (bash) and the **Gemini CLI**. Both run inside the D9010 VmApp VM, on a real
pseudo-terminal, and the window is a normal terminal emulator (xterm.js). It is the answer to "I want to try an AI command-line
tool, but I do not want it loose on my Mac".

## The safety story

| What the program could do | What actually happens |
|---|---|
| Read or change your files | It sees **only the workspace folder you granted** (`/host/f-workspace`), plus the app's own private data (`/data`). Your home folder, Desktop and the rest of the disk do not exist in the VM. You can grant the folder read-only. |
| Install itself, or change the system | The system and the app are read-only. The program runs as an ordinary user (uid 1000, no new privileges). |
| Talk to the internet | The VM has no network device. The one way out is the host's allowlist proxy, and the only host this app asks for is **`generativelanguage.googleapis.com`** (the Gemini API, port 443). Until you allow it, every request fails with the proxy's `403`. |
| Send your files somewhere else | Only to Google's API host, if you allow it. The loader says so in its own words before you do: "This app could read the folder *workspace* and send what it reads to *generativelanguage.googleapis.com*". |
| Leave something running | Closing the window (or stopping the app) hangs every program up and then stops the VM. |

What this does **not** protect against: the Gemini CLI sends what it reads (prompts, file contents, command output) to Google
when you use it. That is what the tool is for. Limit what it can read by choosing the workspace folder carefully.

### Your API key

You type the key into **Settings** in the window (a password field). It is stored in the app's private data as
`settings.json` (mode `0600`, owner only), and it is given as `GEMINI_API_KEY` to the **Gemini CLI process only**: the Shell
profile does not get it. It is never shown in the terminal, never logged and never sent back to the window (Settings only
learns "set" or "not set"). `tests/apps/terminal.mjs` checks each of these with a dummy key.

Two honest limits: anything that runs *as the same user inside this VM* can read `/data/settings.json` and the Gemini
process's environment, so if you tell the Gemini CLI to run `cat /data/settings.json` it can. The key can still only be sent to
the hosts you allowed (Google). And the file is in the app's data folder on your Mac
(`~/Library/Application Support/VMApp Loader/data/dev.vmapp.terminal/` in a packaged loader), readable by you. "Reset app" in the
loader deletes it.

**Getting a key:** open Settings and press *Get a key...* (it opens <https://aistudio.google.com/app/apikey> in your browser after
you confirm), sign in, create a key, paste it, press *Save*, then *Restart*.

## Limits

- **Google sign-in does not work.** "Sign in with Google" in the Gemini CLI opens a browser and waits for a callback on
  `localhost`. The VM has no way to receive it, and it could not reach Google's sign-in hosts anyway. Use an API key.
- **Only the Gemini API is reachable.** Tools that fetch other sites (for example the CLI's web-fetch tool, or `git clone`,
  `npm install` and `curl` in the shell) fail with the proxy's `403`. Adding hosts means adding them to `vmapp.json`; they are
  then shown to you, one by one, to allow.
- **No Google Cloud or Vertex sign-in, no browser, no clipboard bridge from the VM.** Copy and paste work in the window
  (⌘C, ⌘V) because the window, not the VM, owns the clipboard.
- **Size.** The package is about 98 MiB: it carries the whole Gemini CLI bundle (about 95 MiB), which lives in memory in the
  VM (`/app` is a tmpfs), so the app recommends 1024 MiB and 2 CPUs.
- **No persistent shell state** except `/data` (shell history, `~/.gemini`, `~/.bashrc` if you create one) and the workspace.
- The CLI's usage statistics and update checks are switched off by default (in `/data/.gemini/settings.json`, only for keys you
  have not set yourself) because their hosts are not granted and `/app` is read-only.

## How it works

```
window (xterm.js, on the host)          core (Node, in the VM)                     ptyd (Rust, in the VM)
  keystrokes ──terminal:input──────────► main.js ──frames on stdin──────────────► forks the program on a
  resize ──────terminal:resize─────────►   (batches output ~16 ms,                 pseudo-terminal (/dev/pts)
  ◄──terminal:data (base64)─────────────   flow control with acks) ◄─frames on stdout─  and relays bytes
  ──terminal:ack────────────────────────►
```

- `ptyd/` is a 400 KiB static Rust program (std + libc, aarch64 musl) that opens a pseudo-terminal, starts the command as a
  session leader on it and relays the bytes over framed stdin/stdout, including window-size changes (`TIOCSWINSZ`) and signals.
  Its protocol is described at the top of `ptyd/src/main.rs` and `core/ptysession.js`.
  *Why not `node-pty`?* It is a native addon: it must be built for linux-arm64 against the runtime's Node, and its ABI follows
  Node's. `ptyd` has no such coupling, is small enough to read in one sitting, and needs the guest to provide only what
  every Linux program expects: **devpts**, mounted by `vmapp-init` at `/dev/pts` (SPEC section 4).
- `core/main.js` is the bridge: profiles, settings, output batching and flow control (the window acknowledges what it drew; the
  core stops reading a program that is more than 1 MiB ahead).
- `core/profiles.js` lists the profiles. `core/settings.js` stores the key. `core/profile/bashrc` is the Shell's prompt.
- `ui/` is the window. xterm.js and its fit addon are copied by `build.sh` from npm into `ui/vendor/` (exact versions in
  `vendor-src/package-lock.json`); nothing is loaded from the network (the window's CSP forbids it).

## Build, pack, run

```
vmapp/apps/terminal/build.sh                      # ptyd (cargo), the Gemini CLI (npm ci, linux-arm64), xterm.js (npm ci)
vmapp/tools/vmapp pack vmapp/apps/terminal -o terminal.vmapp
vmapp/tools/vmapp install terminal.vmapp          # then open the D9010 VmApp Launcher, Launch, pick your workspace folder
vmapp/tests/apps/run-all.sh                       # builds everything and runs the tests of all sample apps, Terminal included
```

`build.sh` needs the Rust toolchain of the other samples (target `aarch64-unknown-linux-musl`), and Node with npm. It installs
the Gemini CLI at the version pinned in `core/package.json` (an exact version, at least 14 days old when pinned) from the
committed `core/package-lock.json`, with `--ignore-scripts`: no install script of any dependency runs. The packages for other
platforms are skipped (`--os=linux --cpu=arm64`), so the macOS and Windows copies of the optional PTY addon are not in the
package. To move to another Gemini CLI release, edit `core/package.json`, run `npm install --package-lock-only --omit=dev
--ignore-scripts` in `core/`, review the lock file and rebuild.

## Adding another CLI as a profile

Any command-line tool can become a profile (Codex, Claude Code, aider, a REPL...). Three small changes, and the VM keeps doing
the safety work; see also [docs/CONVERTING.md](../../docs/CONVERTING.md) ("AI CLIs as Terminal profiles").

1. **Install the tool into `core/`.** Add it to `core/package.json` `dependencies` with an **exact** version, run `npm install
   --omit=dev --ignore-scripts --os=linux --cpu=arm64 --libc=glibc` in `core/` (or extend `build.sh` for a binary you download)
   and commit the lock file. A static linux-arm64 binary can simply go in `core/bin/`.
2. **Add an entry to `core/profiles.js`:**
   ```js
   {
     id: 'codex', label: 'Codex CLI', description: 'OpenAI Codex, working in your workspace folder.',
     command: () => [process.execPath, path.join(APP, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')],
     env: {},                                      // fixed environment variables for this program
     secret: { env: 'OPENAI_API_KEY', label: 'OpenAI API key', placeholder: 'sk-...',
               help: 'Stored in this app\'s private data and given only to Codex.', helpUrl: 'https://platform.openai.com/api-keys' },
     unavailable: () => (fs.existsSync(path.join(APP, 'node_modules', '@openai', 'codex')) ? null : 'Codex is not bundled in this build.'),
   },
   ```
   `secret` is optional. If it is there, Settings grows a password field for it and the value is passed, as that environment
   variable, to this profile's process only. `prepare()` (optional) can write the tool's default config before it starts.
3. **List the hosts it needs in `vmapp.json`**, each with a `purpose`, and nothing else:
   ```json
   "network": [
     { "host": "generativelanguage.googleapis.com", "purpose": "The Gemini API ..." },
     { "host": "api.openai.com", "purpose": "The OpenAI API: Codex sends your prompts and the files it reads here" }
   ]
   ```
   Find the hosts by running the profile with only its main API host allowed and reading the **Inspector's** `net` rows (or
   `vmapp run --headless`, which prints a `[net] DENIED host:port` line for each refused connection). Add a host only when the
   tool needs it for the feature you want, check that it is a host *name* (never an address), prefer exact names to wildcards, and
   bump the app `version`: an update that adds a host always stops at the user's "asks for more" sheet.

Tools that sign in through the browser (OAuth with a localhost callback) cannot finish that flow in the VM; use their API-key
mode. Tools that bring their own proxy settings need to honour `HTTPS_PROXY` (the VM sets it for every program; Node 22.21+,
Go, Python, curl and Rust `reqwest` do).

## Tests

`vmapp/tests/apps/terminal.mjs` runs in a real VM (three runs, selected with `TERMINAL_PHASE`, started by `tests/apps/run-all.sh`):
the Gemini CLI without a key (it starts and shows its sign-in choice), the Shell (commands, resize, files in the granted folder,
the pseudo-terminal's group and mode, Ctrl+C, flow control, stop, the key's storage, and the network: reachable while allowed,
`403` once revoked) and the Gemini CLI with a dummy key (authenticated from its environment; Google answers "API key not valid"
through the proxy). No real key is used. Without internet access the checks that need it are skipped.
