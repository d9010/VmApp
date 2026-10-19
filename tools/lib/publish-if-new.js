#!/usr/bin/env node
// Publishes one .vmapp to a registry unless that exact package is already there. Used by `tools/pack-examples --publish`, so that
// every sample app can be built and published on its own, and a sample that did not change is not sent again.
//
//   node tools/lib/publish-if-new.js FILE.vmapp [--registry URL]
//
// The owner token is the one `tools/vmapp publish` uses: $VMAPP_PUBLISH_TOKEN, else the one an earlier publish saved in
// $VMAPP_HOME/publish-tokens.json. An app id that is new to the registry joins the publisher of that token.
//   - the same id and version with the same bytes is there already: "unchanged", nothing is sent (exit 0);
//   - the same id and version with other bytes: refused (exit 1); versions are immutable, raise "version" in vmapp.json;
//   - a version that is not newer than the latest one: refused by the registry (exit 1);
//   - otherwise `tools/vmapp publish` runs (exit 0 when it publishes).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const hostlib = require(path.join(ROOT, 'hostlib'));

async function main(argv) {
  const args = argv.slice();
  let registry = process.env.VMAPP_REGISTRY || 'https://api.vmapp.dev';
  let file = null;
  while (args.length) {
    const a = args.shift();
    if (a === '--registry') registry = String(args.shift() || '');
    else if (!file) file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!file) throw new Error('usage: publish-if-new.js FILE.vmapp [--registry URL]');
  registry = registry.replace(/\/+$/, '');
  const p = hostlib.package.read(path.resolve(file));
  const { id, version } = p.manifest;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  const res = await fetch(`${registry}/api/apps/${encodeURIComponent(id)}/versions`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (res.ok) {
    const versions = await res.json();
    const have = Array.isArray(versions) ? versions.find((v) => v.version === version) : null;
    if (have && have.sha256 === sha) return console.log(`unchanged  ${id} ${version} is published already with these bytes (not sent)`);
    if (have) throw new Error(`${id} ${version} is published with other bytes; versions are immutable, so raise "version" in the app's vmapp.json and pack again`);
  } else if (res.status !== 404) {
    throw new Error(`the registry at ${registry} answered HTTP ${res.status} when asked about ${id}`);
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'vmapp'), 'publish', path.resolve(file), '--registry', registry], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`vmapp publish failed for ${id} ${version}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`publish-if-new: ${e.message}`);
  process.exit(1);
});
