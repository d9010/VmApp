'use strict';
// Strict validation, defaults and canonical serialisation of vmapp.json (SPEC section 2.2).

class ManifestError extends Error {
  constructor(field, problem) {
    super(`invalid vmapp.json: ${field} ${problem}`);
    this.name = 'ManifestError';
    this.field = field;
  }
}

const { validateNetwork } = require('./network'); // permissions.network (SPEC 8.3)

const RUNTIMES = ['native', 'node22', 'node22-gpu', 'dotnet8'];
// SPEC 8.7: the runtimes that carry the Vulkan driver (Mesa's Venus ICD). An app that asks for the experimental Vulkan GPU
// (`{cap:"gpu", api:"vulkan"}`) must run on one of them.
const GPU_RUNTIMES = ['node22-gpu'];
// permissions.host[].api (SPEC 8.7): only the capability `gpu` has one, and `vulkan` is its only value.
const HOST_APIS = ['vulkan'];
const FOLDER_ACCESS = ['read', 'readwrite', 'writeonly'];
const RESERVED_ROOTS = ['vmapp.json', 'core.cpio', 'core.erofs', 'icon.png'];
// core.image (SPEC 2.1, 2.2): how the core's files are packed; the package entry is core.<image>
const CORE_IMAGES = ['cpio', 'erofs'];
// ui.features (SPEC 2.2, 7): window features an app may declare; loader/src/protocols.js UI_FEATURE_CSP says what each adds to the CSP.
const UI_FEATURES = ['workers', 'wasm', 'self-fetch', 'frames', 'network'];
const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const FOLDER_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const UI_ROOT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
// Host capabilities (SPEC 8.2): ids of user-registered tools and MCP servers, and the `cap` strings of permissions.host.
const CAP_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOST_CAP_RE = /^(?:screen|input|gpu|tool:\*|mcp:\*|tool:[a-z0-9][a-z0-9-]{0,40}|mcp:[a-z0-9][a-z0-9-]{0,40})$/;
const MAX_HOST_ENTRIES = 8;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 'screen' | 'input' | 'gpu' | 'tool:<id>' | 'tool:*' | 'mcp:<id>' | 'mcp:*' -> {kind:'screen'|'input'|'gpu'|'tool'|'mcp', id:string|null, wildcard:boolean}; null if invalid. */
function parseHostCap(cap) {
  if (typeof cap !== 'string' || !HOST_CAP_RE.test(cap)) return null;
  if (cap === 'screen' || cap === 'input' || cap === 'gpu') return { kind: cap, id: null, wildcard: false };
  const i = cap.indexOf(':');
  const id = cap.slice(i + 1);
  return { kind: cap.slice(0, i), id: id === '*' ? null : id, wildcard: id === '*' };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const len = (s) => [...s].length;

// ---- Devices (SPEC 2.2 permissions.devices, SPEC 7): [{device, purpose?}] ----
// The devices: the microphone (the app's windows may record), and the clipboard (the app's windows and its core may read and
// write the Mac's clipboard; DEV-APPS C5). "camera" is reserved: it is rejected with its own message so a manifest that asks
// for it fails loudly instead of silently getting nothing. The loader enforces the request AND the user's grant
// (loader/src/devices.js, hostlib/session.js); a manifest can only name a device, never configure it.
// microphone (the window, SPEC 8.4), clipboard (window and core, SPEC 8.4), ports (the core's servers on this Mac's localhost, SPEC 8.8)
const DEVICE_NAMES = ['microphone', 'clipboard', 'ports'];
const RESERVED_DEVICE_NAMES = ['camera'];
const MAX_DEVICE_ENTRIES = 4;

/** `raw` = the manifest's permissions.devices (already known to be present). Returns [{device, purpose}] in the given order. */
function parseDevices(raw) {
  if (!Array.isArray(raw)) throw new ManifestError('permissions.devices', 'must be an array');
  if (raw.length > MAX_DEVICE_ENTRIES) throw new ManifestError('permissions.devices', `must have at most ${MAX_DEVICE_ENTRIES} entries`);
  const seen = new Set();
  const out = [];
  raw.forEach((d, i) => {
    const w = `permissions.devices[${i}]`;
    if (!isObj(d)) throw new ManifestError(w, 'must be an object {device, purpose?}');
    checkKeys(d, ['device', 'purpose'], w);
    if (typeof d.device !== 'string') throw new ManifestError(`${w}.device`, 'must be a string');
    if (RESERVED_DEVICE_NAMES.includes(d.device)) throw new ManifestError(`${w}.device`, `"${d.device}" is reserved and not available yet (only ${DEVICE_NAMES.join(', ')} can be requested)`);
    if (!DEVICE_NAMES.includes(d.device)) throw new ManifestError(`${w}.device`, `must be one of ${DEVICE_NAMES.join(', ')}`);
    if (seen.has(d.device)) throw new ManifestError(`${w}.device`, `"${d.device}" is not unique`);
    seen.add(d.device);
    out.push({ device: d.device, purpose: d.purpose === undefined ? '' : str(d.purpose, `${w}.purpose`, { max: 200 }) });
  });
  return out;
}

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ManifestError(where ? `${where}.${k}` : k, 'is not a known key (unknown keys are rejected)');
  }
}

function str(v, field, { min = 0, max = Infinity, control = false } = {}) {
  if (typeof v !== 'string') throw new ManifestError(field, 'must be a string');
  const n = len(v);
  if (n < min || n > max) {
    throw new ManifestError(field, min > 0 ? `must be ${min}-${max} characters` : `must be at most ${max} characters`);
  }
  if (control && CONTROL_RE.test(v)) throw new ManifestError(field, 'must not contain control characters');
  return v;
}

function bool(v, field) {
  if (typeof v !== 'boolean') throw new ManifestError(field, 'must be a boolean');
  return v;
}

function intRange(v, field, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ManifestError(field, `must be an integer from ${min} to ${max}`);
  }
  return v;
}

/** Absolute path in the VM: starts with "/", no NUL, no ".." component. */
function vmPath(v, field) {
  if (typeof v !== 'string' || !v.startsWith('/')) throw new ManifestError(field, 'must be an absolute path');
  if (v.includes('\0') || v.length > 1024) throw new ManifestError(field, 'is not a valid path');
  if (v.split('/').includes('..')) throw new ManifestError(field, 'must not contain ".." components');
  return v;
}

/**
 * Validates `raw` (parsed JSON) and returns a new normalised manifest with defaults filled in and keys in canonical
 * order. opts.files: 'forbidden' (project manifest, before packing), 'required' (inside a package; default),
 * 'optional'.
 */
function validateManifest(raw, opts = {}) {
  const filesMode = opts.files || 'required';
  if (!isObj(raw)) throw new ManifestError('(root)', 'must be a JSON object');
  checkKeys(raw, ['format', 'id', 'name', 'version', 'publisher', 'description', 'runtime', 'core', 'ui', 'permissions', 'files'], '');

  if (raw.format !== 1) throw new ManifestError('format', `must be 1 (got ${JSON.stringify(raw.format)})`);

  if (typeof raw.id !== 'string') throw new ManifestError('id', 'must be a string');
  if (raw.id.length < 3 || raw.id.length > 100) throw new ManifestError('id', 'must be 3-100 characters');
  if (!ID_RE.test(raw.id)) throw new ManifestError('id', 'must be reverse-DNS like "com.example.app" (^[a-z0-9]+(\\.[a-z0-9-]+)+$)');

  if (raw.name === undefined) throw new ManifestError('name', 'is required');
  const name = str(raw.name, 'name', { min: 1, max: 60, control: true });

  if (typeof raw.version !== 'string') throw new ManifestError('version', 'must be a string');
  if (!SEMVER_RE.test(raw.version)) throw new ManifestError('version', 'must be semver MAJOR.MINOR.PATCH with optional -prerelease');

  const publisher = raw.publisher === undefined ? '' : str(raw.publisher, 'publisher', { max: 100 });
  const description = raw.description === undefined ? '' : str(raw.description, 'description', { max: 500 });

  if (typeof raw.runtime !== 'string' || !RUNTIMES.includes(raw.runtime)) {
    throw new ManifestError('runtime', `must be one of ${RUNTIMES.join(', ')}`);
  }

  // core
  if (!isObj(raw.core)) throw new ManifestError('core', 'is required and must be an object');
  checkKeys(raw.core, ['command', 'workdir', 'env', 'memoryMiB', 'cpus', 'image'], 'core');
  // SPEC 2.1: "cpio" (default) is copied into the VM's memory at boot; "erofs" is a read-only image the guest mounts as it is
  const coreImage = raw.core.image === undefined ? 'cpio' : raw.core.image;
  if (!CORE_IMAGES.includes(coreImage)) throw new ManifestError('core.image', `must be one of ${CORE_IMAGES.join(', ')}`);
  const cmd = raw.core.command;
  if (!Array.isArray(cmd) || cmd.length === 0) throw new ManifestError('core.command', 'must be a non-empty array of strings');
  cmd.forEach((c, i) => {
    if (typeof c !== 'string') throw new ManifestError(`core.command[${i}]`, 'must be a string');
    if (c.includes('\0')) throw new ManifestError(`core.command[${i}]`, 'must not contain NUL');
  });
  if (cmd[0] === '') throw new ManifestError('core.command[0]', 'must not be empty');
  const workdir = raw.core.workdir === undefined ? '/app' : vmPath(raw.core.workdir, 'core.workdir');
  const env = {};
  if (raw.core.env !== undefined) {
    if (!isObj(raw.core.env)) throw new ManifestError('core.env', 'must be an object mapping names to strings');
    for (const k of Object.keys(raw.core.env)) {
      if (!ENV_NAME_RE.test(k)) throw new ManifestError(`core.env.${k}`, 'has an invalid name (must match ^[A-Z_][A-Z0-9_]*$)');
      if (k.startsWith('VMAPP_')) throw new ManifestError(`core.env.${k}`, 'must not set VMAPP_* variables');
      const v = raw.core.env[k];
      if (typeof v !== 'string') throw new ManifestError(`core.env.${k}`, 'must be a string');
      if (v.includes('\0')) throw new ManifestError(`core.env.${k}`, 'must not contain NUL');
      env[k] = v;
    }
  }
  // RECOMMENDATIONS (SPEC 2.2): the user chooses the VM's real size, in the permission sheet or on the card (hostlib/resources.js)
  const memoryMiB = raw.core.memoryMiB === undefined ? 256 : intRange(raw.core.memoryMiB, 'core.memoryMiB', 64, 32768);
  const cpus = raw.core.cpus === undefined ? 1 : intRange(raw.core.cpus, 'core.cpus', 1, 16);

  // ui
  let uiRoot = 'ui';
  const uiFeatures = [];
  if (raw.ui !== undefined) {
    if (!isObj(raw.ui)) throw new ManifestError('ui', 'must be an object');
    checkKeys(raw.ui, ['root', 'features'], 'ui');
    // SPEC 2.2, 7: the window features the app's windows may use; each widens SPEC 7's CSP by exactly its own sources (loader/src/protocols.js)
    if (raw.ui.features !== undefined) {
      if (!Array.isArray(raw.ui.features)) throw new ManifestError('ui.features', 'must be an array');
      raw.ui.features.forEach((f, i) => {
        if (typeof f !== 'string' || !UI_FEATURES.includes(f)) throw new ManifestError(`ui.features[${i}]`, `must be one of ${UI_FEATURES.join(', ')}`);
        if (uiFeatures.includes(f)) throw new ManifestError(`ui.features[${i}]`, `"${f}" is not unique`);
        uiFeatures.push(f);
      });
    }
    if (raw.ui.root !== undefined) {
      if (typeof raw.ui.root !== 'string') throw new ManifestError('ui.root', 'must be a string');
      if (!UI_ROOT_RE.test(raw.ui.root) || raw.ui.root === '.' || raw.ui.root === '..') {
        throw new ManifestError('ui.root', 'must be a single folder name (letters, digits, ".", "_", "-"; no slashes)');
      }
      if (RESERVED_ROOTS.includes(raw.ui.root)) throw new ManifestError('ui.root', `must not be "${raw.ui.root}"`);
      uiRoot = raw.ui.root;
    }
  }

  // permissions
  const folders = [];
  let dialogs = true;
  let external = false;
  let links = false;
  const host = [];
  const devices = [];
  if (raw.permissions !== undefined) {
    if (!isObj(raw.permissions)) throw new ManifestError('permissions', 'must be an object');
    checkKeys(raw.permissions, ['folders', 'dialogs', 'external', 'host', 'devices', 'network', 'links'], 'permissions');
    if (raw.permissions.devices !== undefined) devices.push(...parseDevices(raw.permissions.devices));
    if (raw.permissions.folders !== undefined) {
      if (!Array.isArray(raw.permissions.folders)) throw new ManifestError('permissions.folders', 'must be an array');
      if (raw.permissions.folders.length > 8) throw new ManifestError('permissions.folders', 'must have at most 8 entries');
      const names = new Set();
      raw.permissions.folders.forEach((f, i) => {
        const w = `permissions.folders[${i}]`;
        if (!isObj(f)) throw new ManifestError(w, 'must be an object');
        checkKeys(f, ['name', 'access', 'purpose'], w);
        if (typeof f.name !== 'string' || !FOLDER_NAME_RE.test(f.name)) {
          throw new ManifestError(`${w}.name`, 'must match ^[a-z][a-z0-9-]{0,30}$');
        }
        if (names.has(f.name)) throw new ManifestError(`${w}.name`, `"${f.name}" is not unique`);
        names.add(f.name);
        if (!FOLDER_ACCESS.includes(f.access)) throw new ManifestError(`${w}.access`, `must be one of ${FOLDER_ACCESS.join(', ')}`);
        const purpose = f.purpose === undefined ? '' : str(f.purpose, `${w}.purpose`, { max: 200 });
        folders.push({ name: f.name, access: f.access, purpose });
      });
    }
    if (raw.permissions.dialogs !== undefined) dialogs = bool(raw.permissions.dialogs, 'permissions.dialogs');
    if (raw.permissions.external !== undefined) external = bool(raw.permissions.external, 'permissions.external');
    // SPEC 8.9: the app receives vmapp://<its id>/… links opened on the Mac (a sign-in that redirects back, a link the user clicks)
    if (raw.permissions.links !== undefined) links = bool(raw.permissions.links, 'permissions.links');
    if (raw.permissions.host !== undefined) {
      if (!Array.isArray(raw.permissions.host)) throw new ManifestError('permissions.host', 'must be an array');
      if (raw.permissions.host.length > MAX_HOST_ENTRIES) throw new ManifestError('permissions.host', `must have at most ${MAX_HOST_ENTRIES} entries`);
      const caps = new Set();
      raw.permissions.host.forEach((h, i) => {
        const w = `permissions.host[${i}]`;
        if (!isObj(h)) throw new ManifestError(w, 'must be an object');
        checkKeys(h, ['cap', 'api', 'purpose'], w);
        if (typeof h.cap !== 'string' || !HOST_CAP_RE.test(h.cap)) {
          throw new ManifestError(`${w}.cap`, 'must be screen, input, gpu, tool:<id>, tool:*, mcp:<id> or mcp:* (ids match ^[a-z0-9][a-z0-9-]{0,40}$)');
        }
        if (caps.has(h.cap)) throw new ManifestError(`${w}.cap`, `"${h.cap}" is not unique`);
        caps.add(h.cap);
        // SPEC 8.7: `gpu` alone is the llama.cpp RPC service (SPEC 8.6); `{cap:"gpu", api:"vulkan"}` asks for the experimental Vulkan GPU.
        if (h.api !== undefined) {
          if (h.cap !== 'gpu') throw new ManifestError(`${w}.api`, 'is only valid for the capability "gpu"');
          if (typeof h.api !== 'string' || !HOST_APIS.includes(h.api)) throw new ManifestError(`${w}.api`, `must be one of ${HOST_APIS.join(', ')}`);
          if (!GPU_RUNTIMES.includes(raw.runtime)) {
            throw new ManifestError(`${w}.api`, `"${h.api}" needs a runtime that carries the GPU driver (${GPU_RUNTIMES.join(', ')}), not "${raw.runtime}"`);
          }
        }
        const purpose = h.purpose === undefined ? '' : str(h.purpose, `${w}.purpose`, { max: 200 });
        host.push(h.api === undefined ? { cap: h.cap, purpose } : { cap: h.cap, api: h.api, purpose });
      });
    }
  }

  // network (SPEC 8.3): the checks live in hostlib/network.js
  const network =
    raw.permissions && raw.permissions.network !== undefined ? validateNetwork(raw.permissions.network, (field, problem) => new ManifestError(field, problem)) : [];
  // the window feature "network" (SPEC 7, 8.3 "The app's windows") reaches only what permissions.network asks for: without a request it would be nothing
  if (uiFeatures.includes('network') && !network.length) {
    throw new ManifestError(`ui.features[${uiFeatures.indexOf('network')}]`, '"network" needs permissions.network (the windows reach only the hosts the app asks for)');
  }

  // files
  let files;
  if (raw.files !== undefined) {
    if (filesMode === 'forbidden') throw new ManifestError('files', 'must not be present in a project manifest (pack computes it)');
    if (!isObj(raw.files)) throw new ManifestError('files', 'must be an object mapping paths to SHA-256 hex');
    files = {};
    for (const k of Object.keys(raw.files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (k === '' || k.startsWith('/') || k.endsWith('/') || k.split('/').some((c) => c === '' || c === '.' || c === '..')) {
        throw new ManifestError(`files.${k}`, 'is not a valid relative path');
      }
      if (k === 'vmapp.json') throw new ManifestError(`files.${k}`, 'must not list vmapp.json itself');
      if (typeof raw.files[k] !== 'string' || !SHA_RE.test(raw.files[k])) {
        throw new ManifestError(`files.${k}`, 'must be a lowercase hex SHA-256');
      }
      files[k] = raw.files[k];
    }
  } else if (filesMode === 'required') {
    throw new ManifestError('files', 'is required');
  }

  const out = {
    format: 1,
    id: raw.id,
    name,
    version: raw.version,
    publisher,
    description,
    runtime: raw.runtime,
    core: { command: cmd.slice(), workdir, env, memoryMiB, cpus },
    ui: { root: uiRoot },
    permissions: { folders, dialogs, external },
  };
  // only present when not the default, so the canonical form (and the package id) of every cpio manifest is unchanged
  if (coreImage !== 'cpio') out.core.image = coreImage;
  // only present when the app declares window features, so the canonical form of every other manifest is unchanged
  if (uiFeatures.length) out.ui.features = uiFeatures;
  // Only present when the app asks for host capabilities, so the canonical form (and the package id) of every
  // manifest without them is unchanged.
  if (host.length) out.permissions.host = host;
  if (devices.length) out.permissions.devices = devices; // same rule: manifests without devices keep their canonical form
  if (links) out.permissions.links = true; // same rule
  if (network.length) out.permissions.network = network; // same rule: manifests without network keep their canonical form
  if (files) out.files = files;
  return out;
}

/** Canonical JSON text of a (validated, normalised) manifest: 2-space indent, SPEC key order, trailing newline. */
function canonicalize(manifest) {
  const m = validateManifest(manifest, { files: manifest.files === undefined ? 'forbidden' : 'required' });
  return JSON.stringify(m, null, 2) + '\n';
}

/** Parses manifest bytes (strict UTF-8, no BOM) and validates. */
function parseManifest(bytes, opts) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ManifestError('(file)', 'is not valid UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) throw new ManifestError('(file)', 'must not start with a byte order mark');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ManifestError('(file)', `is not valid JSON (${e.message})`);
  }
  return validateManifest(raw, opts);
}

/** semver comparison (MAJOR.MINOR.PATCH[-pre]); returns -1, 0 or 1. */
function compareVersions(a, b) {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`invalid version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const prea = pa[4] ? pa[4].slice(1).split('.') : null;
  const preb = pb[4] ? pb[4].slice(1).split('.') : null;
  if (!prea && !preb) return 0;
  if (!prea) return 1;
  if (!preb) return -1;
  for (let i = 0; i < Math.max(prea.length, preb.length); i++) {
    const x = prea[i];
    const y = preb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx) return -1;
    else if (ny) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

module.exports = {
  ManifestError,
  RUNTIMES,
  GPU_RUNTIMES,
  HOST_APIS,
  FOLDER_ACCESS,
  UI_FEATURES,
  CORE_IMAGES,
  ID_RE,
  SEMVER_RE,
  CAP_ID_RE,
  HOST_CAP_RE,
  MAX_HOST_ENTRIES,
  DEVICE_NAMES,
  RESERVED_DEVICE_NAMES,
  parseHostCap,
  validateManifest,
  canonicalize,
  parseManifest,
  compareVersions,
};
