'use strict';
// Publisher identity: unverified -> email -> domain, and the display rule (only verified facts are shown).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish, storeText } = require('./helpers');
const { isPublicIp, parseProfile } = require('../../registry/lib/publisher');

const MIN = 60 * 1000;
const CLAIMED = { name: 'Jane Doe', company: 'Acme Widgets', email: 'jane@acme.test', url: 'https://acme.test/apps' };
const MANIFEST_PUBLISHER = 'Zorblax Industries';

/** Everything a visitor can fetch without a token. */
async function publicTexts(url, ids) {
  const out = [];
  out.push((await call(url, '/api/apps?limit=100')).text);
  out.push((await call(url, '/api/apps?sort=new&limit=100')).text);
  out.push((await call(url, '/api/stats')).text);
  for (const id of ids) out.push((await call(url, `/api/apps/${id}`)).text);
  return out;
}

function setup(t, extra = {}) {
  const mails = [];
  const env = { mails, dns: [] };
  const mailer = { send: async (m) => void mails.push(m) };
  const p = startRegistry(Object.assign({ mailer, devAllowHttpVerify: true, domainTimeoutMs: 600, resolveTxt: async () => env.dns }, extra));
  return p.then((s) => {
    t.after(async () => {
      await s.close();
      rmrf(s.dir);
    });
    return Object.assign(s, env);
  });
}

function webServer(t) {
  const state = { handler: (req, res) => { res.statusCode = 404; res.end(); }, hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits++;
    state.handler(req, res);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      state.port = srv.address().port;
      t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
      resolve(state);
    });
  });
}

const codeOf = (mail) => /code: ([0-9a-f]{32})/.exec(mail.text)[1];
const serve = (body) => (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.end(body);
};

test('unverified: the API and lists show nothing the publisher merely claims', async (t) => {
  const s = await setup(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha', publisher: MANIFEST_PUBLISHER });
  const r = await publish(s.url, a.file, { profile: CLAIMED });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.publisher, { level: 'unverified', label: '' });
  assert.match(r.json.ownerToken, /^[0-9a-f]{64}$/);

  const list = (await call(s.url, '/api/apps')).json.items[0];
  assert.deepEqual(list.publisher, { level: 'unverified', label: '' });
  const detail = (await call(s.url, '/api/apps/com.example.alpha')).json;
  assert.deepEqual(detail.publisher, { level: 'unverified', label: '' });
  assert.equal(detail.manifest.publisher, undefined, 'the manifest copy has no publisher string');
  assert.equal(detail.claimedPublisher, MANIFEST_PUBLISHER, 'only exposed in the clearly labelled claim field');

  for (const text of await publicTexts(s.url, ['com.example.alpha'])) {
    for (const secret of ['Jane', 'Doe', 'Acme', 'acme.test', 'jane@', 'Widgets']) assert.ok(!text.includes(secret), `public response leaks ${secret}`);
  }
  for (const text of await publicTexts(s.url, [])) assert.ok(!text.includes(MANIFEST_PUBLISHER), 'the list never carries the manifest publisher');

  // search does not match claimed names, companies, emails or the manifest's publisher
  for (const q of ['zorblax', 'jane', 'acme', 'acme.test', 'widgets']) {
    assert.equal((await call(s.url, `/api/apps?q=${q}`)).json.total, 0, `search "${q}" must not match a claim`);
  }
  assert.equal((await call(s.url, '/api/apps?q=alpha')).json.total, 1);
});

test('profile header is validated; non-ASCII names round-trip', async (t) => {
  const s = await setup(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  const hdr = (v) => publish(s.url, a.file, { headers: { 'X-Vmapp-Publisher': v } });
  assert.equal((await hdr('not json')).status, 400);
  assert.equal((await hdr('[1]')).status, 400);
  assert.equal((await hdr('{"name":"x","admin":true}')).status, 400);
  assert.equal((await hdr('{"email":"not-an-email"}')).status, 400);
  assert.equal((await hdr('{"url":"javascript:alert(1)"}')).status, 400);
  assert.equal((await hdr(JSON.stringify({ name: 'x'.repeat(101) }))).status, 400);
  assert.equal((await hdr(JSON.stringify({ name: 'a\u0007b' }))).status, 400);
  assert.deepEqual(parseProfile({ email: 'A@B.CO' }).email, 'a@b.co');
  assert.equal((await call(s.url, '/api/apps')).json.total, 0, 'nothing was published by the rejected requests');
  const r = await publish(s.url, a.file, { profile: { name: 'Zo\u00eb \u4e2d\u6587' } });
  assert.equal(r.status, 201, r.text);
  const me = await call(s.url, '/api/publisher/me', { token: r.json.ownerToken });
  assert.equal(me.json.profile.name, 'Zo\u00eb \u4e2d\u6587');
});

test('email level: one-time code, 15 minutes, only "@domain" is shown', async (t) => {
  const s = await setup(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha', publisher: MANIFEST_PUBLISHER });
  const token = (await publish(s.url, a.file, { profile: CLAIMED })).json.ownerToken;
  const confirm = (code) => call(s.url, '/api/publisher/confirm-email', { method: 'POST', json: { code } });

  // auth
  assert.equal((await call(s.url, '/api/publisher/verify-email', { method: 'POST' })).status, 401);
  assert.equal((await call(s.url, '/api/publisher/verify-email', { method: 'POST', token: crypto.randomBytes(32).toString('hex') })).status, 403);
  assert.equal((await call(s.url, '/api/publisher/me')).status, 401);

  // request a code
  let r = await call(s.url, '/api/publisher/verify-email', { method: 'POST', token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sent, true);
  assert.equal(r.json.emailDomain, 'acme.test');
  assert.ok(!r.text.includes('jane'), 'the response does not repeat the address');
  assert.equal(s.mails.length, 1);
  assert.equal(s.mails[0].to, 'jane@acme.test');
  const code1 = codeOf(s.mails[0]);
  assert.match(s.mails[0].text, new RegExp(`/verify\\?code=${code1}`));
  assert.ok(!storeText(s.storeDir).includes(code1), 'the code is never stored (it lives in memory, as a hash, for 15 minutes)');

  // asking is not enough
  assert.equal((await call(s.url, '/api/apps')).json.items[0].publisher.level, 'unverified');
  // wrong, malformed and foreign codes
  assert.equal((await confirm(crypto.randomBytes(16).toString('hex'))).status, 400);
  assert.equal((await confirm('short')).status, 400);
  assert.equal((await confirm(undefined)).status, 400);
  assert.equal((await confirm(code1.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status, 400);

  // right code: verified; a second use fails
  r = await confirm(code1);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.publisher, { level: 'email', label: 'Verified email @acme.test', emailDomain: 'acme.test' });
  assert.equal((await confirm(code1)).status, 400, 'single use');

  // display: domain of the email only
  const list = (await call(s.url, '/api/apps')).json.items[0];
  assert.deepEqual(list.publisher, { level: 'email', label: 'Verified email @acme.test', emailDomain: 'acme.test' });
  for (const text of await publicTexts(s.url, ['com.example.alpha'])) {
    for (const secret of ['Jane', 'Doe', 'jane@', 'Acme Widgets', 'Widgets', 'https://acme.test/apps']) assert.ok(!text.includes(secret), `public response leaks ${secret}`);
  }
  assert.equal((await call(s.url, '/api/apps?q=acme.test')).json.total, 1, 'the verified email domain is searchable');
  assert.equal((await call(s.url, '/api/apps?q=jane')).json.total, 0);
  assert.equal((await call(s.url, '/api/apps?q=zorblax')).json.total, 0);

  // expiry: valid at 14 minutes, dead at 16
  await call(s.url, '/api/publisher/profile', { method: 'POST', token, json: { name: 'Jane', email: 'other@acme.test' } });
  assert.equal((await call(s.url, '/api/apps')).json.items[0].publisher.level, 'unverified', 'changing the email removes the verification');
  r = await call(s.url, '/api/publisher/verify-email', { method: 'POST', token });
  const code2 = codeOf(s.mails[1]);
  s.clock.advance(16 * MIN);
  assert.equal((await confirm(code2)).status, 400, 'expired');
  r = await call(s.url, '/api/publisher/verify-email', { method: 'POST', token });
  const code3 = codeOf(s.mails[2]);
  assert.notEqual(code3, code2);
  s.clock.advance(14 * MIN);
  assert.equal((await confirm(code3)).status, 200, 'still valid after 14 minutes');
  assert.equal((await call(s.url, '/api/apps')).json.items[0].publisher.label, 'Verified email @acme.test');

  // a new code replaces the old one
  await call(s.url, '/api/publisher/profile', { method: 'POST', token, json: { email: 'jane@acme.test' } });
  await call(s.url, '/api/publisher/verify-email', { method: 'POST', token });
  await call(s.url, '/api/publisher/verify-email', { method: 'POST', token });
  assert.equal((await confirm(codeOf(s.mails[3]))).status, 400, 'the first of two codes is void');
  assert.equal((await confirm(codeOf(s.mails[4]))).status, 200);

  // at most 5 mails per hour per publisher
  let last;
  for (let i = 0; i < 6; i++) last = await call(s.url, '/api/publisher/verify-email', { method: 'POST', token });
  assert.equal(last.status, 429);
});

test('email: nothing to verify without an address; the dev mailer writes .eml files', async (t) => {
  const logs = [];
  const s = await startRegistry({ log: (m) => logs.push(m) });
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
  });
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  const b = buildPackage(w, 'b', { id: 'com.example.beta', name: 'Beta' });
  const t1 = (await publish(s.url, a.file)).json.ownerToken; // no profile at all
  let r = await call(s.url, '/api/publisher/verify-email', { method: 'POST', token: t1 });
  assert.equal(r.status, 400);
  const t2 = (await publish(s.url, b.file, { profile: { email: 'dev@example.org' } })).json.ownerToken;
  r = await call(s.url, '/api/publisher/verify-email', { method: 'POST', token: t2 });
  assert.equal(r.status, 200, r.text);
  const files = fs.readdirSync(path.join(s.dataDir, 'outbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /\.eml$/);
  const eml = fs.readFileSync(path.join(s.dataDir, 'outbox', files[0]), 'utf8');
  assert.match(eml, /^To: dev@example\.org$/m);
  assert.match(eml, new RegExp(`${s.url.replace(/[.]/g, '\\.')}/verify\\?code=[0-9a-f]{32}`));
  assert.ok(logs.some((l) => l.includes('outbox')), 'the mail is logged');
  assert.ok(!logs.some((l) => /[0-9a-f]{32}/.test(l)), 'the code itself is not logged');
});

test('domain level: well-known file, DNS TXT, strict fetching', async (t) => {
  const s = await setup(t);
  const web = await webServer(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha', publisher: MANIFEST_PUBLISHER });
  const domain = `127.0.0.1:${web.port}`;
  const token = (await publish(s.url, a.file, { profile: CLAIMED })).json.ownerToken;
  const post = (p, body, tok = token) => call(s.url, `/api/publisher/${p}`, { method: 'POST', token: tok, json: body || {} });

  // check before starting, and bad domains
  assert.equal((await post('check-domain')).status, 400);
  for (const bad of ['', 'http://example.com', 'example.com/path', 'exa mple.com', 'a..b', '-x.com', 'x'.repeat(300), 5, 'a@b.com']) {
    assert.equal((await post('verify-domain', { domain: bad })).status, 400, `domain ${JSON.stringify(bad).slice(0, 30)}`);
  }
  assert.equal((await call(s.url, '/api/publisher/verify-domain', { method: 'POST', json: { domain } })).status, 401);

  {
    const r = await post('verify-domain', { domain });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.domain, domain);
    assert.match(r.json.token, /^[0-9a-f]{48}$/);
    assert.equal(r.json.file.url, `http://${domain}/.well-known/vmapp-publisher.txt`);
    assert.equal(r.json.file.content, `vmapp-publisher=${r.json.token}`);
    assert.equal(r.json.dns.name, '_vmapp.127.0.0.1');
    assert.equal(r.json.dns.type, 'TXT');
    assert.equal(r.json.dns.value, `vmapp-publisher=${r.json.token}`);
  }
  const dtoken = (await call(s.url, '/api/publisher/me', { token })).json.pendingDomain.token;
  const want = `vmapp-publisher=${dtoken}`;
  const check = () => post('check-domain');

  // failures: nothing served, wrong content, extra content, redirect, too big, never answers
  assert.equal((await check()).status, 422);
  web.handler = serve('vmapp-publisher=deadbeef');
  assert.equal((await check()).status, 422);
  web.handler = serve(`${want}\nsomething else\n`);
  assert.equal((await check()).status, 422, 'the content must be exactly the token line');
  web.handler = serve(`${want}${' '.repeat(5000)}`);
  const big = await check();
  assert.equal(big.status, 422);
  assert.match(big.json.error.message, /larger than 4096/);
  web.handler = (req, res) => {
    if (req.url.startsWith('/.well-known/')) {
      res.writeHead(302, { Location: '/elsewhere' });
      return res.end();
    }
    return serve(want)(req, res);
  };
  const redir = await check();
  assert.equal(redir.status, 422);
  assert.match(redir.json.error.message, /redirect/);
  web.handler = () => {};
  const t0 = Date.now();
  assert.equal((await check()).status, 422);
  assert.ok(Date.now() - t0 < 5000, 'a silent server is cut off by the timeout');
  assert.equal((await call(s.url, '/api/apps')).json.items[0].publisher.level, 'unverified');

  // success (trailing newline is fine)
  web.handler = serve(want + '\n');
  const ok = await check();
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.method, 'file');

  // display: verified domain + company; the url is hidden because its host is not on the domain; never the person's name
  const view = (await call(s.url, '/api/apps')).json.items[0].publisher;
  assert.deepEqual(view, { level: 'domain', label: `Verified: ${domain}`, domain, company: 'Acme Widgets' });
  for (const text of await publicTexts(s.url, ['com.example.alpha'])) {
    for (const secret of ['Jane', 'jane@', 'acme.test', MANIFEST_PUBLISHER]) {
      if (secret === MANIFEST_PUBLISHER && text.includes('claimedPublisher')) continue;
      assert.ok(!text.includes(secret), `public response leaks ${secret}`);
    }
  }
  assert.equal((await call(s.url, '/api/apps?q=widgets')).json.total, 1, 'the verified company is searchable');
  assert.equal((await call(s.url, '/api/apps?q=jane')).json.total, 0);

  // the url is shown once its host is on the verified domain (or a subdomain)
  for (const [url, shown] of [['https://127.0.0.1/apps', true], ['https://evil.com/127.0.0.1', false], ['https://x127.0.0.1/', false], ['http://127.0.0.1:9/', true]]) {
    await post('profile', { company: 'Acme Widgets', url });
    const v = (await call(s.url, '/api/apps')).json.items[0].publisher;
    assert.equal(v.url, shown ? url : undefined, url);
    assert.equal(v.level, 'domain', 'changing the url keeps the domain proof');
  }

  // a domain belongs to one publisher
  const b = buildPackage(w, 'b', { id: 'com.example.beta', name: 'Beta' });
  const tokenB = (await publish(s.url, b.file, { profile: { company: 'Other Co', url: 'https://www.localhost/x' } })).json.ownerToken;
  assert.equal((await post('verify-domain', { domain }, tokenB)).status, 409);
});

test('domain level: subdomain urls, DNS TXT, one publisher per domain', async (t) => {
  const s = await setup(t);
  const web = await webServer(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const domain = `localhost:${web.port}`;
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  const token = (await publish(s.url, a.file, { profile: { name: 'Pat', company: 'Local Co', url: 'https://docs.localhost/start' } })).json.ownerToken;
  const post = (p, body) => call(s.url, `/api/publisher/${p}`, { method: 'POST', token, json: body || {} });
  const started = await post('verify-domain', { domain: domain.toUpperCase() });
  assert.equal(started.json.domain, domain, 'domains are lower-cased');

  // nothing on the web server, nothing in DNS
  s.dns.length = 0;
  assert.equal((await post('check-domain')).status, 422);
  // DNS: TXT value split across chunks is joined; a record for another token does not count
  s.dns.push(['vmapp-publisher=nope']);
  assert.equal((await post('check-domain')).status, 422);
  s.dns.push(['vmapp-publisher=', started.json.token]);
  const ok = await post('check-domain');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.method, 'dns');
  const v = (await call(s.url, '/api/apps')).json.items[0].publisher;
  assert.deepEqual(v, { level: 'domain', label: `Verified: ${domain}`, domain, company: 'Local Co', url: 'https://docs.localhost/start' });
  assert.ok(!JSON.stringify(v).includes('Pat'), 'the person name is never shown');
  // there is nothing pending any more
  assert.equal((await post('check-domain')).status, 400);
  // me: the owner sees status, never the secret token hash
  const me = (await call(s.url, '/api/publisher/me', { token })).json;
  assert.equal(me.domainVerified, true);
  assert.deepEqual(me.apps, ['com.example.alpha']);
  assert.ok(!JSON.stringify(me).includes('tokenHash'));
});

test('apps of one publisher share its identity; tokens cannot cross publishers', async (t) => {
  const s = await setup(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  const b = buildPackage(w, 'b', { id: 'com.example.beta', name: 'Beta' });
  const c = buildPackage(w, 'c', { id: 'com.example.gamma', name: 'Gamma' });
  const b2 = buildPackage(w, 'b2', { id: 'com.example.beta', name: 'Beta', version: '1.1.0' });
  const t1 = (await publish(s.url, a.file, { profile: CLAIMED })).json.ownerToken;

  // a new id with the same token joins the publisher (no new token is issued; a profile in the request is ignored)
  let r = await publish(s.url, b.file, { token: t1, profile: { name: 'Mallory', email: 'm@evil.test' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.ownerToken, undefined);
  assert.equal(r.json.created, true);
  assert.equal((await call(s.url, '/api/publisher/me', { token: t1 })).json.profile.name, 'Jane Doe');
  assert.deepEqual((await call(s.url, '/api/publisher/me', { token: t1 })).json.apps.sort(), ['com.example.alpha', 'com.example.beta']);

  // verifying the email once covers both apps
  await call(s.url, '/api/publisher/verify-email', { method: 'POST', token: t1 });
  await call(s.url, '/api/publisher/confirm-email', { method: 'POST', json: { code: codeOf(s.mails[0]) } });
  const labels = (await call(s.url, '/api/apps')).json.items.map((i) => i.publisher.label);
  assert.deepEqual(labels, ['Verified email @acme.test', 'Verified email @acme.test']);

  // an unknown token for a new id is refused (not silently turned into a new publisher)
  r = await publish(s.url, c.file, { token: crypto.randomBytes(32).toString('hex') });
  assert.equal(r.status, 403);
  // another publisher's token cannot publish a version of this one's app
  const other = buildPackage(w, 'o', { id: 'com.example.other', name: 'Other' });
  const t2 = (await publish(s.url, other.file)).json.ownerToken;
  r = await publish(s.url, b2.file, { token: t2 });
  assert.equal(r.status, 403);
  assert.equal((await publish(s.url, b2.file, { token: t1 })).status, 201);
  // and the other publisher is still unverified
  const items = (await call(s.url, '/api/apps')).json.items;
  assert.equal(items.find((i) => i.id === 'com.example.other').publisher.level, 'unverified');
});

test('domain checks without the dev flag: https only, public addresses only', async (t) => {
  const s = await startRegistry({ mailer: { send: async () => {} }, domainTimeoutMs: 1500 });
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
  });
  const web = await webServer(t);
  const w = tmpdir('pkg-');
  t.after(() => rmrf(w));
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  const post = (p, body) => call(s.url, `/api/publisher/${p}`, { method: 'POST', token, json: body || {} });

  // no ports, no plain-http hosts, no IPs, no localhost: those are dev-only
  for (const d of [`localhost:${web.port}`, `127.0.0.1:${web.port}`, '127.0.0.1', 'localhost', `example.com:${web.port}`, '[::1]']) {
    assert.equal((await post('verify-domain', { domain: d })).status, 400, d);
  }
  // an ordinary name is accepted and the instructions say https
  const r = await post('verify-domain', { domain: 'Vmapp-Test.INVALID' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.file.url, 'https://vmapp-test.invalid/.well-known/vmapp-publisher.txt');
  // the check goes out over https/DNS only and fails closed (".invalid" never resolves)
  const hitsBefore = web.hits;
  const c = await post('check-domain');
  assert.equal(c.status, 422);
  assert.equal(web.hits, hitsBefore);
  assert.equal((await call(s.url, '/api/apps')).json.items[0].publisher.level, 'unverified');

  // addresses that must never be fetched by the server
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
});

test('the web pages for identity exist and use no inline script', async (t) => {
  const s = await setup(t);
  for (const p of ['/verify?code=abc', '/publisher']) {
    const r = await call(s.url, p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(r.text), `${p} has an inline script`);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
  // opening the link does not confirm anything: confirmation is a POST
  assert.equal((await call(s.url, '/api/publisher/confirm-email')).status, 405);
});
