// Checks a built UI folder against the Content-Security-Policy of a vmapp window (SPEC 7):
//   default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:;
//   font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
// What can be seen without running the page: no inline <script>, no on*= handlers or javascript: URLs in the HTML, no remote address in
// src/href, every file the HTML names exists, no eval() and no new Function(code) in the scripts (the one library idiom that builds a
// Function, lodash's `Function("return this")()`, is only reached when there is no `self` or `window`). WebAssembly is only reported:
// whether it is reachable is for the real run to show (a CSP violation in the page's console). The check exists to fail the build early;
// the run in the loader (tests/apps/ollama-desktop.mjs, the CDP run) is the proof.
// Usage: node check-ui.mjs <ui folder>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node check-ui.mjs <ui folder>');
  process.exit(2);
}
const problems = [];
const notes = [];

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// <script ...>…</script> without src: inline code
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc\s*=/.test(m[1])) problems.push(`index.html: an inline <script> (${m[2].trim().slice(0, 40).replace(/\s+/g, ' ')}…)`);
}
if (/\son[a-z]+\s*=\s*["']/i.test(html)) problems.push('index.html: an inline event handler attribute (on…=)');
if (/(href|src|action)\s*=\s*["']\s*javascript:/i.test(html)) problems.push('index.html: a javascript: URL');
for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
  for (const m of tag[0].matchAll(/\s(?:src|href|action|data)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1];
    if (/^(https?:)?\/\//i.test(ref)) problems.push(`index.html: a remote address: ${ref}`);
    else if (ref.startsWith('/') && !fs.existsSync(path.join(root, ref.split(/[?#]/)[0]))) {
      // upstream's <link rel="icon" href="/vite.svg"> names a file that its own public/ does not have: the window has no favicon
      if (/\brel\s*=\s*["']icon["']/i.test(tag[0])) notes.push(`index.html: the icon ${ref} is not in the build (as upstream)`);
      else problems.push(`index.html: ${ref} is not in the build`);
    }
  }
}
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
if (scripts[0] !== '/vmapp-fetch.js' || scripts[1] !== '/ollama-desktop-shim.js') problems.push(`index.html: the two D9010 VmApp scripts must come first, found ${scripts.slice(0, 3).join(', ')}`);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(root);
let js = 0;
const wasm = new Set();
for (const f of files) {
  const rel = path.relative(root, f);
  if (f.endsWith('.wasm')) problems.push(`${rel}: a WebAssembly file`);
  if (!/\.(js|mjs)$/.test(f)) continue;
  js++;
  const text = fs.readFileSync(f, 'utf8');
  if (/(?<![\w$.])eval\s*\(/.test(text)) problems.push(`${rel}: eval(`);
  for (const m of text.matchAll(/new\s+Function\s*\(/g)) problems.push(`${rel}: new Function( at ${m.index}`);
  for (const m of text.matchAll(/(?<![\w$.])Function\(\s*(["'`])((?:(?!\1).)*)\1/g)) {
    if (m[2] === 'return this') notes.push(`${rel}: Function("return this")() (lodash's global lookup, reached only without self/window)`);
    else problems.push(`${rel}: Function(${m[1]}${m[2].slice(0, 30)}…)`);
  }
  if (/WebAssembly\s*\.\s*(instantiate|compile)/.test(text)) wasm.add(rel);
  // remote addresses fetched at run time would be blocked anyway; a literal fetch/import of one is a bug
  for (const m of text.matchAll(/(?:fetch|import)\(\s*["'`](https?:\/\/[^"'`]+)/g)) notes.push(`${rel}: ${m[0].slice(0, 80)}`);
}
if (wasm.size) notes.push(`WebAssembly.instantiate/compile appears in ${[...wasm].join(', ')} (must stay unreachable: check the console of the real run for CSP violations)`);

console.log(`check-ui: ${files.length} files, ${js} scripts, ${scripts.length} script tags in index.html`);
for (const n of new Set(notes)) console.log(`  note: ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  PROBLEM: ${p}`);
  process.exit(1);
}
console.log('check-ui: ok');
