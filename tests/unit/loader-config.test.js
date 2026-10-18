'use strict';
// loader/src/config.js: the dev-only overrides of the loader's binaries. A development loader takes the VM launcher, the kernel,
// the initramfs and the GPU server (and its sandbox profile) from the environment, which is how the loader test substitutes a
// stand-in GPU server; a PACKAGED loader ignores every one of them, so the signed binaries inside the bundle are the only ones it
// ever starts (SPEC 8.6, GOVERNANCE INV-H7).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveConfig } = require('../../loader/src/config');

const OVERRIDES = {
  VMAPP_VM: '/tmp/evil/vmapp-vm',
  VMAPP_KERNEL: '/tmp/evil/Image',
  VMAPP_INITRAMFS: '/tmp/evil/initramfs.cpio',
  VMAPP_GPU_SERVER: '/tmp/evil/rpc-server',
  VMAPP_GPU_PROFILE: '/tmp/evil/rpc-server.sb',
};

/** Runs fn with the overrides set (and process.resourcesPath, which only exists inside Electron), then puts everything back. */
function withEnv(fn) {
  const saved = {};
  for (const k of Object.keys(OVERRIDES)) saved[k] = process.env[k];
  const hadRes = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  const savedRes = process.resourcesPath;
  Object.assign(process.env, OVERRIDES);
  process.resourcesPath = '/Applications/D9010VmAppLauncher.app/Contents/Resources';
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (hadRes) process.resourcesPath = savedRes;
    else delete process.resourcesPath;
  }
}

test('a development loader takes its binaries, the GPU server and its profile from the dev-only overrides', () => {
  const cfg = withEnv(() => resolveConfig(false));
  assert.equal(cfg.vmappVm, OVERRIDES.VMAPP_VM);
  assert.equal(cfg.kernel, OVERRIDES.VMAPP_KERNEL);
  assert.equal(cfg.initramfs, OVERRIDES.VMAPP_INITRAMFS);
  assert.equal(cfg.gpuServer, OVERRIDES.VMAPP_GPU_SERVER);
  assert.equal(cfg.gpuProfile, OVERRIDES.VMAPP_GPU_PROFILE);
});

test('a packaged loader ignores all of them: the GPU server and its profile are the bundled ones', () => {
  const cfg = withEnv(() => resolveConfig(true));
  const bundle = path.join('/Applications/D9010VmAppLauncher.app/Contents/Resources', 'vmapp');
  assert.equal(cfg.gpuServer, path.join(bundle, 'gpu', 'rpc-server'));
  assert.equal(cfg.gpuProfile, path.join(bundle, 'gpu', 'rpc-server.sb'));
  assert.equal(cfg.vmappVm, path.join(bundle, 'vmapp-vm'));
  assert.equal(cfg.kernel, path.join(bundle, 'Image'));
  for (const v of [cfg.gpuServer, cfg.gpuProfile, cfg.vmappVm, cfg.kernel, cfg.initramfs]) assert.ok(!v.includes('evil'), `${v} came from the environment`);
});

test('the registry is fixed: a packaged launcher uses the public one, a development launcher the one on this Mac, VMAPP_REGISTRY overrides either', () => {
  const { PUBLIC_REGISTRY, DEFAULT_DEV_REGISTRY } = require('../../hostlib/updates');
  assert.equal(PUBLIC_REGISTRY, 'https://api.vmapp.dev');
  const saved = process.env.VMAPP_REGISTRY;
  const hadRes = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  process.resourcesPath = '/Applications/D9010VmAppLauncher.app/Contents/Resources';
  try {
    delete process.env.VMAPP_REGISTRY;
    assert.equal(resolveConfig(true).registry, PUBLIC_REGISTRY);
    assert.equal(resolveConfig(false).registry, DEFAULT_DEV_REGISTRY);
    process.env.VMAPP_REGISTRY = 'http://127.0.0.1:9999/';
    assert.equal(resolveConfig(true).registry, 'http://127.0.0.1:9999');
    process.env.VMAPP_REGISTRY = 'not an address';
    assert.equal(resolveConfig(true).registry, PUBLIC_REGISTRY, 'an unusable value falls back to the public registry');
  } finally {
    if (saved === undefined) delete process.env.VMAPP_REGISTRY;
    else process.env.VMAPP_REGISTRY = saved;
    if (!hadRes) delete process.resourcesPath;
  }
});
