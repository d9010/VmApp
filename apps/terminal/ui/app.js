// Terminal window: xterm.js on top of the core's pseudo-terminal bridge (core/main.js lists the channels).
// The page has no network and no Node; everything it knows about a program's output comes from the core as base64 chunks.
(() => {
  'use strict';
  const vm = window.vmapp;
  const $ = (id) => document.getElementById(id);

  const store = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage may be unavailable: the preference just is not remembered */
      }
    },
  };

  // ---------------------------------------------------------------------------------------------- the emulator

  const THEMES = {
    dark: {
      background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', cursorAccent: '#1e1e1e', selectionBackground: '#264f78',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
    },
    light: {
      background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#ffffff', selectionBackground: '#b3d4ff',
      black: '#000000', red: '#c91b00', green: '#00832d', yellow: '#8a6d00', blue: '#0225c7', magenta: '#a8109d', cyan: '#007a8a', white: '#a5a5a5',
      brightBlack: '#686868', brightRed: '#e0382b', brightGreen: '#1f9d4a', brightYellow: '#a07f00', brightBlue: '#2e49e0', brightMagenta: '#c026c0', brightCyan: '#0e8da0', brightWhite: '#1d1d1f',
    },
  };
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const currentTheme = () => (scheme.matches ? THEMES.dark : THEMES.light);

  let fontSize = Math.min(24, Math.max(9, Number.parseInt(store.get('fontSize'), 10) || 13));

  const term = new window.Terminal({
    fontFamily: 'Menlo, "SF Mono", ui-monospace, Monaco, Consolas, "DejaVu Sans Mono", monospace',
    fontSize,
    cursorBlink: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: currentTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));

  scheme.addEventListener('change', () => {
    term.options.theme = currentTheme();
  });

  function refit() {
    try {
      fit.fit();
    } catch {
      /* the element has no size yet (hidden window) */
    }
  }

  let fitScheduled = false;
  new ResizeObserver(() => {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      refit();
    });
  }).observe($('term'));

  function setFontSize(n) {
    fontSize = Math.min(24, Math.max(9, n));
    term.options.fontSize = fontSize;
    $('font-size').textContent = `${fontSize} pt`;
    store.set('fontSize', String(fontSize));
    refit();
  }
  $('font-size').textContent = `${fontSize} pt`;
  $('font-smaller').addEventListener('click', () => setFontSize(fontSize - 1));
  $('font-larger').addEventListener('click', () => setFontSize(fontSize + 1));

  // Copy and paste: the loader's Edit menu (and the `copy` / `paste` events xterm.js listens to) do the work for the
  // shortcuts; these handlers cover a copy that reaches the page as a plain key press, and the screen shortcuts.
  function copySelection() {
    const text = term.getSelection();
    if (text && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
  }
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const cmd = ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey;
    if (cmd && ev.key === 'c' && term.hasSelection()) {
      copySelection();
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && !ev.metaKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
      copySelection();
      return false;
    }
    if (cmd && ev.key === 'k') {
      term.clear();
      return false;
    }
    if (cmd && (ev.key === '=' || ev.key === '+')) {
      setFontSize(fontSize + 1);
      return false;
    }
    if (cmd && ev.key === '-') {
      setFontSize(fontSize - 1);
      return false;
    }
    if (cmd && ev.key === '0') {
      setFontSize(13);
      return false;
    }
    return true;
  });

  function fromBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // ---------------------------------------------------------------------------------------------- the session

  /** The running (or just ended) program: {id, profile, exited}. */
  let session = null;
  let starting = false;
  const early = []; // events that arrive for a session before its start() call has returned

  let info = null; // the core's terminal:init answer

  function showEnded(text) {
    $('ended-text').textContent = text;
    $('ended').hidden = false;
  }

  function route(kind, m) {
    if (!session || m.id !== session.id) return; // an older session's late output
    if (kind === 'data') {
      const bytes = fromBase64(m.b64);
      term.write(bytes, () => vm.send('terminal:ack', { id: m.id, bytes: bytes.length }));
    } else {
      session.exited = true;
      term.write(`\r\n\x1b[2m[The program ended with exit code ${m.code}.]\x1b[0m\r\n`);
      showEnded(`The program ended (exit code ${m.code}). Press Enter or Restart to run it again.`);
    }
  }
  vm.on('terminal:data', (m) => (starting && !session ? early.push(['data', m]) : route('data', m)));
  vm.on('terminal:exit', (m) => (starting && !session ? early.push(['exit', m]) : route('exit', m)));

  async function start() {
    if (!info || starting) return;
    const choice = info.profiles.find((p) => p.id === $('profile').value);
    if (!choice) return;
    starting = true;
    session = null;
    early.length = 0;
    $('ended').hidden = true;
    term.reset();
    refit();
    if (choice.secret && !choice.secret.set) {
      term.write(`\x1b[2m[No ${choice.secret.label} is saved yet. Open Settings to add one.]\x1b[0m\r\n`);
    }
    try {
      const r = await vm.invoke('terminal:start', { profile: choice.id, rows: term.rows, cols: term.cols });
      session = { id: r.id, profile: r.profile, exited: false };
      store.set('profile', choice.id);
      for (const [kind, m] of early.splice(0)) route(kind, m);
      term.focus();
    } catch (e) {
      term.write(`\r\n\x1b[31m[${e.message}]\x1b[0m\r\n`);
      showEnded('The program could not start.');
    } finally {
      starting = false;
    }
  }

  term.onData((data) => {
    if (!session) return;
    if (session.exited) {
      if (data === '\r') start();
      return;
    }
    vm.send('terminal:input', { id: session.id, data });
  });
  term.onBinary((data) => {
    if (session && !session.exited) vm.send('terminal:input', { id: session.id, data, binary: true });
  });
  term.onResize(({ rows, cols }) => {
    if (session && !session.exited) vm.send('terminal:resize', { id: session.id, rows, cols });
  });

  $('restart').addEventListener('click', start);
  $('ended-restart').addEventListener('click', start);
  $('profile').addEventListener('change', start);

  // ---------------------------------------------------------------------------------------------- settings

  function toggleSettings(open) {
    const panel = $('settings');
    panel.hidden = open === undefined ? !panel.hidden : !open;
    $('settings-btn').setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) term.focus();
  }
  $('settings-btn').addEventListener('click', () => toggleSettings());
  $('settings-close').addEventListener('click', () => toggleSettings(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('settings').hidden) toggleSettings(false);
  });

  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const c of children) e.append(c);
    return e;
  }

  /** One section per profile that needs a key. The key is typed here, sent once, and never shown again. */
  function renderSecrets() {
    const root = $('secrets');
    root.textContent = '';
    for (const p of info.profiles.filter((x) => x.secret)) {
      const s = p.secret;
      const state = el('p', { className: 'small' });
      const msg = el('p', { className: 'msg small', role: 'status' });
      const input = el('input', { type: 'password', placeholder: s.placeholder || '', autocomplete: 'off', spellcheck: false });
      input.setAttribute('aria-label', s.label);
      const save = el('button', { type: 'button', className: 'primary', textContent: 'Save' });
      const remove = el('button', { type: 'button', className: 'danger', textContent: 'Remove' });
      const help = el('button', { type: 'button', textContent: 'Get a key…', hidden: !s.hasHelpUrl });

      const paint = () => {
        state.textContent = s.set ? `${s.label}: saved` : `${s.label}: not set`;
        state.className = `small ${s.set ? 'state-ok' : 'state-no'}`;
        remove.disabled = !s.set;
      };
      const say = (text, isError) => {
        msg.textContent = text;
        msg.className = `msg small${isError ? ' error' : ''}`;
      };
      const doSave = async () => {
        try {
          await vm.invoke('terminal:secret-set', { env: s.env, value: input.value });
          input.value = '';
          s.set = true;
          paint();
          say(session && session.profile === p.id ? 'Saved. Restart to use it.' : 'Saved.');
        } catch (e) {
          say(e.message, true);
        }
      };
      save.addEventListener('click', doSave);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') doSave();
      });
      remove.addEventListener('click', async () => {
        try {
          await vm.invoke('terminal:secret-clear', { env: s.env });
          s.set = false;
          paint();
          say('Removed.');
        } catch (e) {
          say(e.message, true);
        }
      });
      help.addEventListener('click', async () => {
        try {
          await vm.invoke('terminal:open-help', { env: s.env });
        } catch (e) {
          say(e.message, true);
        }
      });
      paint();
      root.append(
        el('section', { className: 'group' },
          el('h3', { textContent: s.label }),
          el('p', { className: 'muted small', textContent: `${s.help || ''} Used by: ${p.label}.` }),
          state,
          el('div', { className: 'field' }, input, save),
          el('div', { className: 'row' }, help, remove),
          msg),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------- start up

  async function init() {
    info = await vm.invoke('terminal:init');
    const select = $('profile');
    for (const p of info.profiles) {
      const o = el('option', { value: p.id, textContent: p.available ? p.label : `${p.label} (not available)`, disabled: !p.available });
      if (p.unavailableReason) o.title = p.unavailableReason;
      select.append(o);
    }
    const last = store.get('profile');
    if (last && info.profiles.some((p) => p.id === last && p.available)) select.value = last;
    const w = info.workspace;
    $('where').textContent = w.granted ? `Workspace: ${w.path}` : "No workspace folder granted: working in the app's private data folder";
    $('where').title = w.granted ? `The programs here can change only this folder (${w.path})` : 'Grant the workspace folder in the permission sheet to work on your files';
    renderSecrets();
    refit();
    await start();
  }

  init().catch((e) => {
    term.write(`\x1b[31m[${e.message}]\x1b[0m\r\n`);
  });
})();
