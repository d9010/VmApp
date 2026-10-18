'use strict';
// Fixture helpers: copy the known-good tree to a scratch folder, mutate it, run the rules.

const fs = require('fs');
const os = require('os');
const path = require('path');

const VMAPP = path.resolve(__dirname, '..', '..');
const GOOD = path.join(__dirname, 'fixtures', 'good');
const CHECKER = path.join(VMAPP, 'tools', 'check-invariants');
const { runRules } = require(path.join(VMAPP, 'tools', 'check-invariants.d'));

const made = [];

/** A fresh scratch folder next to the tests (kept inside the project), removed by cleanup(). */
function scratch(prefix = 'w') {
  const dir = fs.mkdtempSync(path.join(__dirname, `.work-${prefix}-`));
  made.push(dir);
  return dir;
}

function cleanup() {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** Copies the good fixture to a scratch folder and returns its path. */
function copyGood() {
  const dir = scratch('t');
  fs.cpSync(GOOD, dir, { recursive: true });
  return dir;
}

/** Replaces `from` (string or RegExp) by `to` in a file; throws when nothing matches (a stale mutation). */
function edit(root, rel, from, to) {
  const p = path.join(root, ...rel.split('/'));
  const text = fs.readFileSync(p, 'utf8');
  const hit = typeof from === 'string' ? text.includes(from) : from.test(text);
  if (!hit) throw new Error(`mutation does not apply: ${rel}: ${from}`);
  fs.writeFileSync(p, typeof from === 'string' ? text.replace(from, () => to) : text.replace(from, to));
}

function write(root, rel, content) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function remove(root, rel) {
  fs.rmSync(path.join(root, ...rel.split('/')));
}

/** Copy the good tree, apply `mutate(root)`, run all rules. Returns {byId, root, results}. */
function check(mutate) {
  const root = copyGood();
  if (mutate) mutate(root);
  const results = runRules(root);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  return { root, results, byId };
}

/** All findings of a rule as one searchable string. */
function messages(r) {
  return r.findings.map((f) => `${f.file || ''}:${f.line || ''} ${f.message} ${f.text || ''}`).join('\n');
}

module.exports = { VMAPP, GOOD, CHECKER, scratch, cleanup, copyGood, edit, write, remove, check, messages, runRules };
