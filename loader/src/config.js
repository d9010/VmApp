'use strict';
// Where the loader finds its data and its binaries (SPEC section 1).
//   dev (not packaged): VMAPP_HOME or $VMAPP_WORK/vmapp-home (VMAPP_WORK defaults to out/work), binaries from vmapp/out
//   packaged:           ~/Library/Application Support/VMApp Loader, binaries from <Resources>/vmapp
//                       (Contents/Resources/vmapp/{vmapp-vm, Image, initramfs.cpio, runtimes/*.img})
// VMAPP_VM, VMAPP_KERNEL, VMAPP_INITRAMFS override the binaries in dev only (same names as tools/vmapp); a packaged
// loader ignores them, so the signed launcher inside the bundle is the only one it ever starts. The same goes for
// VMAPP_HOSTCTL (a fake helper for the tests) and VMAPP_HOSTCTL_DRYRUN (hostlib/hostproc.js), and for VMAPP_EXAMPLES_DIR (the
// folder "Load examples" reads: out/examples in dev, <Resources>/vmapp/examples packaged).
// VMAPP_HOME is honoured in both: where the data lives is not a security boundary (whoever can set the environment of
// the loader's process runs as the user and can edit the data directly), and the packaged tests need it.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { defaultHome, normalizeRegistryUrl } = require('../../hostlib/store');
const { DEFAULT_DEV_REGISTRY, PUBLIC_REGISTRY } = require('../../hostlib/updates');

function resolveConfig(isPackaged) {
  const root = path.resolve(__dirname, '..', '..'); // .../vmapp (dev only; inside the asar when packaged)
  let home;
  let homeFromEnv = false;
  if (process.env.VMAPP_HOME) {
    home = path.resolve(process.env.VMAPP_HOME);
    homeFromEnv = true;
  } else if (isPackaged) home = path.join(os.homedir(), 'Library', 'Application Support', 'VMApp Loader');
  else home = defaultHome();

  const binDir = isPackaged ? path.join(process.resourcesPath, 'vmapp') : path.join(root, 'out');
  const override = (name) => (isPackaged ? undefined : process.env[name]);
  let initramfs = override('VMAPP_INITRAMFS');
  if (!initramfs) {
    initramfs =
      ['initramfs.cpio', 'initramfs.cpio.gz', 'initramfs'].map((n) => path.join(binDir, n)).find((p) => fs.existsSync(p)) ||
      path.join(binDir, 'initramfs.cpio');
  }
  // The registry "Browse registry…" lists and installs from, and the one "Publish…" proposes. It is fixed, not a setting of the UI: a packaged
  // launcher uses the public registry; a development launcher (npm start) uses the one on this Mac. VMAPP_REGISTRY (set in the environment
  // that starts the launcher, never from a window) points either at another registry, for tests and for people who run their own.
  const envRegistry = normalizeRegistryUrl(process.env.VMAPP_REGISTRY || '');
  const registry = envRegistry || (isPackaged ? PUBLIC_REGISTRY : DEFAULT_DEV_REGISTRY);
  return {
    isPackaged,
    root,
    home,
    homeFromEnv,
    registry,
    vmappVm: override('VMAPP_VM') || path.join(binDir, 'vmapp-vm'),
    // the native helper behind host capabilities (SPEC 8.2): out/vmapp-hostctl in dev, Contents/Resources/vmapp/vmapp-hostctl
    // packaged. The dev-only VMAPP_HOSTCTL override is applied (and ignored when packaged) by hostlib/hostproc.js.
    hostctl: path.join(binDir, 'vmapp-hostctl'),
    // the GPU (SPEC 8.6): the sandboxed llama.cpp RPC server and its sandbox profile, built by gpu/build.sh: out/gpu/ in dev,
    // Contents/Resources/vmapp/gpu/ packaged. Dev-only overrides like VMAPP_VM; a packaged loader runs only the bundled, signed one.
    gpuServer: override('VMAPP_GPU_SERVER') || path.join(binDir, 'gpu', 'rpc-server'),
    gpuProfile: override('VMAPP_GPU_PROFILE') || path.join(binDir, 'gpu', 'rpc-server.sb'),
    // the EXPERIMENTAL Vulkan GPU backend (SPEC 8.7): vmapp-vm-krun (with its libraries and sandbox profile, built by gpu/krun/build.sh)
    // in out/krun/bin in dev, Contents/Resources/vmapp/krun/bin packaged, and the gpu kernel flavour (Image-gpu). Same dev-only overrides.
    krunVm: override('VMAPP_VM_KRUN') || path.join(binDir, 'krun', 'bin', 'vmapp-vm-krun'),
    krunKernel: override('VMAPP_KERNEL_GPU') || path.join(binDir, 'Image-gpu'),
    kernel: override('VMAPP_KERNEL') || path.join(binDir, 'Image'),
    initramfs,
    runtimesSrc: path.join(binDir, 'runtimes'),
    // the sample apps of "Load examples" (src/examples.js): *.vmapp files and a README.md, made by tools/pack-examples and, with
    // `tools/package-mac.sh --with-examples`, copied into the bundle. A dev loader may read another folder (the loader test does);
    // a packaged one reads only the folder inside its own bundle.
    examplesDir: override('VMAPP_EXAMPLES_DIR') ? path.resolve(override('VMAPP_EXAMPLES_DIR')) : path.join(binDir, 'examples'),
    uiDir: path.resolve(__dirname, '..', 'ui'),
    preloadLoader: path.resolve(__dirname, '..', 'preload-loader.js'),
    preloadApp: path.resolve(__dirname, '..', 'preload-app.js'),
  };
}

module.exports = { resolveConfig };
