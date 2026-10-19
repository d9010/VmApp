// Builds the unsigned "D9010VmAppLauncher.app" (steps 1-3 of tools/package-mac.sh; signing is build/sign-mac.sh):
//   1. stages the app code (loader/ + hostlib/, no node_modules) in <dist>/stage
//   2. @electron/packager -> Electron 44 app bundle with the code in app.asar (+ ElectronAsarIntegrity in Info.plist)
//   3. @electron/fuses -> production fuses
//   4. copies the VM bits into Contents/Resources/vmapp/ (vmapp-vm, Image, initramfs.cpio, runtimes/*.img), the
//      host-capabilities helper vmapp-hostctl (SPEC 8.2; screen and input, spawned by the loader, never by an app),
//      kernel-info/ (out/kernel-info: the kernel's GPL source offer and licence texts) and gpu/ (out/gpu: the sandboxed
//      llama.cpp RPC server, its sandbox profile, its licence and build record; SPEC 8.6, started by the loader, never by an app)
//
//   node build/package.mjs [--dist <dir>] [--out <vmapp/out dir>] [--with-krun]
//   --with-krun   also bundles the EXPERIMENTAL Vulkan backend (SPEC 8.7): krun/ (launcher, libraries, sandbox profile), Image-gpu,
//                 kernel-info-gpu/ and runtimes/node22-gpu.img (not signed for distribution yet)
//   --with-examples  also bundles the sample apps of "Load examples": out/examples/*.vmapp and README.md (made by tools/pack-examples)
//                 -> Contents/Resources/vmapp/examples/ (about 360 MB; plain data, see below)
// Defaults: dist = vmapp/out/dist, out = vmapp/out. Run from vmapp/loader (npm ci first).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { flipFuses, getCurrentFuseWire, FuseV1Options, FuseVersion } from '@electron/fuses';

const require = createRequire(import.meta.url);
const LOADER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VMAPP = path.resolve(LOADER, '..');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : dflt;
};
const OUT = opt('--out', path.join(VMAPP, 'out'));
const DIST = opt('--dist', path.join(OUT, 'dist'));
const STAGE = path.join(DIST, 'stage');
const PKGOUT = path.join(DIST, 'pkg');
const APP = path.join(DIST, 'D9010VmAppLauncher.app');
const REQUIRED_RUNTIMES = ['native', 'node22', 'dotnet8'];

const loaderPkg = JSON.parse(fs.readFileSync(path.join(LOADER, 'package.json'), 'utf8'));
const electronVersion = loaderPkg.devDependencies.electron;
const step = (m) => console.log(`\n== ${m}`);
const CLONE = fs.constants.COPYFILE_FICLONE; // APFS clone when possible: the 230 MB of images copy instantly

// Only ever delete a directory we created, below DIST.
function removeBelowDist(p) {
  const rel = path.relative(DIST, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to delete ${p}`);
  fs.rmSync(p, { recursive: true, force: true });
}

// ---- inputs ----
const vmFiles = ['vmapp-vm', 'Image', 'initramfs.cpio'];
const HOSTCTL = 'vmapp-hostctl'; // the native helper behind host capabilities; a plain Mach-O, signed by sign-mac.sh
for (const f of vmFiles) if (!fs.existsSync(path.join(OUT, f))) throw new Error(`${path.join(OUT, f)} is missing (run vmapp/tools/build.sh)`);
if (!fs.existsSync(path.join(OUT, HOSTCTL))) throw new Error(`${path.join(OUT, HOSTCTL)} is missing (run vmapp/tools/package-mac.sh, or vmapp/host/hostctl/build.sh out/${HOSTCTL})`);
const KERNEL_INFO = path.join(OUT, 'kernel-info'); // SOURCE-OFFER.md + licences of the kernel, from kernel/build.sh
if (!fs.existsSync(path.join(KERNEL_INFO, 'SOURCE-OFFER.md')) || !fs.existsSync(path.join(KERNEL_INFO, 'licenses'))) {
  throw new Error(`${KERNEL_INFO} (SOURCE-OFFER.md and licenses/) is missing: the bundle ships the Linux kernel, so its source offer must ship too (run vmapp/kernel/build.sh)`);
}
for (const r of REQUIRED_RUNTIMES) {
  if (!fs.existsSync(path.join(OUT, 'runtimes', `${r}.img`))) throw new Error(`${path.join(OUT, 'runtimes', `${r}.img`)} is missing (run vmapp/tools/mkruntime)`);
}
// The GPU server (SPEC 8.6): llama.cpp's RPC server with Metal, built from the pinned commit by gpu/build.sh. Its MIT licence and the
// record of what it was built from travel with it. The sandbox profile is the reviewed gpu/rpc-server.sb, copied by the build.
const GPU = path.join(OUT, 'gpu');
const GPU_FILES = ['rpc-server', 'rpc-server.sb', 'LICENSE-llama.cpp.txt', 'BUILD-INFO.txt'];
for (const f of GPU_FILES) {
  if (!fs.existsSync(path.join(GPU, f))) throw new Error(`${path.join(GPU, f)} is missing (run vmapp/gpu/build.sh)`);
}
fs.mkdirSync(DIST, { recursive: true });

// ---- 1. stage ----
step('stage app code');
removeBelowDist(STAGE);
fs.mkdirSync(path.join(STAGE, 'loader'), { recursive: true });
for (const f of ['main.js', 'preload-app.js', 'preload-loader.js']) fs.copyFileSync(path.join(LOADER, f), path.join(STAGE, 'loader', f));
for (const d of ['src', 'ui']) fs.cpSync(path.join(LOADER, d), path.join(STAGE, 'loader', d), { recursive: true });
// the page half of the HTTP bridge: the launcher uses it too, to answer the app's page natively (loader/src/app-serve.js)
fs.mkdirSync(path.join(STAGE, 'sdk', 'web'), { recursive: true });
fs.copyFileSync(path.join(VMAPP, 'sdk', 'web', 'vmapp-fetch.js'), path.join(STAGE, 'sdk', 'web', 'vmapp-fetch.js'));
// the structured clone codec of the bridge (hostlib/bridge.js); the same file is in the runtime images, for the guest SDK
fs.mkdirSync(path.join(STAGE, 'sdk', 'node'), { recursive: true });
fs.copyFileSync(path.join(VMAPP, 'sdk', 'node', 'ipc-codec.js'), path.join(STAGE, 'sdk', 'node', 'ipc-codec.js'));
fs.mkdirSync(path.join(STAGE, 'hostlib'));
for (const f of fs.readdirSync(path.join(VMAPP, 'hostlib'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(VMAPP, 'hostlib', f), path.join(STAGE, 'hostlib', f));
}
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify({ name: 'vmapp-loader', productName: 'D9010 VmApp Launcher', version: loaderPkg.version, description: loaderPkg.description, main: 'loader/main.js', private: true }, null, 2) + '\n',
);

// ---- 2. packager ----
step(`@electron/packager (electron ${electronVersion}, darwin arm64, asar)`);
removeBelowDist(PKGOUT);
removeBelowDist(APP);
const unused = 'D9010 VmApp Launcher does not use this device; every request from an app is denied.';
// The microphone is the one device an app can be given (SPEC 2.2 permissions.devices, SPEC 7): only an app that asks for it
// AND that you allow in the loader's permission sheet. macOS shows this text in its own consent prompt.
const micUse = 'An app you allowed to use the microphone in D9010 VmApp Launcher wants to listen. D9010 VmApp Launcher gives the microphone only to apps you allow in its permission sheet, and only while they run.';
const appPaths = await packager({
  dir: STAGE,
  out: PKGOUT,
  name: 'D9010VmAppLauncher',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion,
  asar: true,
  prune: false,
  overwrite: true,
  appBundleId: 'com.vmapp.loader',
  appVersion: loaderPkg.version,
  buildVersion: loaderPkg.version,
  appCategoryType: 'public.app-category.utilities',
  appCopyright: 'Copyright © 2026 D9010 Inc. MIT licence.',
  // the D9010 logo: Finder, the Dock, Cmd-Tab and the About panel (made by build/make-icons.sh from build/icons/app-icon.svg)
  icon: path.join(LOADER, 'build', 'icon.icns'),
  darwinDarkModeSupport: true,
  // app links (SPEC 8.9): the loader is the Mac's handler of vmapp://<app id>/… (Info.plist CFBundleURLTypes)
  protocols: [{ name: 'D9010 VmApp app link', schemes: ['vmapp'] }],
  extendInfo: {
    LSMinimumSystemVersion: '13.0',
    // Electron's template says "This app needs access to ..." for these. The camera, system-audio capture and Bluetooth are never
    // given to an app; the microphone only as described above.
    NSCameraUsageDescription: unused,
    NSMicrophoneUsageDescription: micUse,
    NSAudioCaptureUsageDescription: unused,
    NSBluetoothAlwaysUsageDescription: unused,
    NSBluetoothPeripheralUsageDescription: unused,
  },
  quiet: true,
});
if (appPaths.length !== 1) throw new Error(`expected one app, got ${appPaths.length}`);
const built = path.join(appPaths[0], 'D9010VmAppLauncher.app');
fs.renameSync(built, APP);
// The name people see (Finder, Dock, About) has spaces; the bundle and executable file names do not. Only CFBundleDisplayName is changed: Electron
// finds its helper programs as "<CFBundleName> Helper.app" (Contents/Frameworks), so CFBundleName must stay equal to the packager's `name`
// (D9010VmAppLauncher) or the app dies at start with "Unable to find helper app". The menu bar and About use the app's productName
// ("D9010 VmApp Launcher", in the packaged package.json), so they show the spaced name anyway.
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'D9010 VmApp Launcher', path.join(APP, 'Contents', 'Info.plist')]);
// A test cannot run the packaged app without a Mac, so the packager checks the one thing that broke: every helper app Electron looks for exists.
{
  const bundleName = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', path.join(APP, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  for (const suffix of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) {
    const helper = path.join(APP, 'Contents', 'Frameworks', `${bundleName} Helper${suffix}.app`);
    if (!fs.existsSync(helper)) throw new Error(`Electron would not find its helper: ${helper} does not exist (CFBundleName is "${bundleName}")`);
  }
}
removeBelowDist(PKGOUT);
removeBelowDist(STAGE);

// ---- 3. fuses ----
step('fuses');
await flipFuses(APP, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  // LoadBrowserProcessSpecificV8Snapshot and WasmTrapHandlers stay at Electron's defaults
});
const wire = await getCurrentFuseWire(path.join(APP, 'Contents', 'MacOS', 'D9010VmAppLauncher'));
console.log(JSON.stringify(wire));

// ---- 4. VM resources ----
step('copy VM resources to Contents/Resources/vmapp');
const res = path.join(APP, 'Contents', 'Resources', 'vmapp');
fs.mkdirSync(path.join(res, 'runtimes'), { recursive: true });
for (const f of vmFiles) fs.cpSync(path.join(OUT, f), path.join(res, f), { mode: CLONE });
for (const r of REQUIRED_RUNTIMES) fs.cpSync(path.join(OUT, 'runtimes', `${r}.img`), path.join(res, 'runtimes', `${r}.img`), { mode: CLONE });
fs.chmodSync(path.join(res, 'vmapp-vm'), 0o755);
fs.cpSync(path.join(OUT, HOSTCTL), path.join(res, HOSTCTL), { mode: CLONE });
fs.chmodSync(path.join(res, HOSTCTL), 0o755);
// The kernel is GPL-2.0 software that ships in the bundle (Resources/vmapp/Image). Its source offer and licence texts travel with it:
// out/kernel-info/ (made by kernel/build.sh: SOURCE-OFFER.md, licenses/, and the build evidence) -> Resources/vmapp/kernel-info/.
fs.cpSync(KERNEL_INFO, path.join(res, 'kernel-info'), { recursive: true });
// The GPU server and its sandbox profile (SPEC 8.6). hostlib/gpu.js starts only these two files, from this folder, and only through
// /usr/bin/sandbox-exec; sign-mac.sh signs the server (hardened runtime, no entitlements).
fs.mkdirSync(path.join(res, 'gpu'));
for (const f of GPU_FILES) fs.cpSync(path.join(GPU, f), path.join(res, 'gpu', f), { mode: CLONE });
fs.chmodSync(path.join(res, 'gpu', 'rpc-server'), 0o755);
fs.chmodSync(path.join(res, 'gpu', 'rpc-server.sb'), 0o644);

// The EXPERIMENTAL Vulkan backend (SPEC 8.7), only with --with-krun: the launcher with its libraries and sandbox profile (out/krun, from
// gpu/krun/build.sh), the gpu kernel flavour and its source offer (out/Image-gpu, out/kernel-info-gpu) and the runtime that carries the
// Vulkan driver. hostlib starts the launcher only through the user's switch (INV-H8). NOT signed for distribution yet: sign-mac.sh does not
// know these files (they stay ad-hoc signed), so a bundle with them is for the developer's own Mac (docs: gpu/krun/README.md).
if (args.includes('--with-krun')) {
  step('experimental Vulkan backend (--with-krun)');
  const need = [['krun/bin/vmapp-vm-krun'], ['krun/lib/libkrun.1.dylib'], ['krun/share/vmm.sb'], ['krun/licenses/NOTICES.txt'], ['Image-gpu'], ['kernel-info-gpu/SOURCE-OFFER.md'], ['runtimes/node22-gpu.img']];
  for (const [f] of need) if (!fs.existsSync(path.join(OUT, f))) throw new Error(`${path.join(OUT, f)} is missing (run gpu/krun/build.sh, kernel/build.sh --flavour gpu and tools/mkruntime runtimes/node22-gpu)`);
  fs.cpSync(path.join(OUT, 'krun'), path.join(res, 'krun'), { recursive: true });
  fs.cpSync(path.join(OUT, 'Image-gpu'), path.join(res, 'Image-gpu'), { mode: CLONE });
  fs.cpSync(path.join(OUT, 'kernel-info-gpu'), path.join(res, 'kernel-info-gpu'), { recursive: true });
  fs.cpSync(path.join(OUT, 'runtimes', 'node22-gpu.img'), path.join(res, 'runtimes', 'node22-gpu.img'), { mode: CLONE });
  fs.chmodSync(path.join(res, 'krun', 'bin', 'vmapp-vm-krun'), 0o755);
}

// The sample apps of "Load examples" (loader/src/examples.js), only with --with-examples: out/examples/*.vmapp and README.md (from
// tools/pack-examples) -> Resources/vmapp/examples/. They are plain data: the loader reads them like any file the user picks, lists them
// from the packages themselves and verifies each one again when it is installed, so they need no signing of their own (the bundle's
// signature seals them as resources). A packaged loader reads only this folder (src/config.js ignores VMAPP_EXAMPLES_DIR). Nothing in
// them runs or is allowed until the user installs one, launches it and answers its permission sheet.
if (args.includes('--with-examples')) {
  step('sample apps (--with-examples)');
  const src = opt('--examples-dir', path.join(OUT, 'examples')); // a release uses a folder made with: tools/pack-examples --without ...
  const packages = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith('.vmapp') && fs.statSync(path.join(src, f)).isFile()).sort() : [];
  if (packages.length === 0) throw new Error(`${src} has no .vmapp files (run vmapp/tools/pack-examples)`);
  const dest = path.join(res, 'examples');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of packages) fs.cpSync(path.join(src, f), path.join(dest, f), { mode: CLONE });
  if (fs.existsSync(path.join(src, 'README.md'))) fs.cpSync(path.join(src, 'README.md'), path.join(dest, 'README.md'));
  console.log(`${packages.length} example package(s) copied to Resources/vmapp/examples`);
}

// ---- report ----
const plist = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(APP, 'Contents', 'Info.plist')]).toString().trim();
console.log(`\nbuilt ${APP}\nbundle id ${plist}, version ${loaderPkg.version}`);
void require;
