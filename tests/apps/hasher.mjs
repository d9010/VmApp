// Hasher (native runtime, Rust core): choose a folder through dialog.open, stream progress + results, compare every
// SHA-256 with `shasum -a 256`, save the report through dialog.save, and check that closing the window exits the core.
// Run by run-all.sh with: --open <fixtures>/hasher --save <fixtures>/out/hashes.txt
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emitted, ok, requireEnv, waitFor, waitForFile } from './lib.mjs';

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const shasum = (file) => execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(' ')[0];

export default async function ({ session, wm, dialogs }) {
  const fix = requireEnv('APPS_FIX');
  const dir = path.join(fix, 'hasher');
  const reportFile = path.join(fix, 'out', 'hashes.txt');

  // extra content made at test time: a larger binary file, an empty file, unicode name, a symlink (must be skipped)
  fs.writeFileSync(path.join(dir, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024 + 123));
  fs.writeFileSync(path.join(dir, 'empty.dat'), '');
  fs.mkdirSync(path.join(dir, 'zeta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'zeta', 'café.txt'), 'unicode name\n');
  fs.symlinkSync('a.txt', path.join(dir, 'link-to-a.txt'));
  fs.symlinkSync('sub', path.join(dir, 'link-to-sub'));

  await wm.waitForWindows(1, 20000);
  const win = 1;
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  ok('window created by the Rust core (window.create over the bridge)');

  // cancelled dialog ----------------------------------------------------------------------------------------
  const answer = dialogs.opts.open;
  dialogs.opts.open = null;
  assert.deepEqual(await wm.invoke(win, 'hasher:choose'), { canceled: true });
  dialogs.opts.open = answer;
  await assert.rejects(() => wm.invoke(win, 'hasher:save'), /nothing to save/i);
  ok('cancelled folder dialog does nothing; saving before a scan is refused');

  // scan ----------------------------------------------------------------------------------------------------
  const r = await wm.invoke(win, 'hasher:choose');
  assert.equal(r.canceled, false);
  assert.match(r.path, /^\/host\/pick-\d+$/);
  const openCall = dialogs.calls.find((c) => c.kind === 'open');
  assert.equal(openCall.params.directory, true);
  assert.equal(openCall.params.multiple, false);
  const [done] = await wm.waitForEmit('done', { win, timeoutMs: 60000 });
  const expectedFiles = walk(dir);
  assert.equal(done.count, expectedFiles.length);
  assert.equal(done.errors, 0);
  assert.equal(done.truncated, false);
  assert.equal(done.canceled, false);

  const rows = emitted(wm, win, 'result').map((a) => a[0]);
  assert.deepEqual(rows.map((x) => x.path), expectedFiles, 'results arrive in sorted walk order, symlinks skipped');
  for (const row of rows) {
    const file = path.join(dir, row.path);
    assert.equal(row.sha256, shasum(file), `sha256 of ${row.path}`);
    assert.equal(row.size, fs.statSync(file).size, `size of ${row.path}`);
  }
  assert.ok(rows.some((x) => x.path === 'sub/deep/c d.txt'));
  assert.ok(rows.some((x) => x.path === 'zeta/café.txt'));
  assert.ok(!rows.some((x) => x.path.startsWith('link-to')), 'symlinks are not followed');
  ok(`${rows.length} results match shasum -a 256 (incl. 3 MiB file, empty file, nested + unicode names; symlinks skipped)`);

  const started = emitted(wm, win, 'started')[0][0];
  assert.equal(started.total, expectedFiles.length);
  const progress = emitted(wm, win, 'progress').map((a) => a[0]);
  assert.ok(progress.length >= 1);
  const lastProgress = progress.at(-1);
  assert.equal(lastProgress.done, expectedFiles.length);
  assert.equal(lastProgress.total, expectedFiles.length);
  assert.ok(progress.every((p, i) => i === 0 || p.done > progress[i - 1].done), 'progress increases');
  assert.ok(expectedFiles.includes(lastProgress.current));
  ok(`progress streamed (${progress.length} updates, last ${lastProgress.done}/${lastProgress.total})`);

  await waitFor(() => /files hashed$/.test(wm.windows.get(win).title), { what: 'window title with the file count' });
  assert.equal(wm.windows.get(win).title, `${expectedFiles.length} files hashed`);
  ok(`window title: "${wm.windows.get(win).title}"`);

  // save report ---------------------------------------------------------------------------------------------
  const saved = await wm.invoke(win, 'hasher:save');
  assert.equal(saved.canceled, false);
  assert.equal(saved.count, expectedFiles.length);
  const saveCall = dialogs.calls.find((c) => c.kind === 'save');
  assert.equal(saveCall.params.defaultName, 'hashes.txt');
  await waitForFile(reportFile);
  // the host delivers when the write settles; give a partially delivered file a moment to be complete
  const expectedReport = expectedFiles.map((f) => `${shasum(path.join(dir, f))}  ${f}\n`).join('');
  await waitFor(() => fs.readFileSync(reportFile, 'utf8') === expectedReport, { what: 'complete report on the host' });
  const lines = fs.readFileSync(reportFile, 'utf8').trimEnd().split('\n');
  assert.ok(lines.every((l) => /^[0-9a-f]{64} {2}\S/.test(l)));
  assert.ok(!fs.existsSync(reportFile + '.partial'));
  ok(`report written to the chosen host path: ${lines.length} lines "sha256  relative/path"`);

  // closing the window exits the core ---------------------------------------------------------------------
  wm.userClose(win);
  const stopped = await Promise.race([session.whenStopped(), new Promise((r2) => setTimeout(() => r2(null), 15000))]);
  assert.ok(stopped, 'the VM stops after the window closed');
  assert.ok(['core-exited', 'shutdown'].includes(session.stoppedInfo.reason), session.stoppedInfo.reason);
  assert.equal(session.stoppedInfo.exitCode, 0);
  ok('window closed: the Rust core exited with code 0 and the VM powered off');
  console.log('HASHER-OK');
}
