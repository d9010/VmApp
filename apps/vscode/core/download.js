'use strict';
/**
 * download.js: the Explorer's "Download…" to the Mac (the page half is ui/vscode-vmapp-shim.js, `createDownload`).
 *
 * In a browser, VS Code's web workbench downloads a file of its server with the File System Access API (showSaveFilePicker,
 * showDirectoryPicker) or an `<a download>` of a blob. A vmapp window has neither: every permission request of the page is denied and
 * the window does not download (SPEC 7). The files are in the VM, where this core can read them, so the core does it: the platform's
 * save dialog (dialog.showSaveDialog, SPEC 6 `dialog.save`) gives a write-only path /host/save-N/<name>, and the platform delivers
 * what is written there to the place the user chose on the Mac once the write settles. The file is written as <name>.partial and then
 * renamed (SPEC 6), so the Mac never gets half a file.
 *
 *   page -> core  invoke `vscode:download` {paths: ["/host/f-workspace/README.md", ...]}
 *                   one file: the file itself; a folder or several items: one .tar (ustar, with pax records for long names) holding
 *                   each item under its own name, folders recursively (symbolic links are stored as links, never followed; sockets
 *                   and devices are left out; an entry that cannot be read is skipped and counted)
 *                 -> {canceled:true} | {canceled:false, name, bytes, entries, skipped}
 *
 * A path is any absolute path in the VM: the page reaches every file of the VM through the server anyway (the remote file system), so
 * this gives the page nothing it did not have. Where the bytes go is the user's choice in the platform's dialog.
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const MAX_PATHS = 1000;
const BLOCK = 512;

function checkPaths(req) {
  const list = req && Array.isArray(req.paths) ? req.paths : null;
  if (!list || !list.length || list.length > MAX_PATHS) throw new Error('nothing to download');
  return list.map((p) => {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || p.includes('\0')) throw new Error('not a path in the VM');
    return path.posix.resolve(p);
  });
}

// ------------------------------------------------------------------------------------------------ a minimal tar writer (POSIX ustar + pax)

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

/** One 512-byte ustar header. `name` and `linkname` must fit (the caller adds a pax record otherwise). */
function ustarHeader({ name, mode, size, mtime, type, linkname = '' }) {
  const h = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar splits a long name at a slash: prefix (155) + name (100); a pax record carries the full name anyway
    const i = name.lastIndexOf('/', name.length - 2);
    if (i > 0 && Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) {
      prefix = name.slice(0, i);
      base = name.slice(i + 1);
    } else {
      base = name.slice(-100);
    }
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size <= 0o77777777777 ? size : 0, 12), 124, 12, 'ascii');
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12, 'ascii');
  h.fill(0x20, 148, 156); // the checksum field counts as spaces
  h.write(type, 156, 1, 'ascii');
  h.write(linkname.slice(0, 100), 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/** A pax extended header (type 'x') for what ustar cannot hold: long names, long link targets, sizes of 8 GiB and more. */
function paxRecord(name, fields) {
  let body = '';
  for (const [k, v] of Object.entries(fields)) {
    const rest = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(rest) + 1;
    while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
    body += `${len}${rest}`;
  }
  const data = Buffer.from(body, 'utf8');
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  const hname = `PaxHeader/${path.posix.basename(name)}`.slice(0, 100);
  return Buffer.concat([ustarHeader({ name: hname, mode: 0o644, size: data.length, mtime: Date.now() / 1000, type: 'x' }), data, Buffer.alloc(pad)]);
}

function headerFor(entry) {
  const pax = {};
  const nameFits = Buffer.byteLength(entry.name) <= 100 || (() => {
    const i = entry.name.lastIndexOf('/', entry.name.length - 2);
    return i > 0 && Buffer.byteLength(entry.name.slice(0, i)) <= 155 && Buffer.byteLength(entry.name.slice(i + 1)) <= 100;
  })();
  if (!nameFits) pax.path = entry.name;
  if (entry.linkname && Buffer.byteLength(entry.linkname) > 100) pax.linkpath = entry.linkname;
  if (entry.size > 0o77777777777) pax.size = String(entry.size);
  const h = ustarHeader(entry);
  return Object.keys(pax).length ? Buffer.concat([paxRecord(entry.name, pax), h]) : h;
}

/** Writes `items` (absolute VM paths) as a tar to the writable `out`; folders recursively. Resolves {entries, skipped}. */
async function writeTar(items, out) {
  let entries = 0;
  let skipped = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.write(buf)) resolve();
    else {
      const onErr = (e) => reject(e);
      out.once('error', onErr);
      out.once('drain', () => {
        out.off('error', onErr);
        resolve();
      });
    }
  });
  const skip = (e) => {
    if (e && ['EACCES', 'EPERM', 'ENOENT', 'ELOOP'].includes(e.code)) {
      skipped++;
      return;
    }
    throw e;
  };
  const add = async (abs, name) => {
    let st;
    try {
      st = await fs.promises.lstat(abs);
    } catch (e) {
      return skip(e);
    }
    const mtime = st.mtimeMs / 1000;
    if (st.isSymbolicLink()) {
      let linkname;
      try {
        linkname = await fs.promises.readlink(abs);
      } catch (e) {
        return skip(e);
      }
      await write(headerFor({ name, mode: 0o777, size: 0, mtime, type: '2', linkname }));
      entries++;
    } else if (st.isDirectory()) {
      let names;
      try {
        names = (await fs.promises.readdir(abs)).sort();
      } catch (e) {
        return skip(e);
      }
      await write(headerFor({ name: `${name}/`, mode: st.mode, size: 0, mtime, type: '5' }));
      entries++;
      for (const n of names) await add(path.posix.join(abs, n), `${name}/${n}`);
    } else if (st.isFile()) {
      let fh;
      try {
        fh = await fs.promises.open(abs, 'r');
      } catch (e) {
        return skip(e);
      }
      try {
        await write(headerFor({ name, mode: st.mode, size: st.size, mtime, type: '0' }));
        // exactly st.size bytes: a file that grows while it is read is cut, one that shrinks is padded with zeros
        const buf = Buffer.allocUnsafe(1024 * 1024);
        let left = st.size;
        while (left > 0) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), null);
          if (bytesRead === 0) {
            await write(Buffer.alloc(left));
            break;
          }
          await write(Buffer.from(buf.subarray(0, bytesRead)));
          left -= bytesRead;
        }
        const pad = (BLOCK - (st.size % BLOCK)) % BLOCK;
        if (pad) await write(Buffer.alloc(pad));
        entries++;
      } finally {
        await fh.close();
      }
    }
    // sockets, FIFOs and devices are left out
  };
  const used = new Set();
  for (const abs of items) {
    // each item under its own name; two items with the same name (from different folders) get " (2)", " (3)" ...
    const base = path.posix.basename(abs) || 'root';
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base} (${k})`;
    used.add(name);
    await add(abs, name);
  }
  await write(Buffer.alloc(BLOCK * 2)); // the end of the archive
  await new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
  return { entries, skipped };
}

// ------------------------------------------------------------------------------------------------ the channel

/**
 * attach(ipcMain, {dialog, log, parent(event)}): registers `vscode:download`. `parent(event)` gives the window the dialog belongs to
 * (the one that asked).
 */
function attach(ipcMain, o) {
  const log = o.log || (() => {});
  ipcMain.handle('vscode:download', async (event, req) => {
    const items = checkPaths(req);
    let single = null; // one regular file: downloaded as it is
    if (items.length === 1) {
      const st = await fs.promises.stat(items[0]).catch(() => null);
      if (!st) throw new Error(`${items[0]} does not exist`);
      if (st.isFile()) single = items[0];
      else if (!st.isDirectory()) throw new Error(`${path.posix.basename(items[0])} is not a file or a folder`);
    }
    const defaultName = single
      ? path.posix.basename(single)
      : `${items.length === 1 ? path.posix.basename(items[0]) || 'root' : path.posix.basename(path.posix.dirname(items[0])) || 'download'}.tar`;
    const parent = o.parent ? o.parent(event) : undefined;
    const r = await o.dialog.showSaveDialog(parent || undefined, { title: 'Download to Your Mac', defaultPath: defaultName });
    if (r.canceled || !r.filePath) return { canceled: true };
    const dest = r.filePath; // /host/save-N/<name>: write-only, delivered to the Mac when the write settles
    const partial = `${dest}.partial`;
    const started = Date.now();
    let result;
    let bytes;
    try {
      if (single) {
        await pipeline(fs.createReadStream(single), fs.createWriteStream(partial, { mode: 0o644 }));
        result = { entries: 1, skipped: 0 };
      } else {
        result = await writeTar(items, fs.createWriteStream(partial, { mode: 0o644 }));
      }
      bytes = (await fs.promises.stat(partial)).size;
      await fs.promises.rename(partial, dest); // from here on the platform may take it to the Mac at any moment
    } catch (e) {
      await fs.promises.unlink(partial).catch(() => {});
      throw new Error(`the download failed: ${e.message}`);
    }
    log(`download: ${items.length} item(s) -> ${dest} (${bytes} bytes, ${result.entries} entries, ${result.skipped} skipped, ${Date.now() - started} ms)`);
    return { canceled: false, name: path.posix.basename(dest), bytes, entries: result.entries, skipped: result.skipped };
  });
}

module.exports = { attach, writeTar, checkPaths };
