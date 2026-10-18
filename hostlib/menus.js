'use strict';
// App menus in the Mac menu bar (SPEC 7 "Menus", DEV-APPS C9). An app describes its menus as DATA: labels, ids, shortcuts,
// checkboxes and a few standard edit and window roles. The template is validated here (the loader for a page's menu, the session for a
// core's menu.set), the loader builds the native menu itself (toElectronTemplate), and a
// click only tells the app which id was chosen (its window gets a 'menu' event, or its core when the core set the menu). Nothing in
// a template can run loader code or reach a loader action. While an app window is focused its menus sit between the loader's own
// first menu (About, Hide, Quit) and the loader's Window menu.
//
// The template (an array of top-level menus):
//   [{ label, submenu: [ item, ... ] }, ...]
//   item: { id, label, accelerator?, enabled?, visible?, checked?, type?: 'normal'|'separator'|'checkbox'|'radio'|'submenu',
//           role?: one of ROLES, submenu?: [ item, ... ] }
// Limits: at most 16 top-level menus, 4000 items, 5 levels, labels of 120 characters, ids of 200.

const ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'minimize', 'zoom', 'togglefullscreen'];
const TYPES = ['normal', 'separator', 'checkbox', 'radio', 'submenu'];
const MAX_TOP = 16;
const MAX_ITEMS = 4000;
const MAX_DEPTH = 5;
const MAX_LABEL = 120;
const MAX_ID = 200;

// Electron's accelerator grammar (modifiers joined by '+', then one key)
const MODIFIERS = { command: 'cmd', cmd: 'cmd', control: 'ctrl', ctrl: 'ctrl', commandorcontrol: 'cmd', cmdorctrl: 'cmd', alt: 'alt', option: 'alt', altgr: 'altgr', shift: 'shift', super: 'cmd', meta: 'cmd' };
const NAMED_KEYS = ['plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace', 'delete', 'insert', 'return', 'enter', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'escape', 'esc', 'volumeup', 'volumedown', 'volumemute', 'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause', 'printscreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'];
// The shortcuts the loader keeps for itself whatever an app asks: quit the loader, hide it, hide the others.
const RESERVED = ['cmd+q', 'cmd+h', 'alt+cmd+h'];

class MenuError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MenuError';
  }
}

/** Normalised form of an accelerator ('alt+cmd+shift+p'), or null when it is not valid Electron grammar. */
function normalizeAccelerator(acc) {
  if (typeof acc !== 'string' || !acc || acc.length > 60) return null;
  const parts = acc.split('+');
  // "Plus" or a literal '+' as the key: "Cmd++" splits into ['Cmd', '', '']
  let key = parts.pop();
  if (key === '' && parts.length && parts[parts.length - 1] === '') {
    parts.pop();
    key = '+';
  }
  if (!key) return null;
  const mods = new Set();
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  const k = key.toLowerCase();
  const ok = /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-9]|2[0-4])$/.test(k) || /^num[0-9]$/.test(k) || NAMED_KEYS.includes(k) || /^[)!@#$%^&*(:;+=<,_\->.?/~`{\][|\\}"']$/.test(key);
  if (!ok) return null;
  return [...[...mods].sort(), k].join('+');
}

function text(v, what, max) {
  if (typeof v !== 'string') throw new MenuError(`${what} must be a string`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw new MenuError(`${what} must not contain control characters`);
  if (v.length > max) throw new MenuError(`${what} is longer than ${max} characters`);
  return v;
}

/**
 * Validates an app's menu template; returns the normalised template (only known keys, defaults filled in) and the shortcuts that
 * were dropped because the loader keeps them. Throws MenuError with the path of the first problem.
 */
function validateMenuTemplate(raw) {
  if (!Array.isArray(raw)) throw new MenuError('the menu template must be an array of menus');
  if (raw.length > MAX_TOP) throw new MenuError(`at most ${MAX_TOP} top-level menus`);
  let count = 0;
  const dropped = [];
  const ids = new Set();
  const item = (it, where, depth) => {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) throw new MenuError(`${where} must be an object`);
    for (const k of Object.keys(it)) {
      if (!['id', 'label', 'accelerator', 'enabled', 'visible', 'checked', 'type', 'role', 'submenu'].includes(k)) throw new MenuError(`${where}.${k} is not a known key`);
    }
    if (++count > MAX_ITEMS) throw new MenuError(`at most ${MAX_ITEMS} menu items`);
    const type = it.type === undefined ? (it.submenu ? 'submenu' : 'normal') : it.type;
    if (!TYPES.includes(type)) throw new MenuError(`${where}.type must be one of ${TYPES.join(', ')}`);
    if (type === 'separator') return { type };
    const out = { type };
    if (it.role !== undefined) {
      if (!ROLES.includes(it.role)) throw new MenuError(`${where}.role must be one of ${ROLES.join(', ')}`);
      out.role = it.role;
    }
    if (it.label !== undefined) out.label = text(it.label, `${where}.label`, MAX_LABEL);
    else if (!out.role) throw new MenuError(`${where}.label is required`);
    for (const k of ['enabled', 'visible', 'checked']) {
      if (it[k] !== undefined) {
        if (typeof it[k] !== 'boolean') throw new MenuError(`${where}.${k} must be a boolean`);
        out[k] = it[k];
      }
    }
    if (it.accelerator !== undefined) {
      const n = normalizeAccelerator(it.accelerator);
      if (!n) throw new MenuError(`${where}.accelerator "${String(it.accelerator).slice(0, 60)}" is not a valid shortcut`);
      if (RESERVED.includes(n)) dropped.push(it.accelerator);
      else out.accelerator = it.accelerator;
    }
    if (type === 'submenu') {
      if (depth >= MAX_DEPTH) throw new MenuError(`${where}: at most ${MAX_DEPTH} levels of menus`);
      if (!Array.isArray(it.submenu)) throw new MenuError(`${where}.submenu must be an array`);
      out.submenu = it.submenu.map((s, i) => item(s, `${where}.submenu[${i}]`, depth + 1));
      return out;
    }
    if (it.submenu !== undefined) throw new MenuError(`${where}.submenu needs type "submenu"`);
    if (!out.role) {
      out.id = text(it.id, `${where}.id`, MAX_ID);
      if (!out.id) throw new MenuError(`${where}.id must not be empty`);
      if (ids.has(out.id)) throw new MenuError(`${where}.id "${out.id.slice(0, 60)}" is not unique`);
      ids.add(out.id);
    }
    return out;
  };
  const menus = raw.map((m, i) => {
    const where = `menu[${i}]`;
    if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new MenuError(`${where} must be an object {label, submenu}`);
    for (const k of Object.keys(m)) if (!['label', 'submenu'].includes(k)) throw new MenuError(`${where}.${k} is not a known key`);
    if (!Array.isArray(m.submenu)) throw new MenuError(`${where}.submenu must be an array`);
    return { label: text(m.label, `${where}.label`, MAX_LABEL), submenu: m.submenu.map((s, j) => item(s, `${where}.submenu[${j}]`, 1)) };
  });
  return { menus, dropped, items: count };
}

/** Electron template items for a validated app menu: a click of an item with an id calls onClick(id); roles are Electron's own. */
function toElectronTemplate(menus, onClick) {
  const conv = (it) => {
    if (it.type === 'separator') return { type: 'separator' };
    const out = {};
    for (const k of ['type', 'label', 'accelerator', 'enabled', 'visible', 'checked', 'role']) if (it[k] !== undefined) out[k] = it[k];
    if (it.submenu) out.submenu = it.submenu.map(conv);
    if (it.id !== undefined && !it.role) {
      out.id = `app:${it.id}`;
      out.click = () => onClick(it.id);
    }
    return out;
  };
  return menus.map((m) => ({ label: m.label, submenu: m.submenu.map(conv) }));
}

module.exports = { MenuError, validateMenuTemplate, toElectronTemplate, normalizeAccelerator, ROLES, RESERVED };
