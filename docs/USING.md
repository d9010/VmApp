# Using the D9010 VmApp Launcher

**For:** people who want to run apps safely. You don't need to know how D9010 VmApp works inside. (If you're curious,
read [ARCHITECTURE.md](ARCHITECTURE.md).)

## What the loader does for you

Every app you run in the D9010 VmApp Launcher:
- runs in **its own small virtual machine**, separate from your computer and from other apps;
- can see **only the folders you choose**, in the way you choose (read only, read & write, or "drop files here");
- has **no internet access** until you allow specific addresses ([below](#letting-an-app-use-the-internet); the loader itself
  only goes online when you ask, see [Versions and updates](#versions-and-updates));
- gets **a virtual machine of a size you choose**, one vCPU and the recommended memory unless you say otherwise
  ([below](#choosing-how-much-of-your-mac-an-app-may-use));
- shows its window on your desktop like any app, but that window can't touch your files, the network or your camera. It
  can use your **microphone** only if the app asks for it and you allow it ([below](#letting-an-app-use-your-microphone)).

So you can try an app from someone you don't know, and it still can't reach anything you didn't give it.

## Install an app

1. Get the app's `.vmapp` file, from a website, the D9010 VmApp registry, a colleague. (To just try some apps, see
   [Try the examples](#try-the-examples); to search a registry from inside the loader, see
   [Browse and install from a registry](#browse-and-install-from-a-registry).)
2. In the loader, click **Install from file…** and choose the file.
3. Read the review screen:
   - who published the app, and what it says it does;
   - **which folders it will ask for, and why**;
   - **which internet addresses it will ask for, and why**, with wildcards and port 80 marked, and a red warning when it
     could read your folders and send them out;
   - the size it **recommends** for its virtual machine (you choose the real size at the first launch);
   - the **package id**, a fingerprint of exactly this build. If the publisher lists one, they should match.
4. Click **Install**. Nothing runs yet.

## Browse and install from a registry

A registry is a website that lists apps ([DISTRIBUTING.md](DISTRIBUTING.md)). The launcher has one registry of its own
(`https://api.vmapp.dev`, shown at the top of the sheet; it is not a setting), and you can search it without leaving the launcher.
The other way to get an app is **Install from file…**.

1. Click **Browse registry…** (or choose **File → Browse registry…**, ⇧⌘B). A development launcher (`npm start`) uses the registry
   on this Mac, `http://127.0.0.1:8790`; `$VMAPP_REGISTRY`, if it is set in the environment that starts the launcher, points either
   kind at another registry (for tests, or for a registry you run yourself).
2. The **newest apps** appear first. Type in the search box (it looks at an app's name, description and id, and at the
   publisher facts the registry has verified) and press **Search**. **Sort by** offers *Newest* (the default), *Most
   downloaded*, *Recently updated* and *Name (A to Z)*. **Show more** continues the list.
3. Each card shows the app's name and id, the **publisher label exactly as the registry gives it** ("Unverified publisher",
   "Verified email @example.com", "Verified: example.com"), a description, its version, size, download count and the registry's
   summary of what it asks for. All of that is what the registry says; the loader shows it as given and **cannot check it**, so
   treat a publisher label as only as good as the registry. The list of what the app really asks for is the review in step 4.
4. Click **Install** on a card. The loader downloads the package, checks it (its SHA-256 against what the registry announced, and
   every file in it), and then shows you the same **install review** as for a file: the folders, the internet addresses, the
   microphone, control of your computer, and a size recommendation. Nothing is installed until you click **Install** there, and
   **Cancel** throws the download away. As always, installing allows nothing; the app asks for its permissions at its first
   launch.
5. An app you already have shows **Installed 1.0.0** instead of an Install button (if the registry lists another version it says
   so; update through the app's own card, see [Versions and updates](#versions-and-updates)).

To install one app you already know, search for its name or id: it is then the only card.

**When the loader goes online.** Only when you open Browse, press **Search**, change the sort or press **Show more**: one
request to the launcher's registry, carrying the search text, the sort and the page, nothing else (no list of your apps, no
identifier). Nothing is requested when the loader starts or while the sheet is closed, and reopening the sheet shows what it had
without asking again. The sheet's own page has no network; the loader does the asking and cuts the answer down to plain text and
numbers. A registry address that starts with `http://` (not `https://`) and is not on this Mac gets a warning: what you see and
what you download can be changed on the way, so use it for development only.

## Try the examples

The loader can come with a set of sample apps (a notes app, a hasher written in Rust, a .NET to-do list, a WebGPU particle
demo, a terminal with Gemini CLI, a computer-use demo, local language models, Ollama's own desktop app, and more). To get them:

1. **First launch:** with no apps installed, the library shows **Load examples** (and **Install from file…**). **Any time
   later:** choose **File → Load examples…** (⇧⌘E).
2. The sheet lists every example as its own package describes itself: name, version, size and what it does, with badges
   for the things it asks for: **Network** (the addresses), **GPU**, **Control of your computer** (screen, mouse and
   keyboard, tools, MCP servers) and **Microphone**. Each has a **What to allow** hint: what is worth allowing in its
   permission sheet when you first launch it. Every example starts checked; untick the ones you don't want.
3. Click **Install selected**. Each app is verified and then installed, one after the other, and you see the progress
   of each. If one package is damaged or has been changed, the loader says so and installs the rest. An example whose
   version is already installed (or older than the one you have) is skipped, with a note, so you can run this again
   safely; a newer one updates the installed app. At the end a summary says how many were installed, skipped or failed,
   and the new cards appear in the library.

**Installing grants nothing.** The sheet says so, and it is true: no folder, address, device or computer control is
given, and no app is started. Each app asks for its permissions the first time you launch it, in the usual
[permission sheet](#launch-an-app-the-permission-sheet), where everything starts on **Don't allow**.

If your loader has no examples (a loader built without them hides the button and the menu entry), install one `.vmapp`
at a time with **Install from file…**. Someone running the loader from source makes the examples with `tools/pack-examples`
(see [TRY-IT.md](TRY-IT.md)); someone building the app adds them with `tools/package-mac.sh --with-examples`
([../loader/PACKAGING.md](../loader/PACKAGING.md)).

## Launch an app: the permission sheet

The first time you launch an app, the loader asks about each folder it wants:

| You see | What to do |
|---|---|
| **Choose folder…** | pick the folder the app should use. Choose the smallest folder that works: a project folder, not your whole home folder. |
| **Skip** | the app runs without it. Good apps handle this and tell you what they can't do. |
| **Allow:** read & write → read only | you can give less than the app asked for |
| "drop files here" (write-only) | the app can save files into that folder, but **can't see** what's already in it |
| **Ask every time I launch** | the sheet comes back at every launch |

The loader warns you if you choose a very broad folder (like your home folder), and refuses folders it must protect.

The same sheet has a **Network** section if the app asks for internet addresses ([below](#letting-an-app-use-the-internet)),
a red **Control of your computer** section if it asks to act on your Mac, a **Devices** section for the microphone, and a
**Resources** row for the size of its virtual machine ([below](#choosing-how-much-of-your-mac-an-app-may-use)). An app that
asks for any of these shows the sheet at its first launch even if it uses no folder. Everything starts on **Don't allow**.

While an app runs, it may also ask you, through **your Mac's own dialogs, named after the app**, to:
- **open a file or folder:** only what you pick is shared. A single file is shared as a copy, never with the files
  next to it.
- **save a file:** the app writes only that file.
- **open a web page:** you confirm each address.

## Letting an app use the internet

By default an app has **no internet at all**. An app that needs it lists the **hosts** it wants to talk to
(`api.example.com`, or `*.example.com` for all its subdomains) and why. You allow each host separately, or none.

**Where you decide.**
1. **At install**, the review lists every host with the app's reason. Installing allows none of them.
2. **At the first launch**, the permission sheet has a **Network** section: each host on **Don't allow**, with an **Allow**
   choice. If a host asks for more than one port you can allow fewer (a checkbox per port; keep at least one).
3. **Any time later**, the **Network…** button on the app's card. It works **while the app runs**: what you choose applies at
   once, and a host you take away is cut off immediately, open connections included.

On the card, an amber **Can reach the internet** mark and the **Network** pill in the activity monitor show which hosts you
allowed. From a terminal: `vmapp grant-net <app id> <host>` (`--list` shows the requests, `--revoke` takes one away).

- **Only those hosts.** The app can't reach anything else, and it can't reach your own network: your router, other
  devices and this Mac are always out of reach, even by a trick with names.
- **Look at what is asked.** A wildcard (`*.example.com`) covers many servers, so the sheet says "any address under
  example.com" in red; port 80 means unencrypted web traffic and is marked **not encrypted**.
- **The risky combination: files + internet.** An app that can read a folder (or your screen) **and** reach a server
  can send what it reads to that server. The loader says so in its own words, in a red box, at install ("This app
  **could** read the folder “notes” and send what it reads to api.example.com") and in the sheet, which turns it into a
  solid red **"Right now: this app can read … and send what it reads to …"** as soon as the choices on screen allow both.
  The card shows it too while both are allowed. Allow both only for an app you trust.
- **You can see it.** The Inspector lists every connection as a **net** row: host, port, **allowed** or **denied**, bytes up
  and down, how long it took, and why a connection was refused. The **Network** button shows only those rows. It never
  shows the content: it is encrypted end to end.
- **Updates never widen it.** An update that asks for another host, a wider wildcard or another port stops at "asks for
  more" and tells you exactly what is new. The new access stays off until you allow it: if you had allowed an address on
  port 443 and the new version also asks for 8443, only 443 stays on.
- **The web page of an app** in the registry lists the hosts it asks for, so you can look before you download.

## Choosing how much of your Mac an app may use

Each app runs in its own virtual machine, and **you decide how big it is**. The app's manifest only *recommends* a size (for
example "2 vCPUs and 2048 MB"); it cannot take more than you give.

- **Default:** **1 vCPU** and the **recommended memory**.
- **Where:** the **Resources** row in the permission sheet (first launch) and on the app's card. On the card, a change is saved
  at once. You can change it any time the app is **not running**; the row is greyed out while it runs, and a new size applies at the
  next launch. From a terminal: `vmapp resources <app id> --cpus 2 --memory 1024`.
- **vCPUs** go from 1 up to the number of cores your Mac has; **memory** goes from 64 up to **half of your Mac's memory**
  ("MB" here means MiB). The menu never offers more, and the loader refuses it even if asked.
- **Use recommended (2 vCPUs, 2048 MB)** takes the app's recommendation (lowered to what your Mac allows).
- **Below the recommendation is your call.** The row says so ("less memory than the app recommends: it may run slowly or
  fail"); some apps work fine with less.
- Your choice **survives updates** (a bigger recommendation in a new version does not change it, but the row warns you).
  **Reset…** forgets it, like the rest of the app's choices.

## Letting an app control your computer

Most apps never need this. A few, such as an assistant that can use your Mac for you, ask for more than folders: to
**see your screen**, to **move the mouse and type**, to **run programs from a list you wrote**, or to **talk to other
apps** that offer MCP tools (a code editor, for example). If you allow it, **that app can act on your computer in that
way**, like a person sitting at your Mac. Allow it only for an app you trust with that.

**The risks, in plain words**
- *Seeing your screen* shows the app everything that is visible: mail, messages, passwords on screen.
- *Controlling the mouse and keyboard* lets the app click and type anywhere, as you. It could send a message, delete a
  file or buy something. It can also click "Allow" in other dialogs.
- *Running programs* is limited to the programs you add to **your own list** (below), with arguments that match the
  rules you set. A **shell** (a program that runs any command) is the exception: it can do anything you can, so it is
  always marked in red and you should add one only if you really mean it.
- *MCP servers* are programs you add yourself; what they can do depends on the program.

An app can't give itself any of this. Only you can, and everything starts as **Don't allow**.

**How you allow it**
1. **At install:** the review says **"This app requests control of your computer."** when it asks for the mouse and
   keyboard, tools or MCP servers. Installing allows nothing.
2. **At first launch:** the permission sheet has a red **Control of your computer** section. For each thing the app asks
   for, choose a mode:

   | Mode | Meaning |
   |---|---|
   | **Don't allow** (the default) | the app can't do it |
   | **Ask every time** | you get a question each time (for mouse and keyboard, each time it starts controlling your Mac). You can answer **Deny**, **Allow once**, or **Allow while the app runs** |
   | **Allow while the app runs** | no more questions until you stop the app; then it goes back to *Ask every time* |

   There is no "always allow" for the mouse and keyboard or for a shell. For tools and MCP servers you also tick which
   of your own tools or servers the app may use.
3. **Later:** the **Permissions** button on the app's card changes your choices when the app isn't running. A red
   mark on the card ("Can control your computer") shows which apps have been allowed something.

**Your list of tools and MCP servers: Host Capabilities…**
The **Host Capabilities…** button (or ⌘3) opens the window where you add the programs apps may use. **Add a tool…**
asks for the program, a name and a rule for each argument (an app can only send arguments that match your rules). The
presets (a screenshot tool, "open an app", a terminal shell) only fill in the form; you save it. **Add an MCP server…**
asks for the command to start it. Apps never see where a program is on your Mac, and never see this list except for the
entries you allowed them.

**Choosing what to share when an app takes a screenshot**
With **Ask every time**, a screenshot opens a window on the app's window, named after the app (it is the loader's, not
the app's). It shows:
- every **display** with its name, its size and a small live preview (only you see the preview);
- every open **window** (the app and its title; titles appear once *Screen Recording* is allowed for D9010 VmApp Launcher);
- **Select a region…**: the screen goes dim and you drag a rectangle over what you want to share. **Esc** cancels.

The app may suggest something (a window, a display); that comes **preselected**, but **what you pick wins** and the app gets only
that. Then press **Deny** (the default, also **Esc** and closing the window), **Allow once**, or **Allow while the app runs**. The
last one lets the app take further screenshots **without asking**, of what it suggests at that time (or your main display),
**not of what you picked now**. Choose **Allow once** when you want to pick every time. The loader's own windows (the red
badge, the overlay, these questions) never show up in what an app receives.

**You always see it, and you can always stop it**
- **The overlay.** While an app controls your mouse and keyboard, the loader draws, on every screen, a **red ring** where
  the app's pointer is, a **ripple** each time it clicks, and a **caption at the bottom** with the keys it presses (`⌘S`) or the
  text it types, which it **hides by default**: it only says **`typing… (12 characters)`**, so a password an app types is not
  readable on your screen. Key combinations like `⌘S` are always shown. You can click straight through the overlay, it never
  takes the keyboard focus, and it is not in screenshots. It disappears when control ends. If you want to see the first
  characters of what is typed (`Hello, wor…`, on your screen only), turn on **Show typed text in the overlay** in
  **Host Capabilities…**; it is off by default and turning it off hides the text again at once.
- **The red badge.** While an app controls your mouse and keyboard, or runs a shell command, a small red bar stays on
  top of everything (even full-screen windows) saying **"<App> is controlling your computer, Stop"**. Click **Stop** to
  end it at once. The library window shows the same bar. No app can hide it or move it.
- **The panic shortcut: ⌃⌥⌘. (Control, Option, Command and the period key).** It stops everything immediately, from
  any app: every mouse-and-keyboard session, every running tool, every MCP server. It also forgets any "Allow while
  the app runs" you gave. A notification tells you it happened. The **Stop everything now** button in Host
  Capabilities does the same.
- **Time limit.** Mouse and keyboard control ends by itself after 10 minutes; the app has to ask (and you may have to
  agree) again.
- **The Inspector** (below) lists every use, allowed or refused, under the **Host** filter, without screenshots or
  what was typed.

**macOS permissions.** Your Mac has its own switches. For screenshots, give **D9010 VmApp Launcher** *Screen Recording*; to click
and type, give it *Accessibility*: **System Settings, Privacy & Security**. The Host Capabilities window shows whether
each one is on and has buttons to **Ask macOS…** (shows the system prompt) and **Open System Settings**. Apps can never
trigger these prompts. macOS may need you to quit and reopen the loader before a new permission works.

**When a new version asks for this.** If an update adds one of these, the loader always stops and shows it in the
"asks for more" sheet, whatever your Updates choice is. The new request stays on *Don't allow* until you allow it in the
permission sheet.

## Letting an app use your microphone

Some apps, such as a voice-note app, ask to **listen**. This is the one device an app can ask for; the camera is never
available. If you allow it, **the app's window can hear your microphone** for as long as the app runs, and the app can
pass what it hears to its own engine. (If the app has no internet access, that stays inside the app. If you also gave it
internet hosts, it could send the sound out.)

**How you allow it**
1. **At install:** the review has a **Devices** part that names the microphone and the app's stated reason. Installing
   allows nothing.
2. **At first launch:** the permission sheet has a **Devices** section. **Don't allow** is the default. Choose **Allow
   while the app runs** only for an app you trust with your voice. You can change it later: **Permissions** (when the app
   isn't running), or `vmapp grant-device <app id> microphone [--revoke]`.
3. **macOS asks too,** the first time, in its own prompt for **D9010 VmApp Launcher**. You can also switch the microphone off for the
   loader in **System Settings, Privacy & Security, Microphone**.

**What stays refused, whatever you choose:** video, screen sharing, and every other permission a web page can ask for
(notifications, location, clipboard). An app that did not ask for the microphone in its manifest can't use it even if a
grant file says so.

**How you can tell it is listening**
- The app's card in the library has a red **Can use the microphone** label while the permission stands, and **Using the
  microphone now** while a window of the app has an open audio stream.
- The **activity monitor** (next section) shows a **Microphone** pill that pulses while it listens.
- macOS shows its own orange microphone dot in the menu bar.
- The Bridge Inspector has a **host** row for every request: `microphone media.audio` **allowed** or **denied**.

"Using the microphone now" is a best-effort view from the loader: a deliberately hostile app window could hide that one
signal. The permission label, the Inspector row and macOS's dot can't be hidden by an app.

**When a new version asks for it.** An update that newly asks for the microphone always stops at the "asks for more"
sheet; the new request stays on *Don't allow* until you allow it.

## Letting an app use your GPU

Some apps run an AI model on your Mac (a local chatbot, a transcriber). Inside the app's virtual machine there is no Mac graphics chip,
so an app that wants yours has to ask. If you allow it, the loader starts a **sandboxed helper** (llama.cpp's RPC server using the GPU) just
for that app and for as long as it runs, and the app sends its model work to it.

1. **At install and in the permission sheet,** under **Control of your computer**, the entry says: *"Lets this app run work on your
   Mac's GPU (Metal) through a sandboxed helper. The helper processes the app's requests, so only allow apps you trust with your GPU."*
   You choose **Don't allow** (the default) or **Allow while the app runs**. There is no "ask every time": the model sends thousands of requests a
   second. The choice stays until you change it: the sheet, the card's **GPU…** button (it works while the app runs; taking the GPU
   away stops the helper at once), or `vmapp grant-host <app id> gpu --mode session` / `--revoke`.
2. **What the helper can do:** use your GPU, listen on one port that only this Mac can reach, and keep the compiled graphics shaders in
   your Metal cache. It can't read or write your files, start programs or connect to anything. It stops when the app stops, when you take
   the permission away (a running app loses it within a second), on the panic shortcut ⌃⌥⌘. and when you quit the loader.
3. **What you should know:** the helper is open-source llama.cpp code that its authors describe as not hardened against hostile input, which is
   why it runs in a sandbox and only if you opt in. An allowed app can use as much GPU as macOS gives it. Allow it for apps you trust.
4. **How you can tell:** the app's card has an amber **Can use your GPU** label, the activity monitor shows a **GPU** pill that pulses while
   it is used, and the Bridge Inspector's **GPU** filter lists the helper starting and stopping and every connection, with the bytes sent
   each way (never the contents).
5. The first start of the helper after an update of the loader takes 10 to 15 seconds (macOS compiles its shaders); after that it is quick.

**When a new version asks for it.** An update that newly asks for the GPU always stops at the "asks for more" sheet and stays off until
you allow it.

## Watching what runs: the activity monitor

The loader puts an icon in the **menu bar**. Click it for a small window that lists the **apps running right now** and,
for each, what it can reach:

| Pill | Means |
|---|---|
| **Folders 2** | folders you chose (hover for their names and access), plus files or folders picked in dialogs this run |
| **Screen**, **Input** | allowed to see your screen, or to move the mouse and type |
| **Microphone** | allowed to listen (it says **listening** while a window has an open audio stream) |
| **Tools**, **MCP** | allowed to run the programs from your list, or to talk to your MCP servers |
| **GPU** | allowed to run work on your Mac's GPU, through a sandboxed helper ([below](#letting-an-app-use-your-gpu)) |
| **Network** | internet hosts you allowed (hover for the list) |

A pill **pulses** while that thing is being used (an event in the last two seconds, or all the time for a mouse and keyboard
session or an open microphone). An app that can reach nothing says so. Per app you can **Stop** it, **Inspect** it (opens the
Bridge Inspector), or **Show app data in Finder** (the app's private data folder). The top of the library window has the same list
under **Activity**, with Stop. Window menu, **Activity Monitor** (⌘4) opens the popover too.

The pills show what you **allowed**, and pulse on what the loader can observe. Reading or writing inside a folder you
granted isn't visible to the loader, so the Folders pill pulses when a file is delivered or you pick something in a dialog,
not on every read.

## Day to day

| Button | Does |
|---|---|
| **Launch / Stop** | start or stop the app (Stop gives it a moment to save) |
| **Permissions** | change your choices: folders, host capabilities, devices, internet addresses, size (when the app isn't running) |
| **Network…** | change which internet addresses the app may reach; works while the app runs and applies at once (only for apps that ask for any) |
| **Resources** row | the vCPUs and memory of the app's virtual machine; saved at once, locked while the app runs |
| **Inspect** | open the **Bridge Inspector** for this app (below) |
| **Logs** | the app's internal log, useful when reporting a problem to its developer |
| **Reset…** | forget everything the app stored and all your choices for it (folders, internet, size, ...); your own folders aren't touched |
| **Uninstall…** | remove the app; optionally also delete its data |
| **Publish…** | upload the app to a registry (for developers; see [Publish an app](#publish-an-app)) |

Closing an app's last window usually quits it, just like a normal Mac app. Quitting the loader stops all apps. If the
loader crashes, every app's virtual machine stops with it.

## Updating the launcher

When a newer version of the launcher exists, a card appears at the top of its window: the new version, what changed, and three choices.

- **Update now** downloads the new version (a progress line shows) and checks it. Nothing restarts yet.
- **Restart to update** (it replaces the button once the download is ready) closes the launcher and opens the new version. Your apps, their
  folder choices and their data are kept. Running apps stop when the launcher restarts, so finish what you are doing first.
- **Later** hides the card until the next check; **Skip this version** hides it until an even newer version exists.

The launcher asks every time it starts and at least once a day while it runs, and **Check for Updates…** in its menu asks at once ("You're up to date" if there is nothing new). Turn the
automatic check off in **Host Capabilities** (*Check for launcher updates automatically*); the menu item still works. The check asks one address on
vmapp.dev and tells it nothing about you ([SECURITY.md](SECURITY.md#updates-of-the-launcher-itself)). The list of changes is also on the website: the
[Changelog](../CHANGELOG.md) and the Download page.

**Keep the launcher in your Applications folder.** If you open it straight from Downloads, macOS runs it from a temporary read-only copy, which cannot
replace itself; the card then says so and offers **Move to Applications** (it asks first if apps are running, copies the launcher into Applications and
opens it from there; you can then delete the one in Downloads). You can also drag it into Applications yourself.

A launcher you built yourself (or one that is not signed with the maintainers' Developer ID) cannot update in place; its card shows
**Download** instead, which opens the download page.

## Versions and updates

Apps you install from a registry (**Browse registry…**) remember where they came from. Apps you install from a file don't, and show "installed from a
file".

Each registry app has an **Updates** choice on its card:

| Choice | What happens when you launch it |
|---|---|
| **Stay on this version** (the default) | nothing; the loader doesn't contact anyone |
| **Latest compatible** | the loader asks the registry for a newer version of the same major version (a "1.x" app only moves to a newer 1.x) and installs it |
| **Always latest** | the same, but it may move to a new major version |

- The loader only contacts a registry when you click **Check for updates**, press **Show versions from the registry**,
  browse or search a registry, install from a registry, or launch an app set to *Latest compatible* or *Always latest*. It sends
  the app's id and version, nothing else (when you browse: the search text, the sort and the page). If the registry can't be
  reached within 5 seconds, the app just launches the version you have, with a note on its card.
- **If a new version asks for more** (a new folder, more access to a folder, file dialogs or opening links), the loader
  always stops and shows what changed. You choose **Update and review permissions** or **Keep version X and launch**,
  whatever your Updates choice is.
- **Versions…** lists the versions on your Mac (the current one and the 2 before it are kept). **Use this version**
  switches to one. Going back to an older version asks first: the app's data is shared between versions, so an older
  version may not understand data a newer one wrote. Going back also sets *Stay on this version*, so it doesn't jump
  forward again by itself.
- A publisher can **withdraw** a version (for example, because it had a bad bug). A withdrawn version is never picked as
  an update, and if you're running one, its card shows the publisher's reason.
- The loader never goes back to an older version on its own.

On the command line: `vmapp versions <id>`, `vmapp use <id> <version>`, `vmapp policy <id> manual|compatible|latest`
and `vmapp update <id>` (which asks you to add `--yes` when the new version wants more permissions).

## For developers: run your project folder

If you build an app (see [START-HERE.md](START-HERE.md) level 2), you can run it straight from its project folder,
with no `.vmapp` file to make by hand and nothing uploaded anywhere:

1. In the loader, click **Run project folder…** and choose the folder that holds `vmapp.json`, `ui/` and `core/`.
2. The loader packs it with the same code as `vmapp pack`, installs the result and launches it. If the folder isn't a
   D9010 VmApp project, or packing fails, you get the exact reason (for example, which file or field is wrong) and nothing is
   installed. The first launch shows the usual permission sheet.
3. The app's card says **Developer build from <folder name>** and has a **Rebuild & run** button. After you edit the
   folder, click it: the loader stops the app if it is running, packs and installs the folder again, and launches the
   new build. Your folder choices and the app's data are kept.

A developer build installs over any version of the same app id on your Mac, even a newer one, and it never asks a
registry for updates. Installing the app any other way (from a file or a registry) turns the card back into a normal
one.

## Publish an app

**Publish…** is on every app's card. It uploads the installed package of that app (the version on the card) to a
registry you name; it is most useful on a developer build, so edit, **Rebuild & run**, test, then publish.

1. Click **Publish…**. Check the **registry address** (it starts from the registry the app came from, a registry you
   published to before, or the default of this loader). A plain `http://` address to another computer gets a warning:
   anything you send, including your token, is unprotected, so use it for development only.
2. **Owner token.** The first time you publish an app id, leave it empty: you are claiming the id, and the registry gives
   you an owner token afterwards. Later versions need that token. The loader fills it in for you when this Mac has it
   (it is kept in `publish-tokens.json` in the loader's data folder, readable only by you, the same file the
   `vmapp publish` command uses). To publish from another Mac, paste the token.
3. **Who you are** (first publish only; all optional): name, company, email and website. They create your publisher on
   the registry. The registry shows none of it until you verify it: a verified email shows only its domain, a verified
   domain shows the domain, your company and your website, and your name is never shown. See
   [DISTRIBUTING.md](DISTRIBUTING.md), "What users see about you".
4. Click **Publish**. On success you see the address of the app's page (**Open app page…** asks before opening your
   browser). On a first publish you also see your **owner token, once**: it is saved on this Mac, and you should keep a
   copy somewhere safe too, because the registry cannot recover it and without it nobody can publish new versions.

If it fails, the sheet stays open and says why in plain words: the version already exists or is not higher (raise
`version` in `vmapp.json`, **Rebuild & run**, publish again), the id is taken by someone else's token, the token is
missing or wrong, the registry is rate limiting you, or the registry can't be reached. Nothing is saved or changed on
this Mac by a failed publish.

An app that was installed by an older loader can't be published until you install it again, because those versions did
not keep the package file.

## The Bridge Inspector: see what an app does

The Inspector works like a browser's developer tools for apps. For each running app it shows:
- **Traffic:** every message between the app's window and its engine (in its VM), with time, direction and
  duration. Click a row for a preview.
- **Core log:** what the app's engine logged.
- **Delivered files:** files the app saved into your write-only folders.

If an app was allowed to see your screen, control your mouse and keyboard, run tools or use MCP servers, every use
(and every request for the microphone, allowed or refused) appears in the Traffic list as a **host** row (the capability, what it did, how long it took, and **allowed** in green or
**denied** in red). The **Host** button shows only those rows. Screenshots and typed text are never shown there, only that
they happened and how much.

If an app was allowed to reach internet addresses, every connection it makes (or tries to make) appears as a **net** row:
the host and port, **allowed** or **denied** (a refusal says why), the bytes the app sent and received, and the time it
took. The **Network** button shows only those rows. Only the address and the sizes are visible, never the content.

It's read-only. It's useful to see what an app is actually doing, or to show a developer exactly what went wrong.

## Where things are kept

| What | Where |
|---|---|
| installed apps, their data, your choices | `~/Library/Application Support/VMApp Loader/` |
| an app's private data | inside that folder, under `data/<app id>/`. Reset empties it. |
| the loader's own switches | `loader-prefs.json` in that folder (today: whether the overlay shows typed text, off by default) |
| your own folders | untouched, except where you granted read & write, or where the app delivered files |

## What apps can't do in this version

They can't show system notifications, use your camera, add menu bar items, read any folder you didn't choose, or reach any
internet address you didn't allow. Some of these will arrive as permissions you can grant explicitly. The exceptions that
exist today are the internet (see "Letting an app use the internet"), control of your computer (see "Letting an app control
your computer") and the microphone (see "Letting an app use your microphone"): an app can do any of them only if you allow
it, one at a time.
