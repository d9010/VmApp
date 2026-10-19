'use strict';
// Pictures, fonts and media from the core (sdk/web/vmapp-fetch.js "Pictures, fonts and media"): the parts that need no browser. The
// browser half (every place a page can show a picture, with the window's real CSP) is tests/apps/media-probe.mjs, in a real VM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { media } = require('../../sdk/web/vmapp-fetch.js');

const B = (...a) => Uint8Array.from(a);
const text = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const ORIGIN = 'vmapp-ui://app';
// "bridged" for these tests: the page's own origin under /api/ or /assets/
const absolute = (raw) => {
  let u;
  try {
    u = new URL(raw, `${ORIGIN}/index.html`);
  } catch {
    return '';
  }
  return u.protocol === 'vmapp-ui:' && u.hostname === 'app' && /^\/(api|assets)\//.test(u.pathname) ? u.href : '';
};
const lookupOf = (map) => (u) => (u in map ? map[u] : undefined);

test('sniff: the first bytes name the type of a file, whatever the server said', () => {
  assert.equal(media.sniff(B(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(media.sniff(B(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), 'image/jpeg');
  assert.equal(media.sniff(text('GIF89a....')), 'image/gif');
  assert.equal(media.sniff(text('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(media.sniff(text('RIFF\0\0\0\0WAVEfmt ')), 'audio/wav');
  assert.equal(media.sniff(B(0x42, 0x4d, ...new Array(20).fill(0))), 'image/bmp');
  assert.equal(media.sniff(B(0, 0, 1, 0, 1, 0)), 'image/x-icon');
  assert.equal(media.sniff(text('wOF2....')), 'font/woff2');
  assert.equal(media.sniff(text('wOFF....')), 'font/woff');
  assert.equal(media.sniff(text('OTTO....')), 'font/otf');
  assert.equal(media.sniff(B(0, 1, 0, 0, 0, 12)), 'font/ttf');
  assert.equal(media.sniff(text('OggS....')), 'audio/ogg');
  assert.equal(media.sniff(text('ID3\x04....')), 'audio/mpeg');
  assert.equal(media.sniff(text('\0\0\0\x18ftypmp42')), 'video/mp4');
  assert.equal(media.sniff(text('\0\0\0\x1cftypavif')), 'image/avif');
  assert.equal(media.sniff(B(0x1a, 0x45, 0xdf, 0xa3, 0x9f)), 'video/webm');
  assert.equal(media.sniff(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(media.sniff(text('<?xml version="1.0"?>\n<!-- c -->\n<svg width="1"/>')), 'image/svg+xml');
  assert.equal(media.sniff(text('﻿  <svg/>')), '', 'a byte order mark in a latin1 reading is not a type: the extension decides');
  assert.equal(media.sniff(text('<html><body>not a picture</body></html>')), '');
  assert.equal(media.sniff(text('{"json": true}')), '');
  assert.equal(media.sniff(B(1, 2)), '');
  assert.equal(media.sniff(null), '');
});

test('kindOf: which kinds of file a type is', () => {
  for (const [mime, kind] of [
    ['image/png', 'image'], ['IMAGE/SVG+XML', 'image'], ['font/woff2', 'font'], ['application/font-woff', 'font'], ['application/x-font-ttf', 'font'],
    ['application/vnd.ms-fontobject', 'font'], ['audio/mpeg', 'audio'], ['video/mp4', 'video'], ['application/ogg', 'video'], ['text/css', 'css'],
    ['application/octet-stream', ''], ['text/plain', ''], ['', ''], [undefined, ''],
  ]) assert.equal(media.kindOf(mime), kind, String(mime));
});

test('resolveMime: a specific server type wins; a generic or missing one is replaced by the bytes, then by the extension', () => {
  const png = B(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0);
  assert.equal(media.resolveMime('image/png; charset=binary', '/a/b', png), 'image/png');
  assert.equal(media.resolveMime('image/jpeg', '/a/b.png', png), 'image/jpeg', 'a specific type is trusted, even against the extension');
  assert.equal(media.resolveMime('application/octet-stream', '/a/avatar', png), 'image/png', 'bytes beat nothing');
  assert.equal(media.resolveMime('', '/a/avatar', png), 'image/png');
  assert.equal(media.resolveMime(null, '/a/avatar', png), 'image/png');
  assert.equal(media.resolveMime('text/plain', '/a/logo.svg', text('<svg/>')), 'image/svg+xml', 'an SVG served as text');
  assert.equal(media.resolveMime('text/xml', '/a/logo', text('<?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(media.resolveMime('application/octet-stream', '/fonts/x.woff2', text('????')), 'font/woff2', 'the extension, when the bytes say nothing');
  assert.equal(media.resolveMime('', '/fonts/x.TTF?v=3', text('????')), 'font/ttf', 'case and a query string do not matter');
  assert.equal(media.resolveMime('application/octet-stream', '/a/blob', text('????')), '', 'nothing known');
  assert.equal(media.resolveMime('image/png', '/a/b.png', null), 'image/png');
  assert.equal(media.resolveMime('', '/a/clip.mp4', null), 'video/mp4');
});

test('rewriteCssUrls: every bridged url() in the forms CSS has, and nothing else', () => {
  const A = `${ORIGIN}/assets/a.png`;
  const F = `${ORIGIN}/assets/f.woff2`;
  const look = lookupOf({ [A]: 'data:image/png;base64,AAA', [F]: 'data:font/woff2;base64,BBB' });
  const css = [
    '.a { background: url(/assets/a.png) no-repeat; }',
    '.b { background-image: url("/assets/a.png"), url( \'/assets/a.png\' ); }',
    '@font-face { font-family: X; src: url(/assets/f.woff2) format("woff2"), url(/assets/f.woff2) format("woff"); }',
    '.c { mask: url(  "vmapp-ui://app/assets/a.png"  ) center; }',
    '.d { background: url(data:image/png;base64,ZZZ), url(https://example.com/x.png), url(/local/in-the-package.png); }',
    '.e { content: url(/api/not-loaded-yet.svg); }',
  ].join('\n');
  const r = media.rewriteCssUrls(css, look, absolute);
  assert.deepEqual(r.missing, [`${ORIGIN}/api/not-loaded-yet.svg`], 'one file is not loaded yet');
  assert.equal(r.text, css, 'nothing is replaced while a file is missing');
  const ok = media.rewriteCssUrls(css.replace('.e { content: url(/api/not-loaded-yet.svg); }', ''), look, absolute);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.failed, false);
  assert.match(ok.text, /\.a \{ background: url\("data:image\/png;base64,AAA"\) no-repeat; \}/);
  assert.match(ok.text, /\.b \{ background-image: url\("data:image\/png;base64,AAA"\), url\("data:image\/png;base64,AAA"\); \}/);
  assert.match(ok.text, /src: url\("data:font\/woff2;base64,BBB"\) format\("woff2"\), url\("data:font\/woff2;base64,BBB"\) format\("woff"\)/);
  assert.match(ok.text, /\.c \{ mask: url\("data:image\/png;base64,AAA"\) center; \}/);
  assert.match(ok.text, /url\(data:image\/png;base64,ZZZ\), url\(https:\/\/example\.com\/x\.png\), url\(\/local\/in-the-package\.png\)/, 'not the core\'s: untouched');
});

test('rewriteCssUrls: a file that could not be loaded stays as it was and says so; escapes in an address are understood', () => {
  const bad = `${ORIGIN}/assets/bad.png`;
  const r = media.rewriteCssUrls('.a { background: url(/assets/bad.png); }', lookupOf({ [bad]: null }), absolute);
  assert.equal(r.failed, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.text, '.a { background: url(/assets/bad.png); }');
  const spaced = `${ORIGIN}/assets/a b.png`;
  const e = media.rewriteCssUrls('.a { background: url("/assets/a\\ b.png"); }', lookupOf({ [spaced.replace(' ', '%20')]: 'data:image/png;base64,Q' }), absolute);
  assert.match(e.text, /url\("data:image\/png;base64,Q"\)/);
});

test('rewriteSrcset: candidates keep their descriptors; unknown or foreign addresses are left alone', () => {
  const A = `${ORIGIN}/assets/a.png`;
  const B2 = `${ORIGIN}/assets/a2.png`;
  const look = lookupOf({ [A]: 'data:image/png;base64,1', [B2]: 'blob:vmapp-ui://app/uuid' });
  const r = media.rewriteSrcset('/assets/a.png 1x, /assets/a2.png 2x, https://example.com/x.png 3x', look, absolute);
  assert.equal(r.text, 'data:image/png;base64,1 1x, blob:vmapp-ui://app/uuid 2x, https://example.com/x.png 3x');
  assert.deepEqual(r.missing, []);
  const m = media.rewriteSrcset('/assets/a.png 1x, /assets/new.png 2x', look, absolute);
  assert.deepEqual(m.missing, [`${ORIGIN}/assets/new.png`]);
  assert.equal(m.text, '/assets/a.png 1x, /assets/new.png 2x');
  const f = media.rewriteSrcset('/assets/a.png 1x, /assets/gone.png 2x', lookupOf({ [A]: 'data:image/png;base64,1', [`${ORIGIN}/assets/gone.png`]: null }), absolute);
  assert.equal(f.failed, true);
  assert.equal(f.text, 'data:image/png;base64,1 1x, /assets/gone.png 2x');
});

test('absolutizeCssUrls: a stylesheet that is inlined keeps its relative urls pointing at the right place', () => {
  const css = '@font-face { src: url(fonts/x.woff2); } .a { background: url("../img/a.png"); } .b { background: url(data:image/png;base64,Q); } .c { fill: url(#grad); }';
  const out = media.absolutizeCssUrls(css, `${ORIGIN}/assets/css/main.css`);
  assert.match(out, /url\("vmapp-ui:\/\/app\/assets\/css\/fonts\/x\.woff2"\)/);
  assert.match(out, /url\("vmapp-ui:\/\/app\/assets\/img\/a\.png"\)/);
  assert.match(out, /url\(data:image\/png;base64,Q\)/);
  assert.match(out, /url\(#grad\)/);
});

function fakeFetch(files) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const f = files[url];
    if (!f) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? f.type : null) }, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) };
  };
  fn.calls = calls;
  return fn;
}

test('the loader: data: for images and fonts, blob: for what is too big for an image and for audio and video, null when it cannot, once per file', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...new Array(40).fill(7)]);
  const files = {
    [`${ORIGIN}/assets/small.png`]: { type: 'image/png', bytes: png },
    [`${ORIGIN}/assets/octet`]: { type: 'application/octet-stream', bytes: png },
    [`${ORIGIN}/assets/big.png`]: { type: 'image/png', bytes: new Uint8Array(200) },
    [`${ORIGIN}/assets/big.woff2`]: { type: 'font/woff2', bytes: new Uint8Array(200) },
    [`${ORIGIN}/assets/clip.wav`]: { type: 'audio/wav', bytes: new Uint8Array(30) },
    [`${ORIGIN}/assets/huge.png`]: { type: 'image/png', bytes: new Uint8Array(5000) },
  };
  const f = fakeFetch(files);
  const warnings = [];
  const blobs = [];
  const loader = media.createMediaLoader({ fetch: f, maxDataBytes: 100, maxBlobBytes: 1000, warn: (m) => warnings.push(m), makeBlobUrl: (b) => (blobs.push(b), `blob:test/${blobs.length}`) });
  const get = (name) => loader.get(`${ORIGIN}/assets/${name}`);
  assert.equal(get('small.png'), undefined, 'not loaded yet');
  const [a, b, c, d, e, h, miss] = await Promise.all(['small.png', 'octet', 'big.png', 'big.woff2', 'clip.wav', 'huge.png', 'missing.png'].map((n) => loader.load(`${ORIGIN}/assets/${n}`)));
  assert.match(a, /^data:image\/png;base64,/);
  assert.match(b, /^data:image\/png;base64,/, 'an octet-stream picture is a PNG by its bytes');
  assert.equal(c, 'blob:test/1', 'an image above the data limit becomes a blob');
  assert.equal(d, null, 'a font above the data limit cannot (the CSP allows data: only)');
  assert.equal(e, 'blob:test/2', 'audio is a blob');
  assert.equal(h, null, 'above the blob limit');
  assert.equal(miss, null, 'a 404');
  assert.equal(blobs[0].type, 'image/png');
  assert.equal(blobs[1].type, 'audio/wav');
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
  assert.ok(warnings.some((w) => /big\.woff2 could not be shown \(font above/.test(w)));
  assert.ok(warnings.some((w) => /huge\.png.*larger than/.test(w)));
  assert.ok(warnings.some((w) => /missing\.png.*HTTP 404/.test(w)));
  // once per file: asking again (or at the same time) fetches nothing more, and says nothing more
  const before = f.calls.length;
  await Promise.all([loader.load(`${ORIGIN}/assets/small.png`), loader.load(`${ORIGIN}/assets/small.png`), loader.load(`${ORIGIN}/assets/missing.png`)]);
  assert.equal(f.calls.length, before);
  assert.equal(warnings.length, 3);
  assert.equal(get('small.png'), a);
  assert.equal(get('missing.png'), null);
});

test('the loader: two requests for a file that is on its way share one fetch', async () => {
  const f = fakeFetch({ [`${ORIGIN}/assets/a.png`]: { type: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) } });
  const loader = media.createMediaLoader({ fetch: f, warn() {}, makeBlobUrl: () => 'blob:x' });
  const [x, y] = await Promise.all([loader.load(`${ORIGIN}/assets/a.png`), loader.load(`${ORIGIN}/assets/a.png`)]);
  assert.equal(x, y);
  assert.equal(f.calls.length, 1);
});

test('the window\'s CSP is what this design relies on: data: for images and fonts, blob: for images and media, inline styles, no network', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'loader', 'src', 'protocols.js'), 'utf8');
  assert.match(src, /img-src 'self' data: blob:/, 'images: data: and blob:');
  assert.match(src, /media-src 'self' blob:/, 'audio and video: blob:');
  assert.match(src, /font-src 'self' data:/, 'fonts: data: (not blob:)');
  assert.match(src, /style-src 'self' 'unsafe-inline'/, 'a <style> made by the page is allowed');
  assert.match(src, /connect-src 'none'/, 'and the page has no network of its own');
  assert.match(src, /script-src 'self'/, 'so a bridged script cannot run: documented as not covered');
});

test('the script tag options: off, only some paths, the limits', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'sdk', 'web', 'vmapp-fetch.js'), 'utf8');
  for (const attr of ['data-media', 'data-media-max-data', 'data-media-max-blob']) assert.ok(src.includes(`'${attr}'`), attr);
});
