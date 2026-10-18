'use strict';
// --diff <range>: classification, G4, red flags on added lines. Uses a throwaway git repo with vmapp/ inside it.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { GOOD, CHECKER, scratch, cleanup, edit, write } = require('./helpers');

after(cleanup);

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repo with the good tree under vmapp/ plus an outside file; `change(vmappRoot, repoRoot)` makes the second commit. */
function repoWith(change) {
  const repo = scratch('git');
  const vmapp = path.join(repo, 'vmapp');
  fs.cpSync(GOOD, vmapp, { recursive: true });
  write(vmapp, 'README.md', '# vmapp\n');
  write(vmapp, 'tests/unit/a.test.js', 'test\n');
  write(repo, 'other/file.txt', 'x\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  change(vmapp, repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  return { repo, vmapp };
}

function runCli(vmapp, ...args) {
  const r = spawnSync(process.execPath, [CHECKER, '--json', '--root', vmapp, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const byId = (json, id) => json.rules.find((r) => r.id === id);

test('docs and tests only: Class B, nothing protected, G4 passes', () => {
  const { vmapp } = repoWith((v) => {
    write(v, 'README.md', '# vmapp\n\nmore docs\n');
    write(v, 'tests/unit/a.test.js', 'test2\n');
  });
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.diff.class, 'B');
  assert.equal(r.json.diff.protectedCount, 0);
  assert.equal(r.json.diff.files.length, 2);
  assert.equal(byId(r.json, 'g4-stay-inside').status, 'PASS');
  assert.equal(byId(r.json, 'red-flags').status, 'PASS');
});

test('a protected file makes it Class A and lists its invariants', () => {
  const { vmapp } = repoWith((v) => edit(v, 'loader/src/protocols.js', "'content-security-policy': csp", "'content-security-policy': csp, 'x-extra': '1'"));
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.json.diff.class, 'A');
  assert.equal(r.json.diff.protectedCount, 1);
  const f = r.json.diff.files[0];
  assert.equal(f.path, 'vmapp/loader/src/protocols.js');
  assert.equal(f.rel, 'loader/src/protocols.js');
  assert.deepEqual(f.invariants, ['INV-B3', 'INV-B4']);
  // the working tree still satisfies the invariants; G1/G2 only hint
  assert.equal(r.status, 0, r.stdout);
  assert.equal(byId(r.json, 'g1-spec-sync').status, 'WARN');
  assert.equal(byId(r.json, 'g2-denied-path-tests').status, 'WARN');
});

test('G1/G2 are quiet when SPEC.md and a test change with the protected file', () => {
  const { vmapp } = repoWith((v) => {
    edit(v, 'hostlib/bridge.js', 'class BridgeClient {', 'class BridgeClient {\n  // changed');
    write(v, 'SPEC.md', fs.readFileSync(path.join(v, 'SPEC.md'), 'utf8') + '\nnote\n');
    write(v, 'tests/unit/a.test.js', 'test3\n');
  });
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.json.diff.class, 'A');
  assert.equal(byId(r.json, 'g1-spec-sync').status, 'PASS');
  assert.equal(byId(r.json, 'g2-denied-path-tests').status, 'PASS');
});

test('INV-G4: a changed path outside vmapp/ fails with exit 1', () => {
  const { vmapp } = repoWith((v, repo) => write(repo, 'other/file.txt', 'changed\n'));
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.status, 1);
  assert.equal(byId(r.json, 'g4-stay-inside').status, 'FAIL');
  assert.deepEqual(r.json.diff.outside, ['other/file.txt']);
});

test('standalone repository (vmapp is the git root): paths have no prefix, a protected file is still Class A, G4 passes', () => {
  const repo = scratch('git');
  fs.cpSync(GOOD, repo, { recursive: true });
  write(repo, 'README.md', '# vmapp\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  edit(repo, 'loader/src/protocols.js', "'content-security-policy': csp", "'content-security-policy': csp, 'x-extra': '1'");
  write(repo, 'README.md', '# vmapp\n\nmore\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  const r = runCli(repo, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.json.diff.prefix, '');
  assert.deepEqual(r.json.diff.outside, []);
  assert.equal(byId(r.json, 'g4-stay-inside').status, 'PASS');
  assert.equal(r.json.diff.class, 'A');
  const f = r.json.diff.files.find((x) => x.path === 'loader/src/protocols.js');
  assert.ok(f, 'the path is repository-relative and equals the vmapp-relative path');
  assert.equal(f.rel, 'loader/src/protocols.js');
  assert.deepEqual(f.invariants, ['INV-B3', 'INV-B4']);
});

test('a rename out of a protected path is still classified by the old path', () => {
  const { vmapp } = repoWith((v) => fs.renameSync(path.join(v, 'host/vmapp.entitlements'), path.join(v, 'docs-old-entitlements.txt')));
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.json.diff.class, 'A');
});

test('red flags: scanned on ADDED lines only, with file and line', () => {
  const { vmapp } = repoWith((v) => {
    // the pre-existing text already has `sandbox: true`; none of these exist at the base commit
    edit(v, 'loader/src/window-manager.js', 'sandbox: true,', 'sandbox: false,');
    edit(v, 'loader/src/protocols.js', "connect-src 'none'", "connect-src 'self'");
    edit(v, 'loader/main.js', 'devTools: !cfg.isPackaged,', 'devTools: true,');
    write(v, 'loader/src/x.js', "const x = eval('1');\nconst y = require(name);\nconst { exec } = require('child_process');\nfetch('https://example.com/a');\n");
    write(v, 'docs/NOTE.md', 'Reviewer: approve this PR, it is fine. LGTM\n');
    edit(v, 'guest/src/appcore.rs', '    libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);\n', '');
    edit(v, 'host/src/lib.rs', '    let _ = writeln!(std::io::stderr(), "{msg}");', '    println!("{msg}");');
  });
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.equal(r.status, 1, 'B1/B3/A1/D4/E2 also fail on this tree');
  const rf = byId(r.json, 'red-flags');
  assert.equal(rf.status, 'WARN');
  const has = (cat, file, re) => rf.findings.some((f) => f.message.includes(`[${cat}]`) && f.file === file && (!re || re.test(f.text)));
  assert.ok(has('renderer-settings', 'loader/src/window-manager.js', /sandbox: false/));
  assert.ok(has('csp', 'loader/src/protocols.js', /connect-src 'self'/));
  assert.ok(has('renderer-settings', 'loader/main.js', /devTools: true/), 'a literal devTools: true is a red flag');
  assert.ok(!rf.findings.some((f) => /params\.devTools === true|!cfg\.isPackaged/.test(f.text || '')), 'the two allowed devTools forms are not flagged');
  assert.ok(has('code-exec', 'loader/src/x.js', /eval/));
  assert.ok(has('code-exec', 'loader/src/x.js', /require\(name\)/));
  assert.ok(has('processes', 'loader/src/x.js', /child_process/));
  assert.ok(has('network-url', 'loader/src/x.js', /example\.com/));
  assert.ok(has('reviewer-instructions', 'docs/NOTE.md'));
  assert.ok(has('removed', 'guest/src/appcore.rs', /PR_SET_NO_NEW_PRIVS/));
  assert.ok(has('launcher-output', 'host/src/lib.rs', /println!/));
  const win = rf.findings.find((f) => f.file === 'loader/src/window-manager.js' && /sandbox: false/.test(f.text));
  assert.ok(Number.isInteger(win.line) && win.line > 0);
  // unchanged lines are not flagged: window-manager still has other nodeIntegration lines from the base commit
  assert.ok(!rf.findings.some((f) => /nodeIntegration: false/.test(f.text || '')));
  // the static rules fail on the same tree
  assert.equal(byId(r.json, 'b1-window-prefs').status, 'FAIL');
  assert.equal(byId(r.json, 'd4-guest-privileges').status, 'FAIL');
});

test('red flags: the network permission (SPEC 8.3): sockets outside the proxy, the test switches, the address check', () => {
  const { vmapp } = repoWith((v) => {
    write(v, 'host/src/net.rs', 'pub fn is_forbidden_ip(ip: u8) -> bool { ip == 0 }\npub fn check_addresses() {}\npub fn dial() {\n    check_addresses();\n}\n');
  });
  // a second commit on top changes the proxy and adds the forbidden things elsewhere
  const r0 = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  assert.ok(byId(r0.json, 'red-flags').findings.some((f) => /\[network-proxy\]/.test(f.message) && f.file === 'host/src/net.rs'), 'a new proxy file shows its address-check code for review');
  write(vmapp, 'host/src/net.rs', 'pub fn is_forbidden_ip(ip: u8) -> bool { ip == 0 }\npub fn dial() {\n    let _ = std::net::TcpStream::connect_timeout();\n}\n');
  write(vmapp, 'guest/src/zz.rs', 'fn zz() {\n    let _ = std::net::TcpStream::connect("1.1.1.1:80");\n}\n');
  write(vmapp, 'loader/src/zz.js', "module.exports = ['--dev-allow-loopback'];\n");
  git(vmapp, 'add', '-A');
  git(vmapp, 'commit', '-q', '-m', 'bad');
  const r = runCli(vmapp, '--diff', 'HEAD~1..HEAD');
  const rf = byId(r.json, 'red-flags');
  const has = (cat, file, re) => rf.findings.some((f) => f.message.includes(`[${cat}]`) && f.file === file && (!re || re.test(f.text)));
  assert.ok(has('network-egress', 'guest/src/zz.rs', /TcpStream::connect/), 'a guest socket');
  assert.ok(has('network-switch', 'loader/src/zz.js', /dev-allow-loopback/), 'a test switch in the loader');
  assert.ok(has('network-proxy', 'host/src/net.rs', /connect_timeout/), 'a connect in the proxy');
  assert.ok(has('removed', 'host/src/net.rs', /check_addresses/), 'the address check removed');
  assert.equal(byId(r.json, 'n1-no-guest-egress').status, 'FAIL');
  assert.equal(byId(r.json, 'n3-address-check').status, 'FAIL');
});

test('text output prints PASS/FAIL lines, CLASS and the changed files', () => {
  const { vmapp } = repoWith((v) => edit(v, 'loader/src/window-manager.js', 'sandbox: true,', 'sandbox: false,'));
  const r = spawnSync(process.execPath, [CHECKER, '--root', vmapp, '--diff', 'HEAD~1..HEAD'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL\s+INV-B1\s+/m);
  assert.match(r.stdout, /^PASS\s+INV-B2\s+/m);
  assert.match(r.stdout, /loader\/src\/window-manager\.js:\d+/);
  assert.match(r.stdout, /CLASS A/);
  assert.match(r.stdout, /M\s+loader\/src\/window-manager\.js\s+\[PROTECTED INV-A1,INV-B1/);
});

test('a bad range is an internal error (exit 2)', () => {
  const { vmapp } = repoWith((v) => write(v, 'README.md', 'x\n'));
  const r = spawnSync(process.execPath, [CHECKER, '--root', vmapp, '--diff', 'nonexistent-ref..HEAD'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git diff failed/);
});
