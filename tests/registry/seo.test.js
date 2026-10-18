'use strict';
// The server-rendered pages (registry/lib/pages.js): the home page and every app page arrive complete, without running
// any script, with the tags search engines and link previews read; /sitemap.xml and /robots.txt. Registry text is hostile
// input everywhere here: it must reach the markup only escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { CSP } = require('../../registry/lib/registry');
const { PAGE_SIZE } = require('../../registry/lib/pages');
const { esc, html, raw, jsonLd, snippet, httpsUrl } = require('../../registry/lib/html');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish } = require('./helpers');

const PUBLIC = 'https://registry.example.test';
const HOSTILE = '</script><script>alert(1)</script>"\'<img src=x onerror=1>';
const HOSTILE_ESCAPED = '&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&lt;img src=x onerror=1&gt;';
const DAY = 24 * 3600 * 1000;

async function server(t, opts) {
  const s = await startRegistry(opts);
  const w = tmpdir('pkg-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  s.w = w;
  return s;
}

/** Publishes a package built from the fixture with `manifest` merged in; returns the 201 body. */
async function put(s, name, manifest, opts) {
  const r = await publish(s.url, buildPackage(s.w, name, manifest).file, opts);
  assert.equal(r.status, 201, r.text);
  return r.json;
}

/** A request whose Host header is chosen by the test. */
function getWithHost(url, path, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const meta = (doc, attr, name) => {
  const m = new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`).exec(doc);
  return m ? unesc(m[1]) : null;
};
const canonical = (doc) => (/<link rel="canonical" href="([^"]*)">/.exec(doc) || [])[1] || null;
const titleOf = (doc) => unesc((/<title>([^<]*)<\/title>/.exec(doc) || [])[1] || '');
const ldBlocks = (doc) => [...doc.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]));
const listIds = (doc) => [...doc.matchAll(/<a href="\/apps\/([^"]+)">/g)].map((m) => m[1]);
const body = (doc) => doc.slice(doc.indexOf('<body>'));

const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'body', 'header', 'div', 'a', 'nav', 'main', 'section', 'h1', 'h2', 'p', 'code', 'form',
  'label', 'input', 'button', 'ul', 'li', 'span', 'strong', 'dl', 'dt', 'dd', 'pre', 'br', 'footer']);

/**
 * Every "<" in a page must begin a well-formed tag from the pages' own vocabulary, with double-quoted attributes, none of
 * them an event handler; scripts are the page's own files or the JSON-LD data block. (Registry text has its "<" escaped, so
 * a stray one would mean something got through.) Returns the tags found.
 */
function checkMarkup(doc, where) {
  assert.match(doc, /^<!doctype html>\n/, `${where}: starts with a doctype`);
  const tags = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/"']+(?:="[^"]*")?)*)\s*\/?>/g;
  let consumed = 0;
  for (const m of doc.slice('<!doctype html>'.length).matchAll(re)) {
    consumed++;
    const [, close, name, attrs] = m;
    assert.ok(ALLOWED_TAGS.has(name), `${where}: unexpected element <${name}>`);
    if (close) continue;
    const list = [...attrs.matchAll(/\s+([^\s=>/"']+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2]]);
    for (const [k, v] of list) {
      assert.doesNotMatch(k, /^on/i, `${where}: event handler attribute ${k}`);
      assert.notEqual(k, 'style', `${where}: inline style`);
      if (k === 'href' && name === 'a') assert.match(v, /^(\/|https:\/\/)/, `${where}: link to ${v}`);
    }
    if (name === 'script') {
      const src = list.find(([k]) => k === 'src');
      const type = list.find(([k]) => k === 'type');
      assert.ok((src && /^\/[a-z]+\.js$/.test(src[1])) || (type && type[1] === 'application/ld+json'), `${where}: unexpected script ${m[0]}`);
    }
    tags.push({ name, attrs: Object.fromEntries(list) });
  }
  const lt = (doc.match(/</g) || []).length;
  assert.equal(lt, consumed + 1, `${where}: ${lt - consumed - 1} "<" outside well-formed tags`);
  assert.equal((doc.match(/<script/g) || []).length, (doc.match(/<\/script>/g) || []).length, `${where}: unbalanced script tags`);
  return tags;
}

// ---------------------------------------------------------------------------------------------- helpers

test('html helpers: escaping, the template tag, JSON-LD, snippets, links', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc('a\u0000b\u0007c\td\ne'), 'abc\td\ne', 'controls other than tab and newline are dropped');
  assert.equal(esc(0), '0');
  // the tag escapes values, passes its own results and raw(), joins arrays, drops null/undefined/false
  assert.equal(String(html`<b>${'<i>'}</b>${raw('<hr>')}${[html`<u>${'&'}</u>`, 'x<']}${null}${undefined}${false}`), '<b>&lt;i&gt;</b><hr><u>&amp;</u>x&lt;');
  assert.equal(String(html`a${html`<b>${'"'}</b>`}`), 'a<b>&quot;</b>');
  // JSON-LD: still the same JSON, but nothing in it can close a script element or open a comment
  const out = jsonLd({ a: `</script><!-- & > <`, b: 'line\u2028sep\u2029' });
  assert.doesNotMatch(out, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(out), { a: `</script><!-- & > <`, b: 'line\u2028sep\u2029' });
  assert.equal(snippet('  a \n\t b   c ', 100), 'a b c');
  assert.equal(snippet('abcdef', 4), 'abc\u2026');
  assert.equal(snippet('\u{1F600}\u{1F600}\u{1F600}', 2), '\u{1F600}\u2026', 'cuts between characters, not inside a surrogate pair');
  // only plain https links
  assert.equal(httpsUrl('https://example.com'), 'https://example.com/');
  assert.equal(httpsUrl('HTTPS://Example.COM/a b'), 'https://example.com/a%20b');
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', '//example.com', 'https://user:pw@example.com', 'https://u@example.com', '/relative', '', 'ftp://x.test', null, undefined, 5]) {
    assert.equal(httpsUrl(bad), null, String(bad));
  }
});

// ---------------------------------------------------------------------------------------------- the home page

test('home page: complete HTML without running any script, with title, description, canonical, Open Graph, Twitter and JSON-LD', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  await put(s, 'a', { id: 'com.example.alpha', name: 'Alpha', description: 'Alpha does alpha things.', publisher: 'Fixture Alpha Inc.' }, { profile: { name: 'Jane Doe', company: 'Acme Co', email: 'jane@acme.test' } });
  await put(s, 'b', { id: 'com.example.beta', name: 'Beta', description: '' });
  await call(s.url, '/api/apps/com.example.alpha/1.0.0/download', { ip: '10.0.0.1' });

  const r = await call(s.url, '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  checkMarkup(r.text, 'home');
  const doc = r.text;

  // the list, in the API's default order (the downloaded app first), as plain markup
  assert.deepEqual(listIds(doc), ['com.example.alpha', 'com.example.beta']);
  assert.match(doc, /<div class="title"><a href="\/apps\/com\.example\.alpha">Alpha<\/a><span class="ver">v1\.0\.0<\/span><\/div>/);
  assert.match(doc, /<span class="pubbadge level-unverified">Unverified publisher<\/span><span>com\.example\.alpha<\/span>/);
  assert.match(doc, /<p>Alpha does alpha things\.<\/p>/);
  assert.match(doc, /<span>1 download<\/span><span>[\d.]+ KiB<\/span><span>node22<\/span><span>updated 2026-03-01<\/span>/);
  assert.match(doc, /<span>Asks for: folder &quot;docs&quot; \(read only\), file open\/save dialogs<\/span>/);
  assert.match(doc, /<p id="status"[^>]*>2 apps<\/p>/);
  assert.match(doc, /<span id="stats">2 apps, 2 versions, 1 download<\/span>/);
  // the search form works without script, and so do the sort links
  assert.match(doc, /<form id="search" class="search" role="search" action="\/" method="get"/);
  assert.match(doc, /<input type="search" id="q" name="q" value=""/);
  assert.match(doc, /<a href="\/" data-sort="popular" aria-current="page">Popular<\/a><a href="\/\?sort=new" data-sort="new" aria-current="false">New<\/a>/);
  // the claims of the publisher are not on the page
  for (const claim of ['Jane Doe', 'Acme Co', 'jane@acme.test', 'Fixture Alpha Inc.']) assert.ok(!doc.includes(claim), `claim "${claim}" on the page`);

  // the tags
  assert.equal(titleOf(doc), 'D9010 VmApp Registry - apps that run in their own sandbox');
  assert.match(meta(doc, 'name', 'description'), /^Browse, search and download \.vmapp apps\./);
  assert.equal(canonical(doc), `${PUBLIC}/`);
  assert.equal(meta(doc, 'property', 'og:url'), `${PUBLIC}/`);
  assert.equal(meta(doc, 'property', 'og:title'), titleOf(doc));
  assert.equal(meta(doc, 'property', 'og:description'), meta(doc, 'name', 'description'));
  assert.equal(meta(doc, 'property', 'og:type'), 'website');
  assert.equal(meta(doc, 'property', 'og:site_name'), 'D9010 VmApp Registry');
  assert.equal(meta(doc, 'name', 'twitter:card'), 'summary');
  assert.equal(meta(doc, 'name', 'twitter:title'), titleOf(doc));
  assert.equal(meta(doc, 'name', 'robots'), null, 'the plain list is for the index');
  const [ld, ...more] = ldBlocks(doc);
  assert.equal(more.length, 0);
  assert.deepEqual(ld, {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'D9010 VmApp Registry',
    url: `${PUBLIC}/`,
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${PUBLIC}/?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
  });

  // caching: a public page for a CDN, valid for a minute; the same for everybody
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('vary'), null);
  const etag = r.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{20}"$/);
  const again = await fetch(s.url + '/', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('cache-control'), 'public, max-age=60');
  const head = await fetch(s.url + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(doc)));
  assert.equal((await call(s.url, '/', { method: 'POST' })).status, 405);

  // the security headers are the ones every page has: no inline script is allowed, and none is needed for the JSON-LD
  assert.equal(r.headers.get('content-security-policy'), CSP);
  assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval|\*/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('home page: an empty registry says so, and the scripts and styles are still linked', async (t) => {
  const s = await server(t);
  const r = await call(s.url, '/');
  assert.equal(r.status, 200);
  checkMarkup(r.text, 'empty home');
  assert.match(r.text, /<p id="status"[^>]*>No apps yet\. Be the first to publish one\.<\/p>/);
  assert.match(r.text, /<ul id="list" class="applist" data-total="0" data-offset="0"><\/ul>/);
  assert.match(r.text, /<link rel="stylesheet" href="\/style\.css">/);
  assert.match(r.text, /<script src="\/common\.js"><\/script>\n<script src="\/home\.js"><\/script>/);
});

// ---------------------------------------------------------------------------------------------- an app page

test('app page: details, permissions, versions and the tags, all in the HTML', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  const manifest = (version) => ({
    id: 'com.example.alpha', name: 'Alpha', version, description: 'Alpha does alpha things.', publisher: 'Fixture Alpha Inc.',
    permissions: {
      folders: [{ name: 'notes', access: 'readwrite', purpose: 'Your notes' }, { name: 'out', access: 'writeonly' }],
      dialogs: true,
      external: true,
      host: [{ cap: 'screen', purpose: 'Sees the screen' }, { cap: 'input', purpose: 'Types for you' }],
      network: [{ host: 'api.example.com', purpose: 'Syncs notes' }, { host: '*.cdn.example.com', ports: [443, 80], purpose: 'Assets' }],
    },
  });
  const first = await put(s, 'v1', manifest('1.0.0'), { profile: { name: 'Jane Doe', company: 'Acme Co', email: 'jane@acme.test', url: 'https://acme.test' } });
  const token = first.ownerToken;
  await put(s, 'v2', manifest('1.1.0'), { token });
  await put(s, 'v3', manifest('2.0.0'), { token });
  s.clock.advance(DAY);
  const w = await call(s.url, '/api/apps/com.example.alpha/2.0.0/withdraw', { method: 'POST', json: { reason: 'Corrupts notes' }, token });
  assert.equal(w.status, 200, w.text);

  const r = await call(s.url, '/apps/com.example.alpha');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(r.headers.get('set-cookie'), null);
  checkMarkup(r.text, 'app page');
  const doc = r.text;
  const main = body(doc);

  // the name, the version that is offered (2.0.0 is withdrawn: 1.1.0), the publisher by the display rule
  assert.match(main, /<h1>Alpha<span class="muted">  v1\.1\.0<\/span><\/h1>/);
  assert.match(main, /<p class="publisher"><span class="pubbadge level-unverified">Unverified publisher<\/span> <span class="muted">Nobody has confirmed who made this app\.<\/span><\/p>/);
  for (const claim of ['Jane Doe', 'Acme Co', 'jane@acme.test', 'acme.test', 'Fixture Alpha Inc.']) assert.ok(!doc.includes(claim), `claim "${claim}" on the page`);
  assert.match(main, /<p>Alpha does alpha things\.<\/p>/);
  assert.match(main, /<a class="button" href="\/api\/apps\/com\.example\.alpha\/1\.1\.0\/download" rel="nofollow">Download v1\.1\.0 \([\d.]+ KiB\)<\/a>/);
  // the permissions, in words
  assert.match(main, /This app will ask for:/);
  assert.match(main, /<strong>A folder called &quot;notes&quot;<\/strong><span class="badge">readwrite<\/span><span class="why">Lets the app read and change files in a folder you choose\. Why: Your notes<\/span>/);
  assert.match(main, /Lets the app save new files into a folder you choose\. Why: no reason given/);
  assert.match(main, /File open and save dialogs/);
  assert.match(main, /Open web links in your browser/);
  assert.match(main, /<strong>Control your mouse and keyboard<\/strong><span class="badge danger">requests control of your computer<\/span>/);
  assert.match(main, /<strong>The internet: \*\.cdn\.example\.com<\/strong><span class="badge">port 443, 80 \(not encrypted\)<\/span><span class="badge danger">wildcard<\/span><span class="badge danger">not encrypted<\/span>/);
  assert.match(main, /Lets the app connect to any address under cdn\.example\.com \(many servers\)/);
  assert.match(main, /could send what it reads to those addresses/);
  assert.match(main, /vmapp get com\.example\.alpha --install/);
  assert.match(main, /<dt>Runtime<\/dt><dd>node22<\/dd>/);
  // every version, the withdrawn one with its reason, each downloadable by number
  assert.deepEqual([...main.matchAll(/<span class="v">([^<]+)<\/span>/g)].map((m) => m[1]), ['2.0.0', '1.1.0', '1.0.0']);
  assert.match(main, /<span class="withdrawn">Withdrawn: Corrupts notes<\/span>/);
  assert.match(main, /href="\/api\/apps\/com\.example\.alpha\/2\.0\.0\/download" rel="nofollow">Download<\/a>/);
  assert.match(main, /<span class="meta mono">sha256 [0-9a-f]{16}\.\.\.<\/span>/);
  assert.match(main, /new major version/);

  // the tags
  assert.equal(titleOf(doc), 'Alpha - D9010 VmApp Registry');
  assert.equal(meta(doc, 'name', 'description'), 'Alpha does alpha things.');
  assert.equal(canonical(doc), `${PUBLIC}/apps/com.example.alpha`);
  assert.equal(meta(doc, 'property', 'og:url'), `${PUBLIC}/apps/com.example.alpha`);
  assert.equal(meta(doc, 'property', 'og:title'), 'Alpha - D9010 VmApp Registry');
  assert.equal(meta(doc, 'property', 'og:description'), 'Alpha does alpha things.');
  assert.equal(meta(doc, 'name', 'twitter:card'), 'summary');
  assert.equal(meta(doc, 'name', 'twitter:description'), 'Alpha does alpha things.');
  assert.equal(meta(doc, 'name', 'robots'), null);
  const lds = ldBlocks(doc);
  assert.equal(lds.length, 1);
  const detail = (await call(s.url, '/api/apps/com.example.alpha')).json;
  assert.deepEqual(lds[0], {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Alpha',
    softwareVersion: '1.1.0',
    operatingSystem: 'macOS',
    applicationCategory: 'UtilitiesApplication',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    datePublished: detail.createdAt,
    dateModified: detail.versions.find((v) => v.version === '1.1.0').publishedAt,
    description: 'Alpha does alpha things.',
    url: `${PUBLIC}/apps/com.example.alpha`,
    downloadUrl: `${PUBLIC}/api/apps/com.example.alpha/1.1.0/download`,
  }, 'no publisher: it is unverified; no rating, no review, nothing the registry does not know');

  // ETag / 304
  const etag = r.headers.get('etag');
  assert.equal((await fetch(s.url + '/apps/com.example.alpha', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(s.url + '/apps/com.example.alpha', { method: 'HEAD' })).status, 200);
  assert.equal((await call(s.url, '/apps/com.example.alpha', { method: 'DELETE' })).status, 405);
});

test('app page: without a description the preview text says what the page lists, and an app can have no permissions', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  await put(s, 'p', { id: 'com.example.plain', name: 'Plain', description: '', permissions: { folders: [], dialogs: false, external: false } });
  const r = await call(s.url, '/apps/com.example.plain');
  assert.equal(r.status, 200);
  checkMarkup(r.text, 'plain app');
  assert.match(meta(r.text, 'name', 'description'), /^Download Plain v1\.0\.0 from the D9010 VmApp Registry\./);
  assert.match(r.text, /<li>Nothing\. This app asks for no folders and no dialogs\.<\/li>/);
  assert.doesNotMatch(r.text, /<p>\s*<\/p>/, 'no empty description paragraph');
  assert.equal(ldBlocks(r.text)[0].description, undefined);
});

test('a long description is cut for the preview, on one line', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  const long = 'First line.\n\nSecond   line. ' + 'word '.repeat(80);
  await put(s, 'l', { id: 'com.example.long', name: 'Long', description: long });
  const r = await call(s.url, '/apps/com.example.long');
  const d = meta(r.text, 'name', 'description');
  assert.ok([...d].length <= 200 && d.endsWith('\u2026'), d);
  assert.ok(d.startsWith('First line. Second line. word word'));
  assert.ok(!/[\n\t]/.test(d));
  assert.equal(meta(r.text, 'property', 'og:description'), d);
});

// ---------------------------------------------------------------------------------------------- publisher: the display rule

test('the publisher follows the display rule in the page and in the JSON-LD; links are https only', async (t) => {
  const mails = [];
  const dns = [];
  const s = await server(t, { publicUrl: PUBLIC, mailer: { send: async (m) => void mails.push(m) }, devAllowHttpVerify: true, domainTimeoutMs: 600, resolveTxt: async () => dns });
  const web = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { web.closeAllConnections(); web.close(r); }));
  const domain = `localhost:${web.address().port}`;

  const claimed = { name: 'Jane Doe', company: HOSTILE, email: 'jane@acme.test', url: 'https://localhost/a"b\'c<d>' };
  const { ownerToken: token } = await put(s, 'a', { id: 'com.example.alpha', name: 'Alpha', publisher: 'Fixture Inc.' }, { profile: claimed });
  const post = (p, json) => call(s.url, `/api/publisher/${p}`, { method: 'POST', token, json: json || {} });
  const page = async () => (await call(s.url, '/apps/com.example.alpha')).text;

  // unverified: a label, nothing claimed, no publisher in the JSON-LD
  let doc = await page();
  assert.match(doc, /Unverified publisher/);
  for (const claim of ['Jane', 'jane@', 'acme.test', 'Fixture Inc.', HOSTILE_ESCAPED]) assert.ok(!doc.includes(claim), `claim "${claim}" on the page`);
  assert.equal(ldBlocks(doc)[0].publisher, undefined);

  // verified e-mail: the domain of the address only; an e-mail domain is not a publisher, so none in the JSON-LD
  assert.equal((await post('verify-email')).status, 200);
  const code = /code: ([0-9a-f]{32})/.exec(mails[0].text)[1];
  assert.equal((await call(s.url, '/api/publisher/confirm-email', { method: 'POST', json: { code } })).status, 200);
  doc = await page();
  assert.match(doc, /<span class="pubbadge level-email">\u2709 Verified email @acme\.test<\/span>/);
  assert.ok(!doc.includes('jane@acme.test') && !doc.includes('Jane') && !doc.includes(HOSTILE_ESCAPED));
  assert.equal(ldBlocks(doc)[0].publisher, undefined, 'a verified e-mail address does not make its domain the publisher');

  // verified domain: the domain, the company and the https website (the host is the verified one); never the person
  const started = await post('verify-domain', { domain });
  dns.push([`vmapp-publisher=${started.json.token}`]);
  assert.equal((await post('check-domain')).status, 200);
  doc = await page();
  checkMarkup(doc, 'domain-verified app page');
  const href = httpsUrl(claimed.url);
  assert.equal(href, 'https://localhost/a%22b\'c%3Cd%3E');
  assert.ok(doc.includes(`<span class="pubbadge level-domain">\u2713 Verified: ${domain}</span> <strong>${HOSTILE_ESCAPED}</strong> <a href="${esc(href)}" rel="noopener noreferrer nofollow">${esc(claimed.url)}</a>`), doc.match(/<p class="publisher">.*<\/p>/)[0]);
  assert.ok(!doc.includes('Jane') && !doc.includes('jane@') && !doc.includes('Fixture Inc.'));
  assert.deepEqual(ldBlocks(doc)[0].publisher, { '@type': 'Organization', name: HOSTILE, url: href });

  // a website that is not https is shown as text, never as a link, and is not put in the JSON-LD
  assert.equal((await post('profile', { company: 'Acme Co', url: 'http://localhost/start' })).status, 200);
  doc = await page();
  checkMarkup(doc, 'http website');
  assert.match(doc, /<strong>Acme Co<\/strong> <span>http:\/\/localhost\/start<\/span>/);
  assert.ok(!doc.includes('href="http://'));
  assert.deepEqual(ldBlocks(doc)[0].publisher, { '@type': 'Organization', name: 'Acme Co' });

  // no company: the verified domain names the publisher
  assert.equal((await post('profile', { url: '' })).status, 200);
  doc = await page();
  assert.deepEqual(ldBlocks(doc)[0].publisher, { '@type': 'Organization', name: domain });
});

// ---------------------------------------------------------------------------------------------- hostile text

test('hostile registry text appears only escaped: in text, in attributes and in the JSON-LD', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  const permissions = {
    folders: [{ name: 'notes', access: 'read', purpose: HOSTILE }],
    dialogs: true,
    external: true,
    devices: [{ device: 'microphone', purpose: HOSTILE }],
    host: [{ cap: 'input', purpose: HOSTILE }],
    network: [{ host: 'api.example.com', purpose: HOSTILE }],
  };
  const { ownerToken: token } = await put(s, 'e', {
    id: 'com.example.evil', name: HOSTILE, description: `${HOSTILE} & "more"`, publisher: HOSTILE, permissions,
  }, { profile: { name: HOSTILE, company: HOSTILE, email: 'x@evil.test', url: 'https://evil.test/<script>' } });
  await put(s, 'e2', { id: 'com.example.evil', name: HOSTILE, version: '1.1.0', description: HOSTILE, permissions }, { token });
  const w = await call(s.url, '/api/apps/com.example.evil/1.0.0/withdraw', { method: 'POST', json: { reason: HOSTILE }, token });
  assert.equal(w.status, 200, w.text);

  for (const [path, label] of [['/', 'home'], ['/apps/com.example.evil', 'app page'], ['/?q=' + encodeURIComponent(HOSTILE), 'search page'], ['/?q=' + encodeURIComponent(HOSTILE) + '&sort=new&page=9', 'search page 9']]) {
    const r = await call(s.url, path);
    assert.equal(r.status, 200, label);
    const doc = r.text;
    checkMarkup(doc, label);
    // the raw text is nowhere; its escaped form is
    assert.ok(!doc.includes('<script>alert(1)'), `${label}: raw script`);
    assert.ok(!doc.includes('<img'), `${label}: raw img`);
    assert.ok(!doc.includes(HOSTILE), `${label}: the hostile text, unescaped`);
    assert.ok(doc.includes(HOSTILE_ESCAPED), `${label}: the escaped text is shown`);
    // the page is exactly: its own scripts, plus the one data block when there is one
    const scripts = [...doc.matchAll(/<script[^>]*>/g)].map((m) => m[0]).filter((x) => !x.includes('ld+json'));
    assert.deepEqual(scripts, ['<script src="/common.js">', label === 'app page' ? '<script src="/app.js">' : '<script src="/home.js">'], label);
    // attributes: the descriptions carry the text escaped and come back equal when parsed
    for (const [attr, name] of [['name', 'description'], ['property', 'og:description'], ['name', 'twitter:description']]) {
      const v = meta(doc, attr, name);
      assert.ok(v && !/[<>]/.test(doc.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`))[1]), `${label}: ${name}`);
    }
    assert.ok(!/[<>]/.test(doc.match(/<meta property="og:title" content="([^"]*)">/)[1]), `${label}: og:title`);
  }

  // the app page in detail
  const doc = (await call(s.url, '/apps/com.example.evil')).text;
  assert.equal(titleOf(doc), `${HOSTILE} - D9010 VmApp Registry`);
  assert.equal(meta(doc, 'name', 'description'), HOSTILE, 'the meta description round-trips through the escaping');
  const ld = ldBlocks(doc)[0];
  assert.equal(ld.name, HOSTILE);
  assert.equal(ld.description, HOSTILE);
  const ldRaw = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(doc)[1];
  assert.doesNotMatch(ldRaw, /[<>&]/, 'nothing in the JSON-LD can end the script element');
  assert.ok(ldRaw.includes('\\u003c/script\\u003e'));
  assert.equal(ld.publisher, undefined, 'unverified');
  assert.ok(doc.includes(`<span class="withdrawn">Withdrawn: ${HOSTILE_ESCAPED}</span>`));
  assert.ok(doc.includes(`Why: ${HOSTILE_ESCAPED}</span>`));
  assert.ok(!doc.includes('evil.test') && !doc.includes('x@evil.test'), 'the unverified claims are not shown');

  // a search term is echoed escaped, in the input, in the title and in the description
  const q = await call(s.url, '/?q=' + encodeURIComponent(HOSTILE));
  assert.ok(q.text.includes(`value="${HOSTILE_ESCAPED}"`));
  assert.equal(titleOf(q.text), `Search results for "${HOSTILE}" - D9010 VmApp Registry`);
  assert.match(q.text, /<p id="status"[^>]*>1 app match &quot;&lt;\/script&gt;/, 'the search finds the app by its (hostile) name');
});

// ---------------------------------------------------------------------------------------------- absolute URLs

test('absolute URLs come from REGISTRY_PUBLIC_URL only: none without it, never the Host header, only the origin of a valid one', async (t) => {
  const a = await server(t); // no public URL
  const b = await server(t, { publicUrl: PUBLIC + '/some/path/?x=1#y' });
  for (const s of [a, b]) {
    await put(s, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  }
  for (const path of ['/', '/apps/com.example.alpha', '/?page=2', '/?sort=new']) {
    const r = await getWithHost(a.url, path, 'evil.example');
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, /canonical|og:url|evil\.example|127\.0\.0\.1|localhost|http:\/\/|downloadUrl/, `unconfigured ${path}`);
    for (const ld of ldBlocks(r.text)) assert.ok(!('url' in ld) && !('downloadUrl' in ld) && !('potentialAction' in ld), `unconfigured ${path}: absolute URL in the JSON-LD`);
    // with the Host header spoofed, a configured registry still only uses its configuration
    const c = await getWithHost(b.url, path, 'evil.example');
    assert.doesNotMatch(c.text, /evil\.example|127\.0\.0\.1/, `configured ${path}`);
  }
  const home = (await getWithHost(b.url, '/', 'evil.example')).text;
  assert.equal(canonical(home), PUBLIC + '/', 'only the origin of the configured address is used');
  assert.equal(canonical((await call(b.url, '/apps/com.example.alpha')).text), PUBLIC + '/apps/com.example.alpha');
  // the unconfigured registry has no WebSite JSON-LD at all (it needs the address), but its app page still describes the app
  assert.equal(ldBlocks((await call(a.url, '/')).text).length, 0);
  assert.equal(ldBlocks((await call(a.url, '/apps/com.example.alpha')).text)[0]['@type'], 'SoftwareApplication');
  // an address that is not an http(s) URL is as good as none
  for (const bad of ['registry.example.test', 'ftp://registry.example.test', 'javascript:alert(1)', 'not a url']) {
    const s = await server(t, { publicUrl: bad });
    const r = await call(s.url, '/');
    assert.doesNotMatch(r.text, /canonical|og:url/, bad);
    assert.equal((await call(s.url, '/sitemap.xml')).status, 404, bad);
  }
});

// ---------------------------------------------------------------------------------------------- sitemap and robots

test('sitemap.xml: home and the apps that can be found; not a hidden app, not an app whose every version is withdrawn', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  const t0 = Date.parse('2026-03-01T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await put(s, 'vis', { id: 'com.example.vis', name: 'Vis' });
  s.clock.advance(DAY);
  const part = await put(s, 'p1', { id: 'com.example.part', name: 'Part', version: '1.0.0' });
  s.clock.advance(DAY);
  await put(s, 'p2', { id: 'com.example.part', name: 'Part', version: '1.1.0' }, { token: part.ownerToken });
  await call(s.url, '/api/apps/com.example.part/1.1.0/withdraw', { method: 'POST', json: { reason: 'bad' }, token: part.ownerToken });
  s.clock.advance(DAY);
  const gone = await put(s, 'g', { id: 'com.example.gone', name: 'Gone' });
  await call(s.url, '/api/apps/com.example.gone/1.0.0/withdraw', { method: 'POST', json: { reason: 'bad' }, token: gone.ownerToken });
  s.clock.advance(DAY);
  await put(s, 't', { id: 'com.example.tomb', name: 'Tomb' });
  await s.reg.events.append('app.hidden', 'admin', { id: 'com.example.tomb', reason: 'takedown' });
  s.clock.advance(DAY);
  await put(s, 'n', { id: 'com.example.new', name: 'New one' });

  const r = await call(s.url, '/sitemap.xml');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(
    r.text,
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `<url><loc>${PUBLIC}/</loc><lastmod>${iso(t0 + 5 * DAY)}</lastmod></url>\n` +
    `<url><loc>${PUBLIC}/apps/com.example.new</loc><lastmod>${iso(t0 + 5 * DAY)}</lastmod></url>\n` +
    `<url><loc>${PUBLIC}/apps/com.example.part</loc><lastmod>${iso(t0 + DAY)}</lastmod></url>\n` + // 1.1.0 is withdrawn: 1.0.0's time
    `<url><loc>${PUBLIC}/apps/com.example.vis</loc><lastmod>${iso(t0)}</lastmod></url>\n` +
    '</urlset>\n',
  );
  assert.equal((await fetch(s.url + '/sitemap.xml', { headers: { 'If-None-Match': r.headers.get('etag') } })).status, 304);

  // the hidden app: a plain "not found", the same as an app that never existed, and absent from the list too
  const hidden = await call(s.url, '/apps/com.example.tomb');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(hidden.headers.get('cache-control'), 'no-cache');
  checkMarkup(hidden.text, 'hidden app');
  assert.equal(meta(hidden.text, 'name', 'robots'), 'noindex');
  assert.ok(!hidden.text.includes('Tomb') && !hidden.text.includes('takedown'));
  const never = await call(s.url, '/apps/com.example.never');
  assert.equal(never.status, 404);
  assert.equal(hidden.text.replace('com.example.tomb', 'X'), never.text.replace('com.example.never', 'X'), 'a hidden app and an unknown one look the same');
  assert.deepEqual(listIds((await call(s.url, '/')).text), ['com.example.gone', 'com.example.new', 'com.example.part', 'com.example.vis'].sort((x, y) => {
    // the list's order: no downloads, so by name
    const names = { 'com.example.gone': 'gone', 'com.example.new': 'new one', 'com.example.part': 'part', 'com.example.vis': 'vis' };
    return names[x] < names[y] ? -1 : 1;
  }), 'the home list is the API list: withdrawn apps are listed, hidden ones are not');

  // an app whose every version is withdrawn: the page answers, but asks not to be indexed and has no canonical or JSON-LD
  const g = await call(s.url, '/apps/com.example.gone');
  assert.equal(g.status, 200);
  checkMarkup(g.text, 'all withdrawn');
  assert.equal(meta(g.text, 'name', 'robots'), 'noindex, follow');
  assert.equal(canonical(g.text), null);
  assert.equal(ldBlocks(g.text).length, 0);
  assert.match(g.text, /Withdrawn: bad/);
  // the others do not
  assert.equal(meta((await call(s.url, '/apps/com.example.part')).text, 'name', 'robots'), null);

  // restoring the version brings the app back into the sitemap
  await call(s.url, '/api/apps/com.example.gone/1.0.0/restore', { method: 'POST', token: gone.ownerToken });
  assert.match((await call(s.url, '/sitemap.xml')).text, /com\.example\.gone<\/loc><lastmod>2026-03-04T12:00:00Z/);
});

test('sitemap.xml: an empty registry lists the home page; without a public address there is no sitemap', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  assert.equal((await call(s.url, '/sitemap.xml')).text, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${PUBLIC}/</loc></url>\n</urlset>\n`);
  const u = await server(t);
  const r = await call(u.url, '/sitemap.xml');
  assert.equal(r.status, 404);
  assert.match(r.text, /REGISTRY_PUBLIC_URL/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal((await call(s.url, '/sitemap.xml', { method: 'POST' })).status, 405);
});

test('robots.txt: the site is open, the API and the publisher pages are not, the sitemap is named when the address is known', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  const r = await call(s.url, '/robots.txt');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(r.text, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /publish\nDisallow: /publisher\nDisallow: /verify\n\nSitemap: ${PUBLIC}/sitemap.xml\n`);
  const u = await server(t);
  const n = await call(u.url, '/robots.txt');
  assert.equal(n.status, 200);
  assert.equal(n.text, 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /publish\nDisallow: /publisher\nDisallow: /verify\n');
  assert.doesNotMatch(n.text, /Sitemap/i);
  assert.equal((await getWithHost(u.url, '/robots.txt', 'evil.example')).text, n.text);
  // the scripts and styles stay crawlable (a page cannot be rendered without them)
  assert.doesNotMatch(r.text, /style\.css|\.js/);
});

// ---------------------------------------------------------------------------------------------- search, sorting and paging without script

test('the page size of the server-rendered list is the one home.js continues with', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'registry', 'public', 'home.js'), 'utf8');
  assert.equal(Number(/var PAGE = (\d+);/.exec(js)[1]), PAGE_SIZE);
  assert.equal(PAGE_SIZE, 20);
});

test('?q=, ?sort= and ?page= work without script: the same list as the API, one page at a time', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  for (let i = 0; i < 23; i++) {
    const n = String(i).padStart(2, '0');
    await put(s, `a${n}`, { id: `com.example.app${n}`, name: `App ${n}`, description: i === 7 ? 'The seventh, with a unique zebra.' : `Number ${n}` });
  }
  const api = async (qs) => (await call(s.url, `/api/apps?${qs}`)).json.items.map((x) => x.id);

  // page 1: twenty apps, a link to page 2, the page is the one for the index
  let r = await call(s.url, '/');
  assert.deepEqual(listIds(r.text), await api('limit=20'));
  assert.equal(listIds(r.text).length, 20);
  assert.match(r.text, /<p id="status"[^>]*>23 apps<\/p>/);
  assert.match(r.text, /<nav id="pager" class="pager" aria-label="Pages"><span class="muted">Page 1 of 2<\/span><a rel="next" href="\/\?page=2">Next &rarr;<\/a><\/nav>/);
  assert.match(r.text, /<ul id="list" class="applist" data-total="23" data-offset="0">/);
  assert.equal(canonical(r.text), `${PUBLIC}/`);
  assert.equal(meta(r.text, 'name', 'robots'), null);

  // page 2: the rest, its own title and canonical, a link back
  r = await call(s.url, '/?page=2');
  checkMarkup(r.text, 'page 2');
  assert.deepEqual(listIds(r.text), await api('limit=20&offset=20'));
  assert.equal(listIds(r.text).length, 3);
  assert.match(r.text, /<nav id="pager"[^>]*><a rel="prev" href="\/">&larr; Previous<\/a><span class="muted">Page 2 of 2<\/span><\/nav>/);
  assert.match(r.text, /data-offset="20"/);
  assert.equal(titleOf(r.text), 'Apps, page 2 - D9010 VmApp Registry');
  assert.equal(canonical(r.text), `${PUBLIC}/?page=2`);
  assert.equal(meta(r.text, 'name', 'robots'), null);
  assert.equal(ldBlocks(r.text).length, 0, 'the WebSite data is on the start page only');

  // a page past the end: answered, empty, a way back, and not for the index
  r = await call(s.url, '/?page=3');
  assert.equal(r.status, 200);
  assert.equal(listIds(r.text).length, 0);
  assert.match(r.text, /There are no apps on this page\./);
  assert.match(r.text, /<a rel="prev" href="\/\?page=2">/);
  assert.equal(meta(r.text, 'name', 'robots'), 'noindex, follow');
  assert.equal(canonical(r.text), null);
  // nonsense in ?page= is page 1
  for (const bad of ['0', '-1', 'abc', '1.5', '', '99999999999999999999', '%00']) {
    const p = await call(s.url, `/?page=${bad}`);
    assert.equal(p.status, 200, bad);
    assert.deepEqual(listIds(p.text), listIds((await call(s.url, '/')).text), `?page=${bad}`);
  }

  // search: filtered like the API, echoed in the input, not for the index
  r = await call(s.url, '/?q=zebra');
  checkMarkup(r.text, 'search');
  assert.deepEqual(listIds(r.text), ['com.example.app07']);
  assert.deepEqual(listIds(r.text), await api('q=zebra'));
  assert.match(r.text, /<input type="search" id="q" name="q" value="zebra"/);
  assert.match(r.text, /<p id="status"[^>]*>1 app match &quot;zebra&quot;<\/p>/);
  assert.equal(meta(r.text, 'name', 'robots'), 'noindex, follow');
  assert.equal(canonical(r.text), null);
  assert.equal(meta(r.text, 'property', 'og:url'), null);
  assert.equal(titleOf(r.text), 'Search results for "zebra" - D9010 VmApp Registry');
  assert.doesNotMatch(r.text, /id="pager"/, 'one page: no page links');
  r = await call(s.url, '/?q=%20APP%2012%20');
  assert.deepEqual(listIds(r.text), await api('q=app%2012'));
  assert.deepEqual(listIds(r.text), ['com.example.app12']);
  r = await call(s.url, '/?q=nothing-like-this');
  assert.match(r.text, /<p id="status"[^>]*>No apps match &quot;nothing-like-this&quot;\.<\/p>/);
  assert.equal(listIds(r.text).length, 0);
  // a search over several pages keeps the search in its page links
  r = await call(s.url, '/?q=app');
  assert.match(r.text, /<a rel="next" href="\/\?q=app&amp;page=2">/);
  r = await call(s.url, '/?q=app&page=2');
  assert.deepEqual(listIds(r.text), await api('q=app&limit=20&offset=20'));
  assert.match(r.text, /<a rel="prev" href="\/\?q=app">/);
  // the search is cut at 100 characters (the API refuses longer ones; the page does not fail)
  r = await call(s.url, '/?q=' + 'x'.repeat(300));
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`value="${'x'.repeat(100)}" placeholder`));

  // sorting: another order is not for the index; the links, the tab and the form keep it
  r = await call(s.url, '/?sort=updated');
  assert.deepEqual(listIds(r.text), await api('sort=updated&limit=20'));
  assert.match(r.text, /<a href="\/\?sort=updated" data-sort="updated" aria-current="page">Updated<\/a>/);
  assert.match(r.text, /<a href="\/" data-sort="popular" aria-current="false">Popular<\/a>/);
  assert.match(r.text, /<input type="hidden" name="sort" value="updated">/);
  assert.match(r.text, /<a rel="next" href="\/\?sort=updated&amp;page=2">/);
  assert.equal(meta(r.text, 'name', 'robots'), 'noindex, follow');
  assert.equal(canonical(r.text), null);
  r = await call(s.url, '/?sort=new&q=app&page=2');
  assert.deepEqual(listIds(r.text), await api('sort=new&q=app&limit=20&offset=20'));
  assert.match(r.text, /<a href="\/\?sort=new&amp;q=app" data-sort="new" aria-current="page">New<\/a>/);
  // an unknown order is the default one
  r = await call(s.url, '/?sort=bogus');
  assert.deepEqual(listIds(r.text), await api('limit=20'));
  assert.equal(meta(r.text, 'name', 'robots'), null);
  assert.equal(canonical(r.text), `${PUBLIC}/`);
});

// ---------------------------------------------------------------------------------------------- the rest of the site

test('the other pages and files are served as before: no-cache, unchanged addresses', async (t) => {
  const s = await server(t, { publicUrl: PUBLIC });
  await put(s, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  for (const [path, type, mark] of [
    ['/publish', 'text/html', /<h1>Publish an app<\/h1>/],
    ['/publisher', 'text/html', /Verify/],
    ['/verify', 'text/html', /Confirm your email/],
    ['/style.css', 'text/css', /\.tabs a/],
    ['/common.js', 'text/javascript', /window\.R = R/],
    ['/home.js', 'text/javascript', /data-total/],
    ['/app.js', 'text/javascript', /data-ssr/],
    ['/publish.js', 'text/javascript', /./],
  ]) {
    const r = await call(s.url, path);
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get('content-type').startsWith(type), path);
    assert.equal(r.headers.get('cache-control'), 'no-cache', `${path}: only the server-rendered pages are cacheable`);
    assert.match(r.text, mark, path);
  }
  // the shells are not pages of their own, and unknown or malformed addresses are not found
  for (const path of ['/index.html', '/app.html', '/apps', '/apps/', '/apps/not%20an%20id', '/apps/com.example.alpha/', '/apps/com.example.alpha/extra', '/nope', '/sitemap.txt', '/apps/COM.EXAMPLE.ALPHA']) {
    assert.equal((await call(s.url, path)).status, 404, path);
  }
  // the API is as it was
  assert.equal((await call(s.url, '/api/apps')).json.total, 1);
  assert.equal((await call(s.url, '/api/apps')).headers.get('cache-control'), 'no-cache');
  // pages and the API share the request budget per address
  const limited = await server(t, { apiPerMinute: 3 });
  for (const path of ['/', '/apps/com.example.none', '/sitemap.xml']) assert.notEqual((await call(limited.url, path, { ip: '198.51.100.9' })).status, 429);
  assert.equal((await call(limited.url, '/', { ip: '198.51.100.9' })).status, 429);
  assert.equal((await call(limited.url, '/robots.txt', { ip: '198.51.100.9' })).status, 200, 'robots.txt is cheap and always answered');
  assert.equal((await call(limited.url, '/style.css', { ip: '198.51.100.9' })).status, 200, 'static files are not counted');
});
