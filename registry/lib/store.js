'use strict';
// Object layout and the `local` storage backend. The `s3` backend (lib/s3.js) has the same interface and the same keys.
//
//   blobs/sha256/<hh>/<sha256>.vmapp                      packages, content-addressed, written once
//   events/<yyyy>/<mm>/<dd>/<seq 12 digits>-<rand>.json  the event log (the source of truth), one immutable file per event
//   snapshots/<seq 12 digits>.json                        state at that sequence number, a new file each time
//   staging/<uuid>.vmapp                                  uploads waiting for POST /api/publish/complete (s3 only)
//   lease/writer.json                                     the single-writer lease (s3 only; the one mutable object)
//
// Rules every backend keeps:
//   - put / putFile never replace an existing object: they report { created: false } instead.
//   - delete() refuses anything outside blobs/ and staging/. Events and snapshots can never be deleted through a store.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHA_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const DELETABLE = ['blobs/', 'staging/'];

const pad12 = (n) => String(n).padStart(12, '0');

function blobKey(sha256) {
  if (!SHA_RE.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}.vmapp`;
}

function eventKey(seq, ts, rand) {
  const d = new Date(ts).toISOString(); // 2026-10-16T09:00:00.000Z
  return `events/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${pad12(seq)}-${rand}.json`;
}

const snapshotKey = (seq) => `snapshots/${pad12(seq)}.json`;
const stagingKey = (uploadId) => `staging/${uploadId}.vmapp`;
const LEASE_KEY = 'lease/writer.json';

/** { seq, rand, date } from an event key, or null. */
function parseEventKey(key) {
  const m = /^events\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{12})-([0-9a-f]{12})\.json$/.exec(key);
  return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, seq: Number(m[4]), rand: m[5] } : null;
}

function parseSnapshotKey(key) {
  const m = /^snapshots\/(\d{12})\.json$/.exec(key);
  return m ? { seq: Number(m[1]) } : null;
}

function checkKey(key) {
  if (typeof key !== 'string' || key.length > 300 || !KEY_RE.test(key) || key.includes('..')) throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
  return key;
}

function checkDeletable(key) {
  checkKey(key);
  if (!DELETABLE.some((p) => key.startsWith(p))) throw new Error(`refusing to delete ${key}: only blobs/ and staging/ objects can be deleted`);
  return key;
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* some filesystems refuse to fsync a directory */
  }
}

/** Private objects (events, snapshots) are 0600; blobs are public data and 0644. */
const modeFor = (key) => (key.startsWith('blobs/') ? 0o644 : 0o600);

class LocalStore {
  /** @param {string} root directory that holds the layout above */
  constructor(root) {
    this.kind = 'local';
    this.root = path.resolve(root);
    this.tmpDir = path.join(this.root, '.tmp');
    this.supportsPresign = false;
  }

  /**
   * Prepares the directory. `cleanTmp` (the server, which is the only writer) removes the temp files of a write that a
   * crash interrupted; a tool that only reads, or that runs next to a live server, must not. `readOnly` creates nothing.
   */
  async init({ cleanTmp = false, readOnly = false, allowMissing = false } = {}) {
    if (readOnly) {
      if (!fs.existsSync(this.root) && !allowMissing) throw new Error(`there is no registry data at ${this.root}`);
      return;
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    if (!cleanTmp) return;
    for (const name of fs.readdirSync(this.tmpDir)) {
      try {
        fs.unlinkSync(path.join(this.tmpDir, name));
      } catch {
        /* already gone */
      }
    }
  }

  close() {}

  /** Absolute path of a key (for the registry's streaming and the admin tools). */
  pathOf(key) {
    return path.join(this.root, ...checkKey(key).split('/'));
  }

  /** Moves a finished temp file to its final name without ever replacing an existing file. Returns true if it created it. */
  _commit(tmp, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
    try {
      fs.linkSync(tmp, dest); // fails with EEXIST if dest exists: write-once, atomic
    } catch (e) {
      if (e.code === 'EEXIST') {
        fs.unlinkSync(tmp);
        return false;
      }
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV'].includes(e.code)) throw e;
      // a file system without hard links: the registry is the only writer, so check-then-rename is safe
      if (fs.existsSync(dest)) {
        fs.unlinkSync(tmp);
        return false;
      }
      fs.renameSync(tmp, dest);
      fsyncDir(path.dirname(dest));
      return true;
    }
    fs.unlinkSync(tmp);
    fsyncDir(path.dirname(dest));
    return true;
  }

  /** Writes `data` (a Buffer) as `key` unless it exists. Returns { created }. */
  async put(key, data) {
    const dest = this.pathOf(key);
    if (fs.existsSync(dest)) return { created: false };
    const tmp = path.join(this.tmpDir, crypto.randomBytes(8).toString('hex'));
    const fd = fs.openSync(tmp, 'wx', modeFor(key));
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { created: this._commit(tmp, dest) };
  }

  /**
   * Stores the file at `file` as `key` unless it exists. The file stays where it is (the caller deletes it); the store
   * gets a hard link when both are on one file system, else a copy.
   */
  async putFile(key, file) {
    const dest = this.pathOf(key);
    if (fs.existsSync(dest)) return { created: false };
    const tmp = path.join(this.tmpDir, crypto.randomBytes(8).toString('hex'));
    try {
      fs.linkSync(file, tmp);
    } catch {
      fs.copyFileSync(file, tmp, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(tmp, modeFor(key));
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { created: this._commit(tmp, dest) };
  }

  async get(key) {
    try {
      return await fs.promises.readFile(this.pathOf(key));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async head(key) {
    try {
      const st = await fs.promises.stat(this.pathOf(key));
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs, etag: `"${st.size}-${Math.floor(st.mtimeMs)}"` } : null;
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    }
  }

  /** { stream, size, etag } for the object, or null. */
  async getStream(key) {
    const h = await this.head(key);
    if (!h) return null;
    return { stream: fs.createReadStream(this.pathOf(key)), size: h.size, etag: h.etag };
  }

  /** Yields { key, size, mtimeMs } for every object whose key starts with `prefix` (and sorts after `startAfter`), in key order. */
  async *list(prefix = '', { startAfter = '' } = {}) {
    const self = this;
    function* walk(dirKey) {
      const dir = dirKey ? path.join(self.root, ...dirKey.split('/')) : self.root;
      let names;
      try {
        names = fs.readdirSync(dir).sort();
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return;
        throw e;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue; // .tmp and friends
        const key = dirKey ? `${dirKey}/${name}` : name;
        let st;
        try {
          st = fs.statSync(path.join(dir, name));
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          const sub = key + '/';
          // skip subtrees that cannot contain the prefix, or that sort entirely before startAfter
          if (!(sub.startsWith(prefix) || prefix.startsWith(sub))) continue;
          if (startAfter && sub < startAfter.slice(0, sub.length)) continue;
          yield* walk(key);
        } else if (key.startsWith(prefix) && key > startAfter) {
          yield { key, size: st.size, mtimeMs: st.mtimeMs };
        }
      }
    }
    yield* walk('');
  }

  /** Deletes a blob or a staging object (admin gc only). */
  async delete(key) {
    checkDeletable(key);
    try {
      fs.unlinkSync(this.pathOf(key));
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  describe() {
    return `local directory ${this.root}`;
  }
}

module.exports = {
  LocalStore, blobKey, eventKey, snapshotKey, stagingKey, LEASE_KEY, parseEventKey, parseSnapshotKey, checkKey, checkDeletable, fsyncDir, pad12, SHA_RE,
};
