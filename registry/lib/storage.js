'use strict';
// Choosing the storage backend: configuration from the environment, and the store object it builds.
//
// Secrets (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN) are read from the environment only. There is no
// command-line flag for them, so they never show up in `ps`, shell history or a compose file.

const path = require('path');
const { LocalStore } = require('./store');
const { S3Client, S3Store } = require('./s3');

const truthy = (v, def) => {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};

/**
 * { storage: {type, ...}, publicDownloadBase } from environment variables (a plain object, normally process.env).
 *   REGISTRY_STORAGE        local (default) | s3
 *   REGISTRY_LOCAL_DIR      local backend: the directory (default <data dir>/store)
 *   S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN
 *   S3_PATH_STYLE           1 for R2 and MinIO (default: on when S3_ENDPOINT is set)
 *   S3_CONDITIONAL_PUT      0 only for an object store that rejects If-None-Match (default 1)
 *   PUBLIC_DOWNLOAD_BASE    https://dl.example.com : downloads redirect to <base>/blobs/sha256/<hh>/<sha256>.vmapp
 */
function configFromEnv(env = process.env) {
  const type = (env.REGISTRY_STORAGE || 'local').trim().toLowerCase();
  const cfg = { storage: { type }, publicDownloadBase: normaliseBase(env.PUBLIC_DOWNLOAD_BASE) };
  if (type === 'local') {
    if (env.REGISTRY_LOCAL_DIR) cfg.storage.dir = path.resolve(env.REGISTRY_LOCAL_DIR);
  } else if (type === 's3') {
    const need = (name) => {
      const v = env[name];
      if (!v || !String(v).trim()) throw new Error(`REGISTRY_STORAGE=s3 needs ${name}`);
      return String(v).trim();
    };
    Object.assign(cfg.storage, {
      bucket: need('S3_BUCKET'),
      accessKeyId: need('S3_ACCESS_KEY_ID'),
      secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
      endpoint: env.S3_ENDPOINT ? String(env.S3_ENDPOINT).trim() : undefined,
      region: env.S3_REGION ? String(env.S3_REGION).trim() : undefined,
      sessionToken: env.S3_SESSION_TOKEN ? String(env.S3_SESSION_TOKEN).trim() : undefined,
      pathStyle: truthy(env.S3_PATH_STYLE, undefined),
      conditionalPut: truthy(env.S3_CONDITIONAL_PUT, true),
    });
  } else {
    throw new Error(`REGISTRY_STORAGE must be "local" or "s3", not "${type}"`);
  }
  return cfg;
}

/** "https://dl.example.com/" -> "https://dl.example.com"; "" -> null; anything but http(s) is an error. */
function normaliseBase(v) {
  if (v === undefined || v === null || !String(v).trim()) return null;
  let u;
  try {
    u = new URL(String(v).trim());
  } catch {
    throw new Error(`PUBLIC_DOWNLOAD_BASE is not a URL: ${v}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('PUBLIC_DOWNLOAD_BASE must start with https:// (or http:// for a test)');
  if (u.search || u.hash) throw new Error('PUBLIC_DOWNLOAD_BASE must not have a query or fragment');
  return u.href.replace(/\/+$/, '');
}

/**
 * Builds (and initialises) the store for `storage` ({type: 'local'|'s3', ...}); `dataDir` is the default home of the local store.
 * `cleanTmp`: the server removes leftover temp files of an interrupted write; `readOnly`: create nothing (admin tools).
 */
async function openStore(storage, { dataDir, log, cleanTmp = false, readOnly = false, allowMissing = false } = {}) {
  let store;
  if (storage && typeof storage.put === 'function') {
    store = storage; // an already built store (tests)
  } else if (!storage || storage.type === 'local') {
    store = new LocalStore((storage && storage.dir) || path.join(dataDir, 'store'));
  } else if (storage.type === 's3') {
    // requests are signed with the real clock: the object store checks it (a registry test clock must not leak in)
    const { type, ...c } = storage;
    void type;
    store = new S3Store(new S3Client(c), { log });
  } else {
    throw new Error(`unknown storage type "${storage.type}"`);
  }
  await store.init({ cleanTmp, readOnly, allowMissing });
  return store;
}

module.exports = { configFromEnv, openStore, normaliseBase };
