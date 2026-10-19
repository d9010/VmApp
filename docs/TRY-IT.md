# Try D9010 VmApp: play with it, build your first app, give a demo

**For:** anyone trying D9010 VmApp for the first time, on a Mac with Apple silicon. Hands-on, in order. Every command was run
in a checkout of this repository. Commands start in the repository root unless noted.

## 0. One-time setup

```sh
cd path/to/vmapp                       # the repository root
tools/build.sh                         # VM launcher, init, guest kernel (built from pinned source in Docker; 2 to 3 minutes the first time, about 2 minutes with a warm Docker cache)
tools/mkruntime runtimes/native out/runtimes/native.img      # and node22, dotnet8: the shared runtime images (Docker)
(cd loader && npm ci)                  # the loader's dependencies; the first `npm start` downloads the Electron binary (network)
```
Prerequisites (Rust with the musl target, Docker, Node 22, git, and cmake for the optional GPU server) are in
[CONTRIBUTING.md §1](../CONTRIBUTING.md). To run an app from the command line (`tools/vmapp run`) instead of the loader, install
its runtime first: `tools/vmapp runtime-install node22 out/runtimes/node22.img`. Scratch
files and caches go to `out/work/` (or `$VMAPP_WORK`).

If you run Electron from a terminal that has `ELECTRON_RUN_AS_NODE` set (some tools set it), run
`unset ELECTRON_RUN_AS_NODE` first.

## 1. Play: the loader with the sample apps (5 minutes)

**Option A, the packaged app** (what end users get; no Node needed):
```sh
open "out/dist/D9010VmAppLauncher.app"
```
It was built by `tools/package-mac.sh` and is signed ad hoc, so it runs on this Mac.

**Option B, from source** (you can see logs in the terminal):
```sh
cd loader && npm start
```

**The quick way: Load examples.** Make the sample apps once with `tools/pack-examples` (it builds what is missing, which
needs Docker for the big ones; add `--no-build` to pack only what is already built) and they land in `out/examples/`.
A loader started from source reads that folder, so with no apps installed the library offers **Load examples** (any time:
**File → Load examples…**). The sheet lists each sample as its package describes itself, with badges for the network hosts, GPU, control of your
computer and microphone it asks for, and a "What to allow" hint; **Install selected** verifies and installs the ones you
keep checked. A package that fails verification is reported and the others still install; running it again skips what is
installed. Nothing is allowed or launched by installing. The packaged app has the same button when it was built with
`tools/package-mac.sh --with-examples` (about 360 MB bigger). Then skip to step 2 below.

**By hand:** make some packages to install:
```sh
tools/vmapp pack apps/notes -o ~/Desktop/notes.vmapp
tools/vmapp pack templates/starter -o ~/Desktop/starter.vmapp
# Rust and .NET samples need one build step first:
apps/hasher/build.sh && tools/vmapp pack apps/hasher -o ~/Desktop/hasher.vmapp
apps/todo/build.sh   && tools/vmapp pack apps/todo   -o ~/Desktop/todo.vmapp      # needs Docker (the .NET SDK image)
```

In the loader:
1. **Install from file…** → pick `~/Desktop/notes.vmapp`. Read the review screen: the publisher is marked unverified, and the
   folders are listed with their reasons.
2. **Launch** → the permission sheet. For *notes*, choose a scratch folder (make one on the Desktop). For
   *export*, choose another one, or Skip.
3. Write a note, save it, and look in your folder: the file is there. Click **Export as HTML** and look in the
   export folder.
4. Click **Inspect** (or **Bridge Inspector**) and watch the UI ↔ VM messages as you click.
5. Try **Import a file…**: only the file you pick reaches the app, as a copy.
6. Close the Notes window: the app quits and its VM stops. Click **Reset…** to wipe its data.

Things worth showing yourself:
- **Activity Monitor:** a `com.apple.Virtualization.VirtualMachine` process per running app.
- **Folders:** the app can't see anything you didn't grant. Notes with its folders declined shows a friendly empty
  state.

## 2. Build your first app (10 minutes)

```sh
tools/vmapp new hello-world --id com.yourname.helloworld --dir ~/Desktop/hello-world
cd ~/Desktop/hello-world
open TEMPLATE.md                       # the walkthrough of every file and of the app's life
```

Edit:
- `ui/index.html`: what you see;
- `core/main.js`: what runs in the VM; add an `ipcMain.handle('greet', (e, name) => 'Hello ' + name)`;
- `ui/app.js`: call `window.vmapp.invoke('greet', 'world')` and show the result.

Then:
```sh
VMAPP=/path/to/vmapp                    # the repository root
$VMAPP/tools/vmapp pack . -o hello-world.vmapp
$VMAPP/tools/vmapp install hello-world.vmapp
$VMAPP/tools/vmapp run com.yourname.helloworld --headless --duration 3000   # quick check, no window
test/run.sh                                                                 # the template's own real-VM test
```
Finally, install `hello-world.vmapp` in the loader and click Launch. Writing it in Rust or .NET: copy the structure
of `apps/hasher` or `apps/todo` ([BUILDING-APPS.md §5.3](BUILDING-APPS.md)).

## 3. Run your own registry and publish (10 minutes)

```sh
node registry/server.js --port 8790 --data out/work/my-registry        # leave running; open http://127.0.0.1:8790
tools/vmapp publish ~/Desktop/notes.vmapp --name "Your Name" --email you@example.com
#   → prints an owner token ONCE (also saved to $VMAPP_HOME/publish-tokens.json)
tools/vmapp search
tools/vmapp get dev.vmapp.notes -o ~/Desktop/notes-from-registry.vmapp   # verifies the hash and the package id
```
The web page shows no publisher until you verify. The dev server writes verification emails to
`out/work/my-registry/outbox/*.eml`, and the page explains each level.

To get an app from this registry into the loader without the terminal, choose **File → Browse registry…** (⇧⌘B; a development
loader is already pointed at `http://127.0.0.1:8790`; the newest apps come first), search, and click **Install** on a card: you see the same review as for a
file before anything is installed ([USING.md](USING.md#browse-and-install-from-a-registry)).

## 4. A 10-minute demo for other people

1. **The problem (1 min):** "Installing a desktop app means trusting it with all your files. Electron apps, and
   even container-backed ones, run vendor code on your machine with your rights."
2. **Install an app** from the registry page: show the permission list *before* downloading, and the publisher
   (shown only when it is verified).
3. **Install it in the loader:** the review screen, then Launch and the permission sheet. "It asks for exactly
   this folder, and I can say no."
4. **Use it** (Notes): then open Activity Monitor and show the VM process. "Its code runs in there, not on my
   Mac."
5. **The Inspector:** "Every message between the window and the app's engine, live."
6. **Try to escape** (optional, for technical audiences):
   ```sh
   cd templates/starter
   ../../tools/vmapp pack . -o /tmp/s.vmapp
   ../../tools/vmapp install /tmp/s.vmapp
   ```
   Then run `../../tools/vmapp run com.example.starter --headless` and show it can't list your home folder. Or run
   `tests/e2e.sh` and read the PASS lines.
7. **For developers:** `tools/vmapp new my-app`, then `pack`, then install. "It's Electron's API with
   `require('vmapp')`, and your backend can be Rust or C#."
8. **Size:** the Notes package is 27 KB; the OS and Node are shared.

## 5. Where to look when something's off

| Problem | Look at |
|---|---|
| an app window doesn't open | the app's **Logs** button in the loader (`$VMAPP_HOME/logs/<id>.console.log`) |
| what the app is doing | the **Inspector** |
| the platform itself | `tests/e2e.sh` (launcher + VM), `tools/check-invariants` |
| the loader's data | `~/Library/Application Support/VMApp Loader/` (packaged) or `$VMAPP_HOME`, default `out/work/vmapp-home/` (from source; [SPEC](../SPEC.md) section 1) |
