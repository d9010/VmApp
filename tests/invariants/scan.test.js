'use strict';
// The lexical helpers the rules stand on: comments, strings, regexes, templates, Rust raw strings and test modules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const lib = path.resolve(__dirname, '..', '..', 'tools', 'check-invariants.d');
const S = require(path.join(lib, 'lib', 'scan.js'));
const { classify } = require(path.join(lib, 'protected.js'));
const { instructions } = require(path.join(lib, 'rules', 'native.js'));
const { cspProblems } = require(path.join(lib, 'rules', 'renderer.js'));

test('scanJs: comments are blanked, string contents blanked in skel only, lengths and newlines preserved', () => {
  const src = "const a = 'eval(x)'; // eval(y)\n/* new Function(z) */ const b = \"}\";\n";
  const s = S.scanJs(src);
  assert.equal(s.code.length, src.length);
  assert.equal(s.skel.length, src.length);
  assert.equal(s.code.split('\n').length, src.split('\n').length);
  assert.ok(s.code.includes("'eval(x)'"));
  assert.ok(!s.code.includes('eval(y)'));
  assert.ok(!s.code.includes('new Function'));
  assert.ok(!s.skel.includes('eval'));
  assert.ok(s.skel.includes("''".replace("''", "'      '")) || /'\s+'/.test(s.skel));
});

test('scanJs: regex literals and divisions', () => {
  const s = S.scanJs("const r = /['\"`]eval\\(/g; const d = a / b / c; const q = x.replace(/\\//g, '/'); const z = 1;\n");
  assert.ok(!s.skel.includes('eval'), s.skel);
  assert.ok(s.skel.includes('const z = 1;'));
});

test('scanJs: template literals with nested expressions and strings', () => {
  const s = S.scanJs("const t = `a ${ f('}`') + `n${1}` } eval(`; const after = 1;\n");
  assert.ok(!s.skel.includes('eval'));
  assert.ok(s.skel.includes('const after = 1;'));
  assert.ok(s.code.includes("f('}`')"));
});

test('findCalls / parseObject: arguments, nested objects, shorthand, spread, computed keys', () => {
  const sc = S.scanJs("foo(1, { a: 1, 'b-c': { d: 2 }, e, ...f, [g]: 3, h() { return 1; } }, [1, 2]);\n// foo(2)\n");
  const calls = S.findCalls(sc, /\bfoo\s*\(/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.length, 3);
  const o = S.parseObject(sc, calls[0].args[1].start);
  assert.deepEqual(o.props.map((p) => p.key || (p.spread ? '...' : '[]')), ['a', 'b-c', 'e', '...', '[]', 'h']);
  assert.equal(o.props[0].value, '1');
  assert.ok(o.props[2].shorthand);
});

test('evalStringExpr: concatenations of literals only', () => {
  assert.equal(S.evalStringExpr("'a' + \"b\" + `c`"), 'abc');
  assert.equal(S.evalStringExpr("'a' + x"), null);
  assert.equal(S.evalStringExpr('`a${x}`'), null);
});

test('scanRust: raw strings, nested comments, chars vs lifetimes', () => {
  const src = 'fn f<\'a>(x: &\'a str) { let r = r#"println!("hi")"#; /* a /* b */ println!() */ let c = \'}\'; let n = b\'x\'; println!("{}", x); }\n';
  const s = S.scanRust(src);
  assert.equal(s.skel.length, src.length);
  const hits = [...s.skel.matchAll(/println!/g)];
  assert.equal(hits.length, 1, s.skel);
});

test('stripRustTests: removes #[cfg(test)] modules and #[test] fns, keeps the rest', () => {
  const src = 'fn a() { x.unwrap_or(1); }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { y.unwrap(); }\n}\n#[test]\nfn lone() { z.unwrap(); }\nfn b() { w.expect("e"); }\n';
  const s = S.stripRustTests(S.scanRust(src));
  assert.ok(!/\.unwrap\(\)/.test(s.skel));
  assert.ok(/\.expect\(/.test(s.skel));
  assert.ok(/unwrap_or/.test(s.skel));
  assert.equal(s.skel.split('\n').length, src.split('\n').length);
});

test('splitTop / matchBracket ignore brackets inside strings', () => {
  const sc = S.scanJs("f('(', [1, 2], {a: ')'}, 3)");
  const open = sc.skel.indexOf('(');
  const close = S.matchBracket(sc.skel, open);
  assert.equal(close, sc.skel.length - 1);
  assert.equal(S.splitTop(sc.skel, open + 1, close).length, 4);
});

test('instructions(): Dockerfile continuation lines and comments', () => {
  const ins = instructions('# c\nFROM a@sha256:x \\\n  AS b\n\n# c2\nRUN a \\\n # inner\n && b\nCOPY x y\n');
  assert.deepEqual(ins.map((i) => i.line), [2, 6, 9]);
  assert.equal(ins[0].text, 'FROM a@sha256:x AS b');
});

test('classify(): protected paths of GOVERNANCE section 2', () => {
  const P = (p) => classify(p);
  for (const p of ['SPEC.md', 'GOVERNANCE.md', 'loader/src/protocols.js', 'loader/main.js', 'loader/preload-app.js', 'loader/src/window-manager.js', 'loader/src/library.js', 'loader/ui/library.js', 'loader/package.json',
    'hostlib/session.js', 'hostlib/bridge.js', 'hostlib/package.js', 'hostlib/manifest.js', 'hostlib/tar.js', 'hostlib/cpio.js', 'hostlib/store.js', 'host/src/lib.rs', 'host/src/shim/vz_shim.m', 'host/vmapp.entitlements',
    'guest/src/main.rs', 'kernel/build.sh', 'kernel/Dockerfile', 'kernel/pins.env', 'kernel/vmapp-guest.config', 'kernel/kconfig-forbidden.txt',
    'runtimes/node22/Dockerfile', 'tools/mkruntime', 'tools/mkerofs.Dockerfile', 'tools/check-invariants', 'tools/check-invariants.d/rules/native.js', 'docs/REVIEWING.md']) {
    assert.equal(P(p).protected, true, p);
  }
  for (const p of ['README.md', 'docs/BUILDING-APPS.md', 'docs/ARCHITECTURE.md', 'examples/hello/app.js', 'templates/node/main.js', 'tests/unit/session.test.js', 'tools/vmapp', 'tools/build.sh', 'hostlib/headless.js', 'hostlib/index.js', 'sdk/node/vmapp.js', 'loader/test/loader-cdp.mjs', 'loader/README.md', 'registry/index.js']) {
    assert.equal(P(p).protected, false, p);
  }
  assert.deepEqual(P('guest/src/main.rs').invs, ['INV-D4', 'INV-D5', 'INV-E2', 'INV-N1', 'INV-H7']);
  assert.deepEqual(P('guest/src/netproxy.rs').invs, ['INV-D4', 'INV-D5', 'INV-E2', 'INV-N1', 'INV-H7'], 'the guest proxy carries N1, and H7 for the service listener');
  assert.deepEqual(P('host/src/net.rs').invs, ['INV-D1', 'INV-D2', 'INV-D5', 'INV-E1', 'INV-E2', 'INV-E3', 'INV-N1', 'INV-N3', 'INV-N4', 'INV-H7', 'INV-H8'], 'the host proxy carries N1, N3 and N4, H7 for the service tunnel and H8 for the libkrun backend');
  // the GPU capability (SPEC 8.6): the sandbox profile, the pin and the broker are protected; the notes and the unrelated spike are not
  for (const p of ['gpu/rpc-server.sb', 'gpu/pins.env', 'gpu/build.sh', 'hostlib/gpu.js']) assert.equal(P(p).protected, true, p);
  assert.ok(P('gpu/rpc-server.sb').invs.includes('INV-H7'));
  assert.ok(P('hostlib/hostproc.js').invs.includes('INV-H7'), 'the GPU server is started in hostproc.js');
  for (const p of ['gpu/README.md', 'gpu/venus-spike/run-guest.sh']) assert.equal(P(p).protected, false, p);
  assert.deepEqual(P('hostlib/network.js').invs, ['INV-D3', 'INV-N2', 'INV-N4']);
  assert.equal(P('loader/src/devices.js').protected, true);
  assert.deepEqual(P('loader/src/devices.js').invs, ['INV-B3', 'INV-D3'], 'the microphone gate carries B3 and D3');
  assert.deepEqual(P('kernel/Dockerfile').invs, ['INV-D1', 'INV-D4', 'INV-F2']);
  assert.ok(P('hostlib/session.js').invs.includes('INV-C2'));
  assert.ok(P('SPEC.md').invs.length > 20);
});

test('cspProblems(): equal, stricter and weaker', () => {
  const spec = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'";
  assert.deepEqual(cspProblems(spec, spec), []);
  assert.deepEqual(cspProblems("default-src 'self';script-src 'self';style-src 'self';connect-src 'none';frame-src 'none'", spec), []);
  assert.ok(cspProblems(spec.replace("connect-src 'none'", "connect-src 'self'"), spec).length);
  assert.ok(cspProblems(spec.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), spec).length);
  assert.ok(cspProblems(spec.replace("frame-src 'none'", "frame-src 'self'"), spec).length);
  assert.ok(cspProblems(spec.replace("; frame-src 'none'", ''), spec).length);
});
