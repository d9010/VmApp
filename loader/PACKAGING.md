# Packaging the D9010 VmApp Launcher (macOS, arm64)

One command, from anywhere:

```sh
vmapp/tools/package-mac.sh            # builds what is missing, packages, fuses, signs ad hoc, zips (~20 s when out/ is complete)
vmapp/tools/package-mac.sh --rebuild  # also re-runs tools/build.sh first
vmapp/tools/package-mac.sh --with-krun       # also bundles the experimental Vulkan backend (gpu/krun/README.md, SPEC 8.7)
vmapp/tools/package-mac.sh --with-examples   # also bundles the sample apps of "Load examples" (below; about 360 MB more)
```

Output (git-ignored, `vmapp/out/` is in `.gitignore`):

| Path | What |
|---|---|
| `vmapp/out/dist/D9010VmAppLauncher.app` | the app, ad-hoc signed, hardened runtime |
| `vmapp/out/dist/D9010-VmApp-Launcher-0.1.0-mac-arm64.zip` | `ditto -c -k --keepParent` of the app (301,457,917 bytes, 287 MiB) |

No DMG is produced (a zip is enough; `hdiutil create -srcfolder` can wrap the app later).

## Tool versions

| Tool | Version | Published |
|---|---|---|
| `electron` | 44.4.5 (exact, devDependency, unchanged) | |
| `@electron/packager` | 20.3.0 (exact, devDependency) | 2026-08-11 |
| `@electron/fuses` | 2.1.3 (exact, devDependency) | 2026-06-29 |

Both new packages were published well over 14 days before 2026-10-13. Together they add 39 packages to `node_modules`
(dev only; the app has no runtime dependencies). Node >= 22.12 is needed to run the packaging script.
Caches stay in the scratch folder `$VMAPP_WORK` (default `out/work`, git-ignored): `ELECTRON_CACHE=$VMAPP_WORK/electron-cache`, `npm_config_cache=$VMAPP_WORK/cache/npm` (set by the script unless you set them).

## What the script does

1. `tools/build.sh` only if `out/vmapp-vm`, `out/Image` or `out/initramfs.cpio` is missing (or `--rebuild`); then
   `host/hostctl/build.sh out/vmapp-hostctl` if the host-capabilities helper alone is missing.
2. `tools/mkruntime` for any of `native`, `node22`, `dotnet8` missing from `out/runtimes/` (needs Docker).
3. `npm ci` in `loader/`.
4. `loader/build/package.mjs`:
   - stages `loader/{main.js,preload-*.js,src,ui}` and `hostlib/*.js` (no tests, no node_modules) in `out/dist/stage`
     with a generated `package.json` (`main: loader/main.js`; the relative `../hostlib` requires keep working);
   - `@electron/packager`: darwin/arm64, `asar: true`, bundle id `com.vmapp.loader`, `LSMinimumSystemVersion 13.0`,
     `ElectronAsarIntegrity` written to Info.plist; Electron's camera/Bluetooth/system-audio usage strings replaced by a
     neutral "does not use this device" text, and `NSMicrophoneUsageDescription` by the text macOS shows when an app you allowed
     asks to listen (SPEC 8.4); the D9010 logo as the app icon (`build/icon.icns`, made from `build/icons/app-icon.svg` by
     `build/make-icons.sh`; the menu-bar icon and the logo in the library header are `ui/trayTemplate*.png` and `ui/logo.svg`);
   - `@electron/fuses` (below);
   - copies the VM bits and the host-capabilities helper `vmapp-hostctl` into `Contents/Resources/vmapp/` with APFS
     clones (`chmod 0755`; `src/config.js` resolves it as `<Resources>/vmapp/vmapp-hostctl`, and a packaged loader never
     looks anywhere else: `VMAPP_HOSTCTL` and `VMAPP_HOSTCTL_DRYRUN` are ignored);
   - copies `out/kernel-info/` (made by `kernel/build.sh`: `SOURCE-OFFER.md`, `licenses/`, build evidence) to
     `Contents/Resources/vmapp/kernel-info/`, because the bundle ships the Linux kernel; the build stops if it is missing.
   - with `--with-examples` (see below) copies `out/examples/*.vmapp` and `README.md` to `Contents/Resources/vmapp/examples/`.
5. `loader/build/sign-mac.sh <app>` (below).
6. `ditto` zip, then a summary (sizes, `codesign -dv`, fuses).

## The sample apps: `--with-examples`

`tools/package-mac.sh --with-examples` bundles the sample apps that the loader's **Load examples** installs (SPEC 8.1,
[README.md](README.md), [../docs/USING.md](../docs/USING.md)). Without the flag the bundle has no `examples/` folder and the
packaged loader hides the **Load examples** button and the **File → Load examples…** entry (a development loader shows both and
says to run `tools/pack-examples`).

- **Source:** `vmapp/out/examples/` (`*.vmapp` and the `README.md` with the "What to allow" table), made by `tools/pack-examples`. If it
  has no `.vmapp` file, the script runs `tools/pack-examples --no-build` first, which packs only the samples whose build outputs
  already exist (it never starts the Docker builds of the big ones: run `tools/pack-examples` yourself for those). Whatever is in the
  folder is bundled as it is; run `tools/pack-examples` again to refresh it.
- **Destination:** `Contents/Resources/vmapp/examples/` (`build/package.mjs --with-examples`, APFS clones, so the copy is quick). The
  packaged loader reads only this folder (`src/config.js`: `VMAPP_EXAMPLES_DIR` is ignored when packaged, with a warning in the log).
- **Size impact (measured 2026-10-16 with `du`, MiB; both builds also had `--with-krun`):** the 13 samples are 360 MiB
  (`du -sh out/examples`; the big ones are the terminal with Gemini CLI 98 MiB, Ollama 48 MiB, Ollama with the Vulkan libraries
  88 MiB and Ollama's desktop app 111 MiB). `D9010VmAppLauncher.app` went from 674 MiB to 1,033 MiB (`Resources/vmapp/examples` is
  360 MiB), and the zip from 379 MiB to 492 MiB (515,463,366 bytes). The download is therefore about 490 MiB with the examples.
- **Signing:** nothing changes. The `.vmapp` files are plain data (tar archives, not Mach-O), so `sign-mac.sh` does not sign them
  one by one; the bundle's signature seals them as resources, and `codesign --verify --deep --strict` still passes. They are not
  trusted because of that: every package is verified again (every hash) when the user installs it, exactly like a file picked with
  **Install from file…**.
- **Safety:** installing an example grants nothing and starts nothing; each app asks for its permissions at its first launch.

## What is inside

```
D9010VmAppLauncher.app/Contents/
  MacOS/D9010 VmApp Launcher              Electron main executable (renamed)
  Frameworks/                             Electron Framework, Mantle, ReactiveObjC, Squirrel, 4 "D9010 VmApp Launcher Helper*" apps
  Resources/app.asar                      216 KB: loader/ (main.js, preloads, src/, ui/) + hostlib/
  Resources/vmapp/vmapp-vm                host launcher, 806 KB, signed with host/vmapp.entitlements
  Resources/vmapp/vmapp-hostctl           host-capabilities helper (screen, input), 111 KB, hardened runtime, no entitlements
  Resources/vmapp/Image                   kernel (Linux 6.18.56-vmapp, from kernel/build.sh), 7.6 MB
  Resources/vmapp/kernel-info/            the kernel's GPL source offer and licences (SOURCE-OFFER.md, licenses/, build evidence), 0.3 MB
  Resources/vmapp/initramfs.cpio          0.46 MB
  Resources/vmapp/runtimes/native.img     0.2 MB
  Resources/vmapp/runtimes/node22.img     121.9 MB
  Resources/vmapp/runtimes/dotnet8.img    110.9 MB
  Resources/vmapp/examples/               only with --with-examples: *.vmapp sample apps + README.md, about 360 MB
```

Sizes (`du`): app 548 MB (`Resources/vmapp` 260 MB), zip 301 MB; these were measured with the earlier 18.6 MB kernel,
so with the current 7.6 MB kernel the app is about 11 MB smaller (the zip is smaller too). `src/config.js` resolves everything from
`process.resourcesPath/vmapp` when `app.isPackaged`; at start the loader installs the three runtimes into
`$VMAPP_HOME/runtimes` (APFS clone, instant), exactly as in dev.

## Data location and environment in a packaged build

- Data root: `~/Library/Application Support/VMApp Loader` (SPEC section 1). `VMAPP_HOME` **is** honoured in packaged
  builds (needed for tests; the data location is not a security boundary: whoever can set the loader's environment
  already runs as the user and could edit the data directly). The loader logs `(from VMAPP_HOME)` at start.
- **Ignored when packaged** (a warning names the `VMAPP_TEST_*` ones and `VMAPP_VM`, `VMAPP_KERNEL`, `VMAPP_INITRAMFS`, `VMAPP_EXAMPLES_DIR`):
  `VMAPP_TEST_DIALOGS`, `VMAPP_TEST_DIALOG_LOG`, `VMAPP_TEST_GRANTS`, `VMAPP_TEST_DEVTOOLS_LOG`, `VMAPP_TEST_MENU_DIR`, `VMAPP_VM`, `VMAPP_KERNEL`,
  `VMAPP_INITRAMFS`, `VMAPP_EXAMPLES_DIR`, and (by `hostlib/hostproc.js`) `VMAPP_HOSTCTL` and `VMAPP_HOSTCTL_DRYRUN`. The only `vmapp-vm` a
  packaged loader starts is the signed one in its bundle, and the only `vmapp-hostctl` is the signed one next to it; a real
  mouse or keyboard event can never be turned into a dry run, or the helper replaced, from the environment.

## Fuses (`npm`-free check: `npx --no-install @electron/fuses read --app "D9010VmAppLauncher.app"`)

```
RunAsNode                                Disabled
EnableCookieEncryption                   Enabled
EnableNodeOptionsEnvironmentVariable     Disabled
EnableNodeCliInspectArguments            Disabled
EnableEmbeddedAsarIntegrityValidation    Enabled
OnlyLoadAppFromAsar                      Enabled
LoadBrowserProcessSpecificV8Snapshot     Disabled   (Electron default, untouched)
GrantFileProtocolExtraPrivileges         Disabled
WasmTrapHandlers                         Enabled    (Electron default, untouched)
```

Verified: `ELECTRON_RUN_AS_NODE=1 "D9010 VmApp Launcher" -e ...` starts the normal GUI app instead of Node.

## Production hardening (only when `app.isPackaged`)

- **Refuses to start** with `--remote-debugging-*`, `--remote-allow-origins`, `--inspect*`, `--debug*`, `--js-flags`,
  `--no-sandbox`, `--disable-web-security`, `--disable-site-isolation-trials`, `--disable-setuid-sandbox`,
  `--allow-file-access-from-files`, `--allow-running-insecure-content`, `--enable-automation`, `--user-data-dir`,
  `--load-extension`, `--disable-extensions-except`, `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`
  (`src/hardening.js`; the last would make Chromium accept microphone requests without asking the loader's gate): stderr message, native error box, exit 78.
  The check runs before `ready`; Chromium has not opened any port at that point (verified: nothing listens on 9333 while
  the box is shown). The error box is modal: the process stays until it is dismissed.
- Test hooks are off (above). DevTools: the loader's own windows (library, inspector, settings, badge, activity monitor, screenshot picker, region selection, input overlay) always get
  `devTools: false`. An **app** window gets `devTools: true` only if the app's core created it that way
  (`webPreferences.devTools` in the SDK, the `devTools` param of `window.create`; default false): the app's own choice for
  its own windows, in the packaged build too (SPEC 7, INV-B1). The only menu entry is View, Developer Tools (⌥⌘I), and it
  acts only on a focused app window created with `devTools: true`. A `devtools-opened` handler closes DevTools at once on
  every other window (loader windows, and app windows created without `devTools`). Remote debugging stays refused (above), so
  DevTools cannot be reached from outside either.
- Both dev and packaged: folder gate (`src/folder-guard.js`). `/` (also via symlink, e.g. `/Volumes/Macintosh HD`) and
  the loader data dir (or anything inside it) are refused outright; the home folder, `~/Library`, `~/.ssh|.aws|.gnupg|.config|.kube`,
  `/Users`, `/Volumes`, `/Volumes/<disk>`, `/System`, `/Library`, `/Applications`, `/private`, `/usr`, `/bin`, `/sbin`, `/etc`,
  `/var`, `/opt`, and any folder that contains the data dir get a warning dialog with a second confirm
  ("Choose a different folder" is the default, "Share this folder anyway"). It applies to the permission sheet's
  *Choose folder...* and to an app's runtime `dialog.open({directory})`; `lib:launchWithGrants` / `lib:savePermissions`
  re-check and reject refused folders even if a renderer sends them. Covered by `test/loader-cdp.mjs`
  (`hardeningChecks()` plus the sheet flow: home declined, home confirmed, `/` refused, data dir refused, forged grant rejected).

## Signing (ad hoc), `loader/build/sign-mac.sh`

Inside-out, never `--deep` for signing, every Mach-O with `--options runtime`:

1. `Resources/vmapp/vmapp-vm`: `--entitlements host/vmapp.entitlements` (`com.apple.security.virtualization`),
   identifier `com.vmapp.loader.vmapp-vm`. This is the only binary with the virtualization entitlement.
   1b. `Resources/vmapp/vmapp-hostctl`: identifier `com.vmapp.hostctl`, hardened runtime, **no entitlements**. Screen
   capture and synthetic input are gated by the user's Screen Recording and Accessibility consent (System Settings, given to
   "D9010 VmApp Launcher"), not by an entitlement; the helper runs as a child of the loader.
2. dylibs, `chrome_crashpad_handler`, Squirrel's `ShipIt`; 3. the four frameworks; 4. the four helper apps;
5. the app. 4 and 5 use `build/entitlements.mac.adhoc.plist`.

Entitlements: `build/entitlements.mac.plist` = `allow-jit` + `allow-unsigned-executable-memory` (what Electron's V8 needs) +
`com.apple.security.device.audio-input` (the microphone, SPEC 8.4). The same file signs the app and the four Electron helper
apps, because Chromium captures audio in a helper process. It only lets those processes ask macOS for the microphone; the
loader's permission gate and macOS's own consent prompt still decide. There is no camera entitlement. `NSMicrophoneUsageDescription`
is in Info.plist (above).
**Ad hoc only:** `build/entitlements.mac.adhoc.plist` adds `com.apple.security.cs.disable-library-validation`. Without it
dyld refuses to load Electron Framework ("mapping process and mapped file (non-platform) have different Team IDs": an
ad-hoc signature has no Team ID, so the hardened runtime's library validation rejects even our own framework). A Developer
ID build has one Team ID throughout and must use the plain `entitlements.mac.plist` (the script switches on `SIGN_IDENTITY`).

Result: `codesign --verify --deep --strict --verbose=2` passes ("valid on disk, satisfies its Designated Requirement");
app, vmapp-vm and vmapp-hostctl are `flags=0x10002(adhoc,runtime)`, `Signature=adhoc`, `TeamIdentifier=not set`.
**macOS privacy permissions and ad-hoc builds:** Screen Recording and Accessibility are tied to the app's code identity.
An ad-hoc build has none that survives a rebuild, so macOS may ask again (or show an old entry that no longer matches)
after each new build; a Developer ID build keeps one identity, so the user grants once.
An ad-hoc app is not Gatekeeper-trusted: on another Mac it needs right-click > Open (or `xattr -dr com.apple.quarantine`).

## Developer ID + notarization (not done: needs the owner's credentials)

No credentials are in the repo or required by the script. Placeholders:

```sh
# one-time: store notarytool credentials in the login keychain (Apple ID app-specific password or an App Store Connect API key)
xcrun notarytool store-credentials "<PROFILE>" --apple-id "<APPLE_ID>" --team-id "<TEAMID>" --password "<APP_SPECIFIC_PASSWORD>"

# sign (same script; adds --timestamp and uses entitlements.mac.plist without disable-library-validation)
SIGN_IDENTITY="Developer ID Application: <NAME> (<TEAMID>)" vmapp/tools/package-mac.sh

# notarize the zip, wait, staple the app, re-zip so the ticket travels with it
xcrun notarytool submit vmapp/out/dist/D9010-VmApp-Launcher-<version>-mac-arm64.zip --keychain-profile "<PROFILE>" --wait
xcrun stapler staple "vmapp/out/dist/D9010VmAppLauncher.app"
ditto -c -k --keepParent "vmapp/out/dist/D9010VmAppLauncher.app" vmapp/out/dist/D9010-VmApp-Launcher-<version>-mac-arm64.zip
spctl --assess --type execute --verbose=4 "vmapp/out/dist/D9010VmAppLauncher.app"
```

Notes for that run: package-mac.sh zips right after signing, so re-zip after stapling as shown; `vmapp-vm` carries
the virtualization entitlement, which is not a restricted entitlement and needs no provisioning profile (it already runs
ad hoc); every Mach-O is already hardened-runtime signed, which notarization requires. A DMG, if wanted, is
`hdiutil create -volname "D9010 VmApp Launcher" -srcfolder "<app>" -ov -format UDZO <out>.dmg` followed by signing and notarizing the DMG.

## Verification run (2026-10-15, macOS 24.6, arm64)

- `codesign --verify --deep --strict` passes; fuse readout as above. After `vmapp-hostctl` was bundled (2026-10-15): it is
  identifier `com.vmapp.hostctl`, `flags=0x10002(adhoc,runtime)`, no entitlements, and the whole bundle still verifies. The
  packaged GUI was not launched for this change (the real helper needs a supervised run with the owner).
- Bundled `Contents/Resources/vmapp/vmapp-vm run` with the bundled Image, initramfs and `native.img` on `out/test/core-echo.cpio`:
  ready, `WRITE`/`READ` round trip through the bridge socket, clean exit 0 on stdin EOF.
- Packaged app started with `env -i PATH=/usr/bin:/bin HOME=$HOME VMAPP_HOME=<fresh dir>` (no Node on PATH): starts, installs
  `dotnet8`, `native`, `node22` images into `$VMAPP_HOME/runtimes`, logs `ready`, one 1040x720 on-screen window of
  "VMApp Loader" (CGWindowList; System Events and screen capture are not permitted for this harness, so no screenshot);
  SIGTERM quits cleanly (`apps stopped; quitting`), no `vmapp-vm` left.
- `--remote-debugging-port=9333`: refused (error box, nothing listening, no data dir created).
- The UI launch path of an installed app is not drivable from outside in a packaged build (CDP and test hooks are off by design).

## Open issues

- Ad-hoc builds need `disable-library-validation`; only a Developer ID build (with `entitlements.mac.plist`, notarized with `tools/notarize-mac`) opens
  without a warning on other Macs.
- `Resources/*.lproj` Chromium locales are all shipped.
- arm64 only; no universal build. Windows is out of scope here.

## Self-update (SPEC §8.10)

The launcher updates itself with Electron's `autoUpdater` (Squirrel.Mac, `loader/src/updater.js`), fed by `https://vmapp.dev/updates/mac-arm64/latest.json`
(`hostlib/updates.js`). What a build must have for this to work:

- It must be signed with a **Developer ID** (Squirrel.Mac refuses to install over an ad-hoc app, and requires the new app to be signed by the same
  identity). Ad-hoc and `npm start` builds detect this and show **Download** instead of **Update now**.
- `CFBundleShortVersionString` must be the version of `loader/package.json`: the launcher compares it with the feed's `version`.
- The release zip is made with `ditto -c -k --keepParent` (Squirrel reads that format) and is named `D9010-VmApp-Launcher-<version>-mac-arm64.zip`.
- The feed and the GitHub release are made together by `node publish.js --release` ([../docs/PRODUCTION.md](../docs/PRODUCTION.md) section 6).
