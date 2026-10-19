'use strict';
// The web UI: static rules (no inline script, no innerHTML) and a run of the real page scripts against a fake DOM in
// which parsing HTML is impossible, so hostile manifest text can only ever become text nodes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish } = require('./helpers');

const PUBLIC = path.resolve(__dirname, '..', '..', 'registry', 'public');
const files = fs.readdirSync(PUBLIC);
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

test('static rules: no innerHTML or other HTML sinks in any page script', () => {
  const sinks = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]|\bsrcdoc\b|createContextualFragment|DOMParser|\.html\s*\(/;
  const js = files.filter((f) => f.endsWith('.js'));
  assert.ok(js.length >= 5, 'the page scripts exist');
  for (const f of js) assert.doesNotMatch(read(f), sinks, `${f} uses an HTML sink`);
});

test('static rules: pages have no inline script, handler attributes, inline styles or foreign hosts', () => {
  const html = files.filter((f) => f.endsWith('.html'));
  assert.deepEqual(html.sort(), ['app.html', 'index.html', 'publish.html', 'publisher.html', 'verify.html']);
  for (const f of html) {
    const text = read(f);
    for (const m of text.matchAll(/<script\b([^>]*)>/gi)) assert.match(m[1], /\bsrc="\/[a-z]+\.js"/, `${f}: script tag without a local src: ${m[0]}`);
    for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assert.equal(m[1].trim(), '', `${f}: inline script content`);
    assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${f}: event handler attribute`);
    assert.doesNotMatch(text, /\sstyle\s*=/i, `${f}: inline style`);
    assert.doesNotMatch(text, /<style\b/i, `${f}: style element`);
    assert.doesNotMatch(text.replace(/<a [^>]*>/g, ''), /(src|href)="https?:\/\//i, `${f}: external resource`);
    assert.doesNotMatch(text, /javascript:/i);
  }
  assert.doesNotMatch(read('style.css'), /@import|url\(\s*['"]?https?:/i);
});

// ---------------------------------------------------------------------------------------------- fake DOM
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = '';
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(_v) {
    throw new Error('innerHTML must never be used');
  }
  get innerHTML() {
    throw new Error('innerHTML must never be used');
  }
  append(...kids) {
    for (const k of kids) {
      assert.ok(typeof k === 'string' || k instanceof FakeNode || k instanceof FakeText, 'append takes strings and nodes');
      this.children.push(typeof k === 'string' ? new FakeText(k) : k);
    }
  }
  replaceChildren(...kids) {
    this.children = [];
    this._text = '';
    this.append(...kids);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  select() {}
  reset() {}
  walk(fn) {
    fn(this);
    for (const c of this.children) if (c.walk) c.walk(fn);
  }
}
class FakeText {
  constructor(t) {
    this.text = t;
  }
  get textContent() {
    return this.text;
  }
}

// `setup(nodes, tabs)` runs before the scripts do: the page as the server sent it (attributes and content of the containers)
function runPage(baseUrl, { pathname, search = '', ids, scripts, fetchImpl, setup }) {
  const nodes = {};
  for (const id of ids) nodes[id] = new FakeNode('x-' + id);
  const tabs = ['popular', 'new', 'updated'].map((s) => {
    const n = new FakeNode('a');
    n.setAttribute('data-sort', s);
    return n;
  });
  const document = {
    title: '',
    createElement: (tag) => new FakeNode(tag),
    getElementById: (id) => nodes[id] || null,
    querySelectorAll: () => tabs,
  };
  const win = {};
  const sandbox = {
    window: win,
    document,
    location: { pathname, search },
    history: { replaceState() {} },
    navigator: {},
    fetch: fetchImpl || ((p, init) => fetch(baseUrl + p, init)),
    URLSearchParams, Date, JSON, Object, Array, Promise, String, Number, Math, isNaN, encodeURIComponent, decodeURIComponent, console,
  };
  win.document = document;
  vm.createContext(sandbox);
  if (setup) setup(nodes, tabs);
  for (const s of scripts) vm.runInContext(read(s), sandbox, { filename: s });
  return { nodes, document, tabs, sandbox };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const all = (root) => {
  const out = [];
  root.walk((n) => out.push(n));
  return out;
};
const allText = (root) => all(root).map((n) => n._text).concat(all(root).flatMap((n) => n.children.filter((c) => c instanceof FakeText).map((c) => c.text)));

const EVIL = {
  name: '<script>alert(1)</script>',
  description: '<img src=x onerror=alert(1)> & "quotes" \'single\'',
  publisher: '<b onmouseover=alert(2)>Mallory</b>',
};
const ALLOWED_TAGS = new Set(['li', 'p', 'a', 'span', 'div', 'strong', 'h1', 'h2', 'ul', 'dl', 'dt', 'dd', 'section', 'pre', 'br', 'input', 'button', 'x-list', 'x-app', 'x-result', 'x-status', 'x-current', 'x-stats']);

test('hostile manifest text only ever becomes text in the list and app pages', async (t) => {
  const s = await startRegistry();
  const w = tmpdir('pkg-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const pkgs = buildPackage(w, 'evil', {
    id: 'com.example.evil', name: EVIL.name, description: EVIL.description, publisher: EVIL.publisher,
    permissions: { folders: [{ name: 'docs', access: 'readwrite', purpose: '<svg onload=alert(3)> why' }], dialogs: true, external: true },
  });
  const r = await publish(s.url, pkgs.file, { profile: { name: '<i>Jane</i>', company: '<u>Evil Co</u>', url: 'https://evil.test/<x>' } });
  assert.equal(r.status, 201, r.text);

  // the API returns the strings as JSON data with a JSON content type (never as HTML)
  const api = await call(s.url, '/api/apps/com.example.evil');
  assert.match(api.headers.get('content-type'), /^application\/json/);
  assert.equal(api.json.name, EVIL.name);
  assert.equal(api.json.permissions.folders[0].purpose, '<svg onload=alert(3)> why');
  assert.deepEqual(api.json.publisher, { level: 'unverified', label: '' });

  // home page
  const home = runPage(s.url, { pathname: '/', ids: ['list', 'status', 'more', 'q', 'search', 'stats'], scripts: ['common.js', 'home.js'] });
  await settle();
  const list = home.nodes.list;
  assert.equal(list.children.length, 1, 'the app is listed');
  const texts = allText(list);
  assert.ok(texts.includes(EVIL.name), 'the name is a text node, verbatim');
  assert.ok(texts.includes(EVIL.description));
  assert.ok(!texts.some((x) => x.includes('Mallory')), 'the manifest publisher string is not rendered');
  assert.ok(!texts.some((x) => x.includes('Jane') || x.includes('Evil Co')), 'unverified claims are not rendered');
  assert.ok(!texts.some((x) => /nverified/.test(x)), 'an unverified publisher shows nothing');
  for (const n of all(list)) {
    assert.ok(ALLOWED_TAGS.has(n.tagName), `unexpected element <${n.tagName}> created from data`);
    if (n.tagName === 'a') assert.match(n.attrs.href, /^\/apps\/com\.example\.evil$/);
  }
  assert.match(home.nodes.status.textContent, /1 app/);

  // app page
  const page = runPage(s.url, { pathname: '/apps/com.example.evil', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
  await settle();
  const root = page.nodes.app;
  const ptexts = allText(root);
  assert.ok(ptexts.includes(EVIL.name) || ptexts.some((x) => x === EVIL.name));
  assert.ok(ptexts.some((x) => x.includes('<svg onload=alert(3)> why')), 'permission purposes are text');
  assert.ok(ptexts.includes('This app will ask for:'));
  assert.ok(ptexts.includes('vmapp get com.example.evil --install'));
  assert.ok(!ptexts.some((x) => x.includes('Mallory') || x.includes('Jane') || x.includes('Evil Co')), 'only verified facts are rendered');
  assert.ok(!ptexts.some((x) => /nverified|Nobody has confirmed/.test(x)), 'an unverified publisher shows nothing');
  assert.equal(page.document.title, `${EVIL.name} - D9010 VmApp Registry`);
  for (const n of all(root)) {
    assert.ok(ALLOWED_TAGS.has(n.tagName), `unexpected element <${n.tagName}> created from data`);
    if (n.tagName === 'a') assert.match(n.attrs.href, /^\/api\/apps\/com\.example\.evil\/1\.0\.0\/download$/);
  }
  assert.ok(all(root).some((n) => n.tagName === 'a' && n.className === 'button' && /Download v1\.0\.0/.test(n.textContent)), 'a download button');
});

test('app page: the permission list is prominent and complete', async (t) => {
  const s = await startRegistry({ mailer: { send: async () => {} }, devAllowHttpVerify: true });
  const w = tmpdir('pkg-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const a = buildPackage(w, 'a', {
    id: 'com.example.perm', name: 'Perm',
    permissions: { folders: [{ name: 'notes', access: 'readwrite', purpose: 'Your notes' }, { name: 'out', access: 'writeonly' }], dialogs: true, external: true },
  });
  assert.equal((await publish(s.url, a.file)).status, 201);
  const page = runPage(s.url, { pathname: '/apps/com.example.perm', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
  await settle();
  const texts = allText(page.nodes.app).join('\n');
  assert.match(texts, /A folder called "notes"/);
  assert.match(texts, /read and change files in a folder you choose\. Why: Your notes/);
  assert.match(texts, /A folder called "out"/);
  assert.match(texts, /save new files into a folder you choose\. Why: no reason given/);
  assert.match(texts, /File open and save dialogs/);
  assert.match(texts, /Open web links in your browser/);
  assert.match(texts, /How to install/);
  assert.match(texts, /Install\.\.\. in the D9010 VmApp Launcher/);
  assert.match(texts, /vmapp get com\.example\.perm --install/);

  const missing = runPage(s.url, { pathname: '/apps/com.example.nope', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
  await settle();
  assert.match(missing.nodes.status.textContent, /no app with the id/);
});

test('app page and listing show the hosts an app asks to reach (SPEC 8.3) and control of the computer (INV-H6), as text', async (t) => {
  const s = await startRegistry({ mailer: { send: async () => {} }, devAllowHttpVerify: true });
  const w = tmpdir('pkg-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const evil = '<img src=x onerror=alert(5)> why';
  const a = buildPackage(w, 'net', {
    id: 'com.example.netapp', name: 'Net App',
    permissions: {
      folders: [{ name: 'notes', access: 'read', purpose: 'Your notes' }],
      dialogs: true,
      external: false,
      host: [{ cap: 'screen', purpose: 'Sees the screen' }, { cap: 'input', purpose: evil }],
      network: [{ host: 'api.example.com', purpose: 'Syncs notes' }, { host: '*.cdn.example.com', ports: [443, 80], purpose: evil }],
    },
  });
  assert.equal((await publish(s.url, a.file)).status, 201);
  const noNet = buildPackage(w, 'plain', { id: 'com.example.plain', name: 'Plain' });
  assert.equal((await publish(s.url, noNet.file)).status, 201);

  // the API: structured, with wildcard / not-encrypted / control marked
  const api = await call(s.url, '/api/apps/com.example.netapp');
  assert.deepEqual(api.json.permissions.network, [
    { host: 'api.example.com', ports: [443], purpose: 'Syncs notes', wildcard: false, insecure: false },
    { host: '*.cdn.example.com', ports: [443, 80], purpose: evil, wildcard: true, insecure: true },
  ]);
  assert.deepEqual(api.json.permissions.host.map((h) => [h.cap, h.control]), [['screen', false], ['input', true]]);
  const list = await call(s.url, '/api/apps');
  const item = list.json.items.find((x) => x.id === 'com.example.netapp');
  assert.match(item.permissionsSummary, /control of your computer \(you choose whether to allow it\)/, 'INV-H6: the listing says it');
  assert.match(item.permissionsSummary, /internet: api\.example\.com, \*\.cdn\.example\.com:443,80 \(you choose whether to allow it\)/);
  assert.equal((await call(s.url, '/api/apps/com.example.plain')).json.permissions.network.length, 0);
  assert.doesNotMatch(list.json.items.find((x) => x.id === 'com.example.plain').permissionsSummary, /internet/, 'an app without hosts does not mention the internet');

  // the pages
  const home = runPage(s.url, { pathname: '/', ids: ['list', 'status', 'more', 'q', 'search', 'stats'], scripts: ['common.js', 'home.js'] });
  await settle();
  assert.ok(allText(home.nodes.list).some((x) => /Asks for: .*internet: api\.example\.com, \*\.cdn\.example\.com:443,80/.test(x)), 'the list shows the hosts');
  const page = runPage(s.url, { pathname: '/apps/com.example.netapp', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
  await settle();
  const texts = allText(page.nodes.app);
  const joined = texts.join('\n');
  assert.ok(texts.includes('The internet: api.example.com'));
  assert.ok(texts.includes('The internet: *.cdn.example.com'));
  assert.match(joined, /Lets the app connect to api\.example\.com, only if you allow it in the D9010 VmApp Launcher \(the default is no\)\. Why: Syncs notes/);
  assert.match(joined, /Lets the app connect to any address under cdn\.example\.com \(many servers\)/, 'a wildcard is spelled out');
  assert.ok(texts.includes('wildcard') && texts.includes('not encrypted'), 'wildcard and port 80 are marked');
  assert.ok(texts.includes('port 443, 80 (not encrypted)'));
  assert.ok(texts.includes('requests control of your computer'), 'INV-H6');
  assert.ok(texts.includes('Control your mouse and keyboard') && texts.includes('See your screen'));
  assert.ok(texts.some((x) => x.includes(evil)), 'the stated reasons are text');
  assert.match(joined, /asks to read folders and to reach internet addresses, so it could send what it reads/, 'the combined risk is spelled out');
  assert.doesNotMatch(joined, /never gets network access/, 'the old promise is gone');
  assert.match(joined, /Recommended size/);
  for (const n of all(page.nodes.app)) assert.ok(ALLOWED_TAGS.has(n.tagName), `unexpected element <${n.tagName}> created from data`);

  // no risk sentence for an app that only writes
  const w2 = buildPackage(w, 'wo', { id: 'com.example.wo', name: 'Wo', permissions: { folders: [{ name: 'out', access: 'writeonly' }], dialogs: false, external: false, network: [{ host: 'api.example.com' }] } });
  assert.equal((await publish(s.url, w2.file)).status, 201);
  const page2 = runPage(s.url, { pathname: '/apps/com.example.wo', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
  await settle();
  assert.doesNotMatch(allText(page2.nodes.app).join('\n'), /could send what it reads/);
});

test('app page: versions list, withdrawn reasons as plain text, and the update-choice explanation', async (t) => {
  const s = await startRegistry();
  const w = tmpdir('pkg-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const reason = '<img src=x onerror=alert(1)> & "quoted" <script>x</script>';
  let token = null;
  for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
    const p = buildPackage(w, `v${v}`, { id: 'com.example.vp', name: 'Vp', version: v });
    const r = await publish(s.url, p.file, { token });
    assert.equal(r.status, 201, r.text);
    if (r.json.ownerToken) token = r.json.ownerToken;
  }
  let r = await call(s.url, '/api/apps/com.example.vp/1.1.0/withdraw', { method: 'POST', json: { reason }, token });
  assert.equal(r.status, 200, r.text);
  await call(s.url, '/api/apps/com.example.vp/1.0.0/download', { ip: '10.0.0.7' });

  const page = runPage(s.url, { pathname: '/apps/com.example.vp', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
  await settle();
  const root = page.nodes.app;
  const texts = allText(root);

  // the reason is one text node, verbatim: nothing was parsed into elements
  assert.ok(texts.includes(`Withdrawn: ${reason}`), 'the withdrawn badge carries the reason as text');
  for (const n of all(root)) {
    assert.ok(ALLOWED_TAGS.has(n.tagName), `unexpected element <${n.tagName}> created from data`);
    if (n.tagName === 'a') assert.match(n.attrs.href, /^\/api\/apps\/com\.example\.vp\/\d+\.\d+\.\d+\/download$/);
  }
  assert.equal(texts.filter((x) => x.startsWith('Withdrawn:')).length, 1, 'only the withdrawn version is flagged');

  // each version: number, date, size, downloads
  const items = all(root).filter((n) => n.tagName === 'li' && n.children.some((c) => c.className === 'v'));
  assert.deepEqual(items.map((li) => li.children[0].textContent), ['2.0.0', '1.1.0', '1.0.0']);
  const second = items[1].textContent;
  assert.match(second, /2026-03-01 · [\d.]+ KiB · 0 downloads/);
  assert.match(second, /Withdrawn: <img/);
  assert.match(items[2].textContent, /· 1 download(?!s )/);
  assert.doesNotMatch(items[0].textContent, /Withdrawn/);
  assert.ok(all(items[1]).some((n) => n.tagName === 'a' && n.attrs.href === '/api/apps/com.example.vp/1.1.0/download'), 'a withdrawn version can still be downloaded by its number');

  // the explanation of the choices, and the breaking-change rule
  const joined = texts.join('\n');
  assert.match(joined, /Stay on this version/);
  assert.match(joined, /Latest compatible/);
  assert.match(joined, /Always latest/);
  assert.match(joined, /D9010 VmApp Launcher/);
  assert.match(joined, /new major version/);
  assert.match(joined, /breaking change/);
  assert.match(joined, /withdrawn version was pulled by its publisher/);
  // the main download is the newest version that is not withdrawn
  assert.ok(all(root).some((n) => n.tagName === 'a' && n.className === 'button' && /Download v2\.0\.0/.test(n.textContent)));
});

test('publish page: shows the owner token once, in a field, with a save-it-now warning', async (t) => {
  const token = 'ab'.repeat(32);
  const ids = ['form', 'file', 'token', 'go', 'status', 'result', 'pname', 'pcompany', 'pemail', 'purl'];
  const calls = [];
  const fetchImpl = async (p, init) => {
    calls.push({ p, init });
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'com.example.x', version: '1.0.0', packageId: 'f'.repeat(64), ownerToken: token, publisher: { level: 'unverified', label: '' } }) };
  };
  const page = runPage('http://unused', { pathname: '/publish', ids, scripts: ['common.js', 'publish.js'], fetchImpl });
  page.nodes.file.files = [{ name: 'x.vmapp', size: 1234 }];
  page.nodes.pname.value = 'Zoë';
  page.nodes.pemail.value = 'zoe@example.org';
  await page.nodes.form.listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p, '/api/publish');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.headers['X-Vmapp-Publisher']), { name: 'Zoë', email: 'zoe@example.org' });
  assert.match(calls[0].init.headers['X-Vmapp-Publisher'], /^[\x20-\x7e]*$/, 'the header is ASCII');
  const result = page.nodes.result;
  const text = allText(result).join('\n');
  assert.match(text, /Save your owner token now\. It is shown once\./);
  assert.match(text, /Published com\.example\.x 1\.0\.0/);
  const field = all(result).find((n) => n.tagName === 'input');
  assert.equal(field.attrs.value, token);
  assert.equal(field.value, token);
  assert.ok(!text.includes(token), 'the token is in the field only');
  assert.ok(all(result).some((n) => n.attrs.role === 'alert'), 'announced to assistive technology');
});

// ---------------------------------------------------------------------------------------------- server-rendered pages + scripts

const apiReply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('home.js continues after a server-rendered list: no second fetch, "Show more" resumes where the page stopped, sort links keep working', async () => {
  const calls = [];
  const fetchImpl = async (p) => {
    calls.push(p);
    return apiReply({ total: 45, limit: 20, offset: 40, sort: 'new', q: '', items: [] });
  };
  const ids = ['list', 'status', 'more', 'q', 'search', 'stats', 'pager'];
  // page 2 of 3 as the server sends it: items 21-40 of 45, the page links, the totals in the footer
  const page = runPage('http://unused', {
    pathname: '/', search: '?sort=new&page=2', ids, scripts: ['common.js', 'home.js'], fetchImpl,
    setup: (n) => {
      n.list.setAttribute('data-total', '45');
      n.list.setAttribute('data-offset', '20');
      for (let i = 0; i < 20; i++) n.list.append(new FakeNode('li'));
      n.stats.textContent = '45 apps, 45 versions, 0 downloads';
    },
  });
  await settle();
  assert.deepEqual(calls, [], 'the list and the totals are on the page already: nothing is fetched');
  assert.equal(page.nodes.list.children.length, 20, 'the server-rendered items are left alone');
  assert.equal(page.nodes.more.hidden, false, '20 more are to come');
  assert.equal(page.nodes.pager.hidden, true, '"Show more" replaces the page links');
  assert.deepEqual(page.tabs.map((x) => x.attrs['aria-current']), ['false', 'page', 'false']);
  assert.deepEqual(page.tabs.map((x) => x.attrs.href), ['/', '/?sort=new', '/?sort=updated']);

  page.nodes.more.listeners.click[0]();
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/apps\?/);
  assert.match(calls[0], /sort=new/);
  assert.match(calls[0], /offset=40/, 'continues after the 20 shown from offset 20');

  // a sort link changes the list in place; a click with a modifier key is left to the browser
  let prevented = 0;
  page.tabs[0].listeners.click[0]({ metaKey: true, preventDefault() { prevented++; } });
  await settle();
  assert.equal(prevented, 0);
  assert.equal(calls.length, 1, 'cmd-click opens the link; the page does not reload its list');
  page.tabs[2].listeners.click[0]({ preventDefault() { prevented++; } });
  await settle();
  assert.equal(prevented, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /sort=updated/);
  assert.match(calls[1], /offset=0/);
  assert.deepEqual(page.tabs.map((x) => x.attrs['aria-current']), ['false', 'false', 'page']);

  // everything fits on the page: no "Show more"
  const whole = runPage('http://unused', {
    pathname: '/', ids, scripts: ['common.js', 'home.js'], fetchImpl,
    setup: (n) => {
      n.list.setAttribute('data-total', '2');
      n.list.setAttribute('data-offset', '0');
      n.list.append(new FakeNode('li'), new FakeNode('li'));
      n.stats.textContent = 'x';
    },
  });
  await settle();
  assert.equal(whole.nodes.more.hidden, true);
  assert.equal(calls.length, 2);
});

test('app.js leaves a server-rendered page alone, and still fills one that came without content', async () => {
  const calls = [];
  const fetchImpl = async (p) => {
    calls.push(p);
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'no' } }) };
  };
  const page = runPage('http://unused', {
    pathname: '/apps/com.example.x', ids: ['app', 'status'], scripts: ['common.js', 'app.js'], fetchImpl,
    setup: (n) => n.app.setAttribute('data-ssr', '1'),
  });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(page.nodes.status.textContent, '');
  const bare = runPage('http://unused', { pathname: '/apps/com.example.x', ids: ['app', 'status'], scripts: ['common.js', 'app.js'], fetchImpl });
  await settle();
  assert.deepEqual(calls, ['/api/apps/com.example.x']);
  assert.match(bare.nodes.status.textContent, /no app with the id/);
});

// The server renders the same words as the page scripts: the two renderings must not drift apart. The scripts run against
// the real API in the fake DOM; the server's HTML is cut into its text pieces; both lists must be the same, in order.
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&larr;/g, '←').replace(/&amp;/g, '&');
const htmlPieces = (markup) => markup.split(/<[^>]*>/).map(unescapeHtml).filter((x) => x.trim() !== '');
const htmlLinks = (markup) => [...markup.matchAll(/<a [^>]*?href="([^"]*)"/g)].map((m) => unescapeHtml(m[1]));
function domPieces(root) {
  const out = [];
  (function walk(n) {
    if (n._text) out.push(n._text);
    for (const c of n.children) {
      if (c instanceof FakeText) out.push(c.text);
      else walk(c);
    }
  })(root);
  return out.filter((x) => x.trim() !== '');
}
const domLinks = (root) => all(root).filter((n) => n.tagName === 'a').map((n) => n.attrs.href);
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test('the server-rendered app page and list say exactly what the page scripts say (and link to the same places)', async (t) => {
  const dns = [];
  const s = await startRegistry({ mailer: { send: async () => {} }, devAllowHttpVerify: true, domainTimeoutMs: 600, resolveTxt: async () => dns });
  const w = tmpdir('pkg-');
  const web = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => { web.closeAllConnections(); web.close(r); });
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const perms = {
    folders: [{ name: 'notes', access: 'readwrite', purpose: 'Your notes' }, { name: 'out', access: 'writeonly' }, { name: 'ref', access: 'read', purpose: '<b>x</b> & "y"' }],
    dialogs: true,
    external: true,
    devices: [{ device: 'microphone', purpose: 'Dictation' }],
    host: [{ cap: 'screen', purpose: 'Sees the screen' }, { cap: 'input', purpose: 'Types for you' }, { cap: 'gpu' }],
    network: [{ host: 'api.example.com', purpose: 'Syncs' }, { host: '*.cdn.example.com', ports: [443, 80], purpose: 'Assets' }],
  };
  const domain = `localhost:${web.address().port}`;
  let token = null;
  for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
    const p = buildPackage(w, `v${v}`, { id: 'com.example.parity', name: 'Parity & "Co"', version: v, description: 'Does <things> & more.', runtime: 'node22', permissions: perms });
    const r = await publish(s.url, p.file, { token, profile: token ? undefined : { name: 'Jane', company: 'Acme <Co>', url: 'https://localhost/home' } });
    assert.equal(r.status, 201, r.text);
    if (r.json.ownerToken) token = r.json.ownerToken;
  }
  const plain = buildPackage(w, 'plain', { id: 'com.example.plain', name: 'Plain', description: '', permissions: { folders: [], dialogs: false, external: false } });
  assert.equal((await publish(s.url, plain.file)).status, 201);
  assert.equal((await call(s.url, '/api/apps/com.example.parity/1.1.0/withdraw', { method: 'POST', json: { reason: 'Corrupts <notes> & "more"' }, token })).status, 200);
  await call(s.url, '/api/apps/com.example.parity/1.0.0/download', { ip: '10.0.0.7' });

  const parity = async (label) => {
    const ssr = (await call(s.url, '/apps/com.example.parity')).text;
    const region = between(ssr, '<div id="app" data-ssr="1">', '</main>');
    const page = runPage(s.url, { pathname: '/apps/com.example.parity', ids: ['app', 'status'], scripts: ['common.js', 'app.js'] });
    await settle();
    assert.ok(domPieces(page.nodes.app).length > 40, `${label}: the script rendered the page`);
    for (const known of ['Withdrawn: Corrupts <notes> & "more"', 'Parity & "Co"', 'requests control of your computer', 'wildcard', 'Does <things> & more.']) {
      assert.ok(domPieces(page.nodes.app).includes(known), `${label}: the script shows "${known}"`);
      assert.ok(htmlPieces(region).includes(known), `${label}: the server shows "${known}"`);
    }
    assert.deepEqual(htmlPieces(region), domPieces(page.nodes.app), `${label}: app page text`);
    assert.deepEqual(htmlLinks(region), domLinks(page.nodes.app), `${label}: app page links`);

    const home = (await call(s.url, '/')).text;
    const list = between(home, '<ul id="list"', '</ul>');
    const hp = runPage(s.url, { pathname: '/', ids: ['list', 'status', 'more', 'q', 'search', 'stats'], scripts: ['common.js', 'home.js'] });
    await settle();
    assert.equal(hp.nodes.list.children.length, 2);
    assert.deepEqual(htmlPieces(list), domPieces(hp.nodes.list), `${label}: list text`);
    assert.deepEqual(htmlLinks(list), domLinks(hp.nodes.list), `${label}: list links`);
    assert.equal(htmlPieces(between(home, '<p id="status"', '</p>'))[0], hp.nodes.status.textContent, `${label}: status line`);
    assert.equal(htmlPieces(between(home, '<span id="stats">', '</span>'))[0], hp.nodes.stats.textContent, `${label}: totals`);
  };
  await parity('unverified');

  // verified domain with a company and an https website, then with a website that is not https
  const post = (p, json) => call(s.url, `/api/publisher/${p}`, { method: 'POST', token, json: json || {} });
  const started = await post('verify-domain', { domain });
  dns.push([`vmapp-publisher=${started.json.token}`]);
  assert.equal((await post('check-domain')).status, 200);
  await parity('verified domain, https website');
  assert.equal((await post('profile', { company: 'Acme <Co>', url: 'http://localhost/home' })).status, 200);
  await parity('verified domain, http website');
  assert.equal((await post('profile', { url: '' })).status, 200);
  await parity('verified domain, no company');
});
