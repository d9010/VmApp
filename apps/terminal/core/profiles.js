'use strict';
/**
 * Terminal profiles: what the window's profile menu can start. A profile is data plus two small hooks:
 *
 *   id, label, description   what the menu shows
 *   command()                the argv to run, as an array (run on a pseudo-terminal by ptyd, in the workspace folder)
 *   env                      extra environment variables (the base environment is built in main.js)
 *   secret                   optional {env, label, placeholder, help, helpUrl}: a key the user types in Settings; it is stored
 *                            in /data/settings.json and handed to THIS profile's process only, as the variable `env`
 *   prepare({hasSecret})     optional; runs just before the process starts (for example to write the CLI's default config)
 *   unavailable()            optional; returns a reason string when the profile cannot run in this build
 *
 * To add another command-line tool (an AI CLI or anything else): add an entry here, install the tool into core/ (add it to
 * core/package.json and run build.sh), and list the hosts it must reach under `permissions.network` in vmapp.json. See the
 * README ("Adding another CLI as a profile").
 */
const fs = require('fs');
const path = require('path');

const APP = __dirname;
const DATA = process.env.VMAPP_DATA || '/data';

// ------------------------------------------------------------------------------------------------ Gemini CLI

const GEMINI_DIR = path.join(APP, 'node_modules', '@google', 'gemini-cli');

/** The CLI's real entry point, from its package.json `bin` (it is a bundled ES module, not a file we hard-code). */
function geminiEntry() {
  const pkg = JSON.parse(fs.readFileSync(path.join(GEMINI_DIR, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.gemini;
  if (typeof bin !== 'string') throw new Error('the bundled Gemini CLI has no "bin" entry');
  return path.join(GEMINI_DIR, bin);
}

function geminiUnavailable() {
  try {
    fs.accessSync(geminiEntry(), fs.constants.R_OK);
    return null;
  } catch {
    return 'The Gemini CLI is not bundled in this build (run apps/terminal/build.sh, then pack the app again).';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Sets obj[a][b]...[z] = value when that key is absent. Returns false, touching nothing more, when the path is taken or has another shape. */
function setDefault(obj, keyPath, value) {
  let o = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (o[k] === undefined) o[k] = {};
    if (!isObject(o[k])) return false;
    o = o[k];
  }
  const leaf = keyPath[keyPath.length - 1];
  if (leaf in o) return false;
  o[leaf] = value;
  return true;
}

/**
 * Defaults for the CLI's own config in $HOME/.gemini/settings.json, written only for keys the user has not set, and never
 * over a file that is not valid JSON.
 * - They keep the CLI from calling hosts the app has no reason to reach: the usage statistics endpoint and the npm
 *   registry (the update check; /app is read-only anyway, so it could not update itself). What the CLI needs for its work,
 *   generativelanguage.googleapis.com, is a normal permission in vmapp.json.
 * - When Settings holds a key and the user has not picked a sign-in method, "Gemini API key" is picked for them, so the CLI
 *   uses the key from its environment without showing its sign-in dialog (that dialog would display the key).
 */
function prepareGemini({ hasSecret }) {
  const dir = path.join(DATA, '.gemini');
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
  } catch (e) {
    if (e.code !== 'ENOENT') return;
  }
  const wanted = [
    [['privacy', 'usageStatisticsEnabled'], false],
    [['general', 'enableAutoUpdate'], false],
    [['general', 'enableAutoUpdateNotification'], false],
  ];
  if (hasSecret) wanted.push([['security', 'auth', 'selectedType'], 'gemini-api-key']);
  let changed = false;
  for (const [keyPath, value] of wanted) changed = setDefault(cur, keyPath, value) || changed;
  if (!changed) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`);
}

// ------------------------------------------------------------------------------------------------ the list

const PROFILES = [
  {
    id: 'shell',
    label: 'Shell',
    description: 'bash, in your workspace folder. Nothing outside it, and only the network hosts you allowed.',
    command: () => ['/bin/bash', '--rcfile', path.join(APP, 'profile', 'bashrc'), '-i'],
    env: {},
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    description: "Google's Gemini CLI, working in your workspace folder. It signs in with the API key from Settings.",
    command: () => [process.execPath, geminiEntry()],
    // Google sign-in opens a browser and waits for a callback on localhost, which the VM cannot receive: say so, and use a key.
    env: { NO_BROWSER: 'true' },
    secret: {
      env: 'GEMINI_API_KEY',
      label: 'Gemini API key',
      placeholder: 'AIza...',
      help: "Create a key in Google AI Studio. It is stored in this app's private data and given only to the Gemini CLI.",
      helpUrl: 'https://aistudio.google.com/app/apikey',
    },
    prepare: prepareGemini,
    unavailable: geminiUnavailable,
  },
];

/** What the window may know about a profile: no functions, never a secret's value. */
function describe(p, hasSecret) {
  const why = p.unavailable ? p.unavailable() : null;
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    available: !why,
    unavailableReason: why,
    secret: p.secret
      ? { env: p.secret.env, label: p.secret.label, placeholder: p.secret.placeholder, help: p.secret.help, hasHelpUrl: !!p.secret.helpUrl, set: hasSecret(p.secret.env) }
      : null,
  };
}

function find(id) {
  return PROFILES.find((p) => p.id === id) || null;
}

/** The profile whose secret is stored under environment variable `env`, or null. */
function bySecretEnv(env) {
  return PROFILES.find((p) => p.secret && p.secret.env === env) || null;
}

module.exports = { PROFILES, describe, find, bySecretEnv };
