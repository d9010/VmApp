'use strict';
// Open extension signature verifier (DEV-APPS §11 step 15). The server loads it through patch 0008: core/main.js sets
// VSCODE_SIGNATURE_VERIFIER=/app/sigverify.js for the VS Code server.
//
// Verifies a marketplace .vsix against its signature archive (.sigzip) with Node's built-ins only
// (crypto, zlib), in place of Microsoft's closed `@vscode/vsce-sign` binary, whose licence limits it to
// Microsoft's own products. The result has the shape `@vscode/vsce-sign`'s verify() resolves to
// ({ code, didExecute, output }), `code` being a VS Code ExtensionSignatureVerificationCode name.
//
// Two archive kinds exist:
//   Open VSX:  .signature.sig (64-byte raw Ed25519 signature over the whole .vsix file), .signature.manifest
//              (file digests, not signed itself), .signature.p7s (empty, only so VS Code accepts the archive).
//              Key: the registry's Ed25519 public key (API `files.publicKey`, gallery asset
//              Microsoft.VisualStudio.Services.PublicKey). The one key seen on all versions checked is pinned below.
//   Microsoft: .signature.manifest + .signature.p7s, a detached CMS SignedData over the manifest
//              (RSA PKCS#1 v1.5 / SHA-256, signer "Microsoft Corporation, OU=Visual Studio Marketplace",
//              DigiCert Trusted G4 Code Signing CA1 -> DigiCert Trusted Root G4). Only the signature and the
//              chain to a root in Node's store are checked here, with certificates valid NOW: the RFC 3161
//              timestamp and revocation are not checked yet, so a signature whose leaf has expired is reported as
//              not verified (UnknownError, didExecute false: VS Code asks the user), after the package digests matched.
//
// CLI: node sigverify.js <file.vsix> <file.sigzip> [publicKey.pem]   (exit 0 only on Success)

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const tls = require('tls');

// Open VSX registry signing key 14ccb407-4e79-41ed-be5a-6d608325c45a (https://open-vsx.org/api/-/public-key/<id>).
const OPEN_VSX_KEYS = {
  '14ccb407-4e79-41ed-be5a-6d608325c45a':
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAje+vAaSS1zHV5WHCJSa5UXvxRo6+yerEU3IEmtuEuF4=\n-----END PUBLIC KEY-----\n',
};

const MAX_SIG_ENTRIES = 10;

class VerifyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---- ZIP (stored/deflate, no ZIP64, no encryption) ----

function readZip(buf, badCode) {
  const fail = (m) => { throw new VerifyError(badCode, m); };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) fail('ZIP64 is not supported');
  if (cdOff + cdSize > eocd) fail('central directory out of range');
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    if (flags & 1) fail('encrypted entry ' + name);
    if (entries.has(name)) fail('duplicate entry ' + name);
    entries.set(name, { name, method, compSize, size, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  function read(e) {
    const lo = e.localOff;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) fail('bad local header ' + e.name);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (start + e.compSize > buf.length) fail('entry out of range ' + e.name);
    const raw = buf.subarray(start, start + e.compSize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) }); } catch (x) { fail('inflate failed ' + e.name); }
    } else fail('unsupported compression ' + e.method + ' in ' + e.name);
    if (data.length !== e.size) fail('size mismatch ' + e.name);
    return data;
  }
  return { entries, read };
}

// ---- manifest (.signature.manifest): {package:{size,digests:{sha256}}, entries:{b64(name):{size,digests:{sha256}}}} ----

const sha256b64 = (b) => crypto.createHash('sha256').update(b).digest('base64');

function checkManifest(manifestBuf, vsixBuf, vsix) {
  let m;
  try { m = JSON.parse(manifestBuf.toString('utf8')); } catch (e) { throw new VerifyError('SignatureManifestIsUnreadable', 'manifest is not JSON'); }
  if (!m || !m.package || !m.package.digests || !m.entries) throw new VerifyError('SignatureManifestIsInvalid', 'manifest lacks package/entries');
  if (m.package.size !== vsixBuf.length || m.package.digests.sha256 !== sha256b64(vsixBuf)) {
    throw new VerifyError('PackageIntegrityCheckFailed', 'package size/sha256 differ from the manifest');
  }
  const listed = new Set();
  for (const [b64, info] of Object.entries(m.entries)) {
    const name = Buffer.from(b64, 'base64').toString('utf8');
    listed.add(name);
    const e = vsix.entries.get(name);
    if (!e) throw new VerifyError('EntryIsMissing', 'missing entry ' + name);
    const data = vsix.read(e);
    if (data.length !== info.size || !info.digests || data.length !== e.size || sha256b64(data) !== info.digests.sha256) {
      throw new VerifyError('EntryIsTampered', 'entry digest differs: ' + name);
    }
  }
  for (const name of vsix.entries.keys()) {
    if (!name.endsWith('/') && !listed.has(name)) throw new VerifyError('EntryIsTampered', 'entry not in manifest: ' + name);
  }
  return Object.keys(m.entries).length;
}

// ---- Open VSX: Ed25519 over the .vsix bytes ----

function verifyOpenVsx(vsixBuf, sig, keyPems) {
  if (sig.length !== 64) throw new VerifyError('SignatureIsUnreadable', '.signature.sig is not a 64-byte Ed25519 signature');
  for (const [id, pem] of Object.entries(keyPems)) {
    let ok = false;
    try { ok = crypto.verify(null, vsixBuf, crypto.createPublicKey(pem), sig); } catch (e) { ok = false; }
    if (ok) return id;
  }
  throw new VerifyError('SignatureIsInvalid', 'Ed25519 signature does not verify with any trusted Open VSX key');
}

// ---- Microsoft: detached CMS SignedData over the manifest (minimal DER reader) ----

function der(buf, off) {
  if (off + 2 > buf.length) throw new VerifyError('SignatureIsUnreadable', 'truncated DER');
  const tag = buf[off]; let len = buf[off + 1], hl = 2;
  if (len & 0x80) {
    const n = len & 0x7f; if (n < 1 || n > 4) throw new VerifyError('SignatureIsUnreadable', 'bad DER length');
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i]; hl = 2 + n;
  }
  const end = off + hl + len;
  if (end > buf.length) throw new VerifyError('SignatureIsUnreadable', 'DER out of range');
  return { tag, start: off, cs: off + hl, end };
}
function derKids(buf, n) { const out = []; for (let o = n.cs; o < n.end;) { const k = der(buf, o); out.push(k); o = k.end; } return out; }
const OID_DATA = '2a864886f70d010701', OID_SIGNED_DATA = '2a864886f70d010702', OID_MD = '2a864886f70d010904', OID_SHA256 = '608648016503040201';
const OID_RSA = '2a864886f70d010101', OID_SHA256_RSA = '2a864886f70d01010b';

function verifyMicrosoftCms(p7, content, now) {
  const hex = (n) => p7.subarray(n.cs, n.end).toString('hex');
  const ci = derKids(p7, der(p7, 0));
  if (hex(ci[0]) !== OID_SIGNED_DATA) throw new VerifyError('SignatureIsUnreadable', 'not CMS SignedData');
  const sd = derKids(p7, derKids(p7, ci[1])[0]);
  const encap = derKids(p7, sd[2]);
  if (hex(encap[0]) !== OID_DATA || encap.length > 1) throw new VerifyError('SignatureIsInvalid', 'expected detached id-data content');
  const certsNode = sd.find((k) => k.tag === 0xa0);
  if (!certsNode) throw new VerifyError('CertificateIsUnreadable', 'no certificates');
  let certs;
  try { certs = derKids(p7, certsNode).map((c) => new crypto.X509Certificate(p7.subarray(c.start, c.end))); } catch (e) { throw new VerifyError('CertificateIsUnreadable', e.message); }
  const infos = derKids(p7, sd[sd.length - 1]);
  if (infos.length !== 1) throw new VerifyError('SignatureIsInvalid', 'expected exactly one signer');
  const si = derKids(p7, infos[0]);
  const digestAlg = hex(derKids(p7, si[2])[0]);
  const signedAttrs = si[3];
  const sigAlg = hex(derKids(p7, si[4])[0]);
  const sig = p7.subarray(si[5].cs, si[5].end);
  if (signedAttrs.tag !== 0xa0 || digestAlg !== OID_SHA256 || (sigAlg !== OID_RSA && sigAlg !== OID_SHA256_RSA)) {
    throw new VerifyError('SignatureIsInvalid', 'unsupported signer algorithms');
  }
  // signer certificate by subjectKeyIdentifier ([0]) or issuerAndSerialNumber (SEQUENCE)
  let leaf;
  if (si[1].tag === 0x80) {
    const ski = hex(si[1]);
    leaf = certs.find((c) => skiOf(c) === ski);
  } else {
    const serial = hex(derKids(p7, si[1])[1]).replace(/^00/, '').toUpperCase();
    leaf = certs.find((c) => c.serialNumber.replace(/^00/, '').toUpperCase() === serial);
  }
  if (!leaf) throw new VerifyError('CertificateIsUnreadable', 'signer certificate not found');
  // only the marketplace's own signing identity (else any holder of a publicly trusted code signing cert could sign)
  const subj = leaf.subject.split('\n');
  if (!subj.includes('O=Microsoft Corporation') || !subj.includes('OU=Visual Studio Marketplace')) {
    throw new VerifyError('Untrusted', 'signer is not the Visual Studio Marketplace: ' + subj.join(', '));
  }
  // content digest
  let md;
  const attrs = derKids(p7, signedAttrs);
  for (const a of attrs) { const [oid, vals] = derKids(p7, a); if (hex(oid) === OID_MD) md = p7.subarray(derKids(p7, vals)[0].cs, derKids(p7, vals)[0].end); }
  if (!md || !md.equals(crypto.createHash('sha256').update(content).digest())) {
    throw new VerifyError('SignatureManifestIsInvalid', 'manifest digest differs from the signed messageDigest');
  }
  // the signature covers the DER encoding of the attributes as a SET OF (sorted); the archive stores them unsorted
  const body = Buffer.concat(attrs.map((a) => p7.subarray(a.start, a.end)).sort(Buffer.compare));
  const hdr = Buffer.from(p7.subarray(signedAttrs.start, signedAttrs.cs)); hdr[0] = 0x31;
  const tbs = Buffer.concat([hdr, body]);
  const asStored = Buffer.from(p7.subarray(signedAttrs.start, signedAttrs.end)); asStored[0] = 0x31;
  if (!crypto.verify('sha256', tbs, leaf.publicKey, sig) && !crypto.verify('sha256', asStored, leaf.publicKey, sig)) {
    throw new VerifyError('SignatureIsInvalid', 'CMS signature does not verify');
  }
  // chain to a root in Node's bundled store, every certificate valid at `now`
  const roots = tls.rootCertificates.map((p) => new crypto.X509Certificate(p));
  const valid = (c) => new Date(c.validFrom) <= now && now <= new Date(c.validTo);
  let cur = leaf;
  for (let depth = 0; depth < 6; depth++) {
    // an expired certificate is fine if the signature was timestamped while it was valid; that check is not built yet, so this is
    // "cannot verify here", not "invalid": VS Code then asks the user, as it does without a verifier
    if (!valid(cur)) throw new VerifyError('NotVerifiable', 'certificate not valid now, and the RFC 3161 timestamp is not checked yet: ' + cur.subject.replace(/\n/g, ', ') + ' until ' + cur.validTo);
    const root = roots.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) {
      if (!valid(root)) throw new VerifyError('Untrusted', 'root not valid now');
      return { signer: subj.join(', '), root: root.subject.split('\n').pop() };
    }
    const issuer = certs.find((c) => c !== cur && cur.checkIssued(c) && cur.verify(c.publicKey) && c.ca);
    if (!issuer) throw new VerifyError('Untrusted', 'no chain to a trusted root');
    cur = issuer;
  }
  throw new VerifyError('Untrusted', 'chain too long');
}

function skiOf(cert) {
  // X509Certificate has no SKI accessor: find extension 2.5.29.14 in the raw DER
  const raw = cert.raw; const oid = Buffer.from('0603551d0e', 'hex');
  const i = raw.indexOf(oid); if (i < 0) return '';
  let o = i + oid.length; let n = der(raw, o); if (n.tag === 0x01) { o = n.end; n = der(raw, o); }
  const inner = der(raw, n.cs); return raw.subarray(inner.cs, inner.end).toString('hex');
}

// ---- entry point, shaped like @vscode/vsce-sign verify() ----

function verifyBuffers(vsixBuf, sigzipBuf, opts) {
  const o = opts || {};
  const log = [];
  try {
    const sigz = readZip(sigzipBuf, 'SignatureArchiveIsInvalidZip');
    if (sigz.entries.size > MAX_SIG_ENTRIES) throw new VerifyError('SignatureArchiveHasTooManyEntries', sigz.entries.size + ' entries');
    const vsix = readZip(vsixBuf, 'PackageIsInvalidZip');
    const get = (n) => { const e = sigz.entries.get(n); return e ? sigz.read(e) : undefined; };
    const manifest = get('.signature.manifest');
    if (!manifest) throw new VerifyError('SignatureManifestIsMissing', 'no .signature.manifest');
    const edSig = get('.signature.sig');
    const p7s = get('.signature.p7s');
    if (edSig) {
      const keys = o.publicKeyPem ? { given: o.publicKeyPem } : OPEN_VSX_KEYS;
      const keyId = verifyOpenVsx(vsixBuf, edSig, keys);
      log.push('Open VSX Ed25519 signature over the package verified with key ' + keyId);
    } else if (p7s && p7s.length) {
      let r;
      try {
        r = verifyMicrosoftCms(p7s, manifest, o.now || new Date());
      } catch (e) {
        if (!(e instanceof VerifyError) || e.code !== 'NotVerifiable') throw e;
        // the CMS signature itself verified; only the certificate time is open: still refuse a package that does not match the
        // signed manifest, then report "not executed" (VS Code: "cannot verify the extension signature", the user decides)
        const n = checkManifest(manifest, vsixBuf, vsix);
        return { code: 'UnknownError', didExecute: false, output: log.concat(e.message, 'manifest: package digest and ' + n + ' entry digests match').join('\n') };
      }
      log.push('CMS signature over the manifest verified; signer ' + r.signer + '; root ' + r.root);
    } else {
      throw new VerifyError('SignatureIsMissing', 'neither .signature.sig nor a non-empty .signature.p7s');
    }
    const n = checkManifest(manifest, vsixBuf, vsix);
    log.push('manifest: package digest and ' + n + ' entry digests match');
    return { code: 'Success', didExecute: true, output: log.join('\n') };
  } catch (e) {
    if (e instanceof VerifyError) return { code: e.code, didExecute: true, output: log.concat(e.message).join('\n') };
    return { code: 'UnhandledException', didExecute: true, output: String(e && e.stack || e) };
  }
}

async function verify(vsixFilePath, signatureArchiveFilePath, verbose, opts) {
  if (!vsixFilePath || !signatureArchiveFilePath) return { code: 'RequiredArgumentMissing', didExecute: false };
  let vsixBuf, sigBuf;
  try { vsixBuf = await fs.promises.readFile(vsixFilePath); } catch (e) { return { code: 'PackageIsUnreadable', didExecute: true, output: e.message }; }
  try { sigBuf = await fs.promises.readFile(signatureArchiveFilePath); } catch (e) { return { code: 'SignatureArchiveIsUnreadable', didExecute: true, output: e.message }; }
  return verifyBuffers(vsixBuf, sigBuf, opts);
}

module.exports = { verify, verifyBuffers, OPEN_VSX_KEYS };

if (require.main === module) {
  const [vsixPath, sigPath, keyPath] = process.argv.slice(2);
  const opts = keyPath ? { publicKeyPem: fs.readFileSync(keyPath, 'utf8') } : {};
  verify(vsixPath, sigPath, true, opts).then((r) => {
    process.stdout.write(r.code + '\n' + (r.output ? r.output + '\n' : ''));
    process.exit(r.code === 'Success' ? 0 : 1);
  });
}
