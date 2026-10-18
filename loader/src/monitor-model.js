'use strict';
// What the live monitor shows (src/monitor.js), as plain functions without Electron so the unit tests can run them.
//
// A "pill" is one thing an app can reach right now, taken from the user's grants (never from the manifest alone): folders,
// screen, input (mouse and keyboard), mic, tools, mcp, net. `lastAt` is the time of the latest event of that kind and `live`
// says the thing is in continuous use (an input session, a live microphone). The monitor's page shows a pill as "in use" for
// 2 seconds after an event and for as long as it is live. Events are matched by kind only; their payloads are never read.

const { deviceAllowed } = require('../../hostlib/store');

const PULSE_MS = 2000;
const PILL_ORDER = ['folders', 'screen', 'input', 'mic', 'clipboard', 'ports', 'tools', 'mcp', 'gpu', 'net'];
const ACCESS_LABEL = { read: 'read only', readwrite: 'read & write', writeonly: 'write only' };
const MODE_WORDS = { ask: 'asks you every time', session: 'allowed while the app runs', always: 'always allowed' };

/** Which pill a runner event belongs to, or null. `kind` is the runner's: 'traffic' | 'exported' | 'log'. */
function pillOfEvent(kind, item) {
  if (kind === 'exported') return 'folders';
  if (kind !== 'traffic' || !item) return null;
  if (item.allowed === false) return null; // a refused attempt is not use
  if (item.kind === 'net' || item.t === 'net') return 'net';
  if ((item.kind === 'port' || item.t === 'port') && item.phase === 'conn') return 'ports'; // a forwarded connection (SPEC 8.8)
  // the GPU (SPEC 8.6): a tunnel to the sandboxed server opening, moving bytes or closing; the server starting or stopping is not use
  if ((item.kind === 'gpu' || item.t === 'gpu') && item.phase !== 'server') return 'gpu';
  if (item.t === 'grant') return 'folders';
  if (item.t === 'request' && typeof item.op === 'string' && item.op.startsWith('clipboard.')) return 'clipboard'; // the core's clipboard.*
  if (item.kind === 'host' || item.t === 'host') {
    const cap = typeof item.cap === 'string' ? item.cap : '';
    if (cap === 'screen') return 'screen';
    if (cap === 'input') return 'input';
    if (cap === 'microphone') return 'mic';
    if (cap === 'clipboard') return 'clipboard';
    if (cap.startsWith('tool:')) return 'tools';
    if (cap.startsWith('mcp:')) return 'mcp';
  }
  return null;
}

/**
 * What the user has allowed on the network for this app, as names for the hover text (`host` or `host:ports`), or null for
 * nothing. SPEC 8.3: grants/<id>.json has `network: { "<host>": { allow: true|false, ports? } }`, and only an entry that the
 * manifest requests (`permissions.network[].host`) AND the user allowed (`allow: true`) reaches the VM. A declined entry, an
 * entry the manifest does not ask for, or no entries at all: no pill.
 */
function networkNames(grants, manifest) {
  const g = grants && grants.network;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const asked = (manifest && manifest.permissions && manifest.permissions.network) || [];
  const names = [];
  for (const req of asked) {
    const e = req && g[req.host];
    if (!e || e.allow !== true) continue;
    const ports = (Array.isArray(e.ports) && e.ports.length) || e.ports === '*' ? e.ports : Array.isArray(req.ports) || req.ports === '*' ? req.ports : [443];
    names.push(`${req.host}:${ports === '*' ? '*' : ports.join(',')}`);
  }
  return names.length ? names : null;
}

const modeText = (g) => (g && MODE_WORDS[g.mode]) || 'allowed';

/**
 * The pills of one running app.
 * @param {object} o
 * @param {object} o.manifest the app's manifest
 * @param {object} o.grants   store.loadGrants(id)
 * @param {object[]} o.active the broker's active() entries of this app ({kind:'input'|'shell'})
 * @param {number} o.picks    folders chosen in dialogs during this run
 * @param {boolean} o.listening a live audio track in the app's window
 * @param {object} o.used     { <pill>: ms of the last use }
 */
function buildPills({ manifest, grants, active = [], picks = 0, listening = false, used = {} }) {
  const host = (grants && grants.host) || {};
  const out = [];
  const add = (kind, label, title, live) => out.push({ kind, label, title, live: !!live, lastAt: used[kind] || 0 });

  // folders: the ones the user chose in the permission sheet, plus the ones picked in dialogs during this run
  const chosen = ((manifest.permissions && manifest.permissions.folders) || []).filter((f) => grants && grants.folders && grants.folders[f.name]);
  if (chosen.length + picks > 0) {
    const names = chosen.map((f) => `${f.name} (${ACCESS_LABEL[grants.folders[f.name].access] || grants.folders[f.name].access})`);
    if (picks) names.push(`${picks} chosen in a dialog`);
    add('folders', `Folders ${chosen.length + picks}`, `Folders: ${names.join(', ')}`);
  }
  if (host.screen) add('screen', 'Screen', `Screen: can see your screen (${modeText(host.screen)})`);
  if (host.input) add('input', 'Input', `Input: can move the mouse and type (${modeText(host.input)})`, active.some((e) => e.kind === 'input'));
  if (deviceAllowed(manifest, grants, 'microphone')) add('mic', 'Microphone', 'Microphone: can listen through the app’s window', listening);
  if (deviceAllowed(manifest, grants, 'clipboard')) add('clipboard', 'Clipboard', 'Clipboard: can read and change what you copy');
  if (deviceAllowed(manifest, grants, 'ports')) add('ports', 'Ports', 'Ports: can open its servers on this Mac’s localhost');
  const toolCaps = Object.keys(host).filter((k) => k.startsWith('tool:'));
  if (toolCaps.length) {
    const names = toolCaps.flatMap((k) => (k === 'tool:*' ? host[k].tools || [] : [k.slice(5)]));
    add('tools', 'Tools', `Tools: ${names.join(', ') || 'none picked'}`, active.some((e) => e.kind === 'shell'));
  }
  const mcpCaps = Object.keys(host).filter((k) => k.startsWith('mcp:'));
  if (mcpCaps.length) {
    const names = mcpCaps.flatMap((k) => (k === 'mcp:*' ? host[k].servers || [] : [k.slice(4)]));
    add('mcp', 'MCP', `MCP servers: ${names.join(', ') || 'none picked'}`);
  }
  // the GPU (SPEC 8.6): the pill is there when the user allowed it (manifest asks AND the grant says "while the app runs")
  if (host.gpu && host.gpu.mode === 'session' && ((manifest.permissions && manifest.permissions.host) || []).some((h) => h.cap === 'gpu')) {
    add('gpu', 'GPU', 'GPU: can run work on your Mac’s GPU (Metal) through a sandboxed helper, while the app runs');
  }
  const net = networkNames(grants, manifest);
  if (net) add('net', 'Network', `Network: ${net.slice(0, 12).join(', ')}${net.length > 12 ? `, and ${net.length - 12} more` : ''}`);
  out.sort((a, b) => PILL_ORDER.indexOf(a.kind) - PILL_ORDER.indexOf(b.kind));
  return out;
}

module.exports = { pillOfEvent, networkNames, buildPills, PULSE_MS, PILL_ORDER };
