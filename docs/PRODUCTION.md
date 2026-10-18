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

**Apple opens archives inside archives.** With `--with-examples` the app carries `.vmapp` packages, and Apple's checker looks inside them (a package is a tar,
and its core a cpio). Any macOS program in there that is not signed with your Developer ID and a secure timestamp makes the whole submission "Invalid". Our
packages hold Linux programs, which Apple ignores, so the build must not leave macOS or Windows files in them: `apps/terminal/build.sh` deletes the
`prebuilds/darwin-*` and `prebuilds/win32-*` folders that the Gemini CLI's dependencies bring. Which examples a release carries is chosen with
`tools/pack-examples --without NAME`.
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

Not built yet. The plan, consistent with INV-G3 (no network without the user):
- the loader checks a **signed** release feed only when the user allows it, with an off switch;
- each update downloads the full app, verified by signature;
- runtime updates arrive with loader updates. A runtime-only update can use the signed runtime index.

## 6. Release checklist

- [ ] `tools/check-invariants` passes
- [ ] unit, e2e, apps, template, convert, registry and loader suites pass on a clean checkout
- [ ] `tools/package-mac.sh` with the Developer ID; notarized and stapled; `spctl --assess` accepts it
- [ ] the packaged app launches with no Node on `PATH` and runs a sample app end to end
- [ ] `SHA256SUMS`, the SBOM, runtime digests, the commit hash and the kernel source offer are published
- [ ] the release notes list SPEC or format changes and any invariant changes (and there should be none without a
      GOVERNANCE pull request)
