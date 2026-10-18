'use strict';
// Shared helpers for the unit tests. Scratch space lives under $VMAPP_WORK/scratch/unit (VMAPP_WORK defaults to
// vmapp/out/work, git-ignored); never the system temp dir.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // .../vmapp
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(ROOT, 'out', 'work'));
const SCRATCH = path.join(WORK, 'scratch', 'unit');

function tmpdir(prefix = 't-') {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, prefix));
}

function rmrf(dir) {
  if (dir && dir.startsWith(SCRATCH + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

/** Writes a project directory for pack(). */
function makeProject(dir, overrides = {}) {
  const manifest = Object.assign(
    {
      format: 1,
      id: 'com.example.notes',
      name: 'Notes',
      version: '1.0.0',
      publisher: 'Example Inc.',
      description: 'Test app',
      runtime: 'node22',
      core: { command: ['node', 'main.js'], env: { NODE_ENV: 'production' } },
      ui: { root: 'ui' },
      permissions: {
        folders: [
          { name: 'notes', access: 'readwrite', purpose: 'Where notes live' },
          { name: 'export', access: 'writeonly', purpose: 'Exports' },
        ],
        dialogs: true,
        external: true,
      },
    },
    overrides.manifest || {},
  );
  write(path.join(dir, 'vmapp.json'), JSON.stringify(manifest, null, 2));
  write(path.join(dir, 'ui', 'index.html'), '<!doctype html><title>x</title>');
  write(path.join(dir, 'ui', 'css', 'app.css'), 'body{}');
  write(path.join(dir, 'ui', 'js', 'app.js'), 'console.log(1)');
  write(path.join(dir, 'core', 'main.js'), overrides.mainJs || "console.log('hi')\n");
  write(path.join(dir, 'core', 'bin', 'run.sh'), '#!/bin/sh\n', 0o755);
  fs.symlinkSync('main.js', path.join(dir, 'core', 'link.js'));
  return manifest;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, SCRATCH, tmpdir, rmrf, write, makeProject, wait };
