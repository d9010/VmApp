// Checks the built ui/ folder of Code - OSS against the Content-Security-Policy of a vmapp window (SPEC 7) with the window features its
// manifest declares (SPEC 2.2 ui.features: here workers, wasm, self-fetch, frames, network):
//   the page: script-src 'self' (+ 'wasm-unsafe-eval' with "wasm"), no inline script, no eval, no script from the network ("network"
//   lets only data in, through the app's proxy: SPEC 8.3 "The app's windows");
//   isolated frames (vmapp-frame://, "frames"): web content, inline scripts and eval allowed there (VS Code's webview host page).
// (The approach of apps/ollama-desktop/build/check-ui.mjs.) What can be seen without running the page: no inline <script>, no on*=
// handlers or javascript: URLs in index.html, no remote address in it, every file it names exists, the two vmapp scripts come first,
// no eval() and no new Function(code) in the page's scripts, WebAssembly files only with the feature "wasm". The run in the real loader
// (tests/apps/vscode-ui.mjs: no unexpected CSP violation in the console) is the proof.
// Usage: node check-ui.mjs <ui folder> <vmapp.json>
import fs from 'node:fs';
import path from 'node:path';

const [root, manifestPath] = process.argv.slice(2);
if (!root || !manifestPath) {
  console.error('usage: node check-ui.mjs <ui folder> <vmapp.json>');
  process.exit(2);
}
const features = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).ui || {}).features || [];
const problems = [];
const notes = [];

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc\s*=/.test(m[1])) problems.push(`index.html: an inline <script> (${m[2].trim().slice(0, 40).replace(/\s+/g, ' ')}…)`);
}
if (/\son[a-z]+\s*=\s*["']/i.test(html)) problems.push('index.html: an inline event handler attribute (on…=)');
if (/(href|src|action)\s*=\s*["']\s*javascript:/i.test(html)) problems.push('index.html: a javascript: URL');
for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
  for (const m of tag[0].matchAll(/\s(?:src|href|action|data)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1];
    if (/^(https?:)?\/\//i.test(ref)) problems.push(`index.html: a remote address: ${ref}`);
    else if (ref.startsWith('/') && !fs.existsSync(path.join(root, ref.split(/[?#]/)[0]))) problems.push(`index.html: ${ref} is not in the build`);
  }
}
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
if (scripts[0] !== '/vmapp-fetch.js' || scripts[1] !== '/vscode-vmapp-shim.js') problems.push(`index.html: the two D9010 VmApp scripts must come first, found ${scripts.slice(0, 3).join(', ')}`);
for (const f of ['static/out/nls.messages.js', 'static/out/vs/code/browser/workbench/workbench.js', 'static/out/vs/code/browser/workbench/workbench.css']) {
  if (!fs.existsSync(path.join(root, f))) problems.push(`${f} is missing`);
}
// webviews: VS Code's host page of every webview, served in isolated frames
const PRE = 'static/out/vs/workbench/contrib/webview/browser/pre/';
if (features.includes('frames')) {
  for (const f of ['index.html', 'service-worker.js', 'fake.html']) if (!fs.existsSync(path.join(root, PRE, f))) problems.push(`${PRE}${f} is missing (webviews)`);
}
// the web worker extension host's page (shim/exthost/), shown in an isolated frame, and the worker it starts there (step 14)
const EXTHOST = 'vmapp-exthost/out/vs/workbench/services/extensions/worker/';
for (const f of [`${EXTHOST}webWorkerExtensionHostIframe.html`, `${EXTHOST}exthost-frame.js`, 'static/out/vs/workbench/api/worker/extensionHostWorkerMain.js']) {
  if (!fs.existsSync(path.join(root, f))) problems.push(`${f} is missing (browser-only extensions)`);
  else if (!features.includes('frames')) problems.push(`${f}: the web worker extension host needs the feature "frames"`);
}
if (features.includes('wasm') && !fs.existsSync(path.join(root, 'static/node_modules/vscode-oniguruma/release/onig.wasm'))) {
  problems.push('static/node_modules/vscode-oniguruma/release/onig.wasm is missing (TextMate grammars)');
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(root);

// Code that is in the build but cannot reach eval in the page, each checked here rather than trusted:
// * Emscripten's dynamic linker in web-tree-sitter (tree-sitter.js) evals the EM_ASM/EM_JS snippets of a WebAssembly side module it
//   loads, and only those: it is harmless when no module next to it exports __start_em_asm or __em_js__* (none of tree-sitter's do)
const TREE_SITTER = 'static/node_modules/@vscode/tree-sitter-wasm/wasm/';
const treeSitterEmAsm = files
  .filter((f) => path.relative(root, f).split(path.sep).join('/').startsWith(TREE_SITTER) && f.endsWith('.wasm'))
  .filter((f) => /__em_js__|__start_em_asm/.test(fs.readFileSync(f, 'latin1')));
// * the web worker extension host (extensionHostWorkerMain.js, which evaluates each extension with new Function) runs only inside its
//   own worker, in the isolated frame of shim/exthost/ (vmapp-frame://v--<hash>.exthost/, FRAME_CSP), never in the page: the page
//   imports nothing of it (the frame loads it from its own origin)
const WORKER_HOST = ['static/out/vs/workbench/api/worker/extensionHostWorkerMain.js'];
let js = 0;
let bytes = 0;
let wasmFiles = 0;
for (const f of files) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  bytes += fs.statSync(f).size;
  if (f.endsWith('.wasm')) {
    wasmFiles++;
    if (!features.includes('wasm')) problems.push(`${rel}: a WebAssembly file, but the manifest does not declare "wasm"`);
  }
  if (!/\.(js|mjs)$/.test(f)) continue;
  js++;
  const inFrame = rel.startsWith(PRE) || rel.startsWith(EXTHOST); // runs in an isolated frame (FRAME_CSP allows inline scripts and eval there)
  const inWorkerHost = WORKER_HOST.includes(rel);
  const text = fs.readFileSync(f, 'utf8');
  const flag = (what) =>
    inFrame ? notes.push(`${rel}: ${what} (frame content)`) : inWorkerHost ? notes.push(`${rel}: ${what} (the web worker extension host, in its isolated frame)`) : problems.push(`${rel}: ${what}`);
  if (/(?<![\w$.])eval\s*\(/.test(text)) {
    if (rel === `${TREE_SITTER}tree-sitter.js` && !treeSitterEmAsm.length) notes.push(`${rel}: eval( of EM_ASM/EM_JS in side modules; none of the ${TREE_SITTER}*.wasm has any`);
    else flag('eval(');
  }
  for (const m of text.matchAll(/new\s+Function\s*\(/g)) flag(`new Function( at ${m.index}`);
  for (const m of text.matchAll(/(?<![\w$.])Function\(\s*(["'`])((?:(?!\1).)*)\1/g)) {
    if (m[2] === 'return this') notes.push(`${rel}: Function("return this")() (the global-object lookup of a library, reached only without globalThis)`);
    else flag(`Function(${m[1]}${m[2].slice(0, 30)}…)`);
  }
}
if (bytes > 1024 * 1024 * 1024) problems.push(`ui/ is ${(bytes / 1048576).toFixed(1)} MiB, over the 1 GiB a package's UI may have (SPEC 2)`);

console.log(`check-ui: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB, ${js} scripts, ${wasmFiles} WebAssembly files; window features: ${features.join(', ') || 'none'}`);
for (const n of new Set(notes)) console.log(`  note: ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  PROBLEM: ${p}`);
  process.exit(1);
}
console.log('check-ui: ok');
