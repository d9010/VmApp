'use strict';
// Publisher identity: profile validation, verification levels, what may be shown publicly, the dev mailer and the
// domain check (well-known file over HTTPS, or a DNS TXT record).
//
// Levels: "unverified" (default) -> "email" -> "domain". Display rule (the owner's requirement): only verified
// facts are shown. Everything a publisher merely claims (name, company, url, email, the manifest's `publisher`
// string) stays hidden until it is backed by a verification.

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL_RE = /^[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const DEV_DOMAIN_RE = /^([a-z0-9.-]{1,253})(:\d{1,5})?$/;
const WELL_KNOWN = '/.well-known/vmapp-publisher.txt';

class ProfileError extends Error {}

function text(v, field, max, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ProfileError(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new ProfileError(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw new ProfileError(`${field} is required`);
  if (s.length > max) throw new ProfileError(`${field} is longer than ${max} characters`);
  if (CONTROL.test(s)) throw new ProfileError(`${field} must not contain control characters`);
  return s;
}

/** Validates the profile a publisher claims. All fields are optional; email must look like an address. */
function parseProfile(raw) {
  if (raw === undefined || raw === null) return { name: '', company: '', email: '', url: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('publisher profile must be a JSON object');
  const unknown = Object.keys(raw).filter((k) => !['name', 'company', 'email', 'url'].includes(k));
  if (unknown.length) throw new ProfileError(`unknown publisher field "${unknown[0]}"`);
  const p = {
    name: text(raw.name, 'name', 100),
    company: text(raw.company, 'company', 100),
    email: text(raw.email, 'email', 200).toLowerCase(),
    url: text(raw.url, 'url', 200),
  };
  if (p.email && !EMAIL_RE.test(p.email)) throw new ProfileError('email does not look like an email address');
  if (p.url) {
    let u;
    try {
      u = new URL(p.url);
    } catch {
      throw new ProfileError('url is not a valid URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ProfileError('url must start with https:// or http://');
  }
  return p;
}

/** Parses the X-Vmapp-Publisher header: JSON {name, company?, email?, url?} (non-ASCII as \uXXXX escapes). */
function parseProfileHeader(value) {
  if (value === undefined) return null;
  let raw;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ProfileError('X-Vmapp-Publisher must be a JSON object');
  }
  return parseProfile(raw);
}

/** Header-safe JSON (ASCII only), for clients. */
function encodeProfileHeader(profile) {
  return JSON.stringify(profile).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const emailDomain = (email) => (email ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : '');
const hostOf = (domain) => domain.replace(/:\d+$/, '');

function normalizeDomain(input, dev) {
  if (typeof input !== 'string') throw new ProfileError('domain must be a string');
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  let ok = DOMAIN_RE.test(d);
  if (!ok && dev) {
    // tests only: localhost and IPv4 hosts, with an optional port
    const m = DEV_DOMAIN_RE.exec(d);
    ok = !!m && (m[1] === 'localhost' || DOMAIN_RE.test(m[1]) || /^(\d{1,3}\.){3}\d{1,3}$/.test(m[1]));
    if (ok && m[2] && Number(m[2].slice(1)) > 65535) ok = false;
  }
  if (!ok) throw new ProfileError('domain must be a host name such as example.com (no scheme, path or port)');
  return d;
}

/** The part of a publisher that may be shown publicly. Unverified: nothing but the fact that it is unverified. */
function publicView(pub) {
  if (pub && pub.domain && pub.domain.name) {
    const host = hostOf(pub.domain.name);
    const view = { level: 'domain', label: `Verified: ${pub.domain.name}`, domain: pub.domain.name };
    if (pub.company) view.company = pub.company;
    if (pub.url) {
      try {
        const u = new URL(pub.url);
        if (u.hostname === host || u.hostname.endsWith('.' + host)) view.url = pub.url;
      } catch {
        /* not shown */
      }
    }
    return view;
  }
  if (pub && pub.emailVerified && pub.emailVerified.email) {
    const d = emailDomain(pub.emailVerified.email);
    return { level: 'email', label: `Verified email @${d}`, emailDomain: d };
  }
  return { level: 'unverified', label: 'Unverified publisher' };
}

/** Text that search may match: only verified facts. */
function searchableText(pub) {
  const v = publicView(pub);
  return [v.domain, v.company, v.emailDomain].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------------------------------------ mail
/** The development mailer: writes each message to DATA/outbox/<timestamp>-<rand>.eml and logs the path. */
function devMailer(dataDir, log) {
  const dir = path.join(dataDir, 'outbox');
  return {
    async send({ to, subject, text: body }) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${crypto.randomBytes(3).toString('hex')}.eml`);
      const msg = `From: vmapp-registry@localhost\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
      fs.writeFileSync(file, msg, { mode: 0o600 });
      log(`mail: "${subject}" to @${emailDomain(to)} written to ${file}`);
      return { file };
    },
  };
}

// ------------------------------------------------------------------------------------------------ domain check
const PRIVATE = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) PRIVATE.addSubnet(a, n, 'ipv6');

function isPublicIp(addr) {
  const fam = net.isIP(addr);
  if (!fam) return false;
  return !PRIVATE.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

/** dns.lookup that refuses private, loopback and link-local addresses (the server must not be a proxy into the LAN). */
function publicOnlyLookup(hostname, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some((a) => !isPublicIp(a.address))) return cb(new Error('the host resolves to a non-public address'));
    cb(null, address, family);
  });
}

const withDeadline = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t));
};

function fetchWellKnown(domain, { dev, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const url = `${dev ? 'http' : 'https'}://${domain}${WELL_KNOWN}`;
    const mod = dev ? http : https;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const req = mod.get(url, { timeout: timeoutMs, lookup: dev ? undefined : publicOnlyLookup, headers: { 'User-Agent': 'vmapp-registry-verify', Accept: 'text/plain' }, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error(res.statusCode >= 300 && res.statusCode < 400 ? 'the well-known file redirects (redirects are not followed)' : `the well-known file answered HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          return finish(new Error(`the well-known file is larger than ${maxBytes} bytes`));
        }
        chunks.push(c);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', (e) => finish(e));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error('the well-known file request timed out'));
    }, timeoutMs);
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => finish(new Error(`could not fetch the well-known file: ${e.message}`)));
  });
}

/**
 * Checks that `domain` proves the token: the file https://<domain>/.well-known/vmapp-publisher.txt must contain exactly
 * `vmapp-publisher=<token>`, or _vmapp.<domain> must have a TXT record with that value. Returns { ok, method?, reason? }.
 */
async function checkDomain(domain, token, opts) {
  const want = `vmapp-publisher=${token}`;
  const problems = [];
  try {
    const body = await fetchWellKnown(domain, opts);
    if (body.trim() === want) return { ok: true, method: 'file' };
    problems.push('the well-known file does not contain the expected line');
  } catch (e) {
    problems.push(e.message);
  }
  if (opts.resolveTxt || !opts.dev) {
    try {
      const records = await withDeadline((opts.resolveTxt || dns.promises.resolveTxt)(`_vmapp.${hostOf(domain)}`), opts.timeoutMs, 'the DNS lookup');
      if (records.some((chunks) => chunks.join('') === want)) return { ok: true, method: 'dns' };
      problems.push('no matching TXT record on _vmapp.' + hostOf(domain));
    } catch (e) {
      problems.push(`DNS TXT lookup failed (${e.code || e.message})`);
    }
  }
  return { ok: false, reason: problems.join('; ') };
}

module.exports = {
  ProfileError,
  parseProfile,
  parseProfileHeader,
  encodeProfileHeader,
  normalizeDomain,
  emailDomain,
  hostOf,
  publicView,
  searchableText,
  devMailer,
  checkDomain,
  isPublicIp,
  WELL_KNOWN,
};
