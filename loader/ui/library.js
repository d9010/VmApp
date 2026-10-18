'use strict';
/* global h, loader */
// The library: installed apps as cards, the install review, the permission sheet, confirmations.
// All text from manifests is inserted as text nodes (see dom.js). Decisions are made here, in loader UI only.

const ACCESS_LABEL = { read: 'read only', readwrite: 'read & write', writeonly: 'write only' };
const STATE_LABEL = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…' };

let apps = [];
let control = []; // who controls the computer right now: [{kind:'input'|'shell', appId, appName}]
let examplesState = { show: false, available: false }; // "Load examples": {show, available, count, dir?} (src/examples.js infoOf)
let examplesLive = null; // the open "Load examples" sheet's handler for install progress
const bannersEl = document.getElementById('banners');
const appsEl = document.getElementById('apps');
const controlEl = document.getElementById('control-bar');
const activityEl = document.getElementById('activity');
const modalRoot = document.getElementById('modal-root');

// ---------------------------------------------------------------------------------------------- host capabilities (SPEC 8.2)
// The words for what an app may ask for. Apps never choose any of this text.
const HOST_WORDS = {
  screen: 'See your screen (screenshots, the list of open windows)',
  input: 'Control your mouse and keyboard',
  'tool:*': 'Run tools from your own catalog (you pick which)',
  'mcp:*': 'Use MCP servers from your own catalog (you pick which)',
  gpu: 'Run work on your Mac’s GPU (Metal), through a sandboxed helper',
};
// SPEC 8.7: the Vulkan GPU is another thing to allow than the llama.cpp helper (the manifest's `api: "vulkan"`), and it is experimental.
const VULKAN_WORDS = 'EXPERIMENTAL: Use your Mac’s GPU through Vulkan, inside the app’s virtual machine';
const isVulkan = (x) => !!x && x.api === 'vulkan';
function hostWords(cap, x) {
  if (cap === 'gpu' && isVulkan(x)) return VULKAN_WORDS;
  if (HOST_WORDS[cap]) return HOST_WORDS[cap];
  if (cap.startsWith('tool:')) return `Run the tool “${cap.slice(5)}” from your catalog`;
  if (cap.startsWith('mcp:')) return `Use the MCP server “${cap.slice(4)}” from your catalog`;
  return cap;
}
const hostShort = (cap) => (cap === 'screen' ? 'screen' : cap === 'input' ? 'mouse and keyboard' : cap === 'gpu' ? 'GPU' : cap === 'tool:*' ? 'tools' : cap === 'mcp:*' ? 'MCP servers' : cap.startsWith('tool:') ? `tool ${cap.slice(5)}` : `MCP server ${cap.slice(4)}`);
const MODE_WORDS = { ask: 'asks you every time', session: 'allowed while the app runs', always: 'always allowed' };
function grantWords(x) {
  if (!x.grant) return 'not allowed';
  let t = MODE_WORDS[x.grant.mode] || x.grant.mode;
  const picked = x.grant.tools || x.grant.servers;
  if (picked) t += picked.length ? ` (${picked.join(', ')})` : ' (nothing picked)';
  return t;
}
/** True when a requested capability is more than just seeing the screen (or using the GPU, which is neither: SPEC 8.6). */
const controls = (x) => x.risk !== 'screen' && x.risk !== 'gpu';

// ---------------------------------------------------------------------------------------------- devices (SPEC 2.2, SPEC 7)
// The words for the one device that exists today. The camera is reserved and cannot be requested. Apps never choose this text.
const DEVICE_WORDS = {
  microphone: 'Use your microphone (the app’s window can listen and record sound)',
  clipboard: 'Read and change what you copy (the clipboard)',
  ports: 'Open its servers on this Mac (localhost)',
};
// what each device lets the app do, said in the sheet under the device (loader words, INV-B5)
const DEVICE_DETAIL = {
  microphone: ['listens to you', 'If you allow it, the app’s window can hear your microphone for as long as the app runs, and the app can pass what it hears to its own core. The loader shows a red label on the app’s card and in the activity monitor while it listens, and macOS shows its own microphone indicator. macOS also asks you the first time. The camera is never available.'],
  clipboard: ['sees what you copy', 'If you allow it, the app (its window and the programs in its VM) can read whatever you copy, at any time while it runs, and replace it; with internet access it could send it out. Copy and paste with the keyboard (⌘C, ⌘V) work without this. Every read and write is listed in the Bridge Inspector.'],
  ports: ['opens servers on localhost', 'If you allow it, a server the app runs in its VM (a development server, a preview) can be opened on this Mac’s localhost, so your browser can show it. Only this Mac can connect, never your network; but other programs on this Mac can connect to these ports too while they are open. They close when the app stops. Each one, and every connection, is listed in the Bridge Inspector.'],
};
const deviceWords = (d) => DEVICE_WORDS[d] || d;
// SPEC 2.2 ui.features, SPEC 7 "Window features": in the loader's words, never the app's
const FEATURE_WORDS = {
  workers: 'background workers',
  wasm: 'WebAssembly',
  'self-fetch': 'reading its own files',
  frames: 'isolated frames for web content (no access to the app or to your computer)',
};
const featureWords = (list) =>
  list.length ? `the standard sandbox, plus ${list.map((f) => FEATURE_WORDS[f] || f).join(', ')}; still no network, files or devices of its own` : 'the standard sandbox';
const deviceGrantWords = (x) => (x.grant ? 'allowed while the app runs' : 'not allowed');

// ---------------------------------------------------------------------------------------------- network (SPEC 8.3)
// The words for the hosts an app asks to reach. An app supplies only the host names, ports and its reason; every sentence here is
// the loader's (INV-B5, INV-N4). Nothing is allowed until the user says so: the default is “Don’t allow”.
const wildcardBase = (host) => host.replace(/^\*\./, '');
const wildcardWords = (host) => `Wildcard: any address under ${wildcardBase(host)}. It covers many servers, not one, so you are trusting all of them.`;
// `*` (DEV-APPS C2): every public host. The address check still applies, so the words can promise the LAN and this Mac stay out.
const anyHostWords =
  'Any server on the internet: the app can connect to every public address there is, and send there anything it can read. Your local network and this Mac stay unreachable.';
const portWords = (p) => (p === 80 ? '80 (not encrypted)' : String(p));
/** “port 443”, “ports 443, 8443”, with port 80 marked; “any port” for "*". */
const portsText = (ports) => (ports === '*' ? 'any port (including 80, not encrypted)' : `${ports.length === 1 ? 'port' : 'ports'} ${ports.map(portWords).join(', ')}`);
const hostText = (host) => (host === '*' ? 'any server on the internet' : host);
/** The state of one requested host for the card and the summary line. */
function netGrantWords(x) {
  if (x.allowed) return `allowed on ${portsText(x.allowedPorts)}`;
  if (x.grant && x.grant.allow === false) return 'not allowed';
  return 'not allowed';
}
const netAllowedList = (a) => (a.network || []).filter((x) => x.allowed);

// ---------------------------------------------------------------------------------------------- the VM's size (SPEC 2.2, 8)
// The manifest only RECOMMENDS the vCPUs and the memory; the user chooses (the permission sheet and the card). The defaults are
// one vCPU and the recommended memory. “MB” in these words is MiB.
const memWords = (m) => `${m} MB`;
const sizeWords = (s) => `${s.cpus} vCPU${s.cpus === 1 ? '' : 's'}, ${memWords(s.memoryMiB)}`;

// ---------------------------------------------------------------------------------------------- banners
function banner(kind, text) {
  const el = h('div', { class: `banner ${kind}` }, h('span', {}, text), h('button', { title: 'Dismiss', onclick: () => el.remove() }, '×'));
  bannersEl.appendChild(el);
  if (kind === 'info') setTimeout(() => el.remove(), 8000);
}
const fail = (e) => banner('error', e && e.message ? e.message : String(e));
const guarded = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    fail(e);
  }
};

// ---------------------------------------------------------------------------------------------- modal
let closeModal = null;

// `wide`: a wider sheet (lists). `canClose()`: false while the sheet is busy, so Escape does not drop its result.
function openModal({ title, body, buttons, onCancel, wide, canClose }) {
  if (closeModal) closeModal();
  const btns = (buttons || []).map((b) =>
    h(
      'button',
      {
        class: b.kind || '',
        dataset: { action: b.action },
        disabled: !!b.disabled,
        onclick: b.onclick,
      },
      b.label,
    ),
  );
  const sheet = h('div', { class: wide ? 'sheet wide' : 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('h2', {}, title), body, h('div', { class: 'foot' }, btns));
  const overlay = h('div', { class: 'overlay' }, sheet);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (canClose && !canClose()) return;
      close();
      if (onCancel) onCancel();
    }
  };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (closeModal === close) closeModal = null;
  }
  document.addEventListener('keydown', onKey);
  modalRoot.appendChild(overlay);
  closeModal = close;
  return { close, sheet, buttons: btns };
}

// ---------------------------------------------------------------------------------------------- cards
function permSummary(a) {
  const rows = [];
  if (a.folders.length) {
    rows.push(
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'k' }, 'Folders'),
        h('span', {}, a.folders.map((f) => `${f.name} (${ACCESS_LABEL[f.access]})`).join(', ')),
      ),
    );
    const granted = a.folders.map((f) => {
      if (f.grant === undefined) return `${f.name}: not decided yet`;
      if (f.grant === null) return `${f.name}: skipped`;
      return `${f.name}: ${f.grant.path} (${ACCESS_LABEL[f.grant.access]})`;
    });
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Your choice'), h('span', { class: 'mono', dataset: { role: 'grants' } }, granted.join('  •  '))));
  } else {
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Folders'), h('span', {}, 'none requested')));
  }
  const other = [];
  if (a.dialogs) other.push('open/save dialogs (you pick each file or folder)');
  if (a.external) other.push('open links in your browser (you confirm each one)');
  rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Also'), h('span', {}, other.length ? other.join('; ') : 'nothing')));
  if ((a.host || []).length) {
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Computer'), h('span', { class: 'hostline', dataset: { role: 'host-requested' } }, `asks to: ${a.host.map((x) => hostShort(x.cap)).join(', ')}`)));
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Your choice'), h('span', { class: 'mono', dataset: { role: 'host-grants' } }, a.host.map((x) => `${x.cap}: ${grantWords(x)}`).join('  •  '))));
  }
  if ((a.devices || []).length) {
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Devices'), h('span', { dataset: { role: 'devices-requested' } }, `asks to use: ${a.devices.map((x) => x.device).join(', ')}`)));
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Your choice'), h('span', { class: 'mono', dataset: { role: 'devices-grants' } }, a.devices.map((x) => `${x.device}: ${deviceGrantWords(x)}`).join('  •  '))));
  }
  if ((a.network || []).length) {
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Network'), h('span', { dataset: { role: 'net-requested' } }, `asks to reach: ${a.network.map((x) => hostText(x.host)).join(', ')}`)));
    rows.push(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Your choice'), h('span', { class: 'mono', dataset: { role: 'net-grants' } }, a.network.map((x) => `${hostText(x.host)}: ${netGrantWords(x)}`).join('  •  '))));
  }
  return h('div', { class: 'perms' }, rows);
}

/** Amber chip: the user has allowed this app to reach the internet (always true: it comes from the grants, SPEC 8.3). */
function netChips(a) {
  const allowed = netAllowedList(a);
  if (!allowed.length) return [];
  return [h('span', { class: 'chip amber', title: `Allowed: ${allowed.map((x) => `${hostText(x.host)} (${portsText(x.allowedPorts)})`).join('; ')}`, dataset: { role: 'net-chip' } }, allowed.some((x) => x.any) ? 'Can reach any server' : 'Can reach the internet')];
}

/** The loader's warning on the card when the user's grants let the app read folders (or the screen) AND reach hosts (INV-N4). */
function netRiskBox(a) {
  if (!a.risk || !a.risk.active) return null;
  return h('div', { class: 'warnbox', dataset: { role: 'net-risk-active' } }, a.risk.activeMessage);
}

// ---- the Resources row (SPEC 2.2, 8): vCPUs stepper, memory select, “Use recommended”, a warning below the recommendation ----
/**
 * The controls for the VM's size. `res` is the library's resource summary {recommended, limits, current, custom, memoryChoices}.
 * opts.disabled: the app is running (a VM cannot change size). opts.onChange({cpus, memoryMiB}): the user changed something.
 * Returns {el, get(), touched()}: the current values, and whether the user changed anything since it was drawn.
 */
function resourcesControl(res, opts = {}) {
  const lim = res.limits;
  const rec = res.recommended;
  const dis = !!opts.disabled;
  const target = { cpus: Math.min(rec.cpus, lim.cpus), memoryMiB: Math.min(rec.memoryMiB, lim.memoryMiB) };
  const st = { cpus: res.current.cpus, memoryMiB: res.current.memoryMiB, touched: false, custom: !!res.custom };
  const cpuIn = h('input', { type: 'number', min: '1', max: String(lim.cpus), step: '1', value: String(st.cpus), disabled: dis, 'aria-label': 'vCPUs', dataset: { role: 'res-cpus' } });
  const dec = h('button', { type: 'button', title: 'Fewer vCPUs', 'aria-label': 'Fewer vCPUs', dataset: { action: 'cpus-dec' } }, '−');
  const inc = h('button', { type: 'button', title: 'More vCPUs', 'aria-label': 'More vCPUs', dataset: { action: 'cpus-inc' } }, '+');
  const memSel = h(
    'select',
    { disabled: dis, 'aria-label': 'Memory', dataset: { role: 'res-memory' } },
    res.memoryChoices.map((m) => h('option', { value: String(m) }, memWords(m) + (m === rec.memoryMiB ? ' (recommended)' : ''))),
  );
  memSel.value = String(st.memoryMiB);
  const recBtn = h('button', { type: 'button', title: lim.cpus < rec.cpus || lim.memoryMiB < rec.memoryMiB ? 'Lowered to what this Mac allows' : '', dataset: { action: 'use-recommended' } }, `Use recommended (${sizeWords(rec)})`);
  const source = h('span', { class: 'muted sub', dataset: { role: 'res-source' } });
  const warn = h('div', { class: 'warn sub', dataset: { role: 'res-warning' } });
  const note = h('div', { class: 'muted sub', dataset: { role: 'res-note' } });
  const sync = () => {
    cpuIn.value = String(st.cpus);
    memSel.value = String(st.memoryMiB);
    dec.disabled = dis || st.cpus <= 1;
    inc.disabled = dis || st.cpus >= lim.cpus;
    recBtn.disabled = dis || (st.cpus === target.cpus && st.memoryMiB === target.memoryMiB);
    source.textContent = st.custom ? 'your choice' : 'default';
    warn.textContent = st.memoryMiB < rec.memoryMiB ? `That is less memory than the ${memWords(rec.memoryMiB)} the app recommends: it may run slowly or fail.` : '';
    note.textContent = st.cpus < rec.cpus ? `The app recommends ${rec.cpus} vCPU${rec.cpus === 1 ? '' : 's'}; with fewer it may be slower.` : '';
  };
  const changed = () => {
    st.touched = true;
    st.custom = true;
    sync();
    if (opts.onChange) opts.onChange({ cpus: st.cpus, memoryMiB: st.memoryMiB });
  };
  const setCpus = (n) => {
    if (!Number.isFinite(n)) return sync();
    st.cpus = Math.max(1, Math.min(lim.cpus, Math.round(n)));
    changed();
  };
  dec.addEventListener('click', () => setCpus(st.cpus - 1));
  inc.addEventListener('click', () => setCpus(st.cpus + 1));
  cpuIn.addEventListener('change', () => setCpus(Number(cpuIn.value)));
  memSel.addEventListener('change', () => {
    st.memoryMiB = Number(memSel.value);
    changed();
  });
  recBtn.addEventListener('click', () => {
    st.cpus = target.cpus;
    st.memoryMiB = target.memoryMiB;
    changed();
  });
  sync();
  const el = h(
    'div',
    { class: 'rescontrol', dataset: { role: 'res-control' } },
    h(
      'div',
      { class: 'resline' },
      h('label', { class: 'reslabel' }, 'vCPUs', dec, cpuIn, inc),
      h('label', { class: 'reslabel' }, 'Memory', memSel),
      recBtn,
      source,
    ),
    h('div', { class: 'muted sub', dataset: { role: 'res-hint' } }, `This Mac allows up to ${lim.cpus} vCPU${lim.cpus === 1 ? '' : 's'} and ${memWords(lim.memoryMiB)} for one app. The app recommends ${sizeWords(rec)}; you choose.`),
    warn,
    note,
  );
  return { el, get: () => ({ cpus: st.cpus, memoryMiB: st.memoryMiB }), touched: () => st.touched };
}

/** The card's Resources row: saved as soon as the user changes it (no Save button), locked while the app runs. */
function resourcesRow(a) {
  const active = a.state !== 'stopped';
  const ctl = resourcesControl(a.resources, {
    disabled: active,
    onChange: guarded((v) => loader.setResources(a.id, v)), // each change is saved at once, in order (the loader writes one file)
  });
  return h('div', { class: 'resrow', dataset: { role: 'resources' } }, h('span', { class: 'k' }, 'Resources'), ctl.el, active ? h('div', { class: 'muted sub', dataset: { role: 'res-locked' } }, 'Stop the app to change its size.') : null);
}

/** Red chip(s): the microphone is allowed for this app (always true), and a live audio track is in its window (best effort). */
function deviceChips(a) {
  const chips = [];
  if ((a.devices || []).some((x) => x.device === 'microphone' && x.grant)) {
    chips.push(h('span', { class: 'chip red', title: 'You allowed this app to use the microphone while it runs', dataset: { role: 'device-chip' } }, 'Can use the microphone'));
  }
  if (a.listening) chips.push(h('span', { class: 'chip red active', dataset: { role: 'mic-active' } }, 'Using the microphone now'));
  if ((a.devices || []).some((x) => x.device === 'clipboard' && x.grant)) {
    chips.push(h('span', { class: 'chip amber', title: 'You allowed this app to read and change what you copy while it runs', dataset: { role: 'clipboard-chip' } }, 'Can use the clipboard'));
  }
  if ((a.devices || []).some((x) => x.device === 'ports' && x.grant)) {
    chips.push(h('span', { class: 'chip amber', title: 'You allowed this app to open its servers on this Mac’s localhost while it runs (other programs on this Mac can connect to them)', dataset: { role: 'ports-chip' } }, 'Can open localhost ports'));
  }
  return chips;
}

/** Red chip(s) for what the user has allowed this app to do on the computer, and for control that is active now. */
function hostChips(a) {
  const allGranted = (a.host || []).filter((x) => x.grant);
  const granted = allGranted.filter((x) => x.risk !== 'gpu');
  const chips = [];
  if (granted.length) {
    const ctl = granted.some(controls);
    chips.push(
      h('span', { class: 'chip red', title: `Allowed: ${granted.map((x) => `${hostShort(x.cap)} (${grantWords(x)})`).join('; ')}`, dataset: { role: 'host-chip' } }, ctl ? 'Can control your computer' : 'Can see your screen'),
    );
  }
  // SPEC 8.6: an amber chip while the user's grant lets this app run work on the GPU (always accurate: it comes from the grant)
  if (allGranted.some((x) => x.risk === 'gpu')) {
    chips.push(h('span', { class: 'chip amber', title: 'You allowed this app to run work on your Mac’s GPU while it runs, through a sandboxed helper', dataset: { role: 'gpu-chip' } }, 'Can use your GPU'));
  }
  for (const c of a.controlling || []) {
    chips.push(h('span', { class: 'chip red active', dataset: { role: 'host-active' } }, c.kind === 'shell' ? 'Running a shell command now' : 'Controlling your computer now'));
  }
  return chips;
}

const POLICY_LABEL = [
  ['manual', 'Stay on this version'],
  ['compatible', 'Latest compatible'],
  ['latest', 'Always latest'],
];

// "Updates:" choice, "Versions…" and "Check for updates". Only an app installed from a registry has a choice.
function updatesRow(a) {
  const src = a.source;
  const sel = h('select', { dataset: { role: 'policy' }, 'aria-label': 'Updates', disabled: !src }, POLICY_LABEL.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = src ? a.policy : 'manual';
  sel.addEventListener('change', async () => {
    try {
      await loader.setPolicy(a.id, sel.value);
    } catch (e) {
      sel.value = a.policy;
      fail(e);
    }
  });
  return h(
    'div',
    { class: 'updates', dataset: { role: 'updates' } },
    h('span', { class: 'k' }, 'Updates:'),
    sel,
    src ? h('span', { class: 'muted mono', title: src.registry, dataset: { role: 'source' } }, `from ${src.registry}`) : h('span', { class: 'muted', dataset: { role: 'source' } }, 'installed from a file'),
    h('button', { dataset: { action: 'versions' }, onclick: guarded(() => showVersions(a.id)) }, 'Versions…'),
    h('button', { dataset: { action: 'check-updates' }, disabled: !src || a.checking, title: src ? '' : 'This app was installed from a file', onclick: guarded(() => checkUpdates(a)) }, 'Check for updates'),
  );
}

function card(a) {
  if (a.broken) {
    return h(
      'section',
      { class: 'card', dataset: { app: a.id } },
      h('div', { class: 'card-head' }, h('div', { class: 'icon' }, '!'), h('div', { class: 'titles' }, h('div', { class: 'name' }, a.id), h('div', { class: 'card-error' }, `This installation is damaged: ${a.error}`))),
      h('div', { class: 'buttons' }, h('button', { class: 'danger', dataset: { action: 'uninstall' }, onclick: () => confirmUninstall(a) }, 'Uninstall…')),
    );
  }
  const active = a.state !== 'stopped';
  const icon = h('div', { class: 'icon' }, a.icon ? h('img', { src: a.icon, alt: '' }) : (a.name[0] || '?').toUpperCase());
  const stateText = STATE_LABEL[a.state] || a.state;
  return h(
    'section',
    { class: `card ${a.state}`, dataset: { app: a.id, state: a.state } },
    h(
      'div',
      { class: 'card-head' },
      icon,
      h(
        'div',
        { class: 'titles' },
        h('div', { class: 'name' }, a.name, h('span', { class: 'version' }, a.version)),
        // The manifest's publisher is the package's own claim; it stays labelled until publisher signatures exist.
        h('div', { class: 'muted', title: 'Stated by the package, not verified' }, a.publisher ? `${a.publisher} (unverified)` : 'unknown publisher'),
      ),
      h('div', { class: 'state', dataset: { role: 'state' } }, h('span', { class: 'dot' }), h('span', {}, stateText)),
    ),
    a.description ? h('div', { class: 'desc' }, a.description) : null,
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip sandbox', title: 'The app’s code runs in a virtual machine; its windows are sandboxed' }, 'Sandboxed VM'),
      h('span', { class: 'chip' }, `runtime ${a.runtime}`),
      h('span', { class: 'chip mono', title: a.packageId }, `package ${a.packageId.slice(0, 8)}`),
      a.runtimeInstalled ? null : h('span', { class: 'chip err' }, 'runtime not installed'),
      a.dev ? h('span', { class: 'chip dev', title: a.dev.path, dataset: { role: 'dev-badge' } }, `Developer build from ${a.dev.folder}`) : null,
      hostChips(a),
      deviceChips(a),
      netChips(a),
    ),
    netRiskBox(a),
    permSummary(a),
    resourcesRow(a),
    updatesRow(a),
    a.withdrawnCurrent
      ? h('div', { class: 'card-withdrawn', dataset: { role: 'withdrawn' } }, `Version ${a.version} was withdrawn by its publisher${a.withdrawnCurrent.reason ? `: ${a.withdrawnCurrent.reason}` : '.'}`)
      : null,
    a.error ? h('div', { class: 'card-error', dataset: { role: 'error' } }, a.error) : null,
    a.note ? h('div', { class: 'card-note' }, a.note) : null,
    a.notice ? h('div', { class: `card-notice ${a.notice.kind === 'warn' ? 'warn' : ''}`, dataset: { role: 'notice' } }, a.notice.text) : null,
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'primary', dataset: { action: 'launch' }, disabled: active || a.checking, onclick: guarded(() => launch(a)) }, a.checking ? 'Checking for updates…' : 'Launch'),
      a.dev ? h('button', { dataset: { action: 'rebuild' }, title: `Build ${a.dev.path} again and run it (stops the app first if it is running)`, onclick: guarded(() => rebuild(a)) }, 'Rebuild & run') : null,
      h('button', { dataset: { action: 'stop' }, disabled: a.state === 'stopped' || a.state === 'stopping', onclick: guarded(() => loader.stop(a.id)) }, 'Stop'),
      h('button', { dataset: { action: 'permissions' }, disabled: active, onclick: guarded(() => editPermissions(a)) }, 'Permissions'),
      // network grants can change while the app runs: the change applies to it at once (SPEC 8.3)
      (a.network || []).length ? h('button', { dataset: { action: 'network' }, title: 'Which hosts this app may reach. A change applies at once, even while it runs.', disabled: a.state === 'starting' || a.state === 'stopping', onclick: guarded(() => editNetwork(a)) }, 'Network…') : null,
      // the GPU (SPEC 8.6) can be taken away while the app runs: its helper stops and its connections close at once
      (a.host || []).some((x) => x.risk === 'gpu') ? h('button', { dataset: { action: 'gpu' }, title: 'Whether this app may use your Mac’s GPU. Taking it away applies at once, even while the app runs.', disabled: a.state === 'starting' || a.state === 'stopping', onclick: guarded(() => openGpuSheet(a)) }, 'GPU…') : null,
      h('button', { dataset: { action: 'inspect' }, onclick: guarded(() => loader.inspect(a.id, 'traffic')) }, 'Inspect'),
      h('button', { dataset: { action: 'logs' }, onclick: guarded(() => loader.inspect(a.id, 'log')) }, 'Logs'),
      h('button', { dataset: { action: 'publish' }, title: 'Upload this app to a registry', onclick: guarded(() => openPublish(a)) }, 'Publish…'),
      h('span', { class: 'spacer' }),
      h('button', { dataset: { action: 'reset' }, disabled: active, title: active ? 'Stop the app first' : '', onclick: () => confirmReset(a) }, 'Reset…'),
      h('button', { class: 'danger', dataset: { action: 'uninstall' }, disabled: active, title: active ? 'Stop the app first' : '', onclick: () => confirmUninstall(a) }, 'Uninstall…'),
    ),
  );
}

function render() {
  appsEl.replaceChildren();
  if (!apps.length) {
    appsEl.appendChild(emptyState());
    return;
  }
  for (const a of apps) appsEl.appendChild(card(a));
}

// The empty library (first launch): the way in is "Load examples" (the sample apps that came with this loader), or a .vmapp file.
// A development loader without examples says how to make them; a packaged one without examples does not offer the button.
function emptyState() {
  const ex = examplesState;
  return h(
    'div',
    { class: 'empty', dataset: { role: 'empty' } },
    h('div', { class: 'empty-title' }, 'No apps installed yet.'),
    h('div', { class: 'empty-text' }, ex.show ? 'Choose “Load examples” to try the sample apps that came with this loader, or “Install from file…” to add a .vmapp package.' : 'Choose “Install from file…” to add a .vmapp package.'),
    h(
      'div',
      { class: 'empty-actions' },
      ex.show ? h('button', { class: 'primary', dataset: { action: 'load-examples' }, onclick: guarded(openExamples) }, 'Load examples') : null,
      h('button', { dataset: { action: 'install-empty' }, onclick: guarded(install) }, 'Install from file…'),
    ),
    ex.show && !ex.available
      ? h('div', { class: 'muted sub', dataset: { role: 'examples-missing-hint' } }, `There are no examples to load yet: run tools/pack-examples to make them (${ex.dir ? `it fills ${ex.dir}` : 'it fills out/examples'}).`)
      : null,
  );
}

// A red strip at the top of the library while an app controls the computer (the badge on screen is the primary signal).
function renderControl() {
  const items = control.map((e) =>
    h(
      'div',
      { class: 'control-item', dataset: { role: 'control-item', app: e.appId, kind: e.kind } },
      h('span', { class: 'dot' }),
      h('span', { class: 'ctext' }, e.kind === 'shell' ? `${e.appName} is running a shell command` : `${e.appName} is controlling your computer`),
      h('button', { class: 'danger-fill', dataset: { action: 'control-stop' }, onclick: guarded(() => loader.stopControl(e.appId)) }, 'Stop'),
    ),
  );
  if (control.length > 1) {
    items.push(h('div', { class: 'control-item' }, h('span', { class: 'ctext' }, 'Stop everything now (or press ⌃⌥⌘.)'), h('button', { class: 'danger-fill', dataset: { action: 'control-stop-all' }, onclick: guarded(() => loader.stopAllControl()) }, 'Stop all')));
  }
  controlEl.replaceChildren(...items); // replaceChildren does not flatten arrays
}

async function refresh() {
  try {
    [apps, control] = await Promise.all([loader.list(), loader.control()]);
    // the empty state offers "Load examples" only when this loader has some (or is a development build, which explains how to make them)
    if (!apps.length) examplesState = await loader.examplesInfo().catch(() => ({ show: false, available: false }));
    render();
    renderControl();
  } catch (e) {
    fail(e);
  }
}

// "Activity" at the top: the running apps and what each can reach right now (the loader pushes it; pills pulse while in use).
// The same data fills the menu-bar popover. Only the running apps are listed.
const activityList = h('div', { dataset: { role: 'activity-list' } });
activityEl.append(h('div', { class: 'act-title' }, 'Activity'), activityList);
function drawActivity(state) {
  Activity.render(activityList, state, { compact: true, handlers: { stop: guarded((id) => loader.stop(id)) } });
}
Activity.watch(activityList);
loader.onActivity(drawActivity);
loader.activity().then(drawActivity, fail);

// ---------------------------------------------------------------------------------------------- launching and permissions
async function launch(a, opts) {
  const r = await loader.launch(a.id, opts);
  afterLaunch(a, r);
}

function afterLaunch(a, r) {
  if (!r) return;
  if (r.updated) banner('info', `Updated ${a.name} to ${r.updated}.`);
  if (r.askMore) openAskMore(a, r.askMore, true);
  else if (r.sheet) openSheet(r.sheet, 'launch');
}

// "Version X asks for more": loader-owned, shown whatever the update choice is (SPEC 8.1). `launching`: came from Launch.
function openAskMore(a, am, launching) {
  const d = am.diff;
  const items = [];
  for (const f of d.added) items.push(h('li', { dataset: { more: 'folder' } }, `A new folder: “${f.name}” (${ACCESS_LABEL[f.access]})${f.purpose ? `. ${f.purpose}` : ''}`));
  for (const f of d.raised) items.push(h('li', { dataset: { more: 'access' } }, `More access to the folder “${f.name}”: ${ACCESS_LABEL[f.from]} → ${ACCESS_LABEL[f.to]}${f.purpose ? `. ${f.purpose}` : ''}`));
  if (d.dialogs) items.push(h('li', { dataset: { more: 'dialogs' } }, 'Show open and save dialogs (you choose each file or folder)'));
  if (d.external) items.push(h('li', { dataset: { more: 'external' } }, 'Open web links in your browser (you confirm each one)'));
  // SPEC 8.1: a new host capability always stops and asks. It stays off until you allow it in the permission sheet.
  for (const x of d.hostAdded || []) {
    items.push(h('li', { class: x.control ? 'err' : '', dataset: { more: 'host', cap: x.cap } }, `Control of your computer: ${hostWords(x.cap, x)}${x.control ? ' (requests control of your computer)' : ''}${x.purpose ? `. ${x.purpose}` : ''}`));
  }
  // SPEC 8.1: a newly requested device (the microphone) also always stops and asks. It stays off until you allow it in the sheet.
  for (const x of d.devicesAdded || []) {
    items.push(h('li', { class: 'err', dataset: { more: 'device', device: x.device } }, `A new device: ${deviceWords(x.device)}${x.purpose ? `. ${x.purpose}` : ''}`));
  }
  // SPEC 8.1, 8.3: a new host, a wider wildcard or more ports on a host always stops and asks. It stays off until you allow it.
  for (const x of d.netAdded || []) {
    const what = x.kind === 'ports' ? `More network ports on ${hostText(x.host)}: ${portsText(x.newPorts)}` : `A new address to reach: ${hostText(x.host)} (${portsText(x.ports)})`;
    const marks = [x.any ? anyHostWords : null, x.wildcard ? wildcardWords(x.host) : null, x.insecure ? 'Port 80 is not encrypted.' : null].filter(Boolean);
    items.push(h('li', { class: x.any || x.wildcard || x.insecure ? 'err' : '', dataset: { more: 'net', host: x.host, kind: x.kind } }, `${what}.${marks.length ? ` ${marks.join(' ')}` : ''}${x.purpose ? ` ${x.purpose}` : ''}`));
  }
  const newRisk = am.review && am.review.risk && am.review.risk.message ? am.review.risk.message : null;
  const discard = () => loader.cancelInstall().catch(() => {});
  const m = openModal({
    title: `Version ${am.candidate} asks for more:`,
    onCancel: discard,
    body: h(
      'div',
      { dataset: { role: 'asks-more' } },
      h('div', { class: 'muted' }, `“${am.appName}” would go from ${am.current} to ${am.candidate}${am.registry ? ` (from ${am.registry})` : ''}. Nothing changes until you choose.`),
      h('ul', { class: 'morelist' }, items),
      (d.netAdded || []).length && newRisk ? h('div', { class: 'warnbox', dataset: { role: 'net-risk' } }, newRisk) : null,
    ),
    buttons: [
      {
        label: 'Update and review permissions',
        action: 'update-review',
        kind: 'primary',
        onclick: async () => {
          try {
            const done = await loader.installPackage(am.token);
            m.close();
            banner('info', `Updated ${am.appName} to ${done.version}.`);
            openSheet(await loader.sheet(am.id), launching ? 'launch' : 'edit');
          } catch (e) {
            m.close();
            fail(e);
          }
        },
      },
      {
        label: launching ? `Keep version ${am.current} and launch` : `Keep version ${am.current}`,
        action: 'keep-version',
        onclick: async () => {
          m.close();
          await discard();
          if (launching) await guarded(() => launch(a, { skipUpdate: true }))();
        },
      },
    ],
  });
}

async function checkUpdates(a) {
  const r = await loader.checkUpdates(a.id);
  if (r.offline) return banner('error', `Could not check for updates: ${r.error}`);
  if (r.error && !r.candidate) return banner('error', `Could not check for updates: ${r.error}`);
  if (!r.candidate) {
    let t = `${a.name} ${r.current} is up to date.`;
    if (r.latest) t += ` Version ${r.latest} exists but is a bigger change than “${POLICY_LABEL.find((p) => p[0] === r.policy)[1]}” allows; see Versions….`;
    return banner('info', t);
  }
  if (r.error || !r.token) return banner('error', `Version ${r.candidate} is available but could not be fetched: ${r.error}`);
  if (r.diff.any) return openAskMore(a, { token: r.token, id: a.id, appName: r.appName, current: r.current, candidate: r.candidate, diff: r.diff, registry: r.registry, review: r.review }, false);
  return showReview(r, { done: (v) => banner('info', `Updated ${a.name} to ${v}.`) });
}

// ---------------------------------------------------------------------------------------------- versions
function confirmOlder(info, onYes, onNo) {
  const m = openModal({
    title: 'Go back to an older version?',
    onCancel: onNo,
    body: h(
      'div',
      { dataset: { role: 'older-warning' } },
      h(
        'div',
        { class: 'confirm-text' },
        `Going back to an older version: version ${info.to} of “${info.name}” shares its app data with version ${info.from}, so it may not be able to read data written by the newer version.`,
      ),
      info.stays ? h('div', { class: 'confirm-text muted' }, 'Updates for this app will be set to “Stay on this version”, so it does not move forward again by itself.') : null,
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => { m.close(); if (onNo) onNo(); } },
      { label: `Go back to ${info.to}`, action: 'confirm-older', kind: 'danger-fill', onclick: () => { m.close(); onYes(); } },
    ],
  });
}

async function showVersions(id) {
  const v = await loader.versions(id);
  const reopen = () => guarded(() => showVersions(id))();
  const stays = !!v.source && v.policy !== 'manual';

  const useVersion = (x) => {
    const go = async () => {
      try {
        const r = await loader.useVersion(id, x.version);
        banner('info', `${v.name} now uses version ${r.version}.${r.policyChanged ? ' Updates are set to “Stay on this version”.' : ''}`);
      } catch (e) {
        fail(e);
      }
    };
    if (x.older) confirmOlder({ name: v.name, from: v.current, to: x.version, stays }, go, reopen);
    else go();
  };
  const installVersion = (x) => {
    const go = async () => {
      try {
        showReview(await loader.prepareRegistryVersion(id, x.version), { done: (ver) => banner('info', `Installed ${v.name} ${ver}.`) });
      } catch (e) {
        fail(e);
      }
    };
    if (x.older) confirmOlder({ name: v.name, from: v.current, to: x.version, stays }, go, reopen);
    else go();
  };

  const withdrawnText = (w) => `Withdrawn by the publisher${w.reason ? `: ${w.reason}` : '.'}`;
  const row = (x, button, info) =>
    h(
      'div',
      { class: 'vrow', dataset: { version: x.version } },
      h('span', { class: 'vnum mono' }, x.version),
      h('span', { class: `vinfo ${x.withdrawn ? 'withdrawn' : ''}` }, [info, x.withdrawn ? withdrawnText(x.withdrawn) : null].filter(Boolean).join('  •  ')),
      button,
    );
  const installedList = h(
    'div',
    { class: 'vlist', dataset: { role: 'installed-versions' } },
    v.installed.map((x) =>
      row(
        x,
        h('button', { dataset: { action: 'use-version', version: x.version }, disabled: x.current || v.running, title: v.running ? 'Stop the app first' : '', onclick: () => useVersion(x) }, 'Use this version'),
        x.current ? 'current' : 'installed',
      ),
    ),
  );
  const regBox = h('div', { dataset: { role: 'registry-versions' } });
  const showBtn = v.source
    ? h(
        'button',
        {
          dataset: { action: 'show-registry-versions' },
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            regBox.replaceChildren(h('div', { class: 'muted' }, `Asking ${v.source.registry}…`));
            try {
              const r = await loader.registryVersions(id);
              regBox.replaceChildren(
                h(
                  'div',
                  { class: 'vlist', dataset: { role: 'registry-list' } },
                  r.versions.map((x) =>
                    row(
                      x,
                      x.installed ? null : h('button', { dataset: { action: 'install-version', version: x.version }, disabled: v.running, onclick: () => installVersion(x) }, 'Install this version'),
                      x.current ? 'current' : x.installed ? 'installed' : x.publishedAt ? `published ${String(x.publishedAt).slice(0, 10)}` : '',
                    ),
                  ),
                ),
              );
            } catch (err) {
              regBox.replaceChildren(h('div', { class: 'err', dataset: { role: 'registry-error' } }, err.message));
              btn.disabled = false;
            }
          },
        },
        'Show versions from the registry',
      )
    : null;
  const m = openModal({
    title: `Versions of “${v.name}”`,
    body: h(
      'div',
      { dataset: { role: 'versions' } },
      h('div', { class: 'muted' }, `Installed on this Mac (the last few are kept). Current: ${v.current}. App data is shared by all versions.`),
      installedList,
      v.source ? h('div', { class: 'muted' }, `Registry: ${v.source.registry}. It is only contacted when you press the button below.`) : h('div', { class: 'muted' }, 'This app was installed from a file, so there is no registry to ask for other versions.'),
      showBtn,
      regBox,
    ),
    buttons: [{ label: 'Close', action: 'close', onclick: () => m.close() }],
  });
}

// ---------------------------------------------------------------------------------------------- Browse registry
// A loader-owned sheet (INV-B5): the app list of the launcher's registry (fixed by the main process; this page cannot name another),
// newest first, which can be searched and re-sorted, and install from a card. Everything on a card is untrusted text (publishers
// write the names and descriptions, the registry writes the publisher label), so it is only ever inserted as text nodes, from the
// cut-down fields the loader's main process sends (hostlib/updates.js browseRegistry); the page itself has no network. The registry is
// asked only when the sheet opens or the user presses Search, changes the sort or presses “Show more”.
// Install is the verified path: download, checks, then the install review and the permission sheet. Nothing is installed from a card
// without that review.
const BROWSE_SORTS = [
  ['new', 'Newest'],
  ['popular', 'Most downloaded'],
  ['updated', 'Recently updated'],
  ['name', 'Name (A to Z)'],
];
const PUBLISHER_NOTE = 'This is what the registry says about the publisher. This loader cannot check it.';
let browseState = null; // what the sheet showed last, in memory only: { registry, q, sort, items, next, total, insecure, loaded }
let browseSeq = 0; // a newer request (from this sheet or a later one) makes the answer of an older one, still on its way, irrelevant

const browseBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
const browseCount = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The publisher exactly as the registry presents it: its label, styled by its level. Nothing is added or worked out here. */
function browsePublisher(p) {
  if (!p.label) return h('span', { class: 'chip', title: PUBLISHER_NOTE, dataset: { role: 'browse-publisher', level: p.level } }, 'The registry gave no publisher label');
  return h('span', { class: `chip pub-${p.level}`, title: PUBLISHER_NOTE, dataset: { role: 'browse-publisher', level: p.level } }, p.label);
}

/** One result. `install(item, note)` runs the verified install path; an app already on this Mac has no Install button. */
function browseCard(it, install) {
  const have = apps.find((a) => a.id === it.id && !a.broken);
  const note = h('div', { class: 'bnote muted', dataset: { role: 'browse-note' }, 'aria-live': 'polite' });
  const btn = have ? null : h('button', { class: 'primary', dataset: { action: 'browse-install' }, title: `Download ${it.name}, then review what it asks for`, onclick: () => install(it, note) }, 'Install');
  const meta = [`version ${it.latestVersion}`];
  if (it.sizeBytes !== null) meta.push(browseBytes(it.sizeBytes));
  if (it.downloads !== null) meta.push(browseCount(it.downloads, 'download', 'downloads'));
  if (it.runtime) meta.push(`runs on ${it.runtime}`);
  return h(
    'div',
    { class: 'brow', dataset: { browseApp: it.id } },
    h(
      'div',
      { class: 'bhead' },
      h('span', { class: 'bicon', 'aria-hidden': 'true' }, (Array.from(it.name)[0] || '?').toUpperCase()),
      h(
        'div',
        { class: 'btitle' },
        h('span', { class: 'bname', dataset: { role: 'browse-name' } }, it.name),
        it.latestVersion.includes('-') ? h('span', { class: 'chip', title: 'A pre-release: the registry lists it as the latest version' }, 'pre-release') : null,
        h('div', { class: 'mono muted', dataset: { role: 'browse-id' } }, it.id),
      ),
      have
        ? h('span', { class: 'chip sandbox', dataset: { role: 'browse-installed' }, title: 'This app is already in your library' }, `Installed ${have.version}`)
        : btn,
    ),
    browsePublisher(it.publisher),
    it.description ? h('div', { class: 'bdesc', title: it.description, dataset: { role: 'browse-desc' } }, it.description) : null,
    h('div', { class: 'bmeta muted', dataset: { role: 'browse-meta' } }, meta.join(' · '), have && have.version !== it.latestVersion ? ` · the registry lists ${it.latestVersion}` : ''),
    it.permissionsSummary
      ? h('div', { class: 'bperm', title: it.permissionsSummary, dataset: { role: 'browse-perms' } }, h('span', { class: 'k' }, 'The registry says it asks for: '), it.permissionsSummary)
      : null,
    note,
  );
}

async function openBrowse() {
  let def = '';
  try {
    def = (await loader.registryDefault()).registry || ''; // shown only: the main process decides which registry is asked
  } catch {
    /* no registry */
  }
  const st = browseState || { registry: '', q: '', sort: 'new', items: [], next: null, total: 0, insecure: false, loaded: false };
  const reg = h('span', { class: 'mono', dataset: { role: 'browse-registry' } }, st.registry || def || 'none');
  const qIn = h('input', { type: 'text', value: st.q, spellcheck: 'false', maxlength: '100', placeholder: 'Search by name, description or app id', 'aria-label': 'Search', dataset: { role: 'browse-query' } });
  const sortSel = h('select', { 'aria-label': 'Sort', dataset: { role: 'browse-sort' } }, BROWSE_SORTS.map(([v, t]) => h('option', { value: v }, t)));
  sortSel.value = st.sort;
  const searchBtn = h('button', { class: 'primary', dataset: { action: 'browse-search' } }, 'Search');
  const status = h('div', { class: 'muted', dataset: { role: 'browse-status' }, 'aria-live': 'polite' });
  const warn = h('div', { class: 'warn', dataset: { role: 'browse-insecure' } });
  const list = h('div', { class: 'blist', dataset: { role: 'browse-list' } });
  const moreErr = h('span', { class: 'err', dataset: { role: 'browse-more-error' } });
  const moreBtn = h('button', { dataset: { action: 'browse-more' } }, 'Show more');
  const moreRow = h('div', { class: 'bmore' }, moreBtn, moreErr);
  let closed = false;
  let installing = false;
  let installBtns = [];

  const setInstalling = (on) => {
    installing = on;
    for (const b of installBtns) b.disabled = on;
  };
  const install = async (it, note) => {
    if (installing) return;
    setInstalling(true);
    note.className = 'bnote muted';
    note.textContent = 'Downloading and checking the package…';
    try {
      const r = await loader.registryFetch(st.registry, it.id); // the registry this list came from, not whatever the box says now
      if (closed) return void loader.cancelInstall().catch(() => {});
      m.close();
      showReview(r, { done: (ver) => banner('info', `Installed ${r.review.manifest.name} ${ver} from ${r.review.source.registry}.`) });
    } catch (e) {
      note.className = 'bnote err';
      note.textContent = e.message;
    } finally {
      setInstalling(false);
    }
  };

  const render = () => {
    const cards = st.items.map((it) => browseCard(it, install));
    list.replaceChildren(...cards);
    installBtns = [...list.querySelectorAll('[data-action="browse-install"]')];
    moreRow.hidden = st.next === null;
    moreErr.textContent = '';
    warn.textContent = st.insecure ? 'This registry address is plain http, so what you see here (and the download) can be changed on the way. Use it for development only.' : '';
    status.className = 'muted';
    if (!st.loaded) status.textContent = '';
    else if (!st.items.length) status.textContent = st.q ? `No apps in ${st.registry} match “${st.q}”.` : `${st.registry} lists no apps yet.`;
    else status.textContent = `${st.q ? `Matching “${st.q}” in` : 'From'} ${st.registry}: showing ${st.items.length} of ${browseCount(st.total, 'app', 'apps')}.`;
  };

  // append = “Show more”: continues the list on screen (same registry, search and sort), whatever the boxes say now
  const run = async (append) => {
    const my = ++browseSeq;
    const ask = append ? { q: st.q, sort: st.sort, offset: st.next } : { q: qIn.value, sort: sortSel.value, offset: 0 };
    status.className = 'muted';
    status.textContent = 'Asking the registry…';
    moreErr.textContent = '';
    moreBtn.disabled = true;
    if (!append) {
      Object.assign(st, { items: [], next: null, total: 0, insecure: false, loaded: false });
      list.replaceChildren();
      installBtns = [];
      moreRow.hidden = true;
      warn.textContent = '';
    }
    try {
      const r = await loader.registryBrowse(ask);
      if (my !== browseSeq) return;
      const known = new Set(st.items.map((x) => x.id));
      Object.assign(st, { registry: r.registry, q: r.q, sort: r.sort, next: r.next, total: r.total, insecure: r.insecure, loaded: true, items: st.items.concat(r.items.filter((x) => !known.has(x.id))) });
      browseState = st;
      reg.textContent = r.registry;
      render();
    } catch (e) {
      if (my !== browseSeq) return;
      status.className = 'err';
      status.textContent = e.message;
      if (append) {
        moreErr.textContent = 'The list could not be continued.';
        moreRow.hidden = false;
      }
    } finally {
      if (my === browseSeq) moreBtn.disabled = false;
    }
  };

  searchBtn.addEventListener('click', () => run(false));
  moreBtn.addEventListener('click', () => run(true));
  sortSel.addEventListener('change', () => run(false));
  qIn.addEventListener('keydown', (e) => e.key === 'Enter' && run(false));

  const m = openModal({
    title: 'Browse registry',
    wide: true,
    onCancel: () => { closed = true; },
    body: h(
      'div',
      { class: 'browse', dataset: { role: 'browse' } },
      h('div', { class: 'muted' }, 'The newest apps first; search by name, description or app id, or change the order. The names, descriptions and publisher labels below are what the registry says, shown as given; this launcher cannot check them. Installing downloads the package and checks it, then shows you everything the app asks for before anything is installed.'),
      h('div', { class: 'bbar muted' }, h('label', {}, 'Registry'), reg),
      h('div', { class: 'bbar' }, qIn, h('label', { class: 'muted' }, 'Sort by'), sortSel, searchBtn),
      warn,
      status,
      list,
      moreRow,
    ),
    buttons: [{ label: 'Close', action: 'browse-close', onclick: () => { closed = true; m.close(); } }],
  });
  moreRow.hidden = true;
  if (st.loaded) render(); // reopened (after a cancelled review, say): what was shown, with no new request
  else run(false); // the user just opened the sheet: this is their request for the first page, the newest apps
  qIn.focus();
}

async function editPermissions(a) {
  openSheet(await loader.sheet(a.id), 'edit');
}

// "Network…" on a card: only the network section, because a grant can change while the app runs (and then applies to it at once).
async function editNetwork(a) {
  openNetworkSheet(await loader.sheet(a.id), a.state === 'running');
}

function accessOptions(requested) {
  // SPEC 8.2: readwrite can be downgraded to read; read and write-only stay as requested
  return requested === 'readwrite' ? ['readwrite', 'read'] : [requested];
}

function openSheet(data, mode) {
  const state = {};
  let hostSec = null;
  let netSec = null;
  const folderChoices = () => {
    const choices = {};
    for (const [name, s] of Object.entries(state)) choices[name] = s.path && !s.skipped ? { path: s.path, access: s.access } : null;
    return choices;
  };
  // the warning for "can read your data AND send it to hosts" follows what is on screen (INV-N4)
  const refreshRisk = () => {
    if (netSec) netSec.refreshRisk({ folders: folderChoices(), host: hostSec ? hostSec.peek() : {} });
  };
  const rows = data.folders.map((f) => {
    const g = f.grant;
    state[f.name] = { path: g ? g.path : null, access: g ? g.access : f.access, skipped: g === null };
    return folderRow(data, f, state[f.name], refreshRisk);
  });
  const ask = h('input', { type: 'checkbox', id: 'ask-every-time' });
  ask.checked = !!data.askEveryTime;
  const extras = [];
  if (data.dialogs) extras.push('show file and folder dialogs (you choose each one)');
  if (data.external) extras.push('open links in your browser (you confirm each one)');
  const hostRequested = data.host || [];
  hostSec = hostRequested.length ? hostSection(data, hostRequested, refreshRisk) : null;
  const deviceRequested = data.devices || [];
  const deviceSec = deviceRequested.length ? deviceSection(data, deviceRequested) : null;
  const netRequested = data.network || [];
  netSec = netRequested.length ? netSection(data, netRequested, refreshRisk) : null;
  const resCtl = resourcesControl(data.resources, {});
  const onlyOther = !data.folders.length && (hostRequested.length || deviceRequested.length || netRequested.length); // nothing to say about folders
  const body = h(
    'div',
    {},
    !onlyOther ? h('div', { class: 'muted' }, `“${data.appName}” asks for access to these folders. Choose a folder for each one, or skip it. You can grant less than it asks for.`) : null,
    !onlyOther ? h('div', { class: 'folders', dataset: { role: 'folders' } }, rows.length ? rows : h('div', { class: 'muted' }, 'This app asks for no folders.')) : null,
    extras.length ? h('div', { class: 'muted' }, `The app may also ${extras.join(' and ')}.`) : null,
    netSec ? netSec.riskEl : null,
    deviceSec ? deviceSec.el : null,
    hostSec ? hostSec.el : null,
    netSec ? netSec.el : null,
    h(
      'div',
      { class: 'hostsec ressec', dataset: { role: 'resources-section' } },
      h('h3', {}, 'Resources'),
      h('div', { class: 'muted sub' }, `How much of this Mac “${data.appName}” may use for its virtual machine. The app only recommends a size; you choose. By default it gets one vCPU and the recommended memory.`),
      resCtl.el,
    ),
    h('label', {}, ask, ' Ask every time I launch'),
  );
  refreshRisk();
  const submit = (fn) => async () => {
    const choices = folderChoices();
    try {
      const hostChoices = hostSec ? hostSec.collect() : undefined; // throws a plain message when a choice is incomplete
      const deviceChoices = deviceSec ? deviceSec.collect() : undefined;
      const extra = {};
      if (netSec) extra.network = netSec.collect();
      if (resCtl.touched()) extra.resources = resCtl.get(); // untouched: the default (or the earlier choice) stands
      await fn(data.id, choices, ask.checked, hostChoices, deviceChoices, extra);
      m.close();
    } catch (e) {
      fail(e);
    }
  };
  const m = openModal({
    title: mode === 'launch' ? `Permissions for “${data.appName}”` : `Permissions of “${data.appName}”`,
    body,
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      mode === 'launch'
        ? { label: 'Launch', action: 'sheet-launch', kind: 'primary', onclick: submit(loader.launchWithGrants) }
        : { label: 'Save', action: 'sheet-save', kind: 'primary', onclick: submit(loader.savePermissions) },
    ],
  });
}

// "Control of your computer" (SPEC 8.2): the host capabilities the app requests, each off until you choose a mode. Loader UI
// only (INV-B5, INV-H1): the app only named what it wants; the tools and servers offered are YOUR catalog's.
const HOST_RISK_NOTE = {
  screen: 'It can see everything that is visible on your screen, including private information.',
  input: 'It can move the mouse, click and type anywhere on your Mac, as if it were you.',
  tool: 'It can start the programs you pick below, with arguments that match the patterns you set.',
  shell: 'One of these is a shell: it can run any command, with all your access.',
  mcp: 'It can use the programs you pick below, which may reach other apps and accounts.',
  // SPEC 8.6: the loader's own words (INV-B5). The helper is llama.cpp's RPC server, which upstream does not harden against hostile input.
  gpu: 'Lets this app run work on your Mac’s GPU (Metal) through a sandboxed helper. The helper processes the app’s requests, so only allow apps you trust with your GPU.',
  // SPEC 8.7: the loader's own words. It only takes effect while the loader setting “Experimental GPU (Vulkan)” is on.
  gpuVulkan: 'Experimental. Lets this app talk to your Mac’s GPU through Vulkan from inside its virtual machine, which then runs on a different, less proven backend (it cannot be given folders while it runs). The GPU’s drivers process what the app sends, so only allow apps you trust. It works only while “Experimental GPU (Vulkan)” is on in Host Capabilities.',
};

function hostSection(data, list, onChange) {
  const state = {};
  const cards = list.map((x) => {
    const g = x.grant;
    const s = { mode: g ? g.mode : 'none', picked: new Set(g ? g.tools || g.servers || [] : []) };
    state[x.cap] = s;
    return hostRow(x, s, onChange);
  });
  const el = h(
    'div',
    { class: 'hostsec', dataset: { role: 'host-section' } },
    h('h3', {}, 'Control of your computer'),
    h(
      'div',
      { class: 'hostwarn' },
      `“${data.appName}” asks to act on your computer. Everything starts as “Don’t allow”. A red bar stays on top of your screen while an app controls your mouse and keyboard or runs a shell command, with a Stop button; the shortcut ⌃⌥⌘. stops everything at once.`,
    ),
    cards,
  );
  const collect = () => {
    const out = {};
    for (const x of list) {
      const s = state[x.cap];
      if (s.mode === 'none') continue;
      const spec = { mode: s.mode };
      if (x.cap === 'tool:*' || x.cap === 'mcp:*') {
        const what = x.cap === 'tool:*' ? 'tool' : 'MCP server';
        if (!s.picked.size) throw new Error(`Pick at least one ${what} for “${hostShort(x.cap)}”, or choose Don’t allow.`);
        spec[x.cap === 'tool:*' ? 'tools' : 'servers'] = [...s.picked];
      }
      out[x.cap] = spec;
    }
    return out;
  };
  // what is chosen right now, without validating it: the risk warning only needs to know whether the screen is on
  const peek = () => {
    const out = {};
    for (const x of list) if (state[x.cap].mode === 'ask' || state[x.cap].mode === 'session') out[x.cap] = { mode: state[x.cap].mode };
    return out;
  };
  return { el, collect, peek };
}

// "Network" (SPEC 8.3): the hosts the app asks to reach, each off until you choose “Allow”. Loader UI only (INV-B5): the app named
// the hosts and the ports and gave a reason; every other word here is the loader's. `onChange` is told when a choice changes.
// Returns {el, riskEl, collect(), refreshRisk(extra)}: `riskEl` is the loud “can read your data and send it out” banner (INV-N4),
// drawn by the caller where it wants it; `refreshRisk({folders, host})` asks the loader for the sentence that fits the choices.
function netSection(data, list, onChange) {
  const state = {};
  let seq = 0;
  const riskEl = h('div', { dataset: { role: 'net-risk-box' } });
  const cards = list.map((x) => {
    // a request for any port ("*") is allowed or not as a whole; a list can be narrowed port by port
    const s = { mode: x.allowed ? 'allow' : 'none', ports: x.ports === '*' ? null : new Set(x.allowed && x.allowedPorts !== '*' ? x.allowedPorts : x.ports) };
    state[x.host] = s;
    const sel = h('select', { dataset: { role: 'net-mode' }, 'aria-label': `Network access to ${hostText(x.host)}` }, [['none', 'Don’t allow'], ['allow', 'Allow']].map(([v, l]) => h('option', { value: v }, l)));
    sel.value = s.mode;
    const multi = x.ports !== '*' && x.ports.length > 1;
    const portBoxes = (multi ? x.ports : []).map((p) => {
      const box = h('input', { type: 'checkbox', dataset: { port: String(p) } });
      box.checked = s.ports.has(p);
      box.addEventListener('change', () => {
        if (box.checked) s.ports.add(p);
        else s.ports.delete(p);
        if (onChange) onChange();
      });
      return h('label', { class: 'pick' }, box, ` ${portWords(p)}`);
    });
    const portsEl = multi
      ? h('div', { class: 'picks', dataset: { role: 'net-ports' } }, h('div', { class: 'muted sub' }, 'Which ports may it use? You can allow fewer than it asks for.'), portBoxes)
      : null;
    const sync = () => {
      s.mode = sel.value;
      if (portsEl) portsEl.hidden = s.mode === 'none';
    };
    sel.addEventListener('change', () => {
      sync();
      if (onChange) onChange();
    });
    sync();
    return h(
      'div',
      { class: `folder hostcap${x.any || x.wildcard || x.insecure ? ' serious' : ''}`, dataset: { netHost: x.host, wildcard: x.wildcard ? '1' : '0', any: x.any ? '1' : '0' } },
      h(
        'div',
        { class: 'fname' },
        h('span', { class: 'mono', dataset: { role: 'net-host' } }, x.any ? '*' : x.host),
        x.any ? h('span', { class: 'chip red', dataset: { role: 'net-any-chip' } }, 'any server') : null,
        x.wildcard ? h('span', { class: 'chip red', dataset: { role: 'net-wildcard-chip' } }, 'wildcard') : null,
        x.insecure ? h('span', { class: 'chip red', dataset: { role: 'net-insecure-chip' } }, 'not encrypted') : null,
        h('span', { class: 'badge', dataset: { role: 'net-ports-asked' } }, `asks for ${portsText(x.ports)}`),
      ),
      h('div', { class: `purpose ${x.purpose ? '' : 'none'}`, dataset: { role: 'purpose' } }, x.purpose || 'no reason given'),
      x.any ? h('div', { class: 'err sub', dataset: { role: 'net-any' } }, anyHostWords) : null,
      x.wildcard ? h('div', { class: 'err sub', dataset: { role: 'net-wildcard' } }, wildcardWords(x.host)) : null,
      x.insecure ? h('div', { class: 'warn sub', dataset: { role: 'net-insecure' } }, 'Port 80 is plain HTTP: what the app sends and receives there is not encrypted, and anyone on the way can read it.') : null,
      h('div', { class: 'accessrow' }, h('span', {}, 'Allow:'), sel),
      portsEl,
    );
  });
  const el = h(
    'div',
    { class: 'hostsec netsec', dataset: { role: 'net-section' } },
    h('h3', {}, 'Network'),
    h(
      'div',
      { class: 'hostwarn' },
      `“${data.appName}” asks to reach these addresses on the internet. Everything starts as “Don’t allow”. The app can send anything it can read to an address you allow, and the loader cannot see what is inside the connection (it is encrypted end to end). Every connection is listed in the Bridge Inspector, and you can change this at any time, even while the app runs.`,
    ),
    cards,
  );
  const collect = () => {
    const out = {};
    for (const x of list) {
      const s = state[x.host];
      if (s.mode === 'none') {
        out[x.host] = { allow: false };
        continue;
      }
      if (x.ports === '*') {
        out[x.host] = { allow: true };
        continue;
      }
      const ports = x.ports.filter((p) => s.ports.has(p));
      if (!ports.length) throw new Error(`Pick at least one port for “${hostText(x.host)}”, or choose Don’t allow.`);
      out[x.host] = ports.length === x.ports.length ? { allow: true } : { allow: true, ports };
    }
    return out;
  };
  // the loader writes the sentence (INV-N4); the page only shows it
  const refreshRisk = async (extra) => {
    const mine = ++seq;
    const network = {};
    for (const x of list) if (state[x.host].mode === 'allow' && (x.ports === '*' || x.ports.some((p) => state[x.host].ports.has(p)))) network[x.host] = { allow: true };
    let r;
    try {
      r = await loader.riskPreview(data.id, Object.assign({}, extra || {}, { network }));
    } catch {
      return; // the banner keeps what it shows; nothing is allowed by a failed preview
    }
    if (mine !== seq) return;
    const kids = [];
    if (r.atRisk) {
      kids.push(h('div', { class: 'warnbox', dataset: { role: 'net-risk' } }, r.message));
      if (r.active) kids.push(h('div', { class: 'warnbox active', dataset: { role: 'net-risk-active' } }, `Right now: ${r.activeMessage} You have allowed both.`));
    }
    riskEl.replaceChildren(...kids);
  };
  return { el, riskEl, collect, refreshRisk };
}

// The “GPU…” sheet of a card (SPEC 8.6): the one choice, saved at once. Taking the GPU away stops the app's helper and closes its
// connections immediately, also while the app runs; allowing it for a running app starts at its next launch. Loader UI only (INV-B5):
// every sentence is the loader's, except the app's own stated reason.
function openGpuSheet(a) {
  const x = (a.host || []).find((e) => e.risk === 'gpu');
  if (!x) return;
  const running = a.state === 'running';
  const sel = h('select', { dataset: { role: 'gpu-mode' }, 'aria-label': hostWords('gpu', x) }, [['none', 'Don’t allow'], ['session', 'Allow while the app runs']].map(([v, l]) => h('option', { value: v }, l)));
  sel.value = x.grant ? 'session' : 'none';
  const m = openModal({
    title: `GPU for “${a.name}”`,
    body: h(
      'div',
      { dataset: { role: 'gpu-sheet' } },
      running ? h('div', { class: 'muted', dataset: { role: 'gpu-running' } }, 'The app is running. Taking the GPU away applies at once: its connections close and its helper stops. Allowing it starts at the next launch.') : null,
      h(
        'div',
        { class: 'folder hostcap', dataset: { cap: 'gpu', risk: 'gpu' } },
        h('div', { class: 'fname' }, hostWords('gpu', x), h('span', { class: 'chip amber' }, isVulkan(x) ? 'experimental' : 'uses your GPU')),
        h('div', { class: `purpose ${x.purpose ? '' : 'none'}`, dataset: { role: 'purpose' } }, x.purpose || 'no reason given'),
        h('div', { class: 'muted sub', dataset: { role: 'host-note' } }, isVulkan(x) ? HOST_RISK_NOTE.gpuVulkan : HOST_RISK_NOTE.gpu),
        h('div', { class: 'accessrow' }, h('span', {}, 'Allow:'), sel),
      ),
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Save',
        action: 'gpu-save',
        kind: 'primary',
        onclick: async () => {
          try {
            const r = await loader.saveGpu(a.id, sel.value);
            m.close();
            banner('info', r.gpu === 'revoked' ? `The GPU was taken away from “${a.name}”${r.appliesNow ? ': its helper stopped and its connections closed' : ''}.` : r.running ? `The GPU is allowed for “${a.name}”. It starts at the next launch.` : `The GPU is allowed for “${a.name}” while it runs.`);
          } catch (e) {
            fail(e);
          }
        },
      },
    ],
  });
}

// The “Network…” sheet of a card: just this section, saved and applied to the app at once, also while it runs.
function openNetworkSheet(data, running) {
  const folders = {};
  for (const f of data.folders) if (f.grant) folders[f.name] = { path: f.grant.path, access: f.grant.access };
  const hostGrants = {};
  for (const x of data.host || []) if (x.grant && (x.grant.mode === 'ask' || x.grant.mode === 'session')) hostGrants[x.cap] = { mode: x.grant.mode };
  const sec = netSection(data, data.network || [], () => sec.refreshRisk({ folders, host: hostGrants }));
  sec.refreshRisk({ folders, host: hostGrants });
  const m = openModal({
    title: `Network access of “${data.appName}”`,
    body: h(
      'div',
      { dataset: { role: 'network-sheet' } },
      running ? h('div', { class: 'muted', dataset: { role: 'net-running' } }, 'The app is running. What you choose here applies to it at once: a host you take away is cut off immediately, including connections that are open.') : null,
      sec.riskEl,
      sec.el,
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Save',
        action: 'net-save',
        kind: 'primary',
        onclick: async () => {
          try {
            const r = await loader.saveNetwork(data.id, sec.collect());
            m.close();
            banner('info', running ? `Network access saved and applied to “${data.appName}”${r && r.revoked && r.revoked.length ? ` (cut off: ${r.revoked.join(', ')})` : ''}.` : 'Network access saved.');
          } catch (e) {
            fail(e);
          }
        },
      },
    ],
  });
}

// "Devices" (SPEC 2.2, SPEC 7): the devices the app asks to use, each off until you choose “Allow while the app runs”.
// Loader UI only (INV-B5): the app only named the device and gave a reason; the words here are the loader's.
function deviceSection(data, list) {
  const state = {};
  const cards = list.map((x) => {
    const s = { mode: x.grant ? x.grant.mode : 'none' };
    state[x.device] = s;
    const sel = h(
      'select',
      { dataset: { role: 'device-mode' }, 'aria-label': deviceWords(x.device) },
      [['none', 'Don’t allow'], ['allow', 'Allow while the app runs']].map(([v, l]) => h('option', { value: v }, l)),
    );
    sel.value = s.mode;
    sel.addEventListener('change', () => {
      s.mode = sel.value;
    });
    return h(
      'div',
      { class: 'folder hostcap serious', dataset: { device: x.device } },
      h('div', { class: 'fname' }, deviceWords(x.device), h('span', { class: 'chip red' }, (DEVICE_DETAIL[x.device] || ['device'])[0])),
      h('div', { class: `purpose ${x.purpose ? '' : 'none'}`, dataset: { role: 'purpose' } }, x.purpose || 'no reason given'),
      h('div', { class: 'muted sub', dataset: { role: 'device-detail' } }, (DEVICE_DETAIL[x.device] || ['', ''])[1]),
      h('div', { class: 'accessrow' }, h('span', {}, 'Allow:'), sel),
    );
  });
  const el = h(
    'div',
    { class: 'hostsec', dataset: { role: 'device-section' } },
    h('h3', {}, 'Devices'),
    h('div', { class: 'hostwarn' }, `“${data.appName}” asks to use ${list.length > 1 ? 'these devices' : 'a device'}. Everything starts as “Don’t allow”.`),
    cards,
  );
  const collect = () => {
    const out = {};
    for (const x of list) if (state[x.device].mode === 'allow') out[x.device] = { mode: 'allow' };
    return out;
  };
  return { el, collect };
}

function hostRow(x, s, onChange) {
  const wild = x.cap === 'tool:*' || x.cap === 'mcp:*';
  const family = x.cap.startsWith('tool:') ? 'tool' : 'mcp';
  const missing = !wild && (x.cap.startsWith('tool:') || x.cap.startsWith('mcp:')) && !x.candidates.length;
  // The GPU (SPEC 8.6) is a stream of requests: there is no “ask every time” for it, only on (while the app runs) or off.
  const options = x.risk === 'gpu'
    ? [
        ['none', 'Don’t allow'],
        ['session', 'Allow while the app runs'],
      ]
    : [
        ['none', 'Don’t allow'],
        ['ask', 'Ask every time'],
        ['session', 'Allow while the app runs'],
      ];
  if (s.mode === 'always') options.push(['always', 'Always allow (set outside this sheet)']);
  const sel = h('select', { dataset: { role: 'host-mode' }, 'aria-label': hostWords(x.cap, x), disabled: missing }, options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = s.mode;
  let picks = null;
  if (wild) {
    const items = x.candidates.map((c) => {
      const box = h('input', { type: 'checkbox', dataset: { pick: c.id } });
      box.checked = s.picked.has(c.id);
      box.addEventListener('change', () => (box.checked ? s.picked.add(c.id) : s.picked.delete(c.id)));
      return h('label', { class: `pick${c.kind === 'shell' ? ' shell' : ''}`, dataset: { pickrow: c.id } }, box, ` ${c.name} `, h('span', { class: 'muted mono' }, c.id), c.kind === 'shell' ? h('span', { class: 'chip red' }, 'shell: full access') : null);
    });
    picks = h(
      'div',
      { class: 'picks', dataset: { role: 'host-picks' } },
      h('div', { class: 'muted sub' }, family === 'tool' ? 'Which of your tools may it use?' : 'Which of your MCP servers may it use?'),
      items.length
        ? items
        : h(
            'div',
            { class: 'muted' },
            `Your catalog has no ${family === 'tool' ? 'tools' : 'MCP servers'} yet. `,
            h('button', { dataset: { action: 'open-settings' }, onclick: guarded(() => loader.openSettings()) }, 'Open Host Capabilities…'),
          ),
    );
  }
  const sync = () => {
    s.mode = sel.value;
    if (picks) picks.hidden = s.mode === 'none';
  };
  sel.addEventListener('change', () => {
    sync();
    if (onChange) onChange();
  });
  sync();
  return h(
    'div',
    { class: `folder hostcap${x.risk === 'shell' || x.risk === 'input' ? ' serious' : ''}`, dataset: { cap: x.cap, risk: x.risk } },
    h('div', { class: 'fname' }, hostWords(x.cap, x), x.control ? h('span', { class: 'chip red' }, 'control of your computer') : null, x.risk === 'gpu' ? h('span', { class: 'chip amber' }, isVulkan(x) ? 'experimental' : 'uses your GPU') : null),
    h('div', { class: `purpose ${x.purpose ? '' : 'none'}`, dataset: { role: 'purpose' } }, x.purpose || 'no reason given'),
    h('div', { class: 'muted sub', dataset: { role: 'host-note' } }, (isVulkan(x) ? HOST_RISK_NOTE.gpuVulkan : HOST_RISK_NOTE[x.risk]) || ''),
    missing ? h('div', { class: 'err', dataset: { role: 'host-missing' } }, `It is not in your catalog. Add it in Host Capabilities… first.`) : null,
    h('div', { class: 'accessrow' }, h('span', {}, 'Allow:'), sel),
    picks,
  );
}

function folderRow(data, f, s, onChange) {
  const pathEl = h('span', { class: 'path mono', dataset: { role: 'path' } });
  const accessSel = h('select', { dataset: { role: 'access' } }, accessOptions(f.access).map((a) => h('option', { value: a }, ACCESS_LABEL[a])));
  const skipBtn = h('button', { dataset: { action: 'skip' } }, 'Skip');
  const accessNote = h('span', { class: 'muted' });
  const sync = () => {
    pathEl.textContent = s.skipped ? 'Skipped: the app will run without this folder' : s.path || 'No folder chosen yet';
    pathEl.className = `path mono${s.path && !s.skipped ? '' : ' unset'}`;
    accessSel.value = accessOptions(f.access).includes(s.access) ? s.access : f.access;
    s.access = accessSel.value;
    accessSel.disabled = accessOptions(f.access).length < 2;
    skipBtn.disabled = s.skipped;
    accessNote.textContent =
      f.access === 'writeonly' ? 'The app can only add files; they are delivered to this folder and it cannot read it.' : s.access === 'read' && f.access === 'readwrite' ? 'Less than requested: the app can read but not change files.' : '';
  };
  accessSel.addEventListener('change', () => {
    s.access = accessSel.value;
    sync();
    if (onChange) onChange();
  });
  const choose = h(
    'button',
    {
      dataset: { action: 'choose' },
      onclick: guarded(async () => {
        const r = await loader.chooseFolder(data.id, f.name);
        if (r && r.path) {
          s.path = r.path;
          s.skipped = false;
          sync();
          if (onChange) onChange();
        }
      }),
    },
    'Choose folder…',
  );
  skipBtn.addEventListener('click', () => {
    s.path = null;
    s.skipped = true;
    sync();
    if (onChange) onChange();
  });
  sync();
  return h(
    'div',
    { class: 'folder', dataset: { folder: f.name } },
    h('div', { class: 'fname' }, f.name, h('span', { class: `badge ${f.access === 'readwrite' ? 'rw' : ''}`, dataset: { role: 'requested' } }, `asks for ${ACCESS_LABEL[f.access]}`)),
    h('div', { class: `purpose ${f.purpose ? '' : 'none'}`, dataset: { role: 'purpose' } }, f.purpose || 'no reason given'),
    h('div', { class: 'choice' }, pathEl, choose, skipBtn),
    h('div', { class: 'accessrow' }, h('span', {}, 'Allow:'), accessSel, accessNote),
  );
}

// ---------------------------------------------------------------------------------------------- confirmations
function confirmUninstall(a) {
  const purge = h('input', { type: 'checkbox', id: 'purge-data' });
  const name = a.name || a.id;
  const m = openModal({
    title: `Uninstall “${name}”?`,
    body: h(
      'div',
      {},
      h('div', { class: 'confirm-text' }, 'The app is removed from this Mac. Your own folders are not touched.'),
      h('label', {}, purge, ' Also delete the app’s data and my folder choices'),
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Uninstall',
        action: 'confirm-uninstall',
        kind: 'danger-fill',
        onclick: async () => {
          try {
            await loader.uninstall(a.id, purge.checked);
            m.close();
            banner('info', `Uninstalled ${name}.`);
          } catch (e) {
            m.close();
            fail(e);
          }
        },
      },
    ],
  });
}

function confirmReset(a) {
  const m = openModal({
    title: 'Reset app',
    body: h('div', { class: 'confirm-text' }, `Reset “${a.name}”? This deletes the app's data and forgets your folder choices. Your own folders are not touched.`),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Reset',
        action: 'confirm-reset',
        kind: 'danger-fill',
        onclick: async () => {
          try {
            await loader.reset(a.id);
            m.close();
            banner('info', `Reset ${a.name}.`);
          } catch (e) {
            m.close();
            fail(e);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- developer: run a project folder
function afterBuild(r) {
  banner('info', `Built ${r.name} ${r.version} from the project folder${r.previous ? ` (replacing ${r.previous})` : ''}.`);
  afterLaunch({ id: r.id, name: r.name }, r.launch);
}

async function runFolder() {
  const r = await loader.runFolder();
  if (!r || r.canceled) return;
  afterBuild(r);
}

async function rebuild(a) {
  afterBuild(await loader.rebuildDev(a.id));
}

// ---------------------------------------------------------------------------------------------- publish
// A loader-owned sheet: the registry address, the owner token (found on this Mac, or none for a first publish) and, for a
// first publish, who you are. Nothing is sent until Publish is pressed.
async function openPublish(a) {
  const info = await loader.publishInfo(a.id);
  const field = (role, placeholder, value) => h('input', { type: 'text', value: value || '', spellcheck: 'false', autocomplete: 'off', placeholder, dataset: { role } });
  const reg = field('publish-registry', 'registry address (an https address)', info.registry);
  const token = h('input', { type: 'password', value: info.token || '', spellcheck: 'false', autocomplete: 'off', placeholder: 'owner token (empty for a first publish)', dataset: { role: 'publish-token' } });
  const showToken = h('input', { type: 'checkbox', dataset: { role: 'publish-show-token' } });
  showToken.addEventListener('change', () => {
    token.type = showToken.checked ? 'text' : 'password';
  });
  const pub = { name: field('publisher-name', 'your name (optional)'), company: field('publisher-company', 'company (optional)'), email: field('publisher-email', 'email (optional)'), url: field('publisher-url', 'website (optional)') };
  const tokenState = h('div', { class: 'muted sub', dataset: { role: 'publish-token-state' } });
  const insecure = h('div', { class: 'warn', dataset: { role: 'publish-insecure' } });
  const status = h('div', { class: 'muted', dataset: { role: 'publish-status' } });
  const error = h('div', { class: 'err', dataset: { role: 'publish-error' } });
  const publisherBox = h(
    'div',
    { class: 'pubform', dataset: { role: 'publisher-fields' } },
    h(
      'div',
      { class: 'muted sub' },
      'Who you are. Only sent now, on the first publish, to create your publisher. The registry shows none of it until you verify it: a verified email shows only its domain, a verified domain shows the domain, your company and your website. Your name is never shown. Details: docs/DISTRIBUTING.md, “What users see about you”.',
    ),
    pub.name,
    pub.company,
    pub.email,
    pub.url,
  );
  let prefilled = info.token || '';
  const sync = () => {
    const has = !!token.value.trim();
    publisherBox.hidden = has;
    tokenState.textContent = has
      ? token.value.trim() === prefilled
        ? 'Owner token found on this Mac for this app and registry. It is sent to publish a new version.'
        : 'This token is sent to publish a new version of this app, or to add this app to the publisher the token belongs to.'
      : 'No owner token: this is a first publish of this app id. It claims the id and gives you an owner token, shown once.';
  };
  const refreshRegistry = async () => {
    try {
      const i = await loader.publishInfo(a.id, reg.value);
      insecure.textContent = i.insecure ? 'This registry address is plain http, so the package and your owner token travel unprotected. Use it for development only.' : '';
      if (!token.value.trim() || token.value.trim() === prefilled) {
        token.value = i.token || '';
        prefilled = i.token || '';
      }
    } catch (e) {
      insecure.textContent = '';
    }
    sync();
  };
  reg.addEventListener('change', refreshRegistry);
  token.addEventListener('input', sync);
  const go = async () => {
    publishBtn.disabled = true;
    error.textContent = '';
    status.textContent = `Publishing ${info.name} ${info.version} to ${reg.value.trim()}…`;
    try {
      const r = await loader.publish(a.id, { registry: reg.value, token: token.value, publisher: { name: pub.name.value, company: pub.company.value, email: pub.email.value, url: pub.url.value } });
      m.close();
      openPublished(info, r);
    } catch (e) {
      status.textContent = '';
      error.textContent = e.message;
      publishBtn.disabled = false;
    }
  };
  const m = openModal({
    title: `Publish “${info.name}” ${info.version}`,
    body: h(
      'div',
      { class: 'pubform', dataset: { role: 'publish' } },
      h(
        'div',
        { class: 'muted' },
        `This uploads the installed package of “${info.name}” ${info.version} to the registry you name${info.dev ? ` (a developer build from ${info.dev.folder}; use “Rebuild & run” first if you changed it)` : ''}. Nothing else is sent. The first publish of an app id claims it; later versions need the owner token.`,
      ),
      info.hasPackage ? null : h('div', { class: 'err' }, 'The package file of this installation was not kept (it was installed by an older loader). Install it again from its .vmapp file, or use “Rebuild & run”, then publish.'),
      h('label', {}, 'Registry address'),
      reg,
      insecure,
      h('label', {}, 'Owner token'),
      token,
      h('label', {}, showToken, ' Show the token'),
      tokenState,
      publisherBox,
      status,
      error,
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      { label: 'Publish', action: 'publish-go', kind: 'primary', disabled: !info.hasPackage, onclick: go },
    ],
  });
  const publishBtn = m.buttons[1];
  sync();
  refreshRegistry();
}

function openPublished(info, r) {
  const copyBtn = h('button', { dataset: { action: 'copy-token' }, onclick: guarded(async () => {
    await loader.copyText(r.ownerToken);
    copyBtn.textContent = 'Copied';
  }) }, 'Copy token');
  const lines = [
    h('div', { class: 'kv', dataset: { role: 'published' } },
      h('div', { class: 'k' }, 'App'), h('div', { class: 'v mono' }, `${r.id} ${r.version}`),
      h('div', { class: 'k' }, 'App page'), h('div', { class: 'v mono', dataset: { role: 'page-url' } }, r.pageUrl),
      h('div', { class: 'k' }, 'Package id'), h('div', { class: 'v mono' }, r.packageId),
      r.publisherLabel ? [h('div', { class: 'k' }, 'Shown as'), h('div', { class: 'v' }, r.publisherLabel)] : null),
  ];
  if (r.ownerToken) {
    lines.push(
      h('div', { class: 'confirm-text' }, 'Your owner token. It proves that later versions of this app are yours. The registry shows it only now and cannot recover it.'),
      h('div', { class: 'tokenbox' }, h('span', { class: 'mono', dataset: { role: 'owner-token' } }, r.ownerToken), copyBtn),
      r.tokenSaved
        ? h('div', { class: 'muted', dataset: { role: 'token-note' } }, `Saved to this Mac (${r.tokensFile}, readable only by you) and used automatically for the next version. Keep a copy somewhere safe as well, in case this Mac is lost.`)
        : h('div', { class: 'err', dataset: { role: 'token-note' } }, `The token could NOT be saved on this Mac${r.tokenSaveError ? ` (${r.tokenSaveError})` : ''}. Copy it now and keep it safe: without it nobody can publish new versions of this app.`),
    );
  } else if (r.tokenSaved) {
    lines.push(h('div', { class: 'muted', dataset: { role: 'token-note' } }, 'The token you entered worked and is now saved on this Mac for the next version.'));
  }
  if (r.insecure) lines.push(h('div', { class: 'warn' }, 'This registry address is plain http: the package and the token travelled unprotected. Use it for development only.'));
  const m = openModal({
    title: `Published “${info.name}” ${r.version}`,
    body: h('div', { class: 'pubform', dataset: { role: 'publish-result' } }, lines),
    buttons: [
      { label: 'Open app page…', action: 'open-page', onclick: guarded(() => loader.openPage(r.pageUrl)) },
      { label: 'Done', action: 'publish-done', kind: 'primary', onclick: () => m.close() },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- install
async function install() {
  const r = await loader.pickPackage();
  if (!r || r.canceled) return;
  showReview(r, {});
}

// INV-H6: the install review says plainly when an app asks for control of the computer. Nothing is allowed here.
function hostReview(list) {
  if (!list.length) return null;
  const control = list.some((x) => x.control);
  return h(
    'div',
    { class: 'hostsec', dataset: { role: 'review-host' } },
    h('h3', {}, 'Control of your computer'),
    control ? h('div', { class: 'warnbox', dataset: { role: 'control-label' } }, 'This app requests control of your computer.') : null,
    h(
      'div',
      { class: 'muted sub' },
      list.every((x) => x.risk === 'gpu')
        ? 'Installing it allows none of this. At its first launch you choose Don’t allow (the default) or Allow while the app runs.'
        : 'Installing it allows none of this. At its first launch you choose, for each one, Don’t allow (the default), Ask every time, or Allow while the app runs.' + (list.some((x) => x.risk === 'gpu') ? ' (The GPU has no “Ask every time”.)' : ''),
    ),
    list.map((x) =>
      h(
        'div',
        { class: `folder hostcap${x.risk === 'input' ? ' serious' : ''}`, dataset: { cap: x.cap } },
        h('div', { class: 'fname' }, hostWords(x.cap, x), x.control ? h('span', { class: 'chip red' }, 'control of your computer') : null, x.risk === 'gpu' ? h('span', { class: 'chip amber' }, isVulkan(x) ? 'experimental' : 'uses your GPU') : null),
        h('div', { class: `purpose ${x.purpose ? '' : 'none'}` }, x.purpose || 'no reason given'),
        // SPEC 8.6: the GPU is not control of the computer, but it is work a helper does for the app on this Mac: said in the loader's words
        x.risk === 'gpu' ? h('div', { class: 'muted sub', dataset: { role: 'host-note' } }, isVulkan(x) ? HOST_RISK_NOTE.gpuVulkan : HOST_RISK_NOTE.gpu) : null,
      ),
    ),
  );
}

// The install review lists the devices an app asks to use. Nothing is allowed here either.
function deviceReview(list) {
  if (!list.length) return null;
  return h(
    'div',
    { class: 'hostsec', dataset: { role: 'review-devices' } },
    h('h3', {}, 'Devices'),
    h('div', { class: 'muted sub' }, 'Installing it allows none of this. At its first launch you choose, for each one, Don’t allow (the default) or Allow while the app runs.'),
    list.map((x) =>
      h(
        'div',
        { class: 'folder hostcap serious', dataset: { device: x.device } },
        h('div', { class: 'fname' }, deviceWords(x.device), h('span', { class: 'chip red' }, 'listens to you')),
        h('div', { class: `purpose ${x.purpose ? '' : 'none'}` }, x.purpose || 'no reason given'),
      ),
    ),
  );
}

// The install review lists the hosts an app asks to reach (SPEC 8.3, INV-N4), wildcards and unencrypted ports marked, and says in
// words when it could also read folders or the screen. Nothing is allowed here either.
function networkReview(list, risk) {
  if (!list.length) return null;
  return h(
    'div',
    { class: 'hostsec', dataset: { role: 'review-network' } },
    h('h3', {}, 'Network'),
    risk && risk.message ? h('div', { class: 'warnbox', dataset: { role: 'net-risk' } }, risk.message) : null,
    h('div', { class: 'muted sub' }, 'Installing it allows none of this. At its first launch you choose, for each address, Don’t allow (the default) or Allow, and you can change that at any time.'),
    list.map((x) =>
      h(
        'div',
        { class: `folder hostcap${x.any || x.wildcard || x.insecure ? ' serious' : ''}`, dataset: { netHost: x.host } },
        h(
          'div',
          { class: 'fname' },
          h('span', { class: 'mono' }, x.host),
          x.any ? h('span', { class: 'chip red', dataset: { role: 'net-any-chip' } }, 'any server') : null,
          x.wildcard ? h('span', { class: 'chip red' }, 'wildcard') : null,
          x.insecure ? h('span', { class: 'chip red' }, 'not encrypted') : null,
          h('span', { class: 'badge', dataset: { role: 'net-ports-asked' } }, portsText(x.ports)),
        ),
        h('div', { class: `purpose ${x.purpose ? '' : 'none'}`, dataset: { role: 'purpose' } }, x.purpose || 'no reason given'),
        x.any ? h('div', { class: 'err sub', dataset: { role: 'net-any' } }, anyHostWords) : null,
        x.wildcard ? h('div', { class: 'err sub', dataset: { role: 'net-wildcard' } }, wildcardWords(x.host)) : null,
        x.insecure ? h('div', { class: 'warn sub', dataset: { role: 'net-insecure' } }, 'Port 80 is plain HTTP: not encrypted.') : null,
      ),
    ),
  );
}

// The install review (also for updates and versions fetched from a registry). `r` = { token, review }.
function showReview(r, { done } = {}) {
  const rev = r.review;
  const m = rev.manifest;
  const kv = (k, v, cls) => [h('div', { class: 'k' }, k), h('div', { class: `v ${cls || ''}` }, v)];
  const kindText = {
    new: 'New app',
    update: `Update from ${rev.previous}`,
    same: rev.switchOnly ? `Switches to this version, which is already installed (now ${rev.previous})` : `Same version as installed (${rev.previous}); reinstalls it`,
    downgrade: rev.explicit
      ? `Older than the installed ${rev.previous}; you chose this version. App data is shared, so it may not read data written by newer versions.`
      : `Older than the installed ${rev.previous}; downgrades are refused`,
  }[rev.kind];
  const folders = m.permissions.folders.length
    ? m.permissions.folders.map((f) =>
        h('div', { class: 'folder', dataset: { folder: f.name } }, h('div', { class: 'fname' }, f.name, h('span', { class: `badge ${f.access === 'readwrite' ? 'rw' : ''}` }, ACCESS_LABEL[f.access])), h('div', { class: `purpose ${f.purpose ? '' : 'none'}` }, f.purpose || 'no reason given')),
      )
    : [h('div', { class: 'muted' }, 'No folders requested.')];
  const blocker = rev.kind === 'downgrade' && !rev.explicit ? 'This package is older than the installed version.' : !rev.runtimeInstalled ? `The runtime “${m.runtime}” is not installed.` : rev.running ? 'Stop the app first.' : null;
  const body = h(
    'div',
    { class: 'review' },
    h(
      'div',
      { class: 'kv', dataset: { role: 'review' } },
      kv('Name', `${m.name} ${m.version}`),
      kv('Publisher', m.publisher ? `${m.publisher} (stated by the package, not verified)` : 'unknown'),
      kv('Description', m.description || '—'),
      kv('App id', m.id, 'mono'),
      kv('Package id', rev.packageId, 'mono'),
      kv('Status', kindText),
      kv('Source', rev.source ? `from ${rev.source.registry}` : 'a file you chose', rev.source ? 'mono' : ''),
      kv('Runtime', `${m.runtime}  •  recommends ${sizeWords({ cpus: m.core.cpus, memoryMiB: m.core.memoryMiB })} (you choose the size when you first launch it)`),
      kv('Command', JSON.stringify(m.core.command), 'mono'),
      kv('Sizes', `package ${rev.sizes.package}, UI ${rev.sizes.ui}, core ${rev.sizes.core}`),
      kv('Dialogs', m.permissions.dialogs ? 'may show open/save dialogs (you choose each file)' : 'no'),
      kv('Links', m.permissions.external ? 'may open https links in your browser (you confirm each)' : 'no'),
      // SPEC 2.2 ui.features, SPEC 7: what the app's window may run inside its sandbox; none of it reaches a file, a device or the network
      kv('Window', featureWords((m.ui && m.ui.features) || [])),
    ),
    h('div', { class: 'muted' }, 'Folders it will ask for when you first launch it:'),
    h('div', { class: 'folders' }, folders),
    hostReview(rev.host || []),
    deviceReview(rev.devices || []),
    networkReview(rev.network || [], rev.risk),
    rev.source && rev.source.insecure ? h('div', { class: 'warn' }, 'This registry address is plain http, so the download is not protected on the way. Only continue if you trust the network and the registry.') : null,
    blocker ? h('div', { class: 'err' }, blocker) : null,
  );
  const cancel = async () => {
    mm.close();
    try {
      await loader.cancelInstall();
    } catch {
      /* ignore */
    }
  };
  const mm = openModal({
    title: 'Install this app?',
    body,
    onCancel: () => loader.cancelInstall().catch(() => {}),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: cancel },
      {
        label: rev.switchOnly ? 'Use this version' : rev.kind === 'update' ? 'Update' : rev.kind === 'downgrade' ? 'Install this version' : 'Install',
        action: 'confirm-install',
        kind: 'primary',
        disabled: !!blocker,
        onclick: async () => {
          try {
            const res = await loader.installPackage(r.token);
            mm.close();
            if (done) done(res.version);
            else banner('info', `Installed ${m.name} ${res.version}.`);
          } catch (e) {
            mm.close();
            fail(e);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- Load examples
// The sample apps that came with this loader. Loader UI only (INV-B5): the rows are read from the packages themselves (never from
// text an app could draw), every package is verified again when it is installed, and installing grants NOTHING: each app asks for
// its permissions at its first launch, like any other. Nothing is launched from here.
const EXAMPLE_BADGE_CLASS = { network: 'amber', gpu: 'amber', host: 'red', microphone: 'red' };

/** What the row says before anything is installed: a problem, or how it relates to what is installed already. */
function exampleNote(it) {
  if (it.error) return { text: `Can’t be read: ${it.error}`, cls: 'err' };
  if (it.runtimeMissing) return { text: `The runtime “${it.runtime}” is not installed on this Mac, so this one can’t be installed.`, cls: 'err' };
  const s = it.status || {};
  if (s.kind === 'update') return { text: `Update from ${s.installed}`, cls: 'muted' };
  if (s.kind === 'same') return { text: `Version ${s.installed} is already installed: this one will be skipped.`, cls: 'muted' };
  if (s.kind === 'older') return { text: `A newer version (${s.installed}) is installed: this one will be skipped.`, cls: 'muted' };
  return { text: '', cls: 'muted' };
}

/** The same row after the install touched it. `ev` = {phase|status, version?, previous?, note?, error?, step?}. */
function exampleResultNote(ev) {
  const p = ev.phase || ev.status;
  if (p === 'verifying') return { text: 'Verifying…', cls: 'busy' };
  if (p === 'installing') return { text: 'Installing…', cls: 'busy' };
  if (p === 'installed') return { text: `Installed ${ev.version}`, cls: 'ok' };
  if (p === 'updated') return { text: `Updated to ${ev.version}${ev.previous ? ` (was ${ev.previous})` : ''}`, cls: 'ok' };
  if (p === 'skipped') return { text: `Skipped: ${ev.note}`, cls: 'muted' };
  if (p === 'failed') return { text: ev.step === 'verify' ? `Not installed: it did not pass verification. ${ev.error}` : `Not installed: ${ev.error}`, cls: 'err' };
  return { text: '', cls: 'muted' };
}

async function openExamples() {
  const info = await loader.examplesInfo();
  if (!info.show) return banner('error', 'This loader came without examples.');
  if (!info.available) return openExamplesMissing(info);
  openExamplesSheet(await loader.examplesList());
}

// A development loader with no examples folder (or an empty one): say how to make them.
function openExamplesMissing(info) {
  const m = openModal({
    title: 'Load examples',
    body: h(
      'div',
      { dataset: { role: 'examples-missing' } },
      h('div', {}, 'There are no examples to load yet.'),
      h('div', { class: 'muted' }, `The examples are the .vmapp files in ${info.dir || 'the examples folder'}, which is empty or missing. Run tools/pack-examples in the repository to make them (it packs every sample app into out/examples/), then choose Load examples again. A development loader can read another folder: set VMAPP_EXAMPLES_DIR.`),
    ),
    buttons: [{ label: 'Close', action: 'close', onclick: () => m.close() }],
  });
}

function openExamplesSheet(data) {
  const items = data.items;
  let phase = 'choose'; // 'choose' | 'installing' | 'done'
  const boxes = new Map(); // file -> checkbox
  const notes = new Map(); // file -> the row's status element
  const rowEls = new Map();
  const pickable = items.filter((it) => !it.error && !it.runtimeMissing);
  const selected = () => pickable.filter((it) => boxes.get(it.file).checked).map((it) => it.file);
  const setNote = (file, n, result) => {
    const el = notes.get(file);
    if (!el) return;
    el.textContent = n.text;
    el.className = `exstatus ${n.cls}`;
    if (result) rowEls.get(file).dataset.result = result;
  };
  const count = h('span', { class: 'muted', dataset: { role: 'examples-count' } });
  const toggle = h('button', { dataset: { action: 'examples-toggle' } });
  const summary = h('div', { class: 'exsummary', dataset: { role: 'examples-summary' }, 'aria-live': 'polite' });
  let installBtn = null;
  const update = () => {
    const n = selected().length;
    count.textContent = `${n} of ${pickable.length} selected`;
    toggle.textContent = n === pickable.length ? 'Select none' : 'Select all';
    toggle.disabled = phase !== 'choose' || !pickable.length;
    if (installBtn && phase === 'choose') installBtn.disabled = n === 0;
  };
  toggle.addEventListener('click', () => {
    const all = selected().length === pickable.length;
    for (const it of pickable) boxes.get(it.file).checked = !all;
    update();
  });

  const rows = items.map((it) => {
    const ok = !it.error && !it.runtimeMissing;
    const box = h('input', { type: 'checkbox', disabled: !ok, dataset: { role: 'example-check' } });
    box.checked = ok; // all checked
    box.addEventListener('change', update);
    boxes.set(it.file, box);
    const note = exampleNote(it);
    const status = h('div', { class: `exstatus ${note.cls}`, dataset: { role: 'example-status' } }, note.text);
    notes.set(it.file, status);
    const row = h(
      'div',
      { class: `exrow${ok ? '' : ' unavailable'}`, dataset: { example: it.file, state: it.error ? 'unreadable' : it.status ? it.status.kind : '' } },
      h('label', { class: 'exhead' }, box, h('span', { class: 'exname', dataset: { role: 'example-name' } }, it.name), it.version ? h('span', { class: 'version', dataset: { role: 'example-version' } }, it.version) : null, h('span', { class: 'badge', dataset: { role: 'example-size' }, title: it.file }, it.sizeText)),
      it.description ? h('div', { class: 'exdesc muted', dataset: { role: 'example-desc' } }, it.description) : null,
      (it.badges || []).length
        ? h('div', { class: 'chips', dataset: { role: 'example-badges' } }, it.badges.map((b) => h('span', { class: `chip ${EXAMPLE_BADGE_CLASS[b.kind] || ''}`, title: b.title, dataset: { badge: b.kind } }, b.label)))
        : null,
      it.allow ? h('div', { class: 'exallow', dataset: { role: 'example-allow-row' } }, h('span', { class: 'k' }, 'What to allow: '), h('span', { dataset: { role: 'example-allow', from: it.allowFrom || '' } }, it.allow)) : null,
      status,
    );
    rowEls.set(it.file, row);
    return row;
  });

  const lock = () => {
    for (const b of boxes.values()) b.disabled = true;
    toggle.disabled = true;
  };
  const start = async () => {
    const names = selected();
    if (!names.length) return;
    phase = 'installing';
    lock();
    cancelBtn.hidden = true;
    installBtn.disabled = true;
    installBtn.textContent = 'Installing…';
    for (const it of items) setNote(it.file, names.includes(it.file) ? { text: 'Waiting…', cls: 'muted' } : { text: 'Not selected', cls: 'muted' });
    examplesLive = (ev) => setNote(ev.file, exampleResultNote(ev), ev.phase === 'verifying' || ev.phase === 'installing' ? undefined : ev.phase);
    try {
      const r = await loader.examplesInstall(names);
      for (const res of r.results) setNote(res.file, exampleResultNote(res), res.status);
      summary.className = `exsummary ${r.counts.failed ? 'err' : 'ok'}`;
      summary.textContent = r.text;
    } catch (e) {
      summary.className = 'exsummary err';
      summary.textContent = e && e.message ? e.message : String(e);
    } finally {
      examplesLive = null;
      phase = 'done';
      installBtn.disabled = false;
      installBtn.textContent = 'Done';
      installBtn.dataset.action = 'examples-done';
      installBtn.classList.add('primary');
    }
  };

  const m = openModal({
    title: 'Load examples',
    wide: true,
    canClose: () => phase !== 'installing',
    body: h(
      'div',
      { class: 'examples', dataset: { role: 'examples' } },
      h('div', { class: 'muted' }, 'These are the sample apps that came with this loader. Choose the ones to install. Each package is verified again as it is installed.'),
      h('div', { class: 'exnote', dataset: { role: 'examples-note' } }, "Installing doesn't grant anything: each app asks for its permissions the first time you launch it."),
      h('div', { class: 'exbar' }, count, toggle),
      h('div', { class: 'exlist', dataset: { role: 'examples-list' } }, rows),
      summary,
    ),
    buttons: [
      { label: 'Cancel', action: 'examples-cancel', onclick: () => m.close() },
      { label: 'Install selected', action: 'examples-install', kind: 'primary', onclick: () => (phase === 'choose' ? start() : m.close()) },
    ],
  });
  const cancelBtn = m.buttons[0];
  installBtn = m.buttons[1];
  update();
}

// ---------------------------------------------------------------------------------------------- wiring
document.getElementById('btn-install').addEventListener('click', guarded(install));
loader.onExamplesProgress((ev) => {
  if (examplesLive && ev && typeof ev.file === 'string') examplesLive(ev);
});
// the File menu (main.js): it only names the sheet to open; the page shows it
loader.onMenu((action) => {
  if (action === 'examples') guarded(openExamples)();
  else if (action === 'browse') guarded(openBrowse)();
  else if (action === 'install') guarded(install)();
});
document.getElementById('btn-run-folder').addEventListener('click', guarded(runFolder));
document.getElementById('btn-browse-registry').addEventListener('click', guarded(openBrowse));
document.getElementById('btn-inspector').addEventListener('click', guarded(() => loader.inspect(null)));
document.getElementById('btn-settings').addEventListener('click', guarded(() => loader.openSettings()));
loader.onChanged(() => refresh());
loader.onNotice((n) => banner(n && n.kind === 'info' ? 'info' : 'error', n && n.text ? n.text : ''));
refresh();
