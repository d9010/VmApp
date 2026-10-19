# Building, shipping and hosting D9010 VmApp releases

**For:** maintainers who produce releases of the D9010 VmApp Launcher, and anyone hosting D9010 VmApp (the loader downloads, the
runtime images, an app registry). App developers shipping their own apps should read
[DISTRIBUTING.md](DISTRIBUTING.md) instead.

---

## 1. What a release is

**One download per platform, the D9010 VmApp Launcher.** It carries everything apps need:

| Inside `D9010VmAppLauncher.app` (macOS, arm64) | Size | Built by |
|---|---|---|
| Electron 44.4.5 + the loader (`app.asar`, 216 KB of loader code) | ~300 MB | `loader/build/package.mjs` (@electron/packager) |
| `Contents/Resources/vmapp/vmapp-vm`: the VM launcher, signed with the virtualization entitlement | 0.8 MB | `tools/build.sh` |
| `Image` (Linux 6.18.56 kernel, 7.6 MB) + `initramfs.cpio` (`vmapp-init`) | 8 MB | `tools/build.sh` (the kernel: `kernel/build.sh`) |
| `runtimes/native.img`, `node22.img`, `dotnet8.img` | 0.2 + 122 + 111 MB | `tools/mkruntime` |
| **Total app** | ~540 MB on disk; **~300 MB zipped** | `tools/package-mac.sh` |

**The VM ships once, here.** Apps (`.vmapp`) never contain a VM, kernel or runtime. Updating the loader updates the
kernel and runtimes for every app.

**Users need nothing else installed:** no Node, no npm, no Docker. Electron carries its own Node, which only the
loader's trusted main process uses ([FAQ](FAQ.md)).

## 2. Build a release (macOS)

**What the build machine needs** (everything else is in this repository; no sibling folder is needed):
- macOS 13+ on Apple silicon, with the Xcode command-line tools (`clang`, `codesign`);
- Rust with the `aarch64-unknown-linux-musl` target (`rustup target add aarch64-unknown-linux-musl`). The scripts use
  `RUSTUP_HOME`/`CARGO_HOME` if you set them, else a sibling `../_toolchains` workspace toolchain if there is one, else
  `cargo` and `rustc` from `PATH` (`tools/lib/rust-env.sh`); they check the target and the `rust-lld` linker and say
  what to install;
- Node.js 22 (the packager, the CLI, the tests);
- Docker, only to build the guest kernel and the runtime images (`kernel/build.sh`, `tools/mkruntime`).

**Where things go:** products in `out/`, and all scratch files and caches (the cargo target folder, the downloaded
kernel source, the Docker build contexts, test data) in `out/work/`. Set `VMAPP_WORK` to put those elsewhere. Both are
git-ignored.

```sh
cd vmapp
tools/package-mac.sh                     # builds what's missing, packages, applies fuses, signs (ad hoc), zips
#  → out/dist/D9010VmAppLauncher.app
#  → out/dist/D9010-VmApp-Launcher-<version>-mac-arm64.zip
```

What it does, in order:
1. `tools/build.sh` (if needed): the guest init, initramfs, `vmapp-vm` and the kernel. The kernel step uses `out/Image`
   when it is up to date for `kernel/` (pins, config, lists, scripts), otherwise runs `kernel/build.sh`: it downloads
   the pinned Linux source once (cached in `out/work/cache/kernel/`), verifies it against kernel.org's PGP-signed
   checksums, builds the arm64 `Image` in a digest-pinned Ubuntu container, and checks the final config against
   `kernel/kconfig-required.txt` and `kconfig-forbidden.txt`. On an M-series Mac the first build takes about 3 minutes
   (150 MB download, build container, one minute of compiling); after a config change, about 1 minute.
   `tools/build.sh --kernel-from PATH` installs a prebuilt `Image` instead (no Docker); `--rebuild-kernel` forces a
   rebuild.
2. `tools/mkruntime` for any missing runtime image. This needs Docker on the *build* machine.
3. `npm ci` in `loader/` (dev dependencies only: Electron, @electron/packager 20.3.0, @electron/fuses 2.1.3).
4. Package the loader into `.app` with `app.asar`, and copy the VM resources into `Contents/Resources/vmapp/`.
5. **Electron fuses**, the production lock-down:

   | Fuse | State |
   |---|---|
   | RunAsNode | off |
   | NODE_OPTIONS | off |
   | `--inspect` | off |
   | asar integrity validation | on |
   | only load the app from asar | on |
   | cookie encryption | on |
   | file:// extra privileges | off |

6. **Sign inside-out:** every framework, helper and binary, then the app. `vmapp-vm` is the only binary with
   `com.apple.security.virtualization`.
7. Zip with `ditto`.

**Production hardening in the packaged loader:**
- **Startup:** it refuses `--remote-debugging-*`, `--inspect*`, `--no-sandbox`, `--disable-web-security` and
  similar switches at startup.
- **Developer access:** DevTools are off for the loader's own windows. An app's own windows get them only if the app's
  core asked (`webPreferences.devTools: true`), so ship production builds of your app without it. Every `VMAPP_TEST_*` hook
  and resource override is ignored.
- **Folder choices:** very broad folders (home, `/Volumes`, system folders) need a second confirmation; `/` and the
  loader's own data folder are refused.

Details: [../loader/PACKAGING.md](../loader/PACKAGING.md).

### 2.1 Signing for real: Developer ID and notarization

Ad-hoc builds run on the build machine. Other Macs show Gatekeeper warnings. A public release needs an Apple
Developer ID and notarization:
```sh
xcrun notarytool store-credentials "<PROFILE>" --apple-id "<APPLE_ID>" --team-id "<TEAMID>"   # once; it asks for an app-specific password, so none is on the command line
SIGN_IDENTITY="Developer ID Application: <NAME> (<TEAMID>)" tools/package-mac.sh --with-examples --examples-dir=<a folder of the examples you may publish>
bash tools/notarize-mac "<PROFILE>"
```
`tools/notarize-mac` refuses an ad-hoc build, sends the zip to Apple's notary service and waits for the verdict, prints Apple's log if it is not "Accepted", and
otherwise staples the ticket and re-creates the zip. By hand, those steps are `xcrun notarytool submit <zip> --keychain-profile "<PROFILE>" --wait`,
`xcrun stapler staple out/dist/D9010VmAppLauncher.app`, `ditto -c -k --keepParent out/dist/D9010VmAppLauncher.app <zip>` (re-zip after stapling) and
`spctl --assess --type execute --verbose=4 out/dist/D9010VmAppLauncher.app`, which must say "accepted, source=Notarized Developer ID".

**The zip carries no extended attributes.** Both scripts zip with `ditto -c -k --norsrc --noextattr --keepParent`. Without those flags, macOS 15 (which puts
`com.apple.provenance` on every file) makes ditto store hundreds of `._*` entries; an extractor that cannot apply them to the frameworks' symlinks writes them
out as real files, the Electron framework's seal breaks, and the downloaded app is refused ("could not verify … free of malware"). `--release` refuses a zip
with `._` entries and tests the build unpacked with plain `unzip`. (Found on the first 0.1.0 download; the zip was replaced in place, the app was not changed.)

**Apple opens archives inside archives.** With `--with-examples` the app carries `.vmapp` packages, and Apple's checker looks inside them (a package is a tar,
and its core a cpio). Any macOS program in there that is not signed with your Developer ID and a secure timestamp makes the whole submission "Invalid". Our
packages hold Linux programs, which Apple ignores, so the build must not leave macOS or Windows files in them: `apps/terminal/build.sh` deletes the
`prebuilds/darwin-*` and `prebuilds/win32-*` folders that the Gemini CLI's dependencies bring. Which examples a release carries is chosen with
`tools/pack-examples --without NAME`.
**Keep `CFBundleName` equal to the packager's `name` (`D9010VmAppLauncher`).** Electron finds its helper programs as `<CFBundleName> Helper.app`; with the spaced
display name in `CFBundleName` the app quits at start with "Unable to find helper app". Only `CFBundleDisplayName` has spaces, and `loader/build/package.mjs`
checks that the helpers exist.
Developer ID builds use `entitlements.mac.plist`, which is *without* `disable-library-validation`. That entitlement
exists only so ad-hoc local builds can load Electron's framework.

### 2.2 Windows and Linux
They aren't built yet. See [PLATFORMS.md](PLATFORMS.md) for the design and the work list. Each platform will get the
same `package-<os>` flow: an MSIX or NSIS installer for Windows, AppImage, deb and rpm for Linux.

## 3. Reproducibility and trust

The loader is open source, so its users should be able to check that a release is exactly the published source.

| Artifact | Reproducible today? |
|---|---|
| `vmapp-init`, `initramfs.cpio` | yes (static build, deterministic cpio) |
| the kernel `Image` | yes: pinned base image digest, dated apt snapshot, verified source, fixed build identity and timestamp (`kernel/pins.env`); the same inputs give the same bytes |
| runtime images | yes: the same pinned base digests give byte-identical images (`native` and `node22` verified twice) |
| `.vmapp` packages | yes: pack twice, identical bytes |
| `vmapp-vm` | deterministic Rust build, with the code signature applied on top |
| the Electron app bundle | mostly; Electron itself comes from the official release. Signatures differ per signer. |

**Every release publishes:**
- `SHA256SUMS` for every artifact;
- the git commit;
- the runtime image digests;
- an SBOM;
- the Linux kernel source offer (GPL): [kernel/SOURCE-OFFER.md](../kernel/SOURCE-OFFER.md) and the build's
  `out/kernel-info/` (source verification evidence, `BUILD-INFO.txt`, the final `kernel.config`, `licenses/linux/`).

Runtime images also carry their own licences: Node.js (MIT), .NET (MIT) and Debian packages.

## 4. Hosting

| What | Where to start | Notes |
|---|---|---|
| loader downloads | GitHub Releases | one zip or DMG per platform, plus `SHA256SUMS` |
| runtime images (if not all bundled) | GitHub Releases + a **signed runtime index** (`runtimes.json`: name, version, sha256, size, URL) | lets the loader fetch, say, `dotnet8` on first use, verified by hash. Not built yet; today all runtimes are bundled. |
| apps | anywhere: the publisher's site, GitHub, the D9010 VmApp registry | each build is identified by its package id |
| the app registry | one container (`registry/Dockerfile` + `compose.yaml`) behind a TLS reverse proxy or a Cloudflare Tunnel, with its packages and event log in an S3-compatible bucket (R2) or on its own disk | [../registry/README.md](../registry/README.md) (storage design), [../registry/deploy/HOSTING.md](../registry/deploy/HOSTING.md) (EC2 + Cloudflare, step by step, with costs and backups) |

## 5. Updates

The launcher updates itself ([SPEC.md](../SPEC.md) §8.10, INV-U1). What the user sees: when a newer version exists, a card appears at the top
of the launcher window with what changed, and the user chooses **Update now**, **Later** or **Skip this version**. Nothing is downloaded
without that click and nothing restarts without a second one (**Restart to update**).

How it works, and what a release must therefore get right:
- The launcher asks one fixed address, `https://vmapp.dev/updates/mac-arm64/latest.json`, once at start and then about every 24 hours; it
  sends no identifier, no list of apps, not even its own version (it compares the answer with its own version). The user can turn the check
  off in Host Capabilities (`checkForUpdates`) and ask at any time with **Check for Updates…**.
- The feed is a small JSON file that `node publish.js --release` generates (`website/release.js`, `website/build.js`) from the release: version,
  the zip's address (on the GitHub release) with its SHA-256 and size, the changes for the card, the tag and commit, and the minimum macOS.
  The launcher validates it strictly (`cleanLauncherFeed` in `hostlib/updates.js`: only `https`, only the hosts `github.com` and `vmapp.dev`,
  no redirects), and the publish script runs the same function, so a feed the launcher would reject is never deployed.
- The download and the install are done by Electron's `autoUpdater` (Squirrel.Mac), which accepts only a build **signed with the same Developer ID
  as the running launcher**. A stolen feed address therefore cannot install other software: the install fails.
- Ad-hoc and development builds never update in place; they show a **Download** button that opens the download page instead.
- Runtime updates arrive with launcher updates (the runtimes are bundled).
- **An update is the whole zip (about 520 MB); there is no delta.** Squirrel.Mac replaces the app, and the 14 sample apps and the runtimes live inside it. So a
  fix to a bundled sample app (or a runtime) is a new launcher release, like any other change. The lighter route is the registry: an app installed from it
  updates by itself, as only its own package. That is not possible for the large samples yet: the registry accepts uploads up to ~95 MiB, and the
  VS Code package is 402 MB (it needs presigned R2 uploads, see PM.md). Small apps can already be shipped that way.

Because the in-place update needs a signed build, a release is only ever made from a Developer ID build (section 2.1). The first
version cannot test the update itself: that needs two signed releases (see section 6).

## 6. Releasing a new version (one command)

`node publish.js --release` (in `website/`; `npm run release`) makes a release end to end and checks every step. Do these, in order:

1. **Raise the version** in `loader/package.json` (for example `0.1.0` → `0.1.1`) and **write the changelog**: a new entry at the top of
   [../CHANGELOG.md](../CHANGELOG.md), `## [0.1.1] - YYYY-MM-DD`, an optional one-line summary, then `### Added` / `### Changed` / `### Fixed`
   bullets in plain words. Users read these on the update card (the first sentence of each bullet), on the download page, on the GitHub release and
   on the website's changelog page, so write them for users, not for developers.
2. **Build, sign and notarize** (section 2.1): `SIGN_IDENTITY=... tools/package-mac.sh --with-examples --examples-dir=<folder>`, then
   `bash tools/notarize-mac <profile>`. The result is `out/dist/D9010-VmApp-Launcher-<version>-mac-arm64.zip`.
3. **Publish the source**: refresh the public export (`tools/export-github --out <public checkout> --refresh`), commit and push it so that GitHub is at
   the commit the build was made from. The release tags that commit.
4. **The public checkout** is found by itself when it is in the maintainer's workspace at `<workspace>/public/github`, next to the source folder `vmapp/`
   (the workspace's `CLAUDE.md` is the map of the folders). Anywhere else, set `VMAPP_EXPORT_REPO=<public checkout>` or put
   `{"exportRepo": "<path>"}` in `website/.release.local.json` (git-ignored).
5. **Check, then release**:
   ```sh
   cd website
   node publish.js --release --dry-run     # every check, nothing made
   node publish.js --release               # the release
   ```

What `--release` checks before it makes anything: the zip is named for the version of `loader/package.json`, has no `._` entries, is signed with a Developer
ID (not ad hoc), is accepted by macOS's Gatekeeper as a notarized build, has the stapled ticket, its app reports that version, and **the app starts**: it is
launched for 8 seconds in a throwaway data folder and must still be running (a signed, notarized build can still crash at start; 0.1.0 did); `CHANGELOG.md` has a
dated, non-empty entry for the version; the public checkout is clean, at `origin/main`, at the same version and carries the changelog; the tag and
the GitHub release do not exist yet; the update feed would pass the launcher's own validation.

What it then does: tags the commit (`v<version>`) and pushes the tag; creates the GitHub release (the zip, `SHA256SUMS` and notes made from
the changelog entry, marked **latest**); reads the release back (asset size and SHA-256 must match what was uploaded); writes
`website/src/release.json`; builds the site (the **Download** page and button with the version, the tag and commit it was built from, the SHA-256
and what changed; the changelog page; `updates/mac-arm64/latest.json`); deploys it; and verifies the public site, the feed included, byte for byte.
Installed launchers see the new version on their next check. The repository's **Download** link is the release page
(`https://github.com/d9010/VmApp/releases/latest`), which always shows the newest release.

If it stops in the middle: before the tag is pushed nothing is changed. After the release exists but before the site is deployed, run
`node publish.js --site-only --live` (the site is rebuilt from `website/src/release.json`). A version is released once; a mistake is fixed by
a new version, not by replacing a release. Commit `website/src/release.json` with the next documentation change so the source matches what is live.

## 7. Release checklist

- [ ] `tools/check-invariants` passes
- [ ] unit, e2e, apps, template, convert, registry and loader suites pass on a clean checkout
- [ ] `tools/package-mac.sh` with the Developer ID; notarized and stapled; `spctl --assess` accepts it
- [ ] the packaged app launches with no Node on `PATH` and runs a sample app end to end
- [ ] `SHA256SUMS`, the SBOM, runtime digests, the commit hash and the kernel source offer are published
- [ ] the release notes list SPEC or format changes and any invariant changes (and there should be none without a
      GOVERNANCE pull request)
- [ ] `node publish.js --release --dry-run` passes, then `node publish.js --release` (section 6): tag, GitHub release, Download page, update feed
- [ ] on a Mac that has the **previous** signed version installed: the update card appears, **Update now** downloads, **Restart to update**
      relaunches into the new version. (The first release has no previous version; test this with the second.)
