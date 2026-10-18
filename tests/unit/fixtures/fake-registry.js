'use strict';
// A tiny in-process stand-in for the registry's version API (SPEC 8.1), for tests of hostlib/updates.js and as a
// fallback for the loader's CDP test when the real registry lacks /resolve. Speaks only what the loader uses:
//   GET /api/apps/:id/versions   GET /api/apps/:id/resolve?choice=&from=   GET /api/apps/:id/:version/download
// and records every request (method, url, header names) in `log`, so tests can assert what the client sends.
// Faults for the tests: `noResolve` (404), `badResolve` (answers a fixed version), `tamper` (flips a byte of the body
// but keeps the honest headers), `lieAbout` (announces another package id), `omitHeaders`, `hang` (never answers).

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const pkg = require('../../../hostlib/package');
const { pickCandidate } = require('../../../hostlib/updates');

class FakeRegistry {
  constructor() {
    this.apps = new Map(); // id -> Map(version -> { buf, sha256, packageId, manifest, withdrawn })
    this.log = [];
    this.noResolve = false;
    this.badResolve = null;
    this.tamper = new Set();
    this.lieAbout = new Set();
    this.omitHeaders = false;
    this.hang = false;
    this.server = null;
    this.url = null;
  }

  publish(file, { withdrawn = null } = {}) {
    const buf = fs.readFileSync(file);
    const p = pkg.load(buf);
    const id = p.manifest.id;
    if (!this.apps.has(id)) this.apps.set(id, new Map());
    this.apps.get(id).set(p.manifest.version, {
      buf,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      packageId: p.packageId,
      manifest: p.manifest,
      withdrawn,
    });
    return p.manifest.version;
  }

  withdraw(id, version, reason) {
    this.apps.get(id).get(version).withdrawn = reason ? { reason, at: '2026-01-01T00:00:00.000Z' } : null;
  }

  list(id) {
    const m = this.apps.get(id);
    if (!m) return null;
    return [...m.entries()].map(([version, e]) => ({ version, packageId: e.packageId, sha256: e.sha256, size: e.buf.length, publishedAt: '2026-01-01T00:00:00.000Z', withdrawn: e.withdrawn }));
  }

  _handle(req, res) {
    const u = new URL(req.url, 'http://x');
    this.log.push({ method: req.method, url: req.url, headers: Object.keys(req.headers).sort() });
    if (this.hang) return; // never answer
    const json = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const err = (status, code, message) => json(status, { error: { code, message } });
    const m = /^\/api\/apps\/([^/]+)\/(versions|resolve|[^/]+\/download)$/.exec(u.pathname);
    if (!m) return err(404, 'not-found', 'no such route');
    const id = decodeURIComponent(m[1]);
    const list = this.list(id);
    if (!list) return err(404, 'not-found', `no app ${id}`);
    if (m[2] === 'versions') return json(200, list);
    if (m[2] === 'resolve') {
      if (this.noResolve) return err(404, 'not-found', 'no such route');
      if (this.badResolve) return json(200, { version: this.badResolve });
      const v = pickCandidate(list, u.searchParams.get('choice'), u.searchParams.get('from'));
      return json(200, { version: v });
    }
    const version = m[2].split('/')[0] === 'latest' ? list.filter((x) => !x.withdrawn).map((x) => x.version).sort((a, b) => require('../../../hostlib/manifest').compareVersions(a, b)).pop() : m[2].split('/')[0];
    const e = this.apps.get(id).get(version);
    if (!e) return err(404, 'not-found', `no ${id} ${version}`);
    let body = e.buf;
    if (this.tamper.has(version)) {
      body = Buffer.from(body);
      body[body.length - 700] ^= 0xff; // inside the data, not the padding at the end
    }
    const headers = { 'Content-Type': 'application/x-vmapp', 'Content-Length': body.length };
    if (!this.omitHeaders) {
      headers['X-Vmapp-Sha256'] = e.sha256;
      headers['X-Vmapp-Package-Id'] = this.lieAbout.has(version) ? 'f'.repeat(64) : e.packageId;
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${this.server.address().port}`;
        resolve(this.url);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { FakeRegistry };
