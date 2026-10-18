'use strict';
// --diff <git-range>: changed files (marked protected + Class A/B), G4, and the red-flag scan on added lines.

const { execFileSync } = require('child_process');
const { classify } = require('./protected');
const redflags = require('./redflags');

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr ? String(e.stderr) : e.message).trim().split('\n')[0];
    const err = new Error(`git ${args[0]} failed: ${msg}`);
    err.internal = true;
    throw err;
  }
}

/** Parses `git diff --name-status -z -M` output. */
function parseNameStatus(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') {
      const from = parts[i++];
      const to = parts[i++];
      files.push({ status: st[0], score: Number(st.slice(1)) || null, from, path: to });
    } else {
      files.push({ status: st[0], path: parts[i++] });
    }
  }
  return files;
}

/** Parses `git diff -U0`: added lines with new line numbers, removed lines. Paths are repo-relative. */
function parseUnified(out) {
  const added = [];
  const removed = [];
  let file = null;
  let oldFile = null;
  let newLine = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      oldFile = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      oldFile = line === '--- /dev/null' ? null : line.slice(4).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (file) added.push({ repoFile: file, line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const f = oldFile || file;
      if (f) removed.push({ repoFile: f, text: line.slice(1) });
    }
  }
  return { added, removed };
}

/**
 * @param {string} root absolute path of vmapp/
 * @param {string} range e.g. main...HEAD
 */
function analyse(root, range) {
  const prefix = git(root, ['rev-parse', '--show-prefix']).trim(); // 'vmapp/' or ''
  const files = parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', range, '--']));
  const rel = (p) => (prefix ? (p.startsWith(prefix) ? p.slice(prefix.length) : null) : p);

  const outside = [];
  const changed = [];
  for (const f of files) {
    const paths = [f.path, ...(f.from ? [f.from] : [])];
    const entry = { status: f.status, path: f.path, from: f.from || null, inside: true, protected: false, invariants: [], note: null };
    for (const p of paths) {
      const r = rel(p);
      if (r === null) {
        entry.inside = false;
        outside.push(p);
        continue;
      }
      const c = classify(r);
      if (c.protected) {
        entry.protected = true;
        entry.invariants = [...new Set([...entry.invariants, ...c.invs])];
        entry.note = entry.note || c.note;
      }
    }
    entry.rel = rel(f.path);
    changed.push(entry);
  }

  const u = parseUnified(git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', range, '--']));
  const added = u.added.map((a) => ({ file: rel(a.repoFile), line: a.line, text: a.text })).filter((a) => a.file !== null);
  const removed = u.removed.map((a) => ({ file: rel(a.repoFile), text: a.text })).filter((a) => a.file !== null);
  const flags = redflags.scan(added, removed);

  const protectedFiles = changed.filter((c) => c.protected);
  const isTestPath = (p) => !!p && /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?js$|(^|\/)test_[^/]*$/.test(p);
  const testsTouched = changed.some((c) => isTestPath(c.rel)) || added.some((a) => /#\[\s*(?:cfg\s*\(\s*test\s*\)|test)\s*\]/.test(a.text));
  return {
    range,
    prefix,
    files: changed,
    outside: [...new Set(outside)],
    class: protectedFiles.length ? 'A' : 'B',
    protectedCount: protectedFiles.length,
    specChanged: changed.some((c) => c.rel === 'SPEC.md'),
    testsTouched,
    redFlags: flags,
    addedLines: added.length,
    removedLines: removed.length,
  };
}

module.exports = { analyse, parseNameStatus, parseUnified };
