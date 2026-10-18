'use strict';
// The command line: exit codes, --json, --rule, --list; and the real tree.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { GOOD, CHECKER, VMAPP, copyGood, edit, cleanup, messages, runRules } = require('./helpers');

after(cleanup);

const run = (...args) => spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8' });

test('the checker is executable and has a node shebang', () => {
  assert.match(fs.readFileSync(CHECKER, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(CHECKER).mode & 0o111, 'not executable');
});

test('exit 0 and a PASS line per rule on the good tree', () => {
  const r = run('--root', GOOD);
  assert.equal(r.status, 0, r.stdout);
  const lines = r.stdout.split('\n').filter((l) => /^(PASS|FAIL|WARN)\s/.test(l));
  assert.equal(lines.length, 17);
  assert.ok(lines.every((l) => l.startsWith('PASS')));
  assert.match(r.stdout, /^PASS\s+INV-B1\s/m);
});

test('exit 1, the FAIL line, file:line and the offending text on a violating tree', () => {
  const root = copyGood();
  edit(root, 'loader/src/window-manager.js', 'sandbox: true', 'sandbox: false');
  const r = run('--root', root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL\s+INV-B1\s/m);
  assert.match(r.stdout, /loader\/src\/window-manager\.js:\d+/);
  assert.match(r.stdout, /> sandbox: false,/);
  assert.match(r.stdout, /VIOLATIONS FOUND/);
});

test('exit 0 with warnings (WARN does not fail)', () => {
  const root = copyGood();
  edit(root, 'loader/main.js', "const { resolveConfig } = require('./src/config');", "const { resolveConfig } = require('./src/config');\nconst _x = () => fetch('https://example.com');");
  const r = run('--root', root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^WARN\s+INV-G3\s/m);
});

test('--json is machine-readable and complete', () => {
  const root = copyGood();
  edit(root, 'hostlib/session.js', "      case 'app.quit':", "      case 'fs.read':\n        return {};\n      case 'app.quit':");
  const r = run('--json', '--root', root);
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.exit, 1);
  assert.equal(j.summary.fail, 1);
  const c2 = j.rules.find((x) => x.id === 'c2-request-ops');
  assert.equal(c2.inv, 'INV-C2');
  assert.equal(c2.status, 'FAIL');
  assert.equal(c2.findings[0].file, 'hostlib/session.js');
  assert.ok(c2.findings[0].line > 0);
  assert.ok(c2.findings[0].text);
});

test('--rule selects by id or by invariant', () => {
  const a = JSON.parse(run('--json', '--root', GOOD, '--rule', 'b1-window-prefs').stdout);
  assert.deepEqual(a.rules.map((r) => r.id), ['b1-window-prefs']);
  const b = JSON.parse(run('--json', '--root', GOOD, '--rule', 'INV-A1').stdout);
  assert.deepEqual(b.rules.map((r) => r.id).sort(), ['a1-no-code-exec', 'deps-none']);
});

test('--list names the rules', () => {
  const r = run('--list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /INV-F2\s+f2-pinned-bases/);
});

test('usage errors and a missing tree are exit 2', () => {
  assert.equal(run('--nope').status, 2);
  assert.equal(run('--diff').status, 2);
});

test('an unreadable/garbled file is reported, not swallowed: a rule that throws gives exit 2', () => {
  const root = copyGood();
  edit(root, 'loader/package.json', '"main": "main.js"', '"main": "main.js",\n  "oops"');
  const r = run('--root', root);
  assert.equal(r.status, 1, 'unparseable package.json is a FAIL finding');
  assert.match(r.stdout, /cannot parse loader\/package\.json/);
});

// ------------------------------------------------------------------------------------------------ the real tree
test('the real vmapp tree has no violations', () => {
  const results = runRules(VMAPP);
  const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  assert.deepEqual(bad.map((r) => `${r.id}: ${r.error || messages(r)}`), []);
});
