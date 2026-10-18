'use strict';
// The wording of the loader's own dialogs for host capabilities (SPEC 8.2, INV-B5, INV-H3). Pure functions with no
// Electron, so the unit tests can check every sentence. The app never supplies any of this text except what is quoted:
// the app name, the purpose it gave, the arguments it wants to use.

const CONFIRM_BUTTONS = ['Deny', 'Allow once', 'Allow while the app runs'];
const MAX_ARG = 600; // characters of one argument shown
const MAX_ARGS_TEXT = 2400; // characters of all arguments shown
const MAX_ARGS_SHOWN = 20;

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Text for a dialog: control characters (except newline and tab) become spaces, length is capped. */
function clean(s, max = 200) {
  const t = String(s === undefined || s === null ? '' : s).replace(CTRL, ' ');
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `tool:echo` -> {kind:'tool', id:'echo'}; `screen` -> {kind:'screen', id:null}. */
function splitCap(cap) {
  const s = String(cap || '');
  const i = s.indexOf(':');
  return i < 0 ? { kind: s, id: null } : { kind: s.slice(0, i), id: s.slice(i + 1) };
}

/** One line for a requested capability, as the sheets and the install review show it. */
function capLabel(cap) {
  const { kind, id } = splitCap(cap);
  if (kind === 'screen') return 'See your screen (screenshots, the list of open windows)';
  if (kind === 'input') return 'Control your mouse and keyboard';
  if (kind === 'gpu') return 'Run work on your Mac’s GPU (Metal), through a sandboxed helper';
  if (kind === 'tool') return id === '*' ? 'Run tools from your own catalog (you pick which)' : `Run the tool “${clean(id, 41)}” from your catalog`;
  if (kind === 'mcp') return id === '*' ? 'Use MCP servers from your own catalog (you pick which)' : `Use the MCP server “${clean(id, 41)}” from your catalog`;
  return clean(cap, 60);
}

/** The short form, for chips and lists. */
function capShort(cap) {
  const { kind, id } = splitCap(cap);
  if (kind === 'screen') return 'screen';
  if (kind === 'input') return 'mouse and keyboard';
  if (kind === 'gpu') return 'GPU';
  if (kind === 'tool') return id === '*' ? 'tools' : `tool ${id}`;
  if (kind === 'mcp') return id === '*' ? 'MCP servers' : `MCP server ${id}`;
  return cap;
}

/** Arguments as the user must see them: one per line, quoted, so spaces and quotes cannot hide anything. */
function argsText(args) {
  if (args === undefined || args === null) return { text: '(none)', shortened: false };
  if (!Array.isArray(args)) return { text: clean(JSON.stringify(args), MAX_ARGS_TEXT), shortened: true };
  if (!args.length) return { text: '(none)', shortened: false };
  let shortened = false;
  const lines = [];
  let total = 0;
  for (let i = 0; i < args.length; i++) {
    if (i >= MAX_ARGS_SHOWN || total >= MAX_ARGS_TEXT) {
      shortened = true;
      lines.push(`… and ${args.length - i} more`);
      break;
    }
    const raw = typeof args[i] === 'string' ? args[i] : JSON.stringify(args[i]);
    let shown = JSON.stringify(clean(raw, MAX_ARG));
    if ([...String(raw)].length > MAX_ARG) {
      shortened = true;
      shown += ` (first ${MAX_ARG} of ${[...String(raw)].length} characters)`;
    }
    total += shown.length;
    lines.push(`  ${i + 1}. ${shown}`);
  }
  return { text: lines.join('\n'), shortened };
}

/** `detail` of the broker is "<prefix>: <json>"; its JSON part, if it parses. */
function jsonAfter(detail, prefix) {
  if (typeof detail !== 'string' || !detail.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(detail.slice(prefix.length));
  } catch {
    return undefined;
  }
}

function windowText(w, id) {
  if (w && w.title) return `the window “${clean(w.title, 80)}” of ${clean(w.app || 'an app', 60)}`;
  if (w && w.app) return `a window of ${clean(w.app, 60)}`;
  return `window number ${clean(id, 20)}`;
}

const roundN = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '?');

/** A display as the picker and the log name it: `“External Monitor” (1920 × 1080)`; `d` is an item of hostctl `displays`. */
function displayLabel(d) {
  const b = isObj(d && d.bounds) ? d.bounds : {};
  const name = clean((d && d.name) || (d && d.display !== undefined ? `Display ${d.display}` : 'Display'), 60);
  return `“${name}” (${roundN(b.w)} × ${roundN(b.h)})${d && d.main ? ', main display' : ''}`;
}

/**
 * What the APP SUGGESTS capturing (host.screen.capture's parameters are only a suggestion, SPEC 8.2): `params` is the
 * validated {target, display?, windowId?, region?}; `lookup` may carry `windows` and `displays` to name them.
 * A noun phrase: "your main display", "the window “Inbox” of Mail", "a part of your screen (300 × 200 points at 10, 20)".
 */
function captureWhat(params, lookup) {
  const p = isObj(params) ? params : {};
  const target = p.target === 'window' || p.target === 'region' ? p.target : 'display';
  if (target === 'window') {
    const w = ((lookup && lookup.windows) || []).find((x) => x && String(x.windowId) === String(p.windowId));
    return windowText(w, p.windowId);
  }
  if (target === 'region') {
    const r = isObj(p.region) ? p.region : {};
    return `a part of your screen (${roundN(r.w)} × ${roundN(r.h)} points at ${roundN(r.x)}, ${roundN(r.y)})`;
  }
  if (p.display === undefined) return 'your main display';
  const d = ((lookup && lookup.displays) || []).find((x) => x && String(x.display) === String(p.display));
  return d ? `display ${displayLabel(d)}` : `display ${clean(p.display, 12)}`;
}

/** What the user picked, for the log and the Inspector: `target` is {kind, display?, windowId?, region?}. */
function pickedWhat(target, lookup) {
  const t = isObj(target) ? target : {};
  if (t.kind === 'window') return captureWhat({ target: 'window', windowId: t.windowId }, lookup);
  if (t.kind === 'region') return captureWhat({ target: 'region', region: t.region }, lookup);
  return captureWhat({ target: 'display', display: t.display }, lookup);
}

// The one explanation of what "Allow while the app runs" means for screenshots (the picker shows it next to the buttons).
const CAPTURE_SESSION_NOTE =
  'Allow while the app runs: later screenshots need no question, and show what the app asks for then (your main display if that no longer exists), not what you pick now.';

// Glyphs of the keys the overlay shows (macOS order of modifiers: Control, Option, Shift, Command).
const MOD_GLYPH = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];
const KEY_GLYPH = {
  return: '↩', enter: '↩', tab: '⇥', space: 'Space', escape: '⎋', esc: '⎋', delete: '⌫', backspace: '⌫', forwarddelete: '⌦',
  left: '←', right: '→', up: '↑', down: '↓', home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down',
};
const CAPTION_MAX = 28; // characters of typed text the overlay shows (only when the user turned "Show typed text" on)

/** The text an event types, as the overlay would show it (newline and tab get glyphs, control characters are dropped), as characters. */
function typedChars(text) {
  return [...text.replace(/\r\n|\r|\n/g, '↩').replace(/\t/g, '⇥').replace(CTRL, '')];
}

/**
 * How many characters of TEXT the event types: the overlay MASKS these by default (a typed password must not be readable on
 * the screen). 0 for a key combination (`⌘S`) or a named key (Return, an arrow, F5): those are always shown. A single printable
 * key with no ⌘, ⌃ or ⌥ (Shift only changes the letter) is typed text, and so is the space bar.
 */
function typedLength(ev) {
  if (!isObj(ev)) return 0;
  if (typeof ev.text === 'string') return typedChars(ev.text).length;
  if (typeof ev.key !== 'string' || !ev.key) return 0;
  const mods = Array.isArray(ev.modifiers) ? ev.modifiers : [];
  if (mods.some((m) => m === 'cmd' || m === 'ctrl' || m === 'alt')) return 0;
  if (ev.key.toLowerCase() === 'space') return 1;
  const chars = [...ev.key];
  return chars.length === 1 && !new RegExp(CTRL.source).test(ev.key) ? 1 : 0; // (CTRL has the g flag: test() on it keeps state)
}

/** The masked caption for `n` typed characters: "typing… (12 characters)". */
function typedCaption(n) {
  return `typing… (${n} character${n === 1 ? '' : 's'})`;
}

/**
 * The caption the virtual-input overlay shows for what an app just typed (INV-H3: the control is visible):
 *   {kind:'keys', key:'s', modifiers:['cmd']} -> "⌘S"          key combinations and named keys are always shown;
 *   {kind:'keys', text:'Hello, world!'}       -> "typing… (13 characters)"   typed text is MASKED by default.
 * With `opts.showTyped` (the loader setting "Show typed text in the overlay", off by default) the text itself is shown, cut after
 * CAPTION_MAX characters ("…"); newline and tab become ↩ and ⇥; control characters are dropped.
 * Returns null when there is nothing to show. The overlay is excluded from screenshots and never leaves the user's screen.
 */
function keyCaption(ev, opts) {
  if (!isObj(ev)) return null;
  const showTyped = !!opts && opts.showTyped === true; // exactly true: anything else keeps the mask
  if (!showTyped) {
    const n = typedLength(ev);
    if (n > 0) return typedCaption(n);
  }
  if (typeof ev.text === 'string') {
    const t = typedChars(ev.text);
    if (!t.length) return null;
    return t.length > CAPTION_MAX ? `${t.slice(0, CAPTION_MAX).join('')}…` : t.join('');
  }
  if (typeof ev.key !== 'string' || !ev.key) return null;
  const mods = MOD_ORDER.filter((m) => Array.isArray(ev.modifiers) && ev.modifiers.includes(m)).map((m) => MOD_GLYPH[m]).join('');
  const k = ev.key.toLowerCase();
  let label = KEY_GLYPH[k];
  if (!label) label = /^f\d{1,2}$/.test(k) ? k.toUpperCase() : [...ev.key][0].toUpperCase();
  return `${mods}${label}`;
}

/** The caption for a mouse action that has no picture of its own (a scroll); null for the rest (the ring and ripple show those). */
function mouseCaption(ev) {
  if (!isObj(ev) || ev.action !== 'scroll') return null;
  const arrow = Math.abs(Number(ev.dy) || 0) >= Math.abs(Number(ev.dx) || 0) ? (Number(ev.dy) < 0 ? '↑' : '↓') : Number(ev.dx) < 0 ? '←' : '→';
  return `Scroll ${arrow}`;
}

/**
 * The confirmation for one use. `req` is what the broker passes to ui.confirmUse
 * ({app, cap, op, detail, purpose, shell, params?}); `lookup` is {tool, server, windows}: the catalog entry and the window
 * list, when the loader found them.
 * @returns {{message: string, detail: string, shell: boolean, buttons: string[]}}
 */
function confirmText(req, lookup = {}) {
  const app = req.app || {};
  const who = `“${clean(app.name || app.id || 'This app', 60)}”`;
  const { kind, id } = splitCap(req.cap);
  const params = req.params;
  const lines = [];
  let what;
  let shell = !!req.shell;

  switch (req.op) {
    case 'host.screen.windows':
      what = 'see which windows are open on your screen';
      lines.push('That shows the title and the app of every window.');
      break;
    case 'host.screen.capture': {
      // The app's parameters are only a SUGGESTION: the user picks what is captured (SPEC 8.2).
      const p = req.suggestion !== undefined ? req.suggestion : params !== undefined ? params : jsonAfter(req.detail, 'capture the screen: ');
      what = 'take a screenshot of something on your screen';
      lines.push('You choose what it gets: a whole display, one window or a part of a screen. It receives only what you pick.');
      lines.push('It sees everything that is visible there, including private information.');
      lines.push(`It suggests: ${captureWhat(p, lookup)}.`);
      lines.push(CAPTURE_SESSION_NOTE);
      break;
    }
    case 'host.input.start':
      what = 'control your mouse and keyboard';
      if (isObj(params) && params.reason) lines.push(`It says it is doing this to: “${clean(params.reason, 200)}”`);
      else if (typeof req.detail === 'string' && req.detail.includes(': ')) lines.push(`It says it is doing this to: “${clean(req.detail.slice(req.detail.indexOf(': ') + 2), 200)}”`);
      lines.push('While it does, a red bar stays on top of your screen with a Stop button. Control-Option-Command-period stops everything at once.');
      break;
    case 'host.tool.run': {
      const t = lookup.tool || null;
      const name = clean((t && t.name) || id || 'a tool', 80);
      shell = shell || (t && t.kind === 'shell');
      const args = params && Array.isArray(params.args) ? params.args : params && params.args === undefined ? [] : undefined;
      const a = args !== undefined ? argsText(args) : { text: clean(req.detail, 400), shortened: true };
      what = shell ? `run a shell command (“${name}”)` : `run the tool “${name}”`;
      if (t && t.path) lines.push(`Program: ${clean(t.path, 300)}`);
      lines.push(`Arguments:\n${a.text}`);
      if (a.shortened) lines.push('(Shortened here. The app sends the complete text.)');
      if (shell) lines.push('A shell can do anything you can do on this Mac: read, change and delete your files, and start other programs.');
      break;
    }
    case 'host.mcp.list': {
      const s = lookup.server || null;
      what = `start ${clean((s && s.name) || id || 'an MCP server', 80)} and see which tools it offers`;
      if (s && s.command) lines.push(`Program: ${clean(s.command.join(' '), 300)}`);
      break;
    }
    case 'host.mcp.call': {
      const s = lookup.server || null;
      const sname = clean((s && s.name) || (isObj(params) && params.server) || id || 'an MCP server', 80);
      const method = isObj(params) && typeof params.method === 'string' ? params.method : '';
      const inner = isObj(params) && isObj(params.params) ? params.params : {};
      if (method === 'tools/call') {
        what = `use the tool “${clean(inner.name, 80)}” of ${sname}`;
        const a = JSON.stringify(inner.arguments === undefined ? {} : inner.arguments);
        lines.push(`Arguments: ${clean(a, 1200)}`);
      } else {
        what = `ask ${sname} for something (${clean(method || req.detail, 60)})`;
        if (method && Object.keys(inner).length) lines.push(`Details: ${clean(JSON.stringify(inner), 600)}`);
      }
      if (s && s.command) lines.push(`Program: ${clean(s.command.join(' '), 300)}`);
      break;
    }
    default:
      what = clean(req.detail || `use ${kind || 'a host capability'}`, 200);
  }

  if (req.purpose) lines.unshift(`Why the app says it needs this: “${clean(req.purpose, 200)}”`);
  return {
    message: `${who} wants to ${what}`,
    detail: lines.join('\n\n'),
    shell,
    buttons: CONFIRM_BUTTONS,
  };
}

/** The line of the control badge (INV-H3). `entry` is an item of caps.active(). */
function badgeText(entry) {
  const name = clean(entry.appName || entry.appId || 'An app', 60);
  return entry.kind === 'shell' ? `${name} is running a shell command` : `${name} is controlling your computer`;
}

/** The install review's / card's INV-H6 label, or null when the manifest asks for nothing of that kind. */
function controlLabel(summary) {
  return (summary || []).some((s) => s.control) ? 'requests control of your computer' : null;
}

module.exports = {
  CONFIRM_BUTTONS,
  CAPTURE_SESSION_NOTE,
  clean,
  splitCap,
  capLabel,
  capShort,
  argsText,
  displayLabel,
  captureWhat,
  pickedWhat,
  confirmText,
  badgeText,
  controlLabel,
  keyCaption,
  typedLength,
  typedCaption,
  mouseCaption,
};
