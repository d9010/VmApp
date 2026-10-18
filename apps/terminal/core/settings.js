'use strict';
/**
 * The Terminal app's settings: /data/settings.json, mode 0600.
 *
 *   { "version": 1, "secrets": { "GEMINI_API_KEY": "..." } }
 *
 * A secret is stored under the name of the environment variable it is handed to a profile's process as. Values are
 * never returned to the window, never logged and never written to the terminal; the only way out of this module is
 * `secretFor`, which main.js uses to build the environment of the one process that needs it.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.VMAPP_DATA || '/data', 'settings.json');
const SECRET_PATTERN = /^[\x21-\x7e]{8,512}$/; // printable ASCII, no spaces; real keys are ~40 characters

function empty() {
  return { version: 1, secrets: {} };
}

function read() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`[terminal] cannot read settings.json (${e.code || 'error'}); using defaults`);
    return empty();
  }
  try {
    const j = JSON.parse(text);
    const secrets = j && typeof j.secrets === 'object' && j.secrets !== null && !Array.isArray(j.secrets) ? j.secrets : {};
    const clean = {};
    for (const [k, v] of Object.entries(secrets)) if (/^[A-Z][A-Z0-9_]{0,63}$/.test(k) && typeof v === 'string') clean[k] = v;
    return { version: 1, secrets: clean };
  } catch {
    // Not the parser's message: it can quote part of the file, and the file holds secrets.
    console.log('[terminal] settings.json is not valid JSON; ignoring it');
    return empty();
  }
}

/** Atomic write with mode 0600: a temporary file in the same folder, then a rename. */
function write(settings) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, FILE);
}

/** True when a secret is stored for the environment variable `name`. */
function hasSecret(name) {
  return typeof read().secrets[name] === 'string';
}

/** The stored value or undefined. For building one process's environment only. */
function secretFor(name) {
  const v = read().secrets[name];
  return typeof v === 'string' ? v : undefined;
}

/** Stores a secret after validating its shape. Throws an Error whose message never contains the value. */
function setSecret(name, value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!SECRET_PATTERN.test(v)) throw new Error('That does not look like a key: use 8 to 512 visible characters without spaces.');
  const s = read();
  s.secrets[name] = v;
  write(s);
}

function clearSecret(name) {
  const s = read();
  delete s.secrets[name];
  write(s);
}

module.exports = { FILE, hasSecret, secretFor, setSecret, clearSecret };
