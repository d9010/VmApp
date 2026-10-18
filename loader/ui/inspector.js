'use strict';
/* global h, fmtTime, inspector */
// Bridge inspector: a read-only, DevTools-like view of what passes through the loader for one running app.
// Data arrives from the main process (hostlib AppSession 'traffic' / 'log' / 'exported' events); nothing here can
// change the app or the bridge.

const MAX_ROWS = 3000;
const MAX_LOG = 1500;

const $ = (id) => document.getElementById(id);
const appSelect = $('app-select');
const rowsEl = $('rows');
const tablewrap = document.querySelector('.tablewrap');

let apps = [];
let current = null; // app id
let tab = 'traffic';
let paused = false;
let filterText = '';
let hostOnly = false; // the "Host" filter: only kind:'host' rows (what the app did on the computer)
let netOnly = false; // the "Network" filter: only kind:'net' rows (connections through the allowlist proxy, SPEC 8.3)
let gpuOnly = false; // the "GPU" filter: only kind:'gpu' rows (the sandboxed GPU server and the connections to it, SPEC 8.6)
let selectedSeq = null;
let trafficCount = 0;
let filesCount = 0;
const rowBySeq = new Map(); // seq -> { ev, tr }

// ---------------------------------------------------------------------------------------------- traffic
const ARROW = { 'to-core': '→', 'from-core': '←', host: '•' };
const ARROW_TITLE = { 'to-core': 'host → core', 'from-core': 'core → host', host: 'loader' };

const isHost = (ev) => ev.kind === 'host' || ev.t === 'host';
// network rows (SPEC 8.3): one per connection the app made through the allowlist proxy, allowed or refused. Names, ports and byte
// counts only; the contents of a connection are never visible to the loader (TLS is end to end).
const isNet = (ev) => ev.kind === 'net' || ev.t === 'net';
// port-forward rows (SPEC 8.8): a forward starting or stopping, and each forwarded connection with its byte counts
const isPort = (ev) => ev.kind === 'port' || ev.t === 'port';
const PORT_PHASE = { listen: 'forwarding', conn: 'connection', stop: 'stopped' };
// GPU rows (SPEC 8.6): the sandboxed server starting or stopping ({phase:'server', op}), and each tunnel to it opening, moving bytes and
// closing ({phase:'connect'|'traffic'|'disconnect', bytesUp, bytesDown}). Byte counts only: what the app sends the GPU is never read.
const isGpu = (ev) => ev.kind === 'gpu' || ev.t === 'gpu';
const gpuBytes = (ev) => isGpu(ev) && ev.phase !== 'server';
// host rows read "<capability> <op>" (screen host.screen.capture); network rows read "<host>:<port>"; GPU rows read "gpu <phase> #<id>";
// no payload is ever part of them
const chanOf = (ev) =>
  isHost(ev)
    ? `${ev.cap || ''} ${ev.op || ''}`.trim()
    : isNet(ev)
      ? `${ev.window ? 'window ' : ''}${ev.host || '?'}:${ev.port === undefined ? '?' : ev.port}`
      : isPort(ev)
        ? `${PORT_PHASE[ev.phase] || ev.phase} VM port ${ev.port} ⇄ localhost:${ev.hostPort}`
        : isGpu(ev)
          ? ev.phase === 'server' ? `gpu server ${ev.op || ''}`.trim() : `gpu ${ev.phase}${ev.id === undefined ? '' : ` #${ev.id}`}`
          : ev.channel || ev.op || ev.event || '';
const matches = (ev) => {
  if ((hostOnly || netOnly || gpuOnly) && !((hostOnly && isHost(ev)) || (netOnly && isNet(ev)) || (gpuOnly && isGpu(ev)))) return false;
  return !filterText || `${ev.t} ${ev.channel || ''} ${ev.op || ''} ${ev.cap || ''} ${ev.host || ''} ${ev.reason || ''} ${ev.event || ''} ${ev.dir} ${ev.preview || ''}`.toLowerCase().includes(filterText);
};

/** 1234 -> "1.2 KiB" (bytes of a connection, shown up and down). */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KiB`;
  return `${v} B`;
}

/**
 * The result column. A refusal is ALWAYS "denied" (security visibility): the broker sets `error` on a refused request too (it
 * throws "permission denied: ..."), so `error` alone must never turn a refusal into something softer. "failed" is only for a
 * request that was allowed and then did not work (a GPU server that would not start, a tool that could not run).
 */
const verdict = (ev) => (!ev.allowed ? 'denied' : ev.error ? 'failed' : 'allowed');

function trafficRow(ev) {
  const host = isHost(ev);
  const net = isNet(ev);
  const gpu = isGpu(ev);
  const counted = net || gpuBytes(ev) || (isPort(ev) && ev.phase === 'conn'); // rows that show bytes up and down
  const decided = host || net || gpu; // rows that say allowed / denied
  const tr = h(
    'tr',
    { class: `row${ev.error ? ' err' : ''}${host ? ' host' : ''}${net ? ' net' : ''}${gpu ? ' gpu' : ''}${matches(ev) ? '' : ' hidden'}`, dataset: { seq: ev.seq, t: ev.t, dir: ev.dir } },
    h('td', { class: 'mono' }, fmtTime(ev.ts)),
    h('td', { class: ev.dir === 'to-core' ? 'dir-to' : ev.dir === 'from-core' ? 'dir-from' : '', title: ARROW_TITLE[ev.dir] || ev.dir }, ARROW[ev.dir] || '?'),
    h('td', {}, ev.t),
    h('td', { title: (net || gpu) && ev.reason ? `${chanOf(ev)}: ${ev.reason}` : chanOf(ev), dataset: { role: net ? 'net-target' : gpu ? 'gpu-target' : 'chan' } }, chanOf(ev), (net || gpu) && ev.reason ? h('span', { class: 'reason', dataset: { role: net ? 'net-reason' : 'gpu-reason' } }, ` — ${ev.reason}`) : null),
    h('td', { class: 'num' }, ev.win === undefined ? '' : String(ev.win)),
    counted
      ? h('td', { class: 'num', title: `${ev.bytesUp || 0} bytes up, ${ev.bytesDown || 0} bytes down`, dataset: { role: net ? 'net-bytes' : 'gpu-bytes' } }, `↑${fmtBytes(ev.bytesUp)} ↓${fmtBytes(ev.bytesDown)}`)
      : h('td', { class: 'num' }, ev.bytes ? String(ev.bytes) : ''),
    h('td', { class: 'num' }, ev.durationMs === undefined ? '' : `${ev.durationMs} ms`),
    h('td', { class: decided ? (ev.allowed && !ev.error ? 'res-allowed' : 'res-denied') : '', dataset: { role: 'host-result' } }, decided ? verdict(ev) : ''),
  );
  tr.addEventListener('click', () => select(ev.seq));
  return tr;
}

// An event can reach the page twice (in the snapshot and in a live batch queued before it): seq is monotonic, so
// anything at or below the last seen seq of its kind is a duplicate.
const lastSeq = { traffic: 0, log: 0, exported: 0 };
function fresh(kind, item) {
  if (item.seq <= lastSeq[kind]) return false;
  lastSeq[kind] = item.seq;
  return true;
}

function addTraffic(ev) {
  if (!fresh('traffic', ev)) return;
  const nearBottom = tablewrap.scrollTop + tablewrap.clientHeight >= tablewrap.scrollHeight - 30;
  const tr = trafficRow(ev);
  rowsEl.appendChild(tr);
  rowBySeq.set(ev.seq, { ev, tr });
  trafficCount++;
  while (rowsEl.childElementCount > MAX_ROWS) {
    const first = rowsEl.firstElementChild;
    rowBySeq.delete(Number(first.dataset.seq));
    first.remove();
  }
  if (nearBottom) tablewrap.scrollTop = tablewrap.scrollHeight;
  updateCounts();
}

function select(seq) {
  if (selectedSeq !== null && rowBySeq.has(selectedSeq)) rowBySeq.get(selectedSeq).tr.classList.remove('selected');
  selectedSeq = seq;
  const rec = rowBySeq.get(seq);
  if (!rec) return;
  rec.tr.classList.add('selected');
  const ev = rec.ev;
  $('detail-empty').hidden = true;
  $('detail-body').hidden = false;
  const meta = $('detail-meta');
  meta.replaceChildren();
  const add = (k, v) => {
    if (v === undefined || v === '') return;
    meta.appendChild(h('dt', {}, k));
    meta.appendChild(h('dd', {}, String(v)));
  };
  add('Time', new Date(ev.ts).toISOString());
  add('Direction', isNet(ev) && ev.window ? 'window → internet (through the app’s proxy)' : ARROW_TITLE[ev.dir] || ev.dir);
  add('Type', ev.t);
  add('Id', ev.id);
  add('Window', ev.win);
  add('Channel', ev.channel);
  add('Capability', ev.cap);
  add('Op', ev.op);
  if (isHost(ev)) add('Result', ev.allowed ? 'allowed' : 'denied by the loader or the user');
  if (isNet(ev)) {
    add('From', ev.window ? "the app's window (through the app's proxy)" : "the app's core, in the VM");
    add('Host', ev.host);
    add('Port', ev.port);
    add('Result', ev.allowed ? 'allowed' : 'denied (the host refused the connection)');
    add('Bytes up', `${ev.bytesUp || 0} (from the app)`);
    add('Bytes down', `${ev.bytesDown || 0} (to the app)`);
    add('Reason', ev.reason);
  }
  if (isGpu(ev)) {
    if (ev.phase === 'server') {
      add('GPU server', ev.op === 'start' ? (ev.error ? 'could not be started' : 'started (sandboxed, on 127.0.0.1 only)') : 'stopped');
      add('Port', ev.port);
      add('Process', ev.pid);
      add('Why', ev.reason || ev.message);
    } else {
      add('GPU connection', `#${ev.id}: ${ev.phase}`);
      add('Result', ev.allowed ? 'allowed' : 'denied (the host refused the connection)');
      add('Bytes up', `${ev.bytesUp || 0} (from the app)`);
      add('Bytes down', `${ev.bytesDown || 0} (to the app)`);
      add('Reason', ev.reason);
    }
  }
  add('Event', ev.event);
  if (!isNet(ev)) add('Bytes', ev.bytes);
  add('Duration', ev.durationMs === undefined ? undefined : `${ev.durationMs} ms`);
  add('Error', ev.error ? 'yes' : undefined);
  let text = ev.preview || '';
  try {
    text = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    if (ev.bytes && ev.bytes > text.length) text += '\n… (truncated)';
  }
  $('detail-pre').textContent = text;
}

function applyFilter() {
  for (const { ev, tr } of rowBySeq.values()) tr.classList.toggle('hidden', !matches(ev));
}

function updateCounts() {
  $('count-traffic').textContent = trafficCount ? `(${trafficCount})` : '';
  $('count-files').textContent = filesCount ? `(${filesCount})` : '';
  $('status').textContent = paused ? 'Paused: new messages are not shown (they are still recorded).' : '';
}

// ---------------------------------------------------------------------------------------------- log + files
const logEl = $('log-events');

function addLog(item) {
  if (!fresh('log', item)) return;
  const line = h(
    'div',
    { class: `ll ${item.level}`, dataset: { level: item.level } },
    `${fmtTime(item.ts)} `,
    h('span', { class: 'src' }, `[${item.source}] ${item.level}: `),
    item.message,
  );
  const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG) logEl.firstElementChild.remove();
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function addFile(item) {
  if (!fresh('exported', item)) return;
  filesCount++;
  $('files-empty').hidden = true;
  $('files-rows').appendChild(h('tr', { dataset: { share: item.share } }, h('td', { class: 'mono' }, fmtTime(item.ts)), h('td', {}, item.share), h('td', { class: 'mono' }, (item.files || []).join(', '))));
  updateCounts();
}

async function pollConsole() {
  if (tab !== 'log' || !current) return;
  try {
    const lines = await inspector.consoleTail(current);
    const box = $('console-tail');
    const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.textContent = lines.join('\n');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------- app selection
function resetViews() {
  rowsEl.replaceChildren();
  rowBySeq.clear();
  selectedSeq = null;
  trafficCount = 0;
  filesCount = 0;
  lastSeq.traffic = lastSeq.log = lastSeq.exported = 0;
  logEl.replaceChildren();
  $('files-rows').replaceChildren();
  $('files-empty').hidden = false;
  $('console-tail').textContent = '';
  $('detail-empty').hidden = false;
  $('detail-body').hidden = true;
  updateCounts();
}

async function selectApp(id) {
  current = id || null;
  resetViews();
  if (!current) return;
  appSelect.value = current;
  updateStateLabel();
  const snap = await inspector.snapshot(current);
  if (current !== id) return;
  for (const ev of snap.traffic) addTraffic(ev);
  for (const l of snap.log) addLog(l);
  for (const f of snap.exported) addFile(f);
  tablewrap.scrollTop = tablewrap.scrollHeight;
  pollConsole();
}

function updateStateLabel() {
  const a = apps.find((x) => x.id === current);
  $('app-state').textContent = a ? a.state : '';
}

function setApps(list, keep) {
  apps = list;
  const prev = current;
  appSelect.replaceChildren(...(apps.length ? apps.map((a) => h('option', { value: a.id }, `${a.name} (${a.state})`)) : [h('option', { value: '' }, 'no app has run yet')]));
  if (keep && prev && apps.some((a) => a.id === prev)) appSelect.value = prev;
  updateStateLabel();
}

function setTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  $('view-traffic').hidden = name !== 'traffic';
  $('view-log').hidden = name !== 'log';
  $('view-files').hidden = name !== 'files';
  if (name === 'log') pollConsole();
}

// ---------------------------------------------------------------------------------------------- wiring
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
appSelect.addEventListener('change', () => selectApp(appSelect.value));
$('filter').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  applyFilter();
});
$('btn-host').addEventListener('click', (e) => {
  hostOnly = !hostOnly;
  e.currentTarget.setAttribute('aria-pressed', String(hostOnly));
  applyFilter();
});
$('btn-net').addEventListener('click', (e) => {
  netOnly = !netOnly;
  e.currentTarget.setAttribute('aria-pressed', String(netOnly));
  applyFilter();
});
$('btn-gpu').addEventListener('click', (e) => {
  gpuOnly = !gpuOnly;
  e.currentTarget.setAttribute('aria-pressed', String(gpuOnly));
  applyFilter();
});
$('btn-pause').addEventListener('click', (e) => {
  paused = !paused;
  e.target.textContent = paused ? 'Resume' : 'Pause';
  updateCounts();
});
$('btn-clear').addEventListener('click', async () => {
  if (current) await inspector.clear(current).catch(() => {});
  resetViews();
});

inspector.onEvents((batch) => {
  for (const { appId, kind, item } of batch) {
    if (appId !== current) continue;
    if (kind === 'traffic') {
      if (!paused) addTraffic(item);
    } else if (kind === 'log') addLog(item);
    else if (kind === 'exported') addFile(item);
  }
});
inspector.onApps((list) => {
  setApps(list, true);
  // opened before any app had run: the list now has one and the dropdown shows it, so the view must follow it
  if (!current && apps.length) selectApp((apps.find((a) => a.state !== 'stopped') || apps[0]).id);
});
inspector.onSelect(({ appId, tab: t }) => {
  if (t) setTab(t);
  if (appId && appId !== current) {
    if (!apps.some((a) => a.id === appId)) inspector.apps().then((l) => { setApps(l, false); selectApp(appId); });
    else selectApp(appId);
  }
});

(async function init() {
  const q = new URLSearchParams(location.search);
  setApps(await inspector.apps(), false);
  if (q.get('tab')) setTab(q.get('tab'));
  const want = q.get('app');
  const first = (want && apps.find((a) => a.id === want)) || apps.find((a) => a.state !== 'stopped') || apps[0];
  if (first) await selectApp(first.id);
  setInterval(pollConsole, 1000);
})();
