'use strict';
// Host capabilities (SPEC 8.2, GOVERNANCE section H): the catalog the user maintains (tools.json, mcp.json), the
// per-app grants, and the broker that answers an app's `host.*` bridge requests.
//
//   Catalog           load/save capabilities/tools.json and mcp.json. ONLY the CLI and the loader's own UI call the
//                     write methods; the broker gets catalog.readonly(), which has none (INV-H1).
//   setHostGrant      validates and stores one grant (grants/<id>.json, key `host`).
//   HostCapabilities  the broker: requestOp(op, params, ctx), stopAll(), stopApp(). One per loader, shared by all
//                     AppSessions. It checks the manifest AND the user's grant on every call (INV-H2), asks the loader's
//                     UI when the grant says `ask`, shows the control badge through that UI (INV-H3), runs tools and
//                     MCP servers constrained (INV-H4) and returns data only to the requesting app (INV-H5).
// Processes (hostctl, tools, MCP servers) live in hostproc.js. See hostlib/README.md for the interfaces.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Store, HOST_GRANT_MODES } = require('./store');
const { CAP_ID_RE, parseHostCap } = require('./manifest');
const hostproc = require('./hostproc');

// ------------------------------------------------------------------------------------------------ limits

const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_ARG_SPECS = 32;
const MAX_ARGS = 256;
const MAX_ARG_LEN = 65536;
const MAX_CONCURRENT_TOOLS = 4;
const INPUT_MAX_MS = 10 * 60 * 1000;
const DISPLAY_ID_MAX = 4294967295; // a CGDirectDisplayID is an unsigned 32-bit number
// A bridge line is limited to 16 MiB; results are kept well below that (JSON escaping can grow text).
const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const MCP_METHODS = ['tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'];
const MOUSE_ACTIONS = ['move', 'down', 'up', 'click', 'scroll'];
const MOUSE_BUTTONS = ['left', 'right', 'middle'];
const KEY_MODIFIERS = ['cmd', 'shift', 'alt', 'ctrl'];
const TOOL_KINDS = ['tool', 'shell'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new CatalogError(`${where}.${k} is not a known key`);
}

function clip(s, n = 200) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

/** A short JSON rendering for logs and prompts. */
function show(v, n = 160) {
  try {
    return clip(JSON.stringify(v), n);
  } catch {
    return '?';
  }
}

// ------------------------------------------------------------------------------------------------ tool definitions

/** The whole-argument regex of a spec pattern: `^...$` is required and applied to the entire argument. */
function compilePattern(pattern, where = 'pattern') {
  if (typeof pattern !== 'string' || pattern.length < 2 || pattern.length > 1000) throw new CatalogError(`${where} must be a string of 2-1000 characters`);
  if (!pattern.startsWith('^')) throw new CatalogError(`${where} must be anchored: start with ^`);
  let trailing = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i--) trailing++;
  if (!pattern.endsWith('$') || trailing % 2 === 1) throw new CatalogError(`${where} must be anchored: end with $`);
  try {
    // Wrapped, so a top-level alternation (^a|b$) cannot match a part of the argument.
    return new RegExp(`^(?:${pattern.slice(1, -1)})$`);
  } catch (e) {
    throw new CatalogError(`${where} is not a valid regular expression (${e.message})`);
  }
}

const reCache = new Map();
function cachedRegex(pattern) {
  let re = reCache.get(pattern);
  if (!re) {
    re = compilePattern(pattern);
    if (reCache.size > 2000) reCache.clear();
    reCache.set(pattern, re);
  }
  return re;
}

function absPath(v, where) {
  if (typeof v !== 'string' || !path.isAbsolute(v) || v.includes('\0') || v.length > 4096) throw new CatalogError(`${where} must be an absolute path`);
  return v;
}

function intIn(v, where, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new CatalogError(`${where} must be an integer from ${min} to ${max}`);
  return v;
}

function requireExecutable(p, where) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new CatalogError(`${where}: ${p} does not exist`);
  }
  if (!st.isFile()) throw new CatalogError(`${where}: ${p} is not a file`);
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    throw new CatalogError(`${where}: ${p} is not executable`);
  }
}

/**
 * Validates a tool definition (SPEC 8.2) and returns the normalised object.
 * opts.checkFs (default true): `path` must exist and be an executable file (also checked again at every run).
 */
function validateTool(raw, opts = {}) {
  const checkFs = opts.checkFs !== false;
  if (!isObj(raw)) throw new CatalogError('a tool definition must be an object');
  checkKeys(raw, ['id', 'name', 'path', 'args', 'variadic', 'timeoutMs', 'maxOutputBytes', 'kind', 'description', 'cwd'], 'tool');
  if (typeof raw.id !== 'string' || !CAP_ID_RE.test(raw.id)) throw new CatalogError('tool.id must match ^[a-z0-9][a-z0-9-]{0,40}$');
  const where = `tool "${raw.id}"`;
  if (typeof raw.name !== 'string' || !raw.name.length || [...raw.name].length > 60 || CONTROL_RE.test(raw.name)) {
    throw new CatalogError(`${where}: name must be 1-60 characters without control characters`);
  }
  absPath(raw.path, `${where}: path`);
  if (checkFs) requireExecutable(raw.path, where);
  const kind = raw.kind === undefined ? 'tool' : raw.kind;
  if (!TOOL_KINDS.includes(kind)) throw new CatalogError(`${where}: kind must be "tool" or "shell"`);
  if (!Array.isArray(raw.args) || raw.args.length > MAX_ARG_SPECS) throw new CatalogError(`${where}: args must be an array of at most ${MAX_ARG_SPECS} specs`);
  const args = raw.args.map((a, i) => {
    const w = `${where}: args[${i}]`;
    if (!isObj(a)) throw new CatalogError(`${w} must be an object {pattern, optional?, mapPath?}`);
    checkKeys(a, ['pattern', 'optional', 'mapPath'], w);
    compilePattern(a.pattern, `${w}.pattern`);
    const spec = { pattern: a.pattern };
    if (a.optional !== undefined) {
      if (typeof a.optional !== 'boolean') throw new CatalogError(`${w}.optional must be a boolean`);
      if (a.optional) spec.optional = true;
    }
    if (a.mapPath !== undefined && a.mapPath !== false) {
      if (a.mapPath !== true && a.mapPath !== 'read' && a.mapPath !== 'write') throw new CatalogError(`${w}.mapPath must be true, "read" or "write"`);
      spec.mapPath = a.mapPath;
    }
    return spec;
  });
  let variadic = false;
  if (raw.variadic !== undefined) {
    if (typeof raw.variadic !== 'boolean') throw new CatalogError(`${where}: variadic must be a boolean`);
    variadic = raw.variadic;
  }
  if (variadic && !args.length) throw new CatalogError(`${where}: variadic needs at least one arg spec to repeat`);
  const out = { id: raw.id, name: raw.name, path: raw.path, args, variadic };
  out.timeoutMs = raw.timeoutMs === undefined ? 30000 : intIn(raw.timeoutMs, `${where}: timeoutMs`, 1, MAX_TIMEOUT_MS);
  out.maxOutputBytes = raw.maxOutputBytes === undefined ? 1048576 : intIn(raw.maxOutputBytes, `${where}: maxOutputBytes`, 1, MAX_OUTPUT_BYTES);
  out.kind = kind;
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || [...raw.description].length > 500) throw new CatalogError(`${where}: description must be a string of at most 500 characters`);
    out.description = raw.description;
  }
  if (raw.cwd !== undefined) out.cwd = absPath(raw.cwd, `${where}: cwd`);
  return out;
}

/** Validates an MCP server definition: {id, name, command: [absolute path, ...args], env?: {NAME: 'value'}, description?}. */
function validateMcp(raw, opts = {}) {
  const checkFs = opts.checkFs !== false;
  if (!isObj(raw)) throw new CatalogError('an MCP server definition must be an object');
  checkKeys(raw, ['id', 'name', 'command', 'env', 'description'], 'mcp');
  if (typeof raw.id !== 'string' || !CAP_ID_RE.test(raw.id)) throw new CatalogError('mcp.id must match ^[a-z0-9][a-z0-9-]{0,40}$');
  const where = `MCP server "${raw.id}"`;
  if (typeof raw.name !== 'string' || !raw.name.length || [...raw.name].length > 60 || CONTROL_RE.test(raw.name)) {
    throw new CatalogError(`${where}: name must be 1-60 characters without control characters`);
  }
  if (!Array.isArray(raw.command) || !raw.command.length || raw.command.length > 64) throw new CatalogError(`${where}: command must be an array of 1-64 strings`);
  raw.command.forEach((c, i) => {
    if (typeof c !== 'string' || c.includes('\0') || c.length > 4096) throw new CatalogError(`${where}: command[${i}] must be a string`);
  });
  absPath(raw.command[0], `${where}: command[0]`);
  if (checkFs) requireExecutable(raw.command[0], where);
  const env = {};
  if (raw.env !== undefined) {
    if (!isObj(raw.env)) throw new CatalogError(`${where}: env must be an object`);
    for (const [k, v] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new CatalogError(`${where}: env name ${JSON.stringify(k)} is invalid`);
      if (typeof v !== 'string' || v.includes('\0')) throw new CatalogError(`${where}: env.${k} must be a string`);
      env[k] = v;
    }
  }
  const out = { id: raw.id, name: raw.name, command: raw.command.slice(), env };
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || [...raw.description].length > 500) throw new CatalogError(`${where}: description must be a string of at most 500 characters`);
    out.description = raw.description;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ catalog

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readList(file, validate, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new CatalogError(`${file}: ${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CatalogError(`${file}: not valid JSON (${e.message})`);
  }
  if (!Array.isArray(raw)) throw new CatalogError(`${file}: must be a JSON array of ${what}`);
  const seen = new Set();
  return raw.map((d) => {
    const v = validate(d, { checkFs: false });
    if (seen.has(v.id)) throw new CatalogError(`${file}: duplicate id "${v.id}"`);
    seen.add(v.id);
    return v;
  });
}

/**
 * $VMAPP_HOME/capabilities/tools.json and mcp.json (JSON arrays of definitions). Readers always re-read the files, so
 * changes made with the CLI or the loader UI apply to running apps at their next call.
 *
 * The write methods (saveTools, saveMcp, addTool, removeTool, addMcp, removeMcp) are for the CLI and the loader's own
 * settings UI only. Sessions and the broker are given `readonly()`.
 */
class Catalog {
  constructor(o = {}) {
    this.home = path.resolve(o.home || new Store().home);
    this.dir = path.join(this.home, 'capabilities');
    this.toolsFile = path.join(this.dir, 'tools.json');
    this.mcpFile = path.join(this.dir, 'mcp.json');
  }

  // ---- read ----
  tools() {
    return readList(this.toolsFile, validateTool, 'tool definitions');
  }
  tool(id) {
    return this.tools().find((t) => t.id === id) || null;
  }
  mcpServers() {
    return readList(this.mcpFile, validateMcp, 'MCP server definitions');
  }
  mcpServer(id) {
    return this.mcpServers().find((s) => s.id === id) || null;
  }

  /** A view without write methods: what the broker (and so every session) gets. */
  readonly() {
    return Object.freeze({
      tools: () => this.tools(),
      tool: (id) => this.tool(id),
      mcpServers: () => this.mcpServers(),
      mcpServer: (id) => this.mcpServer(id),
    });
  }

  // ---- write (CLI and loader UI only) ----
  saveTools(list) {
    if (!Array.isArray(list)) throw new CatalogError('tools must be an array');
    const seen = new Set();
    const clean = list.map((d) => {
      const v = validateTool(d, { checkFs: false });
      if (seen.has(v.id)) throw new CatalogError(`duplicate tool id "${v.id}"`);
      seen.add(v.id);
      return v;
    });
    writeAtomic(this.toolsFile, JSON.stringify(clean, null, 2) + '\n');
    return clean;
  }
  saveMcp(list) {
    if (!Array.isArray(list)) throw new CatalogError('MCP servers must be an array');
    const seen = new Set();
    const clean = list.map((d) => {
      const v = validateMcp(d, { checkFs: false });
      if (seen.has(v.id)) throw new CatalogError(`duplicate MCP server id "${v.id}"`);
      seen.add(v.id);
      return v;
    });
    writeAtomic(this.mcpFile, JSON.stringify(clean, null, 2) + '\n');
    return clean;
  }
  /** Adds a tool (its executable must exist) or replaces the one with the same id. */
  addTool(def) {
    const v = validateTool(def, { checkFs: true });
    this.saveTools(this.tools().filter((t) => t.id !== v.id).concat([v]));
    return v;
  }
  removeTool(id) {
    const list = this.tools();
    if (!list.some((t) => t.id === id)) throw new CatalogError(`no tool "${id}"`);
    this.saveTools(list.filter((t) => t.id !== id));
  }
  addMcp(def) {
    const v = validateMcp(def, { checkFs: true });
    this.saveMcp(this.mcpServers().filter((s) => s.id !== v.id).concat([v]));
    return v;
  }
  removeMcp(id) {
    const list = this.mcpServers();
    if (!list.some((s) => s.id === id)) throw new CatalogError(`no MCP server "${id}"`);
    this.saveMcp(list.filter((s) => s.id !== id));
  }
}

// ------------------------------------------------------------------------------------------------ grants

/** The manifest entry (`{cap, purpose}`) that lets an app use `cap`, or null. tool:<id> is covered by tool:*, mcp:<id> by mcp:*. */
function requestedEntry(manifest, cap) {
  const list = (manifest && manifest.permissions && manifest.permissions.host) || [];
  const exact = list.find((h) => h.cap === cap);
  if (exact) return exact;
  const pc = parseHostCap(cap);
  if (pc && (pc.kind === 'tool' || pc.kind === 'mcp') && !pc.wildcard) return list.find((h) => h.cap === `${pc.kind}:*`) || null;
  return null;
}

/**
 * Validates one grant against the manifest and the catalog and returns the normalised {mode, tools?, servers?}.
 * Rules: the manifest must request the capability; `always` is refused for input and for shell tools; the tools and
 * servers a wildcard grant lists must exist in the catalog.
 */
function checkHostGrant(manifest, catalog, cap, spec) {
  const pc = parseHostCap(cap);
  if (!pc) throw new CatalogError(`invalid capability "${cap}"`);
  const entry = requestedEntry(manifest, cap);
  if (!entry) throw new CatalogError(`${manifest && manifest.id} does not request "${cap}"`);
  if (!isObj(spec)) throw new CatalogError('a grant must be an object {mode, tools?, servers?}');
  checkKeys(spec, ['mode', 'tools', 'servers', 'api'], 'grant');
  // The GPU (SPEC 8.6) is a stream of requests: nobody can be asked about each one. Its only mode is `session` ("Allow while
  // the app runs", on every run until the user changes it); not allowing it is having no grant at all.
  const mode = spec.mode === undefined ? (pc.kind === 'gpu' ? 'session' : 'ask') : spec.mode;
  if (!HOST_GRANT_MODES.includes(mode)) throw new CatalogError(`mode must be one of ${HOST_GRANT_MODES.join(', ')}`);
  if (pc.kind === 'gpu' && mode !== 'session') throw new CatalogError('the GPU can only be allowed while the app runs (mode session); there is no "ask" or "always" for it');
  if (mode === 'always' && pc.kind === 'input') throw new CatalogError('"always" is not allowed for input control');
  const g = { mode };
  // SPEC 8.7: a grant for the experimental Vulkan GPU records the API the manifest asks for, so it is a different decision from
  // the llama.cpp RPC service's. The caller may name it; it must be the one the manifest asks for.
  if (spec.api !== undefined && (pc.kind !== 'gpu' || spec.api !== (entry.api || undefined))) {
    throw new CatalogError(`"${cap}" is requested ${entry.api ? `for the ${entry.api} API` : 'without an API'}; the grant cannot name "${spec.api}"`);
  }
  if (pc.kind === 'gpu' && entry.api) g.api = entry.api;
  const tools = catalog ? catalog.tools() : [];
  const servers = catalog ? catalog.mcpServers() : [];
  if (pc.kind === 'tool' && !pc.wildcard) {
    const t = tools.find((x) => x.id === pc.id);
    if (!t) throw new CatalogError(`no tool "${pc.id}" in the catalog`);
    if (mode === 'always' && t.kind === 'shell') throw new CatalogError(`"always" is not allowed for the shell tool "${pc.id}"`);
  }
  if (pc.kind === 'mcp' && !pc.wildcard && !servers.some((x) => x.id === pc.id)) throw new CatalogError(`no MCP server "${pc.id}" in the catalog`);
  if (spec.tools !== undefined) {
    if (!(pc.kind === 'tool' && pc.wildcard)) throw new CatalogError('tools is only valid for tool:*');
    g.tools = [...new Set(spec.tools)];
    for (const id of g.tools) {
      const t = tools.find((x) => x.id === id);
      if (!t) throw new CatalogError(`no tool "${id}" in the catalog`);
      if (mode === 'always' && t.kind === 'shell') throw new CatalogError(`"always" is not allowed for the shell tool "${id}"`);
    }
  }
  if (spec.servers !== undefined) {
    if (!(pc.kind === 'mcp' && pc.wildcard)) throw new CatalogError('servers is only valid for mcp:*');
    g.servers = [...new Set(spec.servers)];
    for (const id of g.servers) if (!servers.some((x) => x.id === id)) throw new CatalogError(`no MCP server "${id}" in the catalog`);
  }
  return g;
}

/**
 * Stores (or, with `spec === null`, removes) a host grant for an installed app. `app` is `store.get(id)`.
 * Only the CLI and the loader's permission UI call this.
 */
function setHostGrant(store, catalog, app, cap, spec) {
  if (spec === null) return store.setHostGrant(app.id, cap, null);
  return store.setHostGrant(app.id, cap, checkHostGrant(app.manifest, catalog, cap, spec));
}

/**
 * What the loader's permission sheet and install review show for an app's `permissions.host`:
 *   [{cap, purpose, risk, control, grant, candidates}]
 * risk: 'screen' | 'input' | 'tool' | 'shell' (tool:* when the catalog has a shell tool, or tool:<id> of a shell tool)
 *       | 'mcp'; control: true for what INV-H6 labels "requests control of your computer" (input, tool:*, mcp:*);
 * grant: the stored grant or null; candidates: the catalog entries a wildcard can be mapped to ([{id, name, kind?}]).
 */
function hostRequestSummary(manifest, catalog, grants) {
  const tools = catalog ? catalog.tools() : [];
  const servers = catalog ? catalog.mcpServers() : [];
  const host = (grants && grants.host) || grants || {};
  return ((manifest.permissions && manifest.permissions.host) || []).map((h) => {
    const pc = parseHostCap(h.cap);
    let risk = pc.kind;
    let candidates = [];
    if (pc.kind === 'tool') {
      candidates = (pc.wildcard ? tools : tools.filter((t) => t.id === pc.id)).map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
      if (candidates.some((c) => c.kind === 'shell')) risk = 'shell';
    } else if (pc.kind === 'mcp') {
      candidates = (pc.wildcard ? servers : servers.filter((s) => s.id === pc.id)).map((s) => ({ id: s.id, name: s.name }));
    }
    return {
      cap: h.cap,
      // SPEC 8.7: `api: 'vulkan'` is the experimental Vulkan GPU (the sheet labels it "Experimental"); absent otherwise.
      ...(h.api ? { api: h.api, experimental: true } : {}),
      purpose: h.purpose || '',
      risk,
      control: pc.kind === 'input' || pc.wildcard,
      // a `gpu` grant made for another API (SPEC 8.7) is not a grant for this request
      grant: host[h.cap] && !(h.cap === 'gpu' && (host[h.cap].api || null) !== (h.api || null)) ? host[h.cap] : null,
      candidates,
    };
  });
}

// ------------------------------------------------------------------------------------------------ tool arguments

class ToolArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolArgsError';
  }
}

/**
 * Matches `args` against the tool's spec list: every argument must match its spec (whole-string regex); a spec may be
 * `optional` (skipped when the argument does not fit it); extra arguments are accepted only for a `variadic` tool, where
 * they repeat the LAST spec. Returns, per argument, the index of the spec it matched. Throws ToolArgsError.
 */
function matchArgs(def, args) {
  if (!Array.isArray(args)) throw new ToolArgsError('args must be an array of strings');
  if (args.length > MAX_ARGS) throw new ToolArgsError(`too many arguments (limit ${MAX_ARGS})`);
  args.forEach((a, i) => {
    if (typeof a !== 'string') throw new ToolArgsError(`argument ${i} must be a string`);
    if (a.length > MAX_ARG_LEN) throw new ToolArgsError(`argument ${i} is too long`);
    if (a.includes('\0')) throw new ToolArgsError(`argument ${i} contains a NUL character`);
  });
  const specs = def.args;
  const res = specs.map((s) => cachedRegex(s.pattern));
  const memo = new Map();
  const assign = new Array(args.length);
  const go = (i, j) => {
    const key = i * 1000 + j;
    if (memo.has(key)) return memo.get(key);
    let ok = false;
    if (i === args.length) {
      ok = true;
      for (let k = j; k < specs.length; k++) if (!specs[k].optional) ok = false;
    } else if (j < specs.length) {
      if (res[j].test(args[i]) && go(i + 1, j + 1)) {
        assign[i] = j;
        ok = true;
      } else if (specs[j].optional && go(i, j + 1)) ok = true;
    } else if (def.variadic && specs.length && res[specs.length - 1].test(args[i]) && go(i + 1, j)) {
      assign[i] = specs.length - 1;
      ok = true;
    }
    memo.set(key, ok);
    return ok;
  };
  if (!go(0, 0)) {
    // say something useful without echoing the patterns' internals back at length
    const required = specs.filter((s) => !s.optional).length;
    if (args.length < required) throw new ToolArgsError(`missing arguments: expected at least ${required}, got ${args.length}`);
    if (args.length > specs.length && !def.variadic) throw new ToolArgsError(`too many arguments: at most ${specs.length}, got ${args.length}`);
    throw new ToolArgsError('arguments do not match the tool definition');
  }
  return assign;
}

// ------------------------------------------------------------------------------------------------ op parameters

function num(v, where, min = -1e6, max = 1e6) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${where} must be a number from ${min} to ${max}`);
  return v;
}

/**
 * The app's capture parameters, validated: they are only a SUGGESTION (SPEC 8.2). `display` is a display id (the ones
 * `target.display` in earlier results carry) and applies to target "display"; a "region" is in global desktop points
 * and the display holding most of it is used; "window" needs a windowId.
 */
function captureArgs(p) {
  const target = p.target === undefined ? 'display' : p.target;
  if (!['display', 'window', 'region'].includes(target)) throw new Error('host.screen.capture: target must be "display", "window" or "region"');
  const a = { target };
  if (target === 'window') {
    if (!Number.isInteger(p.windowId) || p.windowId < 0) throw new Error('host.screen.capture: windowId must be an integer');
    a.windowId = p.windowId;
  }
  if (target === 'region') {
    const r = p.region;
    if (!isObj(r)) throw new Error('host.screen.capture: region must be {x, y, w, h}');
    a.region = { x: num(r.x, 'region.x'), y: num(r.y, 'region.y'), w: num(r.w, 'region.w', 1, 100000), h: num(r.h, 'region.h', 1, 100000) };
  }
  if (p.display !== undefined) {
    if (!Number.isInteger(p.display) || p.display < 0 || p.display > DISPLAY_ID_MAX) throw new Error('host.screen.capture: display must be a display id (a non-negative integer)');
    if (target === 'display') a.display = p.display; // a window or a region names its own display
  }
  if (p.maxWidth !== undefined) {
    if (!Number.isInteger(p.maxWidth) || p.maxWidth < 1 || p.maxWidth > 16384) throw new Error('host.screen.capture: maxWidth must be an integer from 1 to 16384');
    a.maxWidth = p.maxWidth;
  }
  return a;
}

/**
 * What the loader's picker returned for a capture: {kind:'display', display} | {kind:'window', windowId} |
 * {kind:'region', region:{x,y,w,h}} (global points). Checked again here, so a UI bug cannot send the helper anything odd.
 * Returns the helper's argument form ({target, display?|windowId?|region?}).
 */
function pickedArgs(t) {
  if (!isObj(t)) throw new Error('the capture target from the loader is not an object');
  if (t.kind === 'display') {
    if (!Number.isInteger(t.display) || t.display < 0 || t.display > DISPLAY_ID_MAX) throw new Error('the capture target from the loader has a bad display');
    return { target: 'display', display: t.display };
  }
  if (t.kind === 'window') {
    if (!Number.isInteger(t.windowId) || t.windowId < 0) throw new Error('the capture target from the loader has a bad window');
    return { target: 'window', windowId: t.windowId };
  }
  if (t.kind === 'region') {
    const r = t.region;
    if (!isObj(r)) throw new Error('the capture target from the loader has no region');
    return { target: 'region', region: { x: num(r.x, 'region.x'), y: num(r.y, 'region.y'), w: num(r.w, 'region.w', 1, 100000), h: num(r.h, 'region.h', 1, 100000) } };
  }
  throw new Error('the capture target from the loader has an unknown kind');
}

const rectOf = (b) => (isObj(b) && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k])) ? { x: b.x, y: b.y, w: b.w, h: b.h } : undefined);

/**
 * The `target` of a capture result (SPEC 8.2): what was ACTUALLY captured, whatever the app suggested.
 *   {kind:'display'|'window'|'region', display?, windowId?, region?, bounds?, by}
 * `bounds` is the captured area in global desktop points (so a position in the picture maps to a position for input);
 * `region` is global and already clipped to its display; `by`: 'user' (picked in the question), 'app' (the app's own
 * suggestion, used because the permission was already given), 'default' (the suggestion no longer exists: main display).
 */
function captureTarget(sent, reply, by) {
  const t = { kind: sent.target };
  const display = Number.isInteger(reply.display) ? reply.display : sent.display;
  const bounds = rectOf(reply.bounds);
  if (sent.target === 'display') {
    if (display !== undefined) t.display = display;
  } else if (sent.target === 'window') {
    t.windowId = sent.windowId;
    if (display !== undefined) t.display = display;
  } else {
    t.region = bounds || sent.region;
    if (display !== undefined) t.display = display;
  }
  if (bounds) t.bounds = bounds;
  t.by = by;
  return t;
}

function mouseArgs(p) {
  if (!MOUSE_ACTIONS.includes(p.action)) throw new Error(`host.input.mouse: action must be one of ${MOUSE_ACTIONS.join(', ')}`);
  const a = { action: p.action };
  if (p.action !== 'scroll') {
    a.x = num(p.x, 'host.input.mouse: x');
    a.y = num(p.y, 'host.input.mouse: y');
  } else {
    if (p.x !== undefined) a.x = num(p.x, 'host.input.mouse: x');
    if (p.y !== undefined) a.y = num(p.y, 'host.input.mouse: y');
    if ((a.x === undefined) !== (a.y === undefined)) throw new Error('host.input.mouse: scroll needs both x and y, or neither');
    if (p.dx !== undefined) a.dx = num(p.dx, 'host.input.mouse: dx');
    if (p.dy !== undefined) a.dy = num(p.dy, 'host.input.mouse: dy');
  }
  if (p.button !== undefined) {
    if (!MOUSE_BUTTONS.includes(p.button)) throw new Error('host.input.mouse: button must be left, right or middle');
    a.button = p.button;
  }
  if (p.clicks !== undefined) {
    if (!Number.isInteger(p.clicks) || p.clicks < 1 || p.clicks > 3) throw new Error('host.input.mouse: clicks must be 1, 2 or 3');
    a.clicks = p.clicks;
  }
  return a;
}

function keysArgs(p) {
  const hasText = p.text !== undefined;
  const hasKey = p.key !== undefined;
  if (hasText === hasKey) throw new Error('host.input.keys: give exactly one of text or key');
  if (hasText) {
    if (typeof p.text !== 'string' || !p.text.length || [...p.text].length > 10000) throw new Error('host.input.keys: text must be a string of 1-10000 characters');
    if (p.modifiers !== undefined) throw new Error('host.input.keys: modifiers go with key, not text');
    return { text: p.text };
  }
  if (typeof p.key !== 'string' || !/^[A-Za-z0-9\-=[\]\\;',./`]{1,16}$/.test(p.key)) throw new Error('host.input.keys: key must be a key name such as "a", "return", "f5"');
  const a = { key: p.key };
  if (p.modifiers !== undefined) {
    if (!Array.isArray(p.modifiers) || p.modifiers.length > 4 || p.modifiers.some((m) => !KEY_MODIFIERS.includes(m))) {
      throw new Error(`host.input.keys: modifiers must be a subset of ${KEY_MODIFIERS.join(', ')}`);
    }
    a.modifiers = [...new Set(p.modifiers)];
  }
  return a;
}

// ------------------------------------------------------------------------------------------------ the broker

/**
 * The per-loader host-capability broker.
 *
 *   const caps = new HostCapabilities({ store, ui, hostctl?, hostctlPath?, packaged? })
 *   caps.requestOp(op, params, ctx)   // used by AppSession for every `host.*` request
 *   caps.stopAll('panic')             // panic: stop all input sessions, tools and MCP servers of every app
 *   caps.stopApp(ctx.key, 'app-stopped')
 *
 * `ctx` (built by AppSession): { key, appId, appName, manifest, grants(): {<cap>: grant}, resolvePath(vmPath) ->
 * {path, access, name}, traffic(event) }. `ui` is the loader's interface (see hostlib/README.md): confirmUse,
 * inputStarted, inputStopped, shellStarted, shellStopped, and optionally attach(caps).
 *
 * Events: 'panic' ({reason}), 'active-changed', 'traffic' (every host event, with `appId`), 'warning' (message).
 */
class HostCapabilities extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {Store} [o.store] (default: new Store({home}))
   * @param {string} [o.home]
   * @param {Catalog} [o.catalog] (default: the store's capabilities/ folder)
   * @param {object} [o.ui] the loader's capability UI
   * @param {object} [o.hostctl] a HostCtl-like object ({request(op,args), on('panic'), close()}) or a () => HostCtl factory
   * @param {string} [o.hostctlPath] the bundled vmapp-hostctl (the loader passes it in a packaged build)
   * @param {boolean} [o.packaged] default: detected. Ignores VMAPP_HOSTCTL / VMAPP_HOSTCTL_DRYRUN when true
   * @param {boolean} [o.dryRun] post no real input events (tests). Default: VMAPP_HOSTCTL_DRYRUN=1 when not packaged
   * @param {boolean} [o.panicHotkey] register the panic hotkey in hostctl (default true on macOS)
   * @param {number[]} [o.excludePids] processes whose windows no screenshot may contain and `host.screen.windows()` hides
   *   (the loader's own badge, overlay and pickers). Default: this process, which owns the loader's windows
   * @param {number} [o.inputMaxMs=600000]
   * @param {number} [o.mcpRequestTimeoutMs=60000]
   */
  constructor(o = {}) {
    super();
    this.store = o.store || new Store({ home: o.home });
    // The broker keeps only the read-only view: nothing reachable from a session can change the catalog (INV-H1).
    this._cat = (o.catalog || new Catalog({ home: this.store.home })).readonly();
    this.ui = o.ui || null;
    this.packaged = o.packaged === undefined ? hostproc.isPackaged() : !!o.packaged;
    this.dryRun = o.dryRun === undefined ? hostproc.hostDryRun({ packaged: this.packaged }) : !!o.dryRun;
    this.inputMaxMs = o.inputMaxMs || INPUT_MAX_MS;
    this.mcpRequestTimeoutMs = o.mcpRequestTimeoutMs || 60000;
    this.panicHotkey = o.panicHotkey === undefined ? process.platform === 'darwin' : !!o.panicHotkey;
    this.excludePids = (Array.isArray(o.excludePids) ? o.excludePids : [process.pid]).filter((n) => Number.isInteger(n) && n > 0).slice(0, 64);
    this._hostctlOpt = o.hostctl || null;
    this._hostctlPath = o.hostctlPath || null;
    this._ctl = null;
    this._apps = new Map(); // ctx.key -> state
    if (this.ui && typeof this.ui.attach === 'function') this.ui.attach(this);
  }

  // ---------------------------------------------------------------------------------------------- hostctl

  _hostctl() {
    if (this._ctl) return this._ctl;
    let c = this._hostctlOpt;
    if (typeof c === 'function') c = c();
    if (!c) c = new hostproc.HostCtl({ command: hostproc.resolveHostCtlCommand({ packaged: this.packaged, bundled: this._hostctlPath }), panicHotkey: this.panicHotkey });
    this._ctl = c;
    if (typeof c.on === 'function') {
      c.on('panic', () => this.stopAll('panic'));
      c.on('warning', (m) => this.emit('warning', String(m)));
    }
    return c;
  }

  async _ctlRequest(op, args) {
    try {
      return await this._hostctl().request(op, args);
    } catch (e) {
      const err = new Error(e && e.code === 'permission' ? `macOS permission missing: ${e.message}` : `host helper: ${(e && e.message) || e}`);
      err.code = e && e.code; // the helper's code (not-found, bad-request, ...) stays readable for the broker
      throw err;
    }
  }

  /** Makes sure the helper runs and the panic hotkey is registered (best effort). */
  async _ensurePanic() {
    if (!this.panicHotkey) return;
    try {
      this._hostctl();
      if (!this._panicOn) {
        this._panicOn = true;
        await this._hostctl().request('panic-hotkey', { enable: true });
      }
    } catch (e) {
      this._panicOn = false;
      this.emit('warning', `panic hotkey not registered: ${e.message}`);
    }
  }

  /**
   * Registers the panic shortcut (and starts the helper) now. The loader calls it at startup so the shortcut works before
   * any app asked for control; without it, it happens at the first input session or tool run. Failures are 'warning'.
   */
  enablePanic() {
    return this._ensurePanic();
  }

  // ---------------------------------------------------------------------------------------------- state

  _state(ctx) {
    let st = this._apps.get(ctx.key);
    if (!st) {
      st = { ctx, input: new Map(), tools: new Map(), mcp: new Map(), approved: new Set(), askChain: Promise.resolve(), closed: false };
      this._apps.set(ctx.key, st);
    }
    st.ctx = ctx;
    return st;
  }

  /** The control currently active, for the loader's badge: [{kind:'input'|'shell', appId, appName, ...}]. */
  active() {
    const out = [];
    for (const st of this._apps.values()) {
      for (const s of st.input.values()) {
        out.push({ kind: 'input', key: st.ctx.key, appId: st.ctx.appId, appName: st.ctx.appName, sessionId: s.id, reason: s.reason, since: s.since, expiresAt: s.expiresAt });
      }
      for (const [runId, r] of st.tools) {
        if (r.def.kind === 'shell') out.push({ kind: 'shell', key: st.ctx.key, appId: st.ctx.appId, appName: st.ctx.appName, runId, tool: { id: r.def.id, name: r.def.name }, since: r.since });
      }
    }
    return out;
  }

  _appInfo(st) {
    return { id: st.ctx.appId, name: st.ctx.appName };
  }

  _traffic(ctx, rec) {
    const ev = {
      ts: rec.ts,
      dir: 'from-core',
      t: 'host',
      kind: 'host',
      appId: ctx.appId,
      cap: rec.cap,
      op: rec.op,
      detail: rec.detail,
      allowed: rec.allowed,
      durationMs: rec.durationMs,
      bytes: 0,
      preview: `${rec.op} ${rec.detail || ''}`.slice(0, 200),
    };
    if (rec.error) {
      ev.error = true;
      ev.message = rec.error;
    }
    try {
      if (typeof ctx.traffic === 'function') ctx.traffic(ev);
    } catch {
      /* the inspector must never break a request */
    }
    this.emit('traffic', ev);
  }

  /** A host event that is not a request (an input session ending by itself, a tool killed). */
  _note(st, cap, op, detail) {
    this._traffic(st.ctx, { ts: Date.now(), cap, op, detail: clip(detail), allowed: true, durationMs: 0 });
  }

  // ---------------------------------------------------------------------------------------------- permission

  /**
   * The permission decision without any side effect: { ok:true, entry, grant } or { ok:false, reason }.
   * `cap` is what is used (screen, input, tool:<id>, mcp:<id>) or, for kind 'list', the family tool:* / mcp:*.
   */
  _gate(ctx, cap, kind = 'use') {
    const pc = parseHostCap(cap);
    if (!pc) return { ok: false, reason: 'invalid capability' };
    const list = (ctx.manifest && ctx.manifest.permissions && ctx.manifest.permissions.host) || [];
    const grants = ctx.grants() || {};
    if (kind === 'list') {
      if (!list.some((h) => parseHostCap(h.cap).kind === pc.kind)) return { ok: false, reason: `"${pc.kind}" capabilities are not requested in the app manifest` };
      if (!Object.keys(grants).some((k) => parseHostCap(k) && parseHostCap(k).kind === pc.kind)) return { ok: false, reason: `no ${pc.kind} capability is granted` };
      return { ok: true, entry: null, grant: null };
    }
    const entry = requestedEntry(ctx.manifest, cap);
    if (!entry) return { ok: false, reason: `"${cap}" is not requested in the app manifest` };
    let grant = null;
    if (grants[cap] && (list.some((h) => h.cap === cap) || list.some((h) => h.cap === `${pc.kind}:*`))) grant = grants[cap];
    else if ((pc.kind === 'tool' || pc.kind === 'mcp') && grants[`${pc.kind}:*`] && list.some((h) => h.cap === `${pc.kind}:*`)) {
      const w = grants[`${pc.kind}:*`];
      const picked = pc.kind === 'tool' ? w.tools : w.servers;
      if (Array.isArray(picked) && picked.includes(pc.id)) grant = w;
    }
    if (!grant) return { ok: false, reason: `"${cap}" is not granted by the user` };
    return { ok: true, entry, grant };
  }

  /**
   * Every host op goes through here before it does anything for the app (INV-H2):
   *   1. the manifest must request the capability and the user's grant must exist (else "permission denied");
   *   2. mode `ask`: ui.confirmUse() answers (true / 'session' to remember for this run / false); `session` and
   *      `always` do not ask. `always` is never honoured for input or a shell tool (treated as `ask`).
   * opts.kind: 'use' (default), 'list' (listing what is granted; no prompt) or 'active' (an input session already
   * started; no prompt, but the grant must still exist). opts.shell marks a shell tool.
   * opts.approvalKey (default `cap`) is what an "allow while the app runs" answer is remembered under, and
   * opts.alsoApprovedBy lists other keys that already satisfy this use: allowing screenshots for the run also allows the
   * window list, but allowing only the window list does not allow screenshots. opts.out receives what the question returned
   * besides yes/no (the capture picker's target). opts.suggestion is the validated capture suggestion shown in the picker.
   */
  async _authorize(ctx, st, rec, cap, detail, opts = {}) {
    const kind = opts.kind || 'use';
    rec.cap = cap;
    rec.detail = clip(detail);
    if (st.closed) throw new Error('permission denied: the app is stopping');
    const g = this._gate(ctx, cap, kind);
    if (!g.ok) {
      if (kind === 'active') this._stopAllInput(st, 'revoked');
      throw new Error(`permission denied: ${g.reason}`);
    }
    if (kind === 'use') {
      let mode = g.grant.mode;
      const pc = parseHostCap(cap);
      if (mode === 'always' && (pc.kind === 'input' || opts.shell)) mode = 'ask';
      const key = opts.approvalKey || cap;
      if (mode === 'ask' && !st.approved.has(key) && !(opts.alsoApprovedBy || []).some((k) => st.approved.has(k))) {
        const yes = await this._ask(ctx, st, cap, rec.op, detail, g.entry, !!opts.shell, opts.params, { key, out: opts.out, suggestion: opts.suggestion });
        if (!yes) throw new Error('permission denied: declined by the user');
      }
    }
    if (st.closed) throw new Error('permission denied: the app is stopping');
    rec.allowed = true;
    return g;
  }

  /** One prompt at a time per app; an answer of 'session' is remembered until the app stops (or panic). */
  _ask(ctx, st, cap, op, detail, entry, shell, params, extra = {}) {
    const key = extra.key || cap;
    const run = async () => {
      if (st.approved.has(key)) return true;
      if (!this.ui || (typeof this.ui.confirmUse !== 'function' && typeof this.ui.chooseCapture !== 'function')) return false;
      let ans;
      try {
        const req = {
          app: this._appInfo(st),
          cap,
          op,
          detail: clip(detail, 400),
          purpose: (entry && entry.purpose) || '',
          shell,
        };
        // `params`: the app's own arguments for this use (the exact tool arguments, the capture target, the MCP call), so
        // the loader's dialog can show them in full; `detail` is a clipped one-line summary.
        if (params !== undefined) req.params = params;
        if (extra.suggestion) req.suggestion = extra.suggestion;
        ans = await this._confirm(req, extra.out);
      } catch (e) {
        this.emit('warning', `confirmUse failed: ${e.message}`);
        return false;
      }
      if (ans === 'session') {
        st.approved.add(key);
        return true;
      }
      return ans === true;
    };
    const p = st.askChain.then(run, run);
    st.askChain = p.catch(() => {});
    return p;
  }

  /**
   * The question itself. A screenshot goes to `ui.chooseCapture(req)` when the loader has one: the USER picks what is
   * captured (SPEC 8.2), the answer is `false` or `{allow: true | 'session', target}`, and the checked target is left in
   * `out.target`. Anything else, and a UI without chooseCapture, is `ui.confirmUse(req)` (true | 'session' | false), and a
   * capture then uses the app's suggestion.
   */
  async _confirm(req, out) {
    if (req.op === 'host.screen.capture' && typeof this.ui.chooseCapture === 'function') {
      const a = await this.ui.chooseCapture(req);
      if (!a || typeof a !== 'object' || !a.allow) return false;
      if (a.target !== undefined && out) out.target = pickedArgs(a.target); // throws on nonsense: counts as declined
      return a.allow === 'session' ? 'session' : true;
    }
    if (typeof this.ui.confirmUse !== 'function') return false;
    return this.ui.confirmUse(req);
  }

  // ---------------------------------------------------------------------------------------------- the ops

  /**
   * Answers one `host.*` request of an app. Unknown ops are errors. Every call emits a 'traffic' event
   * {kind:'host', cap, op, detail, allowed, durationMs} (never screenshot bytes; arguments truncated).
   */
  async requestOp(op, params, ctx) {
    const st = this._state(ctx);
    const p = isObj(params) ? params : {};
    const rec = { ts: Date.now(), op, cap: null, detail: '', allowed: false };
    const t0 = Date.now();
    try {
      return await this._dispatch(op, p, ctx, st, rec);
    } catch (e) {
      rec.error = (e && e.message) || String(e);
      throw e;
    } finally {
      rec.durationMs = Date.now() - t0;
      this._traffic(ctx, rec);
    }
  }

  async _dispatch(op, p, ctx, st, rec) {
    switch (op) {
      case 'host.screen.windows': {
        await this._authorize(ctx, st, rec, 'screen', 'list the windows on screen', { alsoApprovedBy: ['screen.capture'] });
        const list = await this._ctlRequest('windows', {});
        // the loader's own windows (badge, overlay, pickers, other apps' windows) are not the app's business
        return (Array.isArray(list) ? list : []).filter((w) => !this.excludePids.includes(w.pid)).map((w) => ({ windowId: w.windowId, app: w.app, title: w.title, bounds: w.bounds }));
      }
      case 'host.screen.capture': {
        // The app's parameters are a SUGGESTION: the user picks what is captured (SPEC 8.2). A malformed request is an
        // error and never a question (the permission check comes first, so an ungranted app learns nothing about it).
        const suggestion = this._gate(ctx, 'screen').ok ? captureArgs(p) : null;
        const out = {};
        await this._authorize(ctx, st, rec, 'screen', `capture the screen: ${show(p, 120)}`, { params: p, out, suggestion, approvalKey: 'screen.capture' });
        const r = await this._capture(suggestion, out.target);
        rec.detail = clip(`capture ${r.target.kind}${r.target.by === 'user' ? ' (chosen by the user)' : r.target.by === 'default' ? ' (main display)' : ''} -> ${r.width}x${r.height}`);
        return r;
      }
      case 'host.input.start': {
        const reason = p.reason === undefined ? '' : p.reason;
        if (typeof reason !== 'string' || [...reason].length > 200) throw new Error('host.input.start: reason must be a string of at most 200 characters');
        await this._authorize(ctx, st, rec, 'input', `control the mouse and keyboard${reason ? `: ${reason}` : ''}`, { params: { reason } });
        return this._inputStart(st, reason, rec);
      }
      case 'host.input.mouse': {
        await this._authorize(ctx, st, rec, 'input', `mouse ${show(p, 100)}`, { kind: 'active' });
        const s = this._requireInput(st, rec, p.sessionId);
        const a = mouseArgs(p);
        rec.detail = clip(`mouse ${a.action}${a.x !== undefined ? ` at ${a.x},${a.y}` : ''}${a.button ? ` ${a.button}` : ''}`);
        await this._inputRequest('mouse', a);
        if (a.x !== undefined) s.last = { x: a.x, y: a.y };
        if (a.action === 'down') s.down.add(a.button || 'left');
        else if (a.action === 'up' || a.action === 'click') s.down.delete(a.button || 'left');
        this._activity(st, s, { kind: 'mouse', action: a.action, x: a.x, y: a.y, button: a.button || 'left', clicks: a.clicks || 1, dx: a.dx, dy: a.dy }); // x, y: none for a scroll at the cursor
        return {};
      }
      case 'host.input.keys': {
        await this._authorize(ctx, st, rec, 'input', 'keyboard input', { kind: 'active' });
        const s = this._requireInput(st, rec, p.sessionId);
        const a = keysArgs(p);
        // what is typed is not logged, only how much
        rec.detail = a.text !== undefined ? `type ${[...a.text].length} characters` : `key ${a.key}${a.modifiers && a.modifiers.length ? ` +${a.modifiers.join('+')}` : ''}`;
        await this._inputRequest('keys', a);
        // the on-screen overlay shows the keys (to the user only: never in the Inspector, never returned to the app)
        this._activity(st, s, a.text !== undefined ? { kind: 'keys', text: a.text } : { kind: 'keys', key: a.key, modifiers: a.modifiers || [] });
        return {};
      }
      case 'host.input.stop': {
        await this._authorize(ctx, st, rec, 'input', 'stop controlling the mouse and keyboard', { kind: 'active' });
        const id = typeof p.sessionId === 'string' ? p.sessionId : '';
        this._stopInput(st, id, 'stopped');
        rec.detail = 'input control stopped';
        return {};
      }
      case 'host.tool.list': {
        await this._authorize(ctx, st, rec, 'tool:*', 'list the tools', { kind: 'list' });
        const out = [];
        for (const t of this._cat.tools()) {
          if (!this._gate(ctx, `tool:${t.id}`).ok) continue;
          const e = { id: t.id, name: t.name, kind: t.kind, args: t.args.map((a) => Object.assign({}, a)) };
          if (t.description) e.description = t.description;
          if (t.variadic) e.variadic = true;
          out.push(e);
        }
        rec.detail = `${out.length} tool(s)`;
        return out;
      }
      case 'host.tool.run': {
        const id = p.id;
        if (typeof id !== 'string' || !CAP_ID_RE.test(id)) throw new Error('host.tool.run: id must be a tool id');
        const def = this._cat.tool(id);
        await this._authorize(ctx, st, rec, `tool:${id}`, `run ${id} ${show(p.args, 160)}`, { shell: !!def && def.kind === 'shell', params: { id, args: p.args } });
        if (!def) throw new Error(`tool "${id}" is not registered`);
        return this._toolRun(ctx, st, rec, def, p);
      }
      case 'host.mcp.list': {
        await this._authorize(ctx, st, rec, 'mcp:*', 'list the MCP servers', { kind: 'list' });
        const out = [];
        for (const def of this._cat.mcpServers()) {
          if (!this._gate(ctx, `mcp:${def.id}`).ok) continue;
          const entry = { id: def.id, name: def.name, tools: [] };
          try {
            await this._authorize(ctx, st, rec, `mcp:${def.id}`, `start ${def.name} and list its tools`);
            entry.tools = await this._mcpTools(st, def);
          } catch (e) {
            entry.error = e.message;
          }
          out.push(entry);
        }
        rec.cap = 'mcp:*';
        rec.detail = `${out.length} server(s)`;
        return out;
      }
      case 'host.mcp.call': {
        const server = p.server;
        if (typeof server !== 'string' || !CAP_ID_RE.test(server)) throw new Error('host.mcp.call: server must be an MCP server id');
        if (typeof p.method !== 'string' || !MCP_METHODS.includes(p.method)) throw new Error(`host.mcp.call: method must be one of ${MCP_METHODS.join(', ')}`);
        if (p.params !== undefined && p.params !== null && !isObj(p.params)) throw new Error('host.mcp.call: params must be an object');
        const sub = p.method === 'tools/call' && isObj(p.params) && typeof p.params.name === 'string' ? ` ${clip(p.params.name, 60)}` : '';
        await this._authorize(ctx, st, rec, `mcp:${server}`, `${p.method}${sub}${p.method === 'tools/call' && isObj(p.params) ? ` ${show(p.params.arguments, 100)}` : ''}`, { params: { server, method: p.method, params: p.params } });
        const def = this._cat.mcpServer(server);
        if (!def) throw new Error(`MCP server "${server}" is not registered`);
        const result = await this._mcpServer(st, def).request(p.method, p.params || undefined, { timeoutMs: p.method === 'tools/call' ? Math.max(this.mcpRequestTimeoutMs, 120000) : this.mcpRequestTimeoutMs });
        if (Buffer.byteLength(JSON.stringify(result === undefined ? null : result)) > MAX_RESULT_BYTES) throw new Error('the MCP result is too large for the bridge');
        return result === undefined ? null : result;
      }
      default:
        throw new Error(`unknown host op: ${op}`);
    }
  }

  // ---------------------------------------------------------------------------------------------- screen

  /**
   * One screenshot. `suggestion` is the app's validated suggestion; `picked` (helper form, from the user's choice in the
   * loader's picker) wins over it. Without a pick - the permission was already given for this run, or the mode is
   * session / always - the suggestion is used, and when it names a display, window or area that does not exist (any more)
   * the main display is captured instead. The helper never includes windows of `excludePids` (the loader's own).
   * Returns {png, width, height, target} where `target` says what was really captured (captureTarget).
   */
  async _capture(suggestion, picked) {
    const size = suggestion.maxWidth !== undefined ? { maxWidth: suggestion.maxWidth } : {}; // the app keeps the say over the size only
    const request = (a) => this._ctlRequest('capture', Object.assign({}, a, { excludePids: this.excludePids }));
    let a = picked ? Object.assign({}, picked, size) : suggestion;
    let by = picked ? 'user' : 'app';
    let r;
    try {
      r = await request(a);
    } catch (e) {
      const fallback = Object.assign({ target: 'display' }, size);
      if (by !== 'app' || (e.code !== 'not-found' && e.code !== 'bad-request') || JSON.stringify(a) === JSON.stringify(fallback)) throw e;
      a = fallback;
      by = 'default';
      r = await request(a);
    }
    if (!r || typeof r.png !== 'string') throw new Error('host helper: capture returned no image');
    // keep the reply under the bridge line limit: retry smaller
    for (const w of [1920, 1280, 800]) {
      if (r.png.length <= MAX_RESULT_BYTES) break;
      if (a.maxWidth !== undefined && a.maxWidth <= w) continue;
      a = Object.assign({}, a, { maxWidth: w });
      r = await request(a);
      if (!r || typeof r.png !== 'string') throw new Error('host helper: capture returned no image');
    }
    if (r.png.length > MAX_RESULT_BYTES) throw new Error('the capture is too large for the bridge; ask for a smaller region or maxWidth');
    return { png: r.png, width: r.width, height: r.height, target: captureTarget(a, r, by) };
  }

  // ---------------------------------------------------------------------------------------------- input

  _requireUi(method) {
    if (!this.ui || typeof this.ui[method] !== 'function') throw new Error('the loader cannot show the control badge, so this is refused');
  }

  async _inputStart(st, reason, rec) {
    this._requireUi('inputStarted');
    await this._ensurePanic();
    if (st.closed) throw new Error('permission denied: the app is stopping');
    this._stopAllInput(st, 'renewed'); // a new start replaces (renews) the app's running session
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const s = { id, reason, since: now, expiresAt: now + this.inputMaxMs, down: new Set(), last: { x: 0, y: 0 }, timer: null };
    s.timer = setTimeout(() => this._stopInput(st, id, 'expired'), this.inputMaxMs);
    if (s.timer.unref) s.timer.unref();
    st.input.set(id, s);
    try {
      await this.ui.inputStarted({ app: this._appInfo(st), reason, sessionId: id, expiresAt: s.expiresAt });
    } catch (e) {
      this._stopInput(st, id, 'badge-failed');
      throw new Error(`cannot show the control badge: ${e.message}`);
    }
    rec.detail = clip(`input control started (${Math.round(this.inputMaxMs / 1000)} s max)${reason ? `: ${reason}` : ''}`);
    this.emit('active-changed');
    return { sessionId: id };
  }

  /** Like _inputSession, but a call without a running session is logged as denied (nothing was sent to the helper). */
  _requireInput(st, rec, id) {
    try {
      return this._inputSession(st, id);
    } catch (e) {
      rec.allowed = false;
      throw e;
    }
  }

  _inputSession(st, id) {
    const s = typeof id === 'string' ? st.input.get(id) : null;
    if (s && Date.now() >= s.expiresAt) {
      this._stopInput(st, s.id, 'expired'); // the timer may have been late (sleep)
      throw new Error('the input session expired; call host.input.start again');
    }
    if (!s) throw new Error('no such input session (it was stopped or expired); call host.input.start again');
    return s;
  }

  async _inputRequest(op, a) {
    await this._ctlRequest(op, this.dryRun ? Object.assign({}, a, { dryRun: true }) : a);
  }

  /**
   * Tells the loader's UI what the app just did with its input session (a mouse action at a position, keys), so the
   * virtual-input overlay can show it (INV-H3: the control is visible). Optional (`ui.inputActivity`), after the helper
   * accepted the event, and it can never fail or delay the input. The data goes to the loader's own overlay window only.
   */
  _activity(st, s, ev) {
    if (!this.ui || typeof this.ui.inputActivity !== 'function') return;
    try {
      const r = this.ui.inputActivity(Object.assign({ app: this._appInfo(st), sessionId: s.id }, ev));
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* the overlay must not break input */
    }
  }

  _stopAllInput(st, reason) {
    for (const id of [...st.input.keys()]) this._stopInput(st, id, reason);
  }

  /** Ends an input session: releases held buttons, informs the badge. Returns true if there was such a session. */
  _stopInput(st, id, reason) {
    const s = st.input.get(id);
    if (!s) return false;
    st.input.delete(id);
    clearTimeout(s.timer);
    for (const b of s.down) {
      this._ctlRequest('mouse', Object.assign({ action: 'up', x: s.last.x, y: s.last.y, button: b }, this.dryRun ? { dryRun: true } : {})).catch(() => {});
    }
    s.down.clear();
    if (reason !== 'stopped') this._note(st, 'input', 'host.input.stop', `input control ended: ${reason}`);
    try {
      const r = this.ui && typeof this.ui.inputStopped === 'function' ? this.ui.inputStopped({ app: this._appInfo(st), sessionId: id, reason }) : null;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* the badge must not block the stop */
    }
    this.emit('input-stopped', { appId: st.ctx.appId, sessionId: id, reason });
    this.emit('active-changed');
    return true;
  }

  // ---------------------------------------------------------------------------------------------- tools

  async _toolRun(ctx, st, rec, def, p) {
    const args = p.args === undefined ? [] : p.args;
    let assigned;
    try {
      assigned = matchArgs(def, args);
    } catch (e) {
      throw new Error(`tool "${def.id}": ${e.message}`);
    }
    const argv = args.map((a, i) => {
      const spec = def.args[assigned[i]];
      if (!spec.mapPath) return a;
      let r;
      try {
        r = ctx.resolvePath(a);
      } catch (e) {
        throw new Error(`tool "${def.id}": argument ${i}: ${e.message}`);
      }
      if (spec.mapPath === 'read' && r.access === 'wo') throw new Error(`tool "${def.id}": argument ${i}: ${a} is a write-only share`);
      if (spec.mapPath === 'write' && r.access === 'ro') throw new Error(`tool "${def.id}": argument ${i}: ${a} is a read-only share`);
      return r.path;
    });
    let stdin;
    if (p.stdin !== undefined && p.stdin !== null) {
      if (typeof p.stdin !== 'string') throw new Error('host.tool.run: stdin must be a string');
      if (Buffer.byteLength(p.stdin) > MAX_STDIN_BYTES) throw new Error('host.tool.run: stdin is larger than 1 MiB');
      stdin = p.stdin;
    }
    try {
      requireExecutable(def.path, `tool "${def.id}"`);
    } catch (e) {
      throw new Error(e.message);
    }
    const cwd = def.cwd || os.homedir();
    let st0;
    try {
      st0 = fs.statSync(cwd);
    } catch {
      st0 = null;
    }
    if (!st0 || !st0.isDirectory()) throw new Error(`tool "${def.id}": its working directory ${cwd} does not exist`);
    if (st.tools.size >= MAX_CONCURRENT_TOOLS) throw new Error(`too many tools are running (limit ${MAX_CONCURRENT_TOOLS})`);
    const shell = def.kind === 'shell';
    if (shell) this._requireUi('shellStarted');
    rec.detail = clip(`${def.id} ${show(argv, 140)}`);
    await this._ensurePanic();

    // The run is registered before anything starts, so a panic during the badge call still reaches it. A shell tool's
    // badge is shown BEFORE the process starts.
    const runId = crypto.randomBytes(6).toString('hex');
    const run = { handle: null, def, since: Date.now(), killReason: null };
    st.tools.set(runId, run);
    const appInfo = this._appInfo(st);
    const toolInfo = { id: def.id, name: def.name };
    let badge = false;
    let res;
    try {
      if (shell) {
        try {
          await this.ui.shellStarted({ app: appInfo, tool: toolInfo, runId, detail: rec.detail });
          badge = true;
        } catch (e) {
          throw new Error(`cannot show the control badge: ${e.message}`);
        }
      }
      if (run.killReason) throw new Error(`tool "${def.id}" was stopped (${run.killReason})`);
      if (st.closed) throw new Error('permission denied: the app is stopping');
      run.handle = hostproc.startProcess(def.path, argv, { cwd, env: hostproc.cleanEnv(), stdin, timeoutMs: def.timeoutMs, maxOutputBytes: def.maxOutputBytes });
      this.emit('active-changed');
      try {
        res = await run.handle.done;
      } catch (e) {
        throw new Error(`tool "${def.id}" could not be started: ${e.code || e.message}`);
      }
    } finally {
      st.tools.delete(runId);
      if (badge) {
        try {
          const r = this.ui.shellStopped({ app: appInfo, tool: toolInfo, runId });
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
          /* the badge must not block the result */
        }
      }
      this.emit('active-changed');
    }
    if (res.killedBy) throw new Error(`tool "${def.id}" was stopped (${res.killedBy})`);
    rec.detail = clip(`${rec.detail} -> exit ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}`);
    return fitResult({ exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated, timedOut: res.timedOut, signal: res.signal });
  }

  // ---------------------------------------------------------------------------------------------- MCP

  /** The app's own process for this server (one per app per server, started on first use). */
  _mcpServer(st, def) {
    let srv = st.mcp.get(def.id);
    if (!srv || JSON.stringify(srv.command) !== JSON.stringify(def.command) || JSON.stringify(srv.env) !== JSON.stringify(def.env)) {
      if (srv) srv.kill({ force: true });
      srv = new hostproc.McpServer({ command: def.command, env: def.env, requestTimeoutMs: this.mcpRequestTimeoutMs });
      st.mcp.set(def.id, srv);
    }
    return srv;
  }

  async _mcpTools(st, def) {
    const srv = this._mcpServer(st, def);
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await srv.request('tools/list', cursor ? { cursor } : undefined);
      if (r && Array.isArray(r.tools)) tools.push(...r.tools);
      cursor = r && typeof r.nextCursor === 'string' ? r.nextCursor : undefined;
      if (!cursor || tools.length >= 500) break;
    }
    return tools.slice(0, 500);
  }

  // ---------------------------------------------------------------------------------------------- stopping

  /** Stops what the app has running (input sessions, tools, MCP servers) without forgetting the app. */
  _stopState(st, reason) {
    this._stopAllInput(st, reason);
    for (const [, r] of st.tools) {
      r.killReason = reason;
      if (r.handle) r.handle.kill(reason);
    }
    for (const [, srv] of st.mcp) srv.kill({ force: true });
    st.mcp.clear();
  }

  /** The app stopped: end all its control, forget its state, and turn its `session` grants back into `ask`. */
  stopApp(key, reason = 'app-stopped') {
    const st = this._apps.get(key);
    if (!st) return;
    st.closed = true;
    this._stopState(st, reason);
    this._apps.delete(key);
    try {
      this.store.expireSessionHostGrants(st.ctx.appId);
    } catch (e) {
      this.emit('warning', `could not reset session grants of ${st.ctx.appId}: ${e.message}`);
    }
    this.emit('active-changed');
  }

  /** The user pressed Stop for one app (badge): ends its input sessions and running tools, keeps the app running. */
  stopControl(appId, reason = 'user') {
    for (const st of this._apps.values()) if (st.ctx.appId === appId) this._stopState(st, reason);
  }

  /**
   * Panic (the hotkey, or the badge's Stop for everything): stops every input session, kills every running tool and
   * MCP server of every app, forgets "allow for this session" answers, and emits 'panic'.
   */
  stopAll(reason = 'panic') {
    for (const st of this._apps.values()) {
      this._stopState(st, reason);
      st.approved.clear();
    }
    this.emit('panic', { reason });
  }

  /** Stops everything and the helper process. */
  async close() {
    for (const key of [...this._apps.keys()]) this.stopApp(key, 'closed');
    if (this._ctl && typeof this._ctl.close === 'function') await this._ctl.close();
  }
}

/** Keeps a tool result under the bridge line limit, cutting text and setting truncated. */
function fitResult(r) {
  const size = () => Buffer.byteLength(JSON.stringify(r));
  while (size() > MAX_RESULT_BYTES) {
    r.truncated = true;
    if (r.stdout.length >= r.stderr.length) r.stdout = r.stdout.slice(0, Math.floor(r.stdout.length / 2));
    else r.stderr = r.stderr.slice(0, Math.floor(r.stderr.length / 2));
  }
  return r;
}

module.exports = {
  Catalog,
  CatalogError,
  HostCapabilities,
  ToolArgsError,
  validateTool,
  validateMcp,
  compilePattern,
  matchArgs,
  checkHostGrant,
  setHostGrant,
  hostRequestSummary,
  requestedEntry,
  captureArgs,
  pickedArgs,
  captureTarget,
  MCP_METHODS,
  INPUT_MAX_MS,
  MAX_RESULT_BYTES,
};
