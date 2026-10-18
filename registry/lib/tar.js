'use strict';
// A minimal ustar writer (and reader, for tests and for checking an export), Node built-ins only. It writes regular
// files only. Used by `admin.js export`.

const BLOCK = 512;

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  // ustar: up to 155 bytes of directory prefix plus up to 100 bytes of name, split at a "/"
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error(`tar: the name is too long: ${name}`);
}

function header(path, size, mtimeMs, mode = 0o600) {
  const { name, prefix } = splitName(path);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(mtimeMs / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // checksum placeholder: eight spaces
  h.write('0', 156, 'ascii'); // regular file
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

class TarWriter {
  /** @param {import('stream').Writable} stream */
  constructor(stream) {
    this.stream = stream;
    this.entries = 0;
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      this.stream.once('error', onError);
      if (this.stream.write(buf)) {
        this.stream.off('error', onError);
        resolve();
      } else {
        this.stream.once('drain', () => {
          this.stream.off('error', onError);
          resolve();
        });
      }
    });
  }

  /** Adds one file. */
  async add(path, data, mtimeMs = Date.now()) {
    await this._write(header(path, data.length, mtimeMs));
    await this._write(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) await this._write(Buffer.alloc(pad));
    this.entries++;
  }

  /** Writes the end-of-archive marker and closes the stream. */
  finish() {
    return new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(Buffer.alloc(BLOCK * 2), resolve);
    });
  }
}

/** Reads a whole archive (a Buffer) into [{path, data, mtimeMs}]. Throws on a bad checksum. */
function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const want = parseInt(field(148, 156).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== want) throw new Error(`tar: bad checksum at offset ${off}`);
    const size = parseInt(field(124, 136).trim(), 8);
    const prefix = field(345, 500);
    out.push({ path: (prefix ? prefix + '/' : '') + field(0, 100), data: Buffer.from(buf.subarray(off + BLOCK, off + BLOCK + size)), mtimeMs: parseInt(field(136, 148).trim(), 8) * 1000 });
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

module.exports = { TarWriter, readTar, header };
