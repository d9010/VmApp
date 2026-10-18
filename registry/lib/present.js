'use strict';
// How stored records are shown through the API.
//
// Display rule: only verified facts about the publisher are shown (see lib/publisher.js). The manifest's own
// `publisher` string is a claim; it is exposed only in `claimedPublisher` of the detail view, which the web UI
// does not render, and never in lists or search.

const versions = require('./versions');
const { publicView } = require('./publisher');

const ACCESS_WORDS = { read: 'read only', readwrite: 'read and change', writeonly: 'save files only' };
const iso = (ms) => new Date(ms).toISOString();

/** `api.example.com`, or `api.example.com:443,8443` when the app asks for ports other than 443 (SPEC 8.3). */
function networkLabel(e) {
  const ports = Array.isArray(e.ports) ? e.ports : [443];
  return ports.length === 1 && ports[0] === 443 ? e.host : `${e.host}:${ports.join(',')}`;
}

/** INV-H6: input control, tool:* and mcp:* are "control of your computer"; the registry says so. */
const isControl = (cap) => cap === 'input' || cap.endsWith(':*');

function permissionsSummary(p) {
  const parts = [];
  for (const f of p.folders) parts.push(`folder "${f.name}" (${ACCESS_WORDS[f.access] || f.access})`);
  if (p.dialogs) parts.push('file open/save dialogs');
  if (p.external) parts.push('open web links');
  for (const d of p.devices || []) parts.push(`${d.device} (you choose whether to allow it)`); // SPEC 8.4: the microphone
  const host = (p.host || []).filter((h) => h.cap !== 'gpu');
  if (host.some((h) => isControl(h.cap))) parts.push('control of your computer (you choose whether to allow it)'); // SPEC 8.2, INV-H6
  else if (host.length) parts.push('see your screen (you choose whether to allow it)');
  // SPEC 8.6: the GPU is not control of the computer, but it is work done on it by a helper the app drives: said in its own words
  // SPEC 8.7: with "api":"vulkan" it is the experimental Vulkan GPU in the app's VM, a different thing to allow
  const gpu = (p.host || []).find((h) => h.cap === 'gpu');
  if (gpu && gpu.api === 'vulkan') parts.push("EXPERIMENTAL: use your Mac's GPU through Vulkan inside the app's virtual machine (you choose whether to allow it)");
  else if (gpu) parts.push("run work on your Mac's GPU through a sandboxed helper (you choose whether to allow it)");
  // SPEC 8.3: the hosts the app asks to reach; the user allows each one in the loader, the default is no
  const net = p.network || [];
  if (net.length) {
    const shown = net.slice(0, 3).map(networkLabel);
    parts.push(`internet: ${shown.join(', ')}${net.length > 3 ? ` and ${net.length - 3} more` : ''} (you choose whether to allow it)`);
  }
  return parts.length ? parts.join(', ') : 'none';
}

/** The record shown as the app's latest: the newest version that is not withdrawn (see lib/versions.js). */
function latestVersion(app) {
  return app.versions[versions.displayVersion(app)];
}

/** {reason, at} for a withdrawn version, else null. Old records without the field are not withdrawn. */
function withdrawnView(rec) {
  return versions.isWithdrawn(rec) ? { reason: rec.withdrawn.reason, at: iso(rec.withdrawn.at) } : null;
}

/** One entry of GET /api/apps/:id/versions (SPEC 8.1). */
function versionEntry(x) {
  return { version: x.version, packageId: x.packageId, sha256: x.sha256, size: x.size, publishedAt: iso(x.publishedAt), withdrawn: withdrawnView(x) };
}

function listItem(db, app) {
  const v = latestVersion(app);
  const m = v.meta.manifest;
  return {
    id: app.id,
    name: m.name,
    publisher: publicView(db.getPublisher(app.publisherId)),
    description: m.description,
    latestVersion: v.version,
    runtime: m.runtime,
    downloads: db.appDownloads(app),
    downloads30d: db.downloads30d(app),
    createdAt: iso(app.createdAt),
    updatedAt: iso(app.updatedAt),
    sizeBytes: v.size,
    permissionsSummary: permissionsSummary(m.permissions),
  };
}

function details(db, app) {
  const v = latestVersion(app);
  const m = v.meta.manifest;
  const list = versions.sortedDesc(app).map((x) => Object.assign(versionEntry(x), { downloads: db.versionDownloads(app, x.version) }));
  const manifest = Object.assign({}, m, { files: v.meta.files });
  delete manifest.publisher; // an unverified claim: see claimedPublisher
  return Object.assign(listItem(db, app), {
    packageId: v.packageId,
    claimedPublisher: m.publisher, // NOT verified. Shown by no UI.
    manifest,
    permissions: {
      folders: m.permissions.folders.map((f) => ({ name: f.name, access: f.access, purpose: f.purpose })),
      dialogs: m.permissions.dialogs,
      external: m.permissions.external,
      devices: (m.permissions.devices || []).map((d) => ({ device: d.device, purpose: d.purpose })),
      // SPEC 8.2 (INV-H6): what the app asks to do on the computer; `control` marks input, tool:* and mcp:*
      host: (m.permissions.host || []).map((h) => ({ cap: h.cap, purpose: h.purpose, control: isControl(h.cap) })),
      // SPEC 8.3: the hosts the app asks to reach (wildcards and port 80 are marked); nothing is allowed until the user says so
      network: (m.permissions.network || []).map((e) => ({
        host: e.host,
        ports: e.ports,
        purpose: e.purpose,
        wildcard: e.host.startsWith('*.'),
        insecure: Array.isArray(e.ports) && e.ports.includes(80),
      })),
    },
    versions: list,
  });
}

module.exports = { listItem, details, permissionsSummary, latestVersion, versionEntry, withdrawnView, iso };
