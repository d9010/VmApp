# Start here: learn D9010 VmApp level by level

**For:** anyone new to D9010 VmApp, whether you want to run apps, build one, or ship one. Go in order and stop at any
level; nothing later is required for anything earlier. Each level takes minutes and links to the details.

---

## Level 0: understand (2 minutes)

An app has two halves:
- its **window** (HTML, CSS, JavaScript), which shows on your desktop, sandboxed;
- its **engine** (any language), which runs in a tiny private Linux VM on your computer.

The **D9010 VmApp Launcher** runs apps and asks you what each one may reach: which folders, and whether it may use the
screen and so on. Nothing is reachable unless you allow it.

```
 your desktop: app window ◄── messages via the loader ──► app engine in its own VM
                (no network, no files)                     (only what you granted)
```

More: [ARCHITECTURE.md §1](ARCHITECTURE.md) and [FAQ.md](FAQ.md).

## Level 1: run an example

1. Open the **D9010 VmApp Launcher**: the packaged app, or `cd vmapp/loader && npm start` from source.
2. With no apps installed yet, click **Load examples** (any time later: **File → Load examples…**). The sheet lists the
   sample apps, each with what it asks for and what to allow; keep the ones you want checked and click **Install
   selected**. Installing grants nothing: every app asks at its first launch. (From source, make the examples first
   with `tools/pack-examples`; the packaged app carries them when it was built with `tools/package-mac.sh --with-examples`.)
   Prefer one app by hand? `tools/vmapp pack apps/notes -o ~/Desktop/notes.vmapp`, then **Install from file…**.
3. Click **Launch** on *Notes*, pick a folder for notes, and use it.
4. Click **Inspect** to watch the window talk to its engine.

More: [USING.md](USING.md).

## Level 2: build your own and run it locally, with no publishing

```sh
tools/vmapp new my-app --id com.you.myapp --dir ~/Projects/my-app
```
Edit `~/Projects/my-app/ui/` (the window) and `core/` (the engine). Then, in the loader, choose **Run project
folder…** and pick `~/Projects/my-app`. The loader packs it, installs it as a **Developer build** and launches it. Edit,
then click **Rebuild & run** on its card to see your change.

Nothing is uploaded anywhere: this is your private test loop. Read `TEMPLATE.md` in your new folder, the guided tour
of every file.

More: [BUILDING-APPS.md](BUILDING-APPS.md).

## Level 3: test it

- Headless, in a real VM: `tools/vmapp run com.you.myapp --headless --script test/my.test.mjs`. The template
  includes a working `test/`.
- **Inspector:** every message between your window and your engine, with timing.
- **Logs:** the **Logs** button, which shows your engine's output.

More: [BUILDING-APPS.md §9](BUILDING-APPS.md).

## Level 4: package it into one file

```sh
tools/vmapp pack ~/Projects/my-app -o ~/Projects/my-app/dist/my-app-1.0.0.vmapp
tools/vmapp verify ~/Projects/my-app/dist/my-app-1.0.0.vmapp
```
**Your build artifact** is that single `.vmapp` file: your manifest, your UI and your engine's files, each hashed.
It's typically KBs. The OS and language runtime aren't in it; the loader has them.

## Level 5: share it privately

Send the `.vmapp` file any way you like: chat, email, a shared drive. The other person uses **Install from file…**
in their loader and sees your app's permissions before anything runs. There's no registry and no account.

## Level 6: publish it to a registry

Pick whichever way suits you. All four do the same thing:

| Way | For | How |
|---|---|---|
| **Loader** | people who don't want a terminal or a website | the app's card → **Publish…** |
| **Website** | a quick manual upload | `<registry>/publish`, then choose your `.vmapp` |
| **CLI** | developers | `tools/vmapp publish my-app-1.0.0.vmapp` |
| **HTTP API** | AI agents and CI | `POST <registry>/api/publish` (a recipe is in PUBLISHING.md) |

Your app gets a permanent page at `<registry>/apps/<your app id>`. The first publish gives you an **owner token**,
which proves later versions are yours. The CLI and the loader save it for you.

More: [PUBLISHING.md](PUBLISHING.md), and [DISTRIBUTING.md](DISTRIBUTING.md) for trust and verified publishers.

## Level 7: ship updates

1. Change `version` in `vmapp.json` (`1.0.0` → `1.0.1` for fixes, `1.1.0` for features, `2.0.0` for breaking
   changes).
2. Pack and publish again. The same id lands on the same page.

Users choose per app between *Stay on this version*, *Latest compatible* (never crosses a new major version) and
*Always latest*. A bad release can be **withdrawn** with a reason; it's then never chosen automatically.

More: [PUBLISHING.md §4](PUBLISHING.md), SPEC §8.1.

---

**Going further:**
- [CONVERTING.md](CONVERTING.md): bring an existing app.
- [HOST-CAPABILITIES.md](HOST-CAPABILITIES.md): screen, mouse and keyboard, tools, MCP; for computer-use agents. §9: the GPU
  (llama.cpp RPC remoting to a sandboxed Metal server), for local AI models.
- [PROTOCOL.md](PROTOCOL.md): the bridge.
- [../CONTRIBUTING.md](../CONTRIBUTING.md): improve the platform.
