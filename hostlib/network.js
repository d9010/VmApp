'use strict';
// The network permission (SPEC 8.3): validation of `permissions.network`, matching, the rules handed to `vmapp-vm --net`,
// grants, what a permission sheet shows, the update diff, and the "can read folders AND send to hosts" warning
// (GOVERNANCE INV-N2, INV-N4).
//
// Enforcement is not here: `vmapp-vm` (host/src/net.rs) checks every connection against the rules this file hands it, and
// resolves names and refuses non-public addresses itself. The name syntax and the matching rules below must agree with
// that file (tests/unit/network.test.js checks the same cases).

const MAX_NETWORK_ENTRIES = 32;
const MAX_NETWORK_PORTS = 8;
const DEFAULT_PORTS = [443];
const MAX_PURPOSE = 200;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_TLDS = ['localhost', 'local', 'internal', 'localdomain', 'lan'];
const IP_PROBLEM = 'must be a host name: IP addresses are not allowed';
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

// ------------------------------------------------------------------------------------------------ names

/** Why `name` is not a valid DNS name for a rule (lower-case ASCII, two or more labels, a real top-level label), or null. */
function hostnameProblem(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 253) return 'must have 1 to 253 characters';
  if (/[:[\]%]/.test(name) || /^[0-9.]+$/.test(name)) return IP_PROBLEM;
  const labels = name.split('.');
  if (labels.length < 2) return 'needs at least two labels (like example.com)';
  for (const l of labels) {
    if (!LABEL_RE.test(l)) return 'may only use lower-case a-z, 0-9 and "-" in labels of 1 to 63 characters (write an international name in its xn-- form)';
  }
  const last = labels[labels.length - 1];
  if (/^[0-9]*x?[0-9a-f]*$/.test(last) && /^[0-9]/.test(last)) return IP_PROBLEM; // 127.1, 0x7f.0.0.1 and friends
  if (!/^[a-z]/.test(last)) return 'must end in a top-level label that starts with a letter';
  if (LOCAL_TLDS.includes(last) || name === 'home.arpa' || name.endsWith('.home.arpa')) return 'must not name this machine or a local network';
  return null;
}

/**
 * `api.example.com`, `*.example.com` or `*` -> {wildcard, any, base} where `base` is the exact host or the suffix after `*.`, and
 * `any` is `*`: every public host name (SPEC 8.3, DEV-APPS C2; the host still refuses every non-public address it resolves to).
 * Returns {problem} when invalid.
 */
function parseHostPattern(host) {
  if (typeof host !== 'string') return { problem: 'must be a string' };
  if (host === '*') return { wildcard: false, any: true, base: '' };
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    const p = hostnameProblem(base);
    if (p) return { problem: p.startsWith('needs at least two') ? 'a wildcard needs a suffix with at least two labels (like *.example.com)' : `has an invalid suffix: it ${p}` };
    return { wildcard: true, any: false, base };
  }
  const p = hostnameProblem(host);
  if (p) return { problem: p };
  return { wildcard: false, any: false, base: host };
}

// Ports are a list of numbers, or "*" (every port 1-65535).
const ANY_PORT = '*';
/** Do `ports` include `port`? */
const portsAllow = (ports, port) => ports === ANY_PORT || (Array.isArray(ports) && ports.includes(port));
/** Is every port of `sub` in `sup`? */
const portsWithin = (sub, sup) => sup === ANY_PORT || (sub !== ANY_PORT && Array.isArray(sub) && sub.every((p) => sup.includes(p)));
const copyPorts = (ports) => (ports === ANY_PORT ? ANY_PORT : ports.slice());

/** Does the rule (host pattern + ports) allow `host` on `port`? Same semantics as NetRule::matches in host/src/net.rs. */
function matchRule(entry, host, port) {
  if (!portsAllow(entry.ports, port)) return false;
  const p = parseHostPattern(entry.host);
  if (p.problem) return false;
  if (p.any) return true;
  if (!p.wildcard) return host === p.base;
  return host.length > p.base.length + 1 && host.endsWith('.' + p.base);
}

function validatePort(v, field, fail) {
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw fail(field, 'must be an integer from 1 to 65535');
  return v;
}

function validatePorts(list, field, fail) {
  if (list === ANY_PORT) return ANY_PORT;
  if (!Array.isArray(list) || list.length === 0) throw fail(field, 'must be a non-empty array of ports, or "*" (every port)');
  if (list.length > MAX_NETWORK_PORTS) throw fail(field, `must have at most ${MAX_NETWORK_PORTS} ports`);
  const seen = new Set();
  list.forEach((p, i) => {
    validatePort(p, `${field}[${i}]`, fail);
    if (seen.has(p)) throw fail(`${field}[${i}]`, `${p} is not unique`);
    seen.add(p);
  });
  return list.slice();
}

// ------------------------------------------------------------------------------------------------ the manifest

/**
 * Validates `permissions.network` and returns the normalised list `[{host, ports, purpose}]`.
 * `fail(field, problem)` makes the error to throw (manifest.js passes its ManifestError).
 */
function validateNetwork(raw, fail = (field, problem) => new NetworkError(`${field} ${problem}`)) {
  const field = 'permissions.network';
  if (!Array.isArray(raw)) throw fail(field, 'must be an array');
  if (raw.length > MAX_NETWORK_ENTRIES) throw fail(field, `must have at most ${MAX_NETWORK_ENTRIES} entries`);
  const hosts = new Set();
  return raw.map((e, i) => {
    const w = `${field}[${i}]`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw fail(w, 'must be an object');
    for (const k of Object.keys(e)) if (!['host', 'ports', 'purpose'].includes(k)) throw fail(`${w}.${k}`, 'is not a known key (unknown keys are rejected)');
    if (typeof e.host !== 'string') throw fail(`${w}.host`, 'must be a string');
    const p = parseHostPattern(e.host);
    if (p.problem) throw fail(`${w}.host`, p.problem);
    if (hosts.has(e.host)) throw fail(`${w}.host`, `"${e.host}" is not unique`);
    hosts.add(e.host);
    const ports = e.ports === undefined ? DEFAULT_PORTS.slice() : validatePorts(e.ports, `${w}.ports`, fail);
    let purpose = '';
    if (e.purpose !== undefined) {
      if (typeof e.purpose !== 'string') throw fail(`${w}.purpose`, 'must be a string');
      if ([...e.purpose].length > MAX_PURPOSE) throw fail(`${w}.purpose`, `must be at most ${MAX_PURPOSE} characters`);
      if (CONTROL_RE.test(e.purpose)) throw fail(`${w}.purpose`, 'must not contain control characters');
      purpose = e.purpose;
    }
    return { host: e.host, ports, purpose };
  });
}

// ------------------------------------------------------------------------------------------------ grants

/**
 * `grants.network`: { "<host pattern>": { allow: boolean, ports?: [..] } }. Structural checks; whether the entry exists in
 * the manifest and whether `ports` fits the request is `resolveNetwork`'s business. `fail(message)` makes the error.
 */
function validateNetworkGrants(g, fail = (m) => new NetworkError(m)) {
  if (g === null || typeof g !== 'object' || Array.isArray(g)) throw fail('grants.network must be an object');
  const out = {};
  for (const [host, v] of Object.entries(g)) {
    const p = parseHostPattern(host);
    if (p.problem) throw fail(`grants.network: invalid host "${host}": ${p.problem}`);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw fail(`grants.network.${host} must be an object {allow}`);
    for (const k of Object.keys(v)) if (!['allow', 'ports'].includes(k)) throw fail(`grants.network.${host}.${k} is not a known key`);
    if (typeof v.allow !== 'boolean') throw fail(`grants.network.${host}.allow must be a boolean`);
    const entry = { allow: v.allow };
    if (v.ports !== undefined) entry.ports = validatePorts(v.ports, `grants.network.${host}.ports`, (f, m) => fail(`${f} ${m}`));
    out[host] = entry;
  }
  return out;
}

/** The network grants of `grants`, which is either the whole grants object ({folders, host, network}) or the map itself. */
function netGrantsOf(grants) {
  if (!grants || typeof grants !== 'object') return {};
  if (grants.network !== undefined) return grants.network || {};
  if ('folders' in grants || 'host' in grants || 'askEveryTime' in grants) return {};
  return grants;
}

/** Ports a grant gives an entry: the grant's own (a subset of the request) or all requested. null if the grant is wider. */
function grantedPorts(entry, grant) {
  if (!grant || grant.allow !== true) return null;
  if (!grant.ports) return copyPorts(entry.ports);
  return portsWithin(grant.ports, entry.ports) ? copyPorts(grant.ports) : null;
}

/**
 * Checks a grant the user is about to save for one manifest entry and returns it in stored form: {allow:true|false, ports?}.
 * `spec` is {allow?: boolean (default true), ports?: number[]}. Throws NetworkError when the app does not request the host
 * or the ports are wider than requested (INV-N2: never wider than the request).
 */
function checkNetGrant(manifest, host, spec = {}) {
  const entries = (manifest && manifest.permissions && manifest.permissions.network) || [];
  const e = entries.find((x) => x.host === host);
  if (!e) throw new NetworkError(`the app does not request network access to "${host}"`);
  const out = { allow: spec.allow !== false };
  if (out.allow && spec.ports !== undefined) {
    const ports = validatePorts(spec.ports, 'ports', (f, m) => new NetworkError(`${f} ${m}`));
    if (!portsWithin(ports, e.ports)) throw new NetworkError(`ports ${portsArg(ports)} are wider than the requested ${portsArg(e.ports)}`);
    if (ports !== ANY_PORT && (e.ports === ANY_PORT || ports.length !== e.ports.length)) out.ports = ports;
  }
  return out;
}

const portsArg = (ports) => (ports === ANY_PORT ? ANY_PORT : ports.join(','));
const ruleArg = (host, ports) => `${host}:${portsArg(ports)}`;

/**
 * The rules `vmapp-vm` is started with: one per manifest entry the user allowed, with the granted ports.
 * Returns { rules: [{host, ports, arg}], args: ['host:443', ...], notes: [string] }.
 * Only manifest entries count; an allow for a host the manifest does not list, or one with more ports than requested, is
 * ignored (and noted). Nothing granted means no rules, which means no network.
 */
function resolveNetwork(manifest, grants) {
  const g = netGrantsOf(grants);
  const entries = (manifest && manifest.permissions && manifest.permissions.network) || [];
  const rules = [];
  const notes = [];
  const listed = new Set(entries.map((e) => e.host));
  for (const e of entries) {
    const grant = g[e.host];
    if (!grant || grant.allow !== true) continue;
    const ports = grantedPorts(e, grant);
    if (!ports) {
      notes.push(`network "${e.host}": granted ports are wider than requested; ignored`);
      continue;
    }
    rules.push({ host: e.host, ports, arg: ruleArg(e.host, ports) });
  }
  for (const host of Object.keys(g)) if (!listed.has(host)) notes.push(`network "${host}": the app does not request it; the grant is ignored`);
  return { rules, args: rules.map((r) => r.arg), notes };
}

/**
 * What a permission sheet / install review shows, like capabilities.hostRequestSummary:
 *   [{host, ports, purpose, wildcard, any, anyPort, insecure, odd, grant, allowed, allowedPorts}]
 * wildcard: `*.suffix`; any: `*` (every internet host); anyPort: ports "*"; insecure: port 80 (unencrypted HTTP) is included;
 * odd: ports other than 443; grant: the stored grant or null; allowed/allowedPorts: what the grant gives (nothing without one).
 */
function netRequestSummary(manifest, grants) {
  const g = netGrantsOf(grants);
  const entries = (manifest && manifest.permissions && manifest.permissions.network) || [];
  return entries.map((e) => {
    const grant = g[e.host] || null;
    const ports = grantedPorts(e, grant);
    return {
      host: e.host,
      ports: copyPorts(e.ports),
      purpose: e.purpose || '',
      wildcard: e.host.startsWith('*.'),
      any: e.host === '*',
      anyPort: e.ports === ANY_PORT,
      insecure: portsAllow(e.ports, 80),
      odd: e.ports === ANY_PORT || e.ports.some((p) => p !== 443),
      grant,
      allowed: !!ports,
      allowedPorts: ports || [],
    };
  });
}

// ------------------------------------------------------------------------------------------------ updates

/** Does `old` (an entry) allow every host `next` allows (on hosts alone, ignoring ports)? */
function hostCovers(old, next) {
  const o = parseHostPattern(old.host);
  const n = parseHostPattern(next.host);
  if (o.problem || n.problem) return false;
  if (o.any) return true;
  if (n.any) return false;
  if (!o.wildcard) return !n.wildcard && o.base === n.base;
  return n.wildcard ? n.base === o.base || n.base.endsWith('.' + o.base) : n.base.endsWith('.' + o.base);
}

/**
 * What a new version can reach that the old one could not (SPEC 8.1, 8.3): a new host or a wider wildcard, or more ports on
 * a host. A narrower request is not news (`a.example.com` under an old `*.example.com`). `removed` lists the hosts of the old
 * version that the new one no longer reaches (informational).
 * @returns {{added: {host, ports, newPorts, kind: 'host'|'ports', wildcard, any, insecure, purpose}[], removed: string[]}}
 * (`ports` and `newPorts` are lists, or "*".)
 */
function netDiff(oldManifest, newManifest) {
  const list = (m) => ((m && m.permissions && m.permissions.network) || []).filter((e) => e && typeof e.host === 'string' && (Array.isArray(e.ports) || e.ports === ANY_PORT));
  const oldList = list(oldManifest);
  const newList = list(newManifest);
  const added = [];
  for (const e of newList) {
    const covering = oldList.filter((o) => hostCovers(o, e));
    let newPorts;
    if (covering.some((o) => o.ports === ANY_PORT)) newPorts = [];
    else {
      const have = new Set(covering.flatMap((o) => o.ports));
      newPorts = e.ports === ANY_PORT ? ANY_PORT : e.ports.filter((p) => !have.has(p));
    }
    if (newPorts !== ANY_PORT && !newPorts.length) continue;
    added.push({
      host: e.host,
      ports: copyPorts(e.ports),
      newPorts,
      kind: covering.length ? 'ports' : 'host',
      wildcard: e.host.startsWith('*.'),
      any: e.host === '*',
      insecure: portsAllow(newPorts, 80),
      purpose: e.purpose || '',
    });
  }
  const removed = oldList.filter((o) => !newList.some((e) => hostCovers(e, o) && portsWithin(o.ports, e.ports))).map((o) => o.host);
  return { added, removed };
}

// ------------------------------------------------------------------------------------------------ the exfiltration warning

const quote = (s) => `“${s}”`;

function phrase(items, one, many) {
  if (items.length === 1) return `${one} ${items[0]}`;
  return `${many} ${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeSources(folders, screen) {
  const parts = [];
  if (folders.length) parts.push(phrase(folders.map(quote), 'the folder', 'the folders'));
  if (screen) parts.push('your screen');
  return parts.join(' and ');
}

function describeHosts(hosts) {
  if (hosts.includes('*')) return 'any server on the internet';
  const shown = hosts.slice(0, 3);
  const more = hosts.length - shown.length;
  const head = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : head;
}

/**
 * GOVERNANCE INV-N4: "folder + network" (or screen + network) is the exfiltration pair. Where an app can read data AND reach
 * hosts, the loader says so in words it writes itself.
 *   requested: {folders, screen, hosts}   what the manifest asks for (folders with read or readwrite access; screen capture; hosts)
 *   granted:   {folders, screen, hosts}   what the user's grants give (only when `grants` is passed)
 *   atRisk:    the manifest asks for both (install review: "could")
 *   active:    the grants give both (permission sheet: "can")
 *   message / activeMessage: the sentence for each, or null.
 */
function riskSummary(manifest, grants) {
  const perms = (manifest && manifest.permissions) || {};
  const readable = (f) => f.access === 'read' || f.access === 'readwrite';
  const askedFolders = (perms.folders || []).filter(readable).map((f) => f.name);
  const askedScreen = (perms.host || []).some((h) => h.cap === 'screen');
  const askedHosts = (perms.network || []).map((e) => e.host);
  const requested = { folders: askedFolders, screen: askedScreen, hosts: askedHosts };

  const g = grants && typeof grants === 'object' ? grants : {};
  const gf = (g.folders && typeof g.folders === 'object' && !Array.isArray(g.folders) ? g.folders : {});
  const grantedFolders = (perms.folders || [])
    .filter(readable)
    .filter((f) => gf[f.name] && (gf[f.name].access === 'read' || gf[f.name].access === 'readwrite'))
    .map((f) => f.name);
  const grantedScreen = askedScreen && !!(g.host && g.host.screen);
  const grantedHosts = resolveNetwork(manifest, g).rules.map((r) => r.host);
  const granted = { folders: grantedFolders, screen: grantedScreen, hosts: grantedHosts };

  const both = (r) => r.hosts.length > 0 && (r.folders.length > 0 || r.screen);
  const sentence = (r, verb) => `This app ${verb} read ${describeSources(r.folders, r.screen)} and send what it reads to ${describeHosts(r.hosts)}.`;
  const atRisk = both(requested);
  const active = both(granted);
  return {
    requested,
    granted,
    atRisk,
    active,
    message: atRisk ? sentence(requested, 'could') : null,
    activeMessage: active ? sentence(granted, 'can') : null,
  };
}

module.exports = {
  NetworkError,
  MAX_NETWORK_ENTRIES,
  MAX_NETWORK_PORTS,
  DEFAULT_PORTS,
  ANY_PORT,
  hostnameProblem,
  parseHostPattern,
  portsAllow,
  portsWithin,
  portsArg,
  matchRule,
  validateNetwork,
  validateNetworkGrants,
  netGrantsOf,
  grantedPorts,
  checkNetGrant,
  ruleArg,
  resolveNetwork,
  netRequestSummary,
  hostCovers,
  netDiff,
  riskSummary,
};
