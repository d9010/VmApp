'use strict';
/* global h, settings */
// Host Capabilities window: macOS permissions, the user's tools and MCP servers (the catalog), Stop everything.
// Loader-owned (INV-B5, INV-H1). Everything is inserted as text. The presets only fill the form: the user saves.

const banners = document.getElementById('banners');
const modalRoot = document.getElementById('modal-root');

let st = { tools: [], mcp: [], errors: [], active: [], shortcut: '⌃⌥⌘.', platform: '' };
let perm = null; // {ok, screenRecording, accessibility, macos} | {ok:false, error}

function banner(kind, text) {
  const el = h('div', { class: `banner ${kind}` }, h('span', {}, text), h('button', { title: 'Dismiss', onclick: () => el.remove() }, '×'));
  banners.appendChild(el);
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

/** replaceChildren that skips null/false (the DOM would turn them into the text "null") and flattens arrays. */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

// ---------------------------------------------------------------------------------------------- modal
let closeModal = null;
function openModal({ title, body, buttons }) {
  if (closeModal) closeModal();
  const btns = (buttons || []).map((b) => h('button', { class: b.kind || '', dataset: { action: b.action }, onclick: b.onclick }, b.label));
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('h2', {}, title), body, h('div', { class: 'foot' }, btns)));
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (closeModal === close) closeModal = null;
  }
  document.addEventListener('keydown', onKey);
  modalRoot.appendChild(overlay);
  closeModal = close;
  return { close, buttons: btns };
}

// ---------------------------------------------------------------------------------------------- presets (fill the form only)
const PRESETS = [
  {
    key: 'screenshot',
    label: 'Screenshot tool (screencapture)',
    tool: {
      id: 'screencapture',
      name: 'Screenshot tool',
      path: '/usr/sbin/screencapture',
      kind: 'tool',
      description: 'Takes a screenshot of the screen into a file the app saved a place for.',
      args: [{ pattern: '^-x$' }, { pattern: '^-R\\d+,\\d+,\\d+,\\d+$', optional: true }, { pattern: '^/host/save-\\d+/[\\w .-]+\\.png$', mapPath: 'write' }],
      timeoutMs: 30000,
    },
  },
  {
    key: 'open-app',
    label: 'Open an app (open -a)',
    tool: {
      id: 'open-app',
      name: 'Open an app',
      path: '/usr/bin/open',
      kind: 'tool',
      description: 'Opens an application by name.',
      args: [{ pattern: '^-a$' }, { pattern: '^[A-Za-z0-9 .-]{1,60}$' }],
      timeoutMs: 30000,
    },
  },
  {
    key: 'terminal',
    label: 'Terminal shell (full access)',
    tool: {
      id: 'terminal',
      name: 'Terminal shell',
      path: '/bin/zsh',
      kind: 'shell',
      description: 'A full shell. The app can run any command you could.',
      args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,10000}$' }],
      timeoutMs: 60000,
    },
  },
];

// ---------------------------------------------------------------------------------------------- macOS permissions
function permRow(which, title, what) {
  const known = perm && perm.ok;
  const granted = known && (which === 'screen' ? perm.screenRecording : perm.accessibility);
  const text = !perm ? 'Checking…' : !perm.ok ? 'Unknown' : granted ? 'Allowed' : 'Not allowed';
  return h(
    'div',
    { class: 'permrow', dataset: { perm: which } },
    h('span', { class: 'pname' }, title),
    h('span', { class: `status ${known ? (granted ? 'ok' : 'no') : ''}`, dataset: { role: `perm-${which}-status` } }, text),
    h('span', { class: 'muted sub grow' }, what),
    h('button', { dataset: { action: `ask-${which}` }, title: 'Shows the macOS question. Nothing is asked until you click.', onclick: guarded(() => askMacos(which)) }, 'Ask macOS…'),
    h('button', { dataset: { action: `open-${which}` }, onclick: guarded(() => settings.openSystemSettings(which)) }, 'Open System Settings'),
  );
}

async function askMacos(which) {
  const r = await settings.askMacos(which);
  perm = r;
  if (!r.ok) banner('error', `macOS permissions: ${r.error}`);
  else banner('info', 'macOS may need a moment, and D9010 VmApp Launcher may need to be restarted before a new permission works.');
  renderMacos();
}

function renderMacos() {
  const sec = document.getElementById('sec-macos');
  fill(
    sec,
    h('h2', {}, 'macOS permissions'),
    h('div', { class: 'muted sub' }, 'Seeing the screen needs Screen Recording, and controlling the mouse and keyboard needs Accessibility. You give both to “D9010 VmApp Launcher” in System Settings; apps can never ask for them or turn them on.'),
    permRow('screen', 'Screen Recording', 'Needed for screenshots and the list of windows.'),
    permRow('accessibility', 'Accessibility', 'Needed to click and type for an app.'),
    perm && !perm.ok ? h('div', { class: 'err sub', dataset: { role: 'perm-error' } }, `The macOS helper is not available: ${perm.error}`) : null,
    h('div', { class: 'stoprow' }, h('button', { dataset: { action: 'refresh-status' }, onclick: guarded(refreshStatus) }, 'Check again'), perm && perm.ok && perm.macos ? h('span', { class: 'muted sub' }, `macOS ${perm.macos}`) : null),
  );
}

async function refreshStatus() {
  perm = await settings.status();
  renderMacos();
}

// ---------------------------------------------------------------------------------------------- stop everything
function renderStop() {
  const sec = document.getElementById('sec-stop');
  const items = st.active || [];
  fill(
    sec,
    h('h2', {}, 'Stop everything'),
    h(
      'div',
      { class: 'muted sub' },
      'While an app controls your mouse and keyboard, or runs a shell command, a red bar stays on top of your screen with a Stop button. The shortcut below stops every app at once, wherever you are.',
    ),
    h(
      'div',
      { class: 'stoprow' },
      h('span', { class: 'kbd', dataset: { role: 'panic-shortcut' } }, st.shortcut),
      h('span', { class: 'muted' }, 'Control-Option-Command-period'),
      h('span', { class: 'grow' }),
      h('button', { class: 'danger-fill', dataset: { action: 'stop-all' }, onclick: guarded(stopAll) }, 'Stop everything now'),
    ),
    h(
      'div',
      { class: 'activelist', dataset: { role: 'active-list' } },
      items.length
        ? items.map((e) =>
            h(
              'div',
              { class: 'activeitem', dataset: { app: e.appId, kind: e.kind } },
              h('span', {}, e.kind === 'shell' ? `${e.appName} is running a shell command (${e.tool ? e.tool.name : ''})` : `${e.appName} is controlling your computer`),
              h('button', { dataset: { action: 'stop-app' }, onclick: guarded(() => settings.stopControl(e.appId)) }, 'Stop'),
            ),
          )
        : h('div', { class: 'muted sub' }, 'Nothing is controlling your computer right now.'),
    ),
  );
}

async function stopAll() {
  await settings.stopAll();
  banner('info', 'Stopped: no app is controlling your computer now.');
}

// ---------------------------------------------------------------------------------------------- the input overlay
// While an app controls the mouse and keyboard the overlay shows a caption of what it types. By default it only says how much
// ("typing… (12 characters)"); keys like ⌘S are always shown. This switch (off by default) shows the first characters of the text.
function renderOverlay() {
  const sec = document.getElementById('sec-overlay');
  const on = !!(st.prefs && st.prefs.overlayShowTyped);
  const box = h('input', { type: 'checkbox', id: 'pref-overlay-typed', dataset: { role: 'pref-overlay-typed' } });
  box.checked = on;
  box.addEventListener(
    'change',
    guarded(async () => {
      try {
        st.prefs = await settings.setPref('overlayShowTyped', box.checked);
        banner('info', box.checked ? 'The overlay now shows the first characters of typed text.' : 'The overlay now hides typed text again.');
      } catch (e) {
        box.checked = !box.checked;
        throw e;
      }
      renderOverlay();
    }),
  );
  fill(
    sec,
    h('h2', {}, 'Input overlay'),
    h(
      'div',
      { class: 'muted sub' },
      'While an app controls your mouse and keyboard, a ring shows where its pointer is and a caption at the bottom of the screen shows what it presses. Key combinations like ⌘S are always shown. What it types is hidden by default: the caption only says “typing… (12 characters)”, so a password typed by an app is not readable on your screen.',
    ),
    h('label', { class: 'stoprow' }, box, ' Show typed text in the overlay'),
    h(
      'div',
      { class: `sub ${on ? 'err' : 'muted'}`, dataset: { role: 'pref-overlay-note' } },
      on
        ? 'On: the first 28 characters an app types appear on your screen. They are never recorded and never in the Inspector, but anyone looking at your screen can read them.'
        : 'Off: typed text is hidden.',
    ),
  );
}

// ---------------------------------------------------------------------------------------------- experimental GPU (Vulkan)
// SPEC 8.7. An app can ask for the Vulkan GPU in its manifest and you allow it per app (permission sheet); it only runs on the
// experimental backend while this switch is on. Off by default; off, such an app starts normally, without a GPU.
function renderGpuVulkan() {
  const sec = document.getElementById('sec-gpu');
  const on = !!(st.prefs && st.prefs.experimentalGpuVulkan);
  const box = h('input', { type: 'checkbox', id: 'pref-gpu-vulkan', dataset: { role: 'pref-gpu-vulkan' } });
  box.checked = on;
  box.addEventListener(
    'change',
    guarded(async () => {
      try {
        st.prefs = await settings.setPref('experimentalGpuVulkan', box.checked);
        banner('info', box.checked ? 'Apps you allowed to use the Vulkan GPU now run on the experimental GPU backend.' : 'Apps start on the normal backend again, without a Vulkan GPU.');
      } catch (e) {
        box.checked = !box.checked;
        throw e;
      }
      renderGpuVulkan();
    }),
  );
  fill(
    sec,
    h('h2', {}, 'Experimental GPU (Vulkan)', h('span', { class: 'chip amber' }, 'experimental')),
    h(
      'div',
      { class: 'muted sub' },
      'Lets an app that asks for the Vulkan GPU, and that you allowed in its permission sheet, use your Mac’s GPU from inside its virtual machine. It runs on a different, experimental virtual machine backend with these limits: the app cannot be given folders while it runs (only the ones you chose at launch), it can crash or hang the GPU work of its own virtual machine (the loader then stops that app), and it is less proven than the normal backend.',
    ),
    h('label', { class: 'stoprow' }, box, ' Experimental GPU (Vulkan)'),
    h('div', { class: 'sub muted', dataset: { role: 'pref-gpu-vulkan-note' } }, on ? 'On: allowed apps run on the experimental GPU backend.' : 'Off: apps run on the normal backend, without a Vulkan GPU.'),
  );
}

// ---------------------------------------------------------------------------------------------- launcher updates
// SPEC 8.10. On by default; off, the launcher asks only when you choose "Check for Updates…". Either way nothing is downloaded or
// installed until you press "Update now" on the card in the library window.
function renderUpdates() {
  const sec = document.getElementById('sec-updates');
  const on = !st.prefs || st.prefs.checkForUpdates !== false;
  const box = h('input', { type: 'checkbox', id: 'pref-check-updates', dataset: { role: 'pref-check-updates' } });
  box.checked = on;
  box.addEventListener(
    'change',
    guarded(async () => {
      try {
        st.prefs = await settings.setPref('checkForUpdates', box.checked);
        banner('info', box.checked ? 'The launcher will check for updates each time it starts, and at least once a day.' : 'The launcher will check for updates only when you choose “Check for Updates…”.');
      } catch (e) {
        box.checked = !box.checked;
        throw e;
      }
      renderUpdates();
    }),
  );
  fill(
    sec,
    h('h2', {}, 'Launcher updates'),
    h(
      'div',
      { class: 'muted sub' },
      'The launcher can ask, each time it starts and then at least once a day while it runs, whether a newer version of itself exists. It asks one address on vmapp.dev for a small file and sends nothing about you: no identifier, no list of your apps, not even the version you run. A card appears in the library when there is an update. Nothing is downloaded until you press “Update now”, and nothing restarts until you press “Restart to update”. You can also ask any time with “Check for Updates…” in the launcher’s menu.',
    ),
    h('label', { class: 'stoprow' }, box, ' Check for launcher updates automatically'),
    h('div', { class: 'sub muted', dataset: { role: 'pref-check-updates-note' } }, on ? 'On: checks each time the launcher starts, and at least once a day while it runs.' : 'Off: checks only when you choose “Check for Updates…”.'),
  );
}

// ---------------------------------------------------------------------------------------------- catalog lists
const argSummary = (t) => (t.args.length ? t.args.map((a) => a.pattern).join('   ') : 'no arguments');

function toolEntry(t) {
  const shell = t.kind === 'shell';
  return h(
    'div',
    { class: `entry${shell ? ' shell' : ''}`, dataset: { tool: t.id, kind: t.kind } },
    h('div', { class: 'ename' }, t.name, h('span', { class: 'chip mono' }, t.id), shell ? h('span', { class: 'chip red', dataset: { role: 'shell-chip' } }, 'shell: full access') : null),
    h('div', { class: 'eb' }, h('button', { dataset: { action: 'edit-tool' }, onclick: () => toolForm(t) }, 'Edit…'), h('button', { class: 'danger', dataset: { action: 'remove-tool' }, onclick: () => confirmRemove('tool', t) }, 'Remove…')),
    h('div', { class: 'meta mono' }, `${t.path}   •   ${t.variadic ? 'last argument may repeat   •   ' : ''}${argSummary(t)}`),
  );
}

function mcpEntry(s) {
  return h(
    'div',
    { class: 'entry', dataset: { mcp: s.id } },
    h('div', { class: 'ename' }, s.name, h('span', { class: 'chip mono' }, s.id)),
    h('div', { class: 'eb' }, h('button', { dataset: { action: 'edit-mcp' }, onclick: () => mcpForm(s) }, 'Edit…'), h('button', { class: 'danger', dataset: { action: 'remove-mcp' }, onclick: () => confirmRemove('mcp', s) }, 'Remove…')),
    h('div', { class: 'meta mono' }, s.command.join(' ') + (Object.keys(s.env || {}).length ? `   •   env: ${Object.keys(s.env).join(', ')}` : '')),
  );
}

function renderTools() {
  const sec = document.getElementById('sec-tools');
  fill(
    sec,
    h('div', { class: 'listhead' }, h('h2', {}, 'Tools'), h('button', { class: 'primary', dataset: { action: 'add-tool' }, onclick: () => toolForm(null) }, 'Add a tool…')),
    h(
      'div',
      { class: 'muted sub' },
      'A tool is a program on this Mac that you allow apps to run. The app only sends the arguments, and each one must match the pattern you set. The program is started directly, never through a shell, unless you add a shell tool.',
    ),
    h('div', { class: 'presets' }, h('span', { class: 'muted sub' }, 'Presets (they fill the form; you save it):'), PRESETS.map((p) => h('button', { dataset: { action: `preset-${p.key}` }, onclick: () => toolForm(null, p.tool) }, p.label))),
    st.tools.length ? h('div', { class: 'activelist', dataset: { role: 'tools-list' } }, st.tools.map(toolEntry)) : h('div', { class: 'muted', dataset: { role: 'tools-empty' } }, 'No tools yet.'),
  );
}

function renderMcp() {
  const sec = document.getElementById('sec-mcp');
  fill(
    sec,
    h('div', { class: 'listhead' }, h('h2', {}, 'MCP servers'), h('button', { class: 'primary', dataset: { action: 'add-mcp' }, onclick: () => mcpForm(null) }, 'Add an MCP server…')),
    h('div', { class: 'muted sub' }, 'An MCP server is a program that speaks the Model Context Protocol over standard input and output (for example the one a code editor offers). Each app that you allow gets its own copy, started when it first needs it and stopped when the app stops.'),
    st.mcp.length ? h('div', { class: 'activelist', dataset: { role: 'mcp-list' } }, st.mcp.map(mcpEntry)) : h('div', { class: 'muted', dataset: { role: 'mcp-empty' } }, 'No MCP servers yet.'),
  );
}

function render() {
  renderMacos();
  renderStop();
  renderOverlay();
  renderGpuVulkan();
  renderUpdates();
  renderTools();
  renderMcp();
}

async function reload() {
  st = await settings.state();
  for (const m of st.errors || []) fail(new Error(m));
  render();
}

function confirmRemove(kind, e) {
  const what = kind === 'tool' ? 'tool' : 'MCP server';
  const m = openModal({
    title: `Remove “${e.name}”?`,
    body: h('div', { class: 'confirm-text' }, `The ${what} “${e.name}” is taken out of your catalog. Apps that you allowed to use it lose that, and nothing else changes.`),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Remove',
        action: 'confirm-remove',
        kind: 'danger-fill',
        onclick: async () => {
          try {
            if (kind === 'tool') await settings.removeTool(e.id);
            else await settings.removeMcp(e.id);
            m.close();
            banner('info', `Removed “${e.name}”.`);
            await reload();
          } catch (err) {
            m.close();
            fail(err);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- tool form
function toolForm(existing, preset) {
  const src = existing || preset || { kind: 'tool', args: [] };
  const editing = !!existing;
  const f = {
    name: h('input', { type: 'text', value: src.name || '', spellcheck: 'false', dataset: { role: 'tool-name' } }),
    id: h('input', { type: 'text', value: src.id || '', spellcheck: 'false', readonly: editing, dataset: { role: 'tool-id' }, placeholder: 'letters, digits and dashes, like screencapture' }),
    kind: h('select', { dataset: { role: 'tool-kind' } }, h('option', { value: 'tool' }, 'Tool: only the arguments you allow'), h('option', { value: 'shell' }, 'Shell: full access (dangerous)')),
    path: h('input', { type: 'text', value: src.path || '', spellcheck: 'false', dataset: { role: 'tool-path' }, placeholder: '/usr/bin/…  (the full path of the program)' }),
    desc: h('input', { type: 'text', value: src.description || '', dataset: { role: 'tool-description' } }),
    timeout: h('input', { type: 'number', min: '1', max: '600000', value: src.timeoutMs === undefined ? '' : String(src.timeoutMs), placeholder: '30000', dataset: { role: 'tool-timeout' } }),
    maxout: h('input', { type: 'number', min: '1', max: '16777216', value: src.maxOutputBytes === undefined ? '' : String(src.maxOutputBytes), placeholder: '1048576', dataset: { role: 'tool-maxout' } }),
    cwd: h('input', { type: 'text', value: src.cwd || '', spellcheck: 'false', dataset: { role: 'tool-cwd' }, placeholder: 'empty: your home folder' }),
    variadic: h('input', { type: 'checkbox', dataset: { role: 'tool-variadic' } }),
  };
  f.kind.value = src.kind === 'shell' ? 'shell' : 'tool';
  f.variadic.checked = !!src.variadic;
  const warn = h('div', { class: 'warnbox', dataset: { role: 'shell-warning' }, hidden: true }, 'A shell tool lets the app run any command, with all your access: it can read, change and delete your files and start any program. Only add it for an app you fully trust. It always asks you first, is never “always allowed”, and shows the red badge while it runs.');
  const syncKind = () => {
    warn.hidden = f.kind.value !== 'shell';
  };
  f.kind.addEventListener('change', syncKind);
  syncKind();

  const argList = h('div', { class: 'arglist', dataset: { role: 'arg-list' } });
  const addArg = (a) => {
    const pat = h('input', { type: 'text', value: (a && a.pattern) || '', spellcheck: 'false', placeholder: '^pattern$', dataset: { role: 'arg-pattern' } });
    const opt = h('input', { type: 'checkbox', dataset: { role: 'arg-optional' } });
    opt.checked = !!(a && a.optional);
    const mp = h('select', { dataset: { role: 'arg-mappath' }, title: 'A path inside a folder you gave the app (/host/…) is replaced by the real path' }, [
      h('option', { value: '' }, 'plain text'),
      h('option', { value: 'true' }, 'path (any)'),
      h('option', { value: 'read' }, 'path (readable)'),
      h('option', { value: 'write' }, 'path (writable)'),
    ]);
    mp.value = a && a.mapPath ? String(a.mapPath) : '';
    const row = h('div', { class: 'argrow', dataset: { role: 'arg-row' } }, pat, h('label', {}, opt, ' optional'), mp, h('button', { title: 'Remove this argument', dataset: { action: 'remove-arg' }, onclick: () => row.remove() }, '−'));
    argList.appendChild(row);
  };
  for (const a of src.args || []) addArg(a);

  const error = h('div', { class: 'err', dataset: { role: 'form-error' } });
  const collect = () => {
    const def = { id: f.id.value.trim(), name: f.name.value.trim(), path: f.path.value.trim(), kind: f.kind.value };
    def.args = [...argList.querySelectorAll('[data-role="arg-row"]')].map((row) => {
      const spec = { pattern: row.querySelector('[data-role="arg-pattern"]').value };
      if (row.querySelector('[data-role="arg-optional"]').checked) spec.optional = true;
      const mp = row.querySelector('[data-role="arg-mappath"]').value;
      if (mp) spec.mapPath = mp === 'true' ? true : mp;
      return spec;
    });
    if (f.variadic.checked) def.variadic = true;
    if (f.desc.value.trim()) def.description = f.desc.value.trim();
    if (f.timeout.value.trim()) def.timeoutMs = Number(f.timeout.value);
    if (f.maxout.value.trim()) def.maxOutputBytes = Number(f.maxout.value);
    if (f.cwd.value.trim()) def.cwd = f.cwd.value.trim();
    return def;
  };
  const m = openModal({
    title: editing ? `Edit the tool “${src.name}”` : preset ? 'Add a tool (from a preset)' : 'Add a tool',
    body: h(
      'div',
      { class: 'form', dataset: { role: 'tool-form' } },
      preset ? h('div', { class: 'full muted sub' }, 'This is a starting point. Check every field, then press Save.') : null,
      h('label', {}, 'Name'),
      f.name,
      h('label', {}, 'Id'),
      f.id,
      h('label', {}, 'Kind'),
      f.kind,
      h('div', { class: 'full' }, warn),
      h('label', {}, 'Program'),
      h('div', { class: 'inline' }, f.path, h('button', { dataset: { action: 'browse' }, onclick: guarded(async () => { const r = await settings.pickFile(); if (r && r.path) f.path.value = r.path; }) }, 'Choose…')),
      h('label', {}, 'Description'),
      f.desc,
      h('div', { class: 'full' }, h('strong', {}, 'Arguments'), h('div', { class: 'muted sub' }, 'In order. Each argument the app sends must match its pattern entirely (write it as ^…$). An argument that does not match, or extra ones, is refused.')),
      h('div', { class: 'full' }, argList, h('button', { dataset: { action: 'add-arg' }, onclick: () => addArg(null) }, 'Add an argument')),
      h('label', {}, 'Repeat'),
      h('label', {}, f.variadic, ' the last argument may repeat'),
      h('label', {}, 'Time limit (ms)'),
      f.timeout,
      h('label', {}, 'Output limit (bytes)'),
      f.maxout,
      h('label', {}, 'Working folder'),
      f.cwd,
      h('div', { class: 'full' }, error),
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Save',
        action: 'save-tool',
        kind: 'primary',
        onclick: async () => {
          error.textContent = '';
          try {
            await settings.saveTool(collect());
            m.close();
            banner('info', `Saved the tool “${f.name.value.trim()}”.`);
            await reload();
          } catch (e) {
            error.textContent = e.message;
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- MCP form
function mcpForm(existing) {
  const src = existing || { command: [], env: {} };
  const editing = !!existing;
  const f = {
    name: h('input', { type: 'text', value: src.name || '', dataset: { role: 'mcp-name' } }),
    id: h('input', { type: 'text', value: src.id || '', spellcheck: 'false', readonly: editing, dataset: { role: 'mcp-id' }, placeholder: 'letters, digits and dashes, like vscode' }),
    program: h('input', { type: 'text', value: src.command[0] || '', spellcheck: 'false', dataset: { role: 'mcp-program' }, placeholder: '/usr/local/bin/…  (the full path of the program)' }),
    args: h('textarea', { spellcheck: 'false', dataset: { role: 'mcp-args' }, placeholder: 'one argument per line' }),
    env: h('textarea', { spellcheck: 'false', dataset: { role: 'mcp-env' }, placeholder: 'NAME=value, one per line (optional)' }),
    desc: h('input', { type: 'text', value: src.description || '', dataset: { role: 'mcp-description' } }),
  };
  f.args.value = src.command.slice(1).join('\n');
  f.env.value = Object.entries(src.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  const error = h('div', { class: 'err', dataset: { role: 'form-error' } });
  const collect = () => {
    const def = { id: f.id.value.trim(), name: f.name.value.trim() };
    def.command = [f.program.value.trim(), ...f.args.value.split('\n').filter((l) => l !== '')];
    const env = {};
    for (const line of f.env.value.split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf('=');
      if (i < 1) throw new Error(`The environment line “${line.slice(0, 40)}” must look like NAME=value.`);
      env[line.slice(0, i).trim()] = line.slice(i + 1);
    }
    def.env = env;
    if (f.desc.value.trim()) def.description = f.desc.value.trim();
    return def;
  };
  const m = openModal({
    title: editing ? `Edit the MCP server “${src.name}”` : 'Add an MCP server',
    body: h(
      'div',
      { class: 'form', dataset: { role: 'mcp-form' } },
      h('label', {}, 'Name'),
      f.name,
      h('label', {}, 'Id'),
      f.id,
      h('label', {}, 'Program'),
      h('div', { class: 'inline' }, f.program, h('button', { dataset: { action: 'browse' }, onclick: guarded(async () => { const r = await settings.pickFile(); if (r && r.path) f.program.value = r.path; }) }, 'Choose…')),
      h('label', {}, 'Arguments'),
      f.args,
      h('label', {}, 'Environment'),
      f.env,
      h('label', {}, 'Description'),
      f.desc,
      h('div', { class: 'full muted sub' }, 'The program starts with only PATH and HOME plus the variables above. Put a secret here only if you accept that every app you allow to use this server can use it.'),
      h('div', { class: 'full' }, error),
    ),
    buttons: [
      { label: 'Cancel', action: 'cancel', onclick: () => m.close() },
      {
        label: 'Save',
        action: 'save-mcp',
        kind: 'primary',
        onclick: async () => {
          error.textContent = '';
          try {
            await settings.saveMcp(collect());
            m.close();
            banner('info', `Saved the MCP server “${f.name.value.trim()}”.`);
            await reload();
          } catch (e) {
            error.textContent = e.message;
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- wiring
settings.onChanged(() => settings.state().then((s) => { st = s; renderStop(); }).catch(() => {}));
window.addEventListener('focus', () => refreshStatus().catch(() => {})); // coming back from System Settings
render();
reload().catch(fail);
refreshStatus().catch(fail);
