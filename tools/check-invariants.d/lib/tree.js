'use strict';
// A read-only view of the vmapp tree being checked (the real one, or a fixture), plus the finding helpers.

const fs = require('fs');
const path = require('path');
const scan = require('./scan');

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'target', 'build', 'dist', '_work']);

class Tree {
  /** @param {string} root absolute path of the vmapp folder */
  constructor(root) {
    this.root = path.resolve(root);
    this._text = new Map();
    this._scan = new Map();
  }

  abs(rel) {
    return path.join(this.root, ...rel.split('/'));
  }

  exists(rel) {
    try {
      return fs.statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }

  isDir(rel) {
    try {
      return fs.statSync(this.abs(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  read(rel) {
    if (!this._text.has(rel)) this._text.set(rel, fs.readFileSync(this.abs(rel), 'utf8'));
    return this._text.get(rel);
  }

  /** Scan (see scan.js) of a file; kind: 'js' | 'rust' | 'rust-nontest' | 'c'. */
  scan(rel, kind) {
    const key = `${kind}:${rel}`;
    if (!this._scan.has(key)) {
      const text = this.read(rel);
      let s;
      if (kind === 'js') s = scan.scanJs(text);
      else if (kind === 'rust') s = scan.scanRust(text);
      else if (kind === 'rust-nontest') s = scan.stripRustTests(scan.scanRust(text));
      else if (kind === 'c') s = scan.scanC(text);
      else throw new Error(`unknown scan kind ${kind}`);
      s.liner = scan.makeLiner(text);
      this._scan.set(key, s);
    }
    return this._scan.get(key);
  }

  /**
   * Files under a folder (posix relative paths, sorted).
   * @param {string} dir relative folder ('' = root)
   * @param {{exts?:string[], skip?:(rel:string)=>boolean, names?:RegExp}} [o]
   */
  list(dir, o = {}) {
    const out = [];
    const walk = (rel) => {
      let ents;
      try {
        ents = fs.readdirSync(this.abs(rel || '.'), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.work-')) continue;
          if (o.skip && o.skip(r + '/')) continue;
          walk(r);
        } else if (e.isFile()) {
          if (o.exts && !o.exts.includes(path.extname(e.name))) continue;
          if (o.names && !o.names.test(e.name)) continue;
          if (o.skip && o.skip(r)) continue;
          out.push(r);
        }
      }
    };
    walk(dir.replace(/\/+$/, ''));
    return out.sort();
  }
}

/** Production JavaScript of a folder: no tests, no vendored code. */
const JS_EXTS = ['.js', '.mjs', '.cjs'];
function prodJs(tree, dir) {
  return tree.list(dir, { exts: JS_EXTS, skip: (r) => /(^|\/)(test|tests|__tests__)\/$/.test(r) || /\.(test|spec)\.[cm]?js$/.test(r) });
}

/** Finding helpers. A finding: {level:'fail'|'warn', file, line, text, message}. */
function fail(file, line, message, text) {
  return { level: 'fail', file: file || null, line: line || null, message, text: text || null };
}
function warn(file, line, message, text) {
  return { level: 'warn', file: file || null, line: line || null, message, text: text || null };
}
/** A finding located at `idx` in a scanned file. */
function at(level, rel, sc, idx, message) {
  return {
    level,
    file: rel,
    line: sc.liner(idx),
    message,
    text: scan.lineText(sc.text, idx) || null,
  };
}

module.exports = { Tree, prodJs, fail, warn, at, JS_EXTS };
