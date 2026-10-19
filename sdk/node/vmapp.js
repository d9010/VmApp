'use strict';
/**
 * vmapp: the core-side SDK for Node apps (SPEC section 9). Inside the node22 runtime it is available as
 * require('vmapp'). It mirrors the Electron main-process API:
 *
 *   const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, MenuItem, folders } = require('vmapp');
 *
 * Single file, no dependencies. The SDK is a SERVER on $VMAPP_SOCKET (a stale socket file is unlinked first);
 * the host's bridge connection arrives through the guest's vsock port 1024 and speaks the JSON-lines protocol of
 * SPEC section 6. One connection per app run: if a second connection arrives it replaces the old one (the old one
 * is closed and logged). When the active connection closes, the process exits with code 0, because the host is
 * gone and the VM is the app.
 *
 * Startup sequence, precisely (host -> core `init`):
 *   1. `folders` is filled in place (keys cleared, then the init's folder map assigned), app info is stored.
 *   2. app.emit('ready') runs every 'ready' listener synchronously (a throwing listener is logged, not fatal).
 *   3. The whenReady() promise is resolved. Its `.then` callbacks are only SCHEDULED here (microtasks); they run
 *      after this function returns, so the window.create requests they cause are written AFTER the `ready` message.
 *   4. `{t:'ready'}` is written, synchronously, right after step 3.
 * A second `init` (a replaced connection) refills `folders`, does not re-emit 'ready', and sends `ready` again.
 *
 * Window lifecycle: BrowserWindow#loadFile creates the window with the host (request window.create). When the host
 * reports that the last window closed, `app` emits 'window-all-closed'; if the app has no listener for it, the
 * default is app.quit() (SPEC 8.5).
 *
 * Window options: width, height, minWidth, minHeight, title, resizable, and `webPreferences: { devTools: true }` (like
 * Electron; default false). It lets the user open the browser developer tools on that window (View menu, Alt+Cmd+I) in
 * dev and packaged builds; leave it off in production. Every other webPreferences key is ignored (the host fixes them),
 * with one warning in the log per run.
 *
 * Links (SPEC 8.9): with `permissions.links` in the manifest, a vmapp://<app id>/… link opened on the Mac (a sign-in redirecting back,
 * a link the user clicks) arrives as Electron's app.on('open-url', (event, url) => …).
 *
 * Quit: app.quit() emits 'before-quit' (listeners may return promises; waited for at most 2 s), sends the
 * `app.quit` request (waits for the reply at most 1 s), then exits the process. A host `before-quit` message does the
 * same without the request. Errors thrown in ipcMain.handle handlers reach the renderer as rejected promises with
 * the message only (no stack).
 *
 * vmapp extension to the Electron dialog API: dialog.showOpenDialog([win], {properties: ['openDirectory'],
 * access: 'readwrite'}). `access` is 'read' (the default) or 'readwrite' and applies to directory picks: the user is
 * told that the app will be able to change files in the folder. File picks are always read-only; the returned
 * paths point at a private clone of each chosen file, never at its folder.
 *
 * Host capabilities (SPEC 8.2): `host`, for apps whose manifest has `permissions.host` and whose user granted it.
 * Everything is denied by default; a denied call rejects with "permission denied: ...". The user may be asked at each
 * use, and a badge is shown while input control or a shell tool is active.
 *   host.screen.windows()                  -> [{windowId, app, title, bounds:{x,y,w,h}}]    (cap `screen`)
 *   host.screen.capture({target, windowId, region:{x,y,w,h}, display, maxWidth})
 *                                          -> {png: Buffer, width, height, target}; target 'display' (default) | 'window' | 'region'.
 *     The parameters are only a SUGGESTION: the user is asked what to share (a display, a window or a region) and the app gets
 *     only what was picked. `result.target` says what was ACTUALLY captured: {kind: 'display'|'window'|'region', display?,
 *     windowId?, region? (global points), bounds: {x,y,w,h} (the captured area in global points: x = bounds.x + fx * bounds.w
 *     maps a position in the picture to a point for input), by: 'user' | 'app' (your suggestion, because the permission was
 *     already given for this run) | 'default' (your suggestion no longer exists: the main display)}. Pass `target` back as the
 *     next suggestion (a display id, windowId or region) to keep the user's choice. `region` is in global desktop points.
 *   host.input.start(reason)               -> InputSession (cap `input`; ends after 10 minutes, on stop, or when the
 *                                             user stops it: call start again to continue)
 *     session.mouse({action:'move'|'down'|'up'|'click'|'scroll', x, y, button, clicks, dx, dy})
 *     session.keys({text}) | session.keys('text') | session.keys({key, modifiers:['cmd','shift','alt','ctrl']})
 *     session.stop()
 *   host.tool.list()                       -> [{id, name, kind, description, args:[{pattern, optional, mapPath}], variadic}]
 *   host.tool.run(id, args, {stdin})       -> {exitCode, stdout, stderr, truncated, timedOut, signal}   (cap `tool:<id>`)
 *     args are strings checked against the tool's patterns; a mapPath argument is a VM path such as
 *     /host/save-0/shot.png that the host maps to the real file. No shell: `;` or `$(...)` in an argument is plain text.
 *   host.mcp.list()                        -> [{id, name, tools:[...]}]
 *   host.mcp.call(server, method, params)  -> the JSON-RPC result; method: tools/list, tools/call, resources/list,
 *                                             resources/read, prompts/list, prompts/get   (cap `mcp:<id>`)
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const codec = require('./ipc-codec.js'); // structured clone over the bridge's JSON lines (SPEC 6 "Values")

const MAX_LINE = 16 * 1024 * 1024;
const SOCKET_PATH = process.env.VMAPP_SOCKET;

// ------------------------------------------------------------------------------------------------ state

let conn = null; // the active host connection
let nextReqId = 1;
const pending = new Map(); // request id -> { resolve, reject, sync }
const invokeHandlers = new Map(); // channel -> fn
const windows = new Map(); // host window id -> BrowserWindow
let initInfo = null; // { app, platform, data }
let quitPromise = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls every listener of `name` in order; a throwing listener is logged. Returns the listeners' return values. */
function safeEmit(emitter, name, ...args) {
  const results = [];
  for (const fn of emitter.rawListeners(name)) {
    try {
      results.push(fn.apply(emitter, args));
    } catch (e) {
      hostLog('error', `error in '${name}' listener: ${errMessage(e)}`);
    }
  }
  return results;
}

function errMessage(e) {
  return e && e.message !== undefined ? String(e.message) : String(e);
}

function writeLine(sock, obj) {
  const line = JSON.stringify(obj) + '\n';
  if (Buffer.byteLength(line) > MAX_LINE) throw new Error('message exceeds the 16 MiB bridge line limit');
  sock.write(line);
}

/** Sends a message on the active connection. Returns false when there is none. */
function send(obj) {
  if (!conn || conn.destroyed) return false;
  writeLine(conn, obj);
  return true;
}

function hostLog(level, message) {
  try {
    if (!send({ t: 'log', level, message: String(message) })) process.stderr.write(`[D9010 VmApp ${level}] ${message}\n`);
  } catch {
    /* ignore */
  }
}

function request(op, params, sync) {
  return new Promise((resolve, reject) => {
    if (!conn || conn.destroyed) return reject(new Error('D9010 VmApp: not connected to the host'));
    const id = nextReqId++;
    pending.set(id, { resolve, reject, sync });
    try {
      send({ t: 'request', id, op, params: params || {} });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

function rejectAllPending(message) {
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
}

// ------------------------------------------------------------------------------------------------ app

class App extends EventEmitter {
  constructor() {
    super();
    this._ready = false;
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }
  whenReady() {
    return this._readyPromise;
  }
  isReady() {
    return this._ready;
  }
  getName() {
    return (initInfo && initInfo.app && initInfo.app.name) || '';
  }
  getVersion() {
    return (initInfo && initInfo.app && initInfo.app.version) || '';
  }
  getPath(name) {
    switch (name) {
      case 'userData':
        return (initInfo && initInfo.data) || process.env.VMAPP_DATA || '/data';
      case 'temp':
        return process.env.TMPDIR || '/tmp';
      case 'home':
        return (initInfo && initInfo.data) || process.env.HOME || '/data';
      default:
        throw new Error(`Failed to get '${name}' path`);
    }
  }
  quit() {
    return beginQuit(true);
  }
  exit(code) {
    process.exit(code === undefined ? 0 : code);
  }
}
const app = new App();

function beginQuit(notifyHost) {
  if (quitPromise) return quitPromise;
  quitPromise = (async () => {
    const results = safeEmit(app, 'before-quit');
    await Promise.race([Promise.allSettled(results), sleep(2000)]);
    if (notifyHost) {
      try {
        await Promise.race([request('app.quit', {}), sleep(1000)]);
      } catch {
        /* the host may already be gone */
      }
    }
    process.exit(0);
  })();
  return quitPromise;
}

function windowAllClosed() {
  if (app.listenerCount('window-all-closed') > 0) safeEmit(app, 'window-all-closed');
  else app.quit();
}

// ------------------------------------------------------------------------------------------------ windows

let warnedWebPreferences = false; // the "webPreferences are ignored" warning is logged once per run

class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this._options = Object.assign({}, options);
    this._id = null;
    this._createP = null;
    this._created = false;
    this._destroyed = false;
    this._closeRequested = false;
    this._queue = [];
    const self = this;
    this.webContents = {
      get id() {
        return self._id;
      },
      send(channel, ...args) {
        self._sendToRenderer(channel, args);
      },
      isDestroyed() {
        return self._destroyed;
      },
      getOwnerBrowserWindow() {
        return self;
      },
    };
  }

  get id() {
    return this._id;
  }

  /** Creates the window on the host. `entry` is relative to ui.root. Resolves once the host created the window. */
  loadFile(entry) {
    if (this._destroyed) return Promise.reject(new Error('Object has been destroyed'));
    if (this._createP) return Promise.reject(new Error('loadFile can only be called once per window'));
    const o = this._options;
    const params = { entry: String(entry).replace(/^\.\//, ''), width: o.width || 800, height: o.height || 600 };
    for (const k of ['minWidth', 'minHeight', 'title', 'resizable']) if (o[k] !== undefined) params[k] = o[k];
    // DevTools, like Electron: new BrowserWindow({ webPreferences: { devTools: true } }); the default is false. The host
    // decides what it honours (SPEC 7). Every other webPreferences key is ignored, with one warning per run.
    const wp = o.webPreferences && typeof o.webPreferences === 'object' ? o.webPreferences : {};
    params.devTools = wp.devTools === true;
    const ignoredPrefs = Object.keys(wp).filter((k) => k !== 'devTools');
    if (ignoredPrefs.length && !warnedWebPreferences) {
      warnedWebPreferences = true;
      hostLog('warn', `BrowserWindow webPreferences are ignored except devTools (the host fixes the rest): ${ignoredPrefs.join(', ')}`);
    }
    this._createP = request('window.create', params, (res) => {
      // runs synchronously when the reply arrives, so the window is known before any later message is handled
      this._id = res.win;
      this._created = true;
      windows.set(res.win, this);
    }).then(() => {
      for (const q of this._queue.splice(0)) send({ t: 'emit', win: this._id, channel: q.channel, args: q.args });
    });
    return this._createP;
  }

  loadURL() {
    return Promise.reject(new Error('loadURL is not supported in D9010 VmApp; use loadFile'));
  }

  _sendToRenderer(channel, args) {
    if (this._destroyed) return;
    // like Electron's webContents.send: a value the structured clone algorithm cannot copy throws here, at the call, "… could not be cloned."
    const encoded = codec.encode(args);
    if (!this._created) {
      this._queue.push({ channel: String(channel), args: encoded });
      return;
    }
    send({ t: 'emit', win: this._id, channel: String(channel), args: encoded });
  }

  _afterCreate(fn) {
    if (this._created) fn();
    else if (this._createP) this._createP.then(fn, () => {});
  }

  setTitle(title) {
    this._options.title = String(title);
    this._afterCreate(() => request('window.setTitle', { win: this._id, title: this._options.title }).catch(logReject('setTitle')));
  }
  getTitle() {
    return this._options.title || '';
  }
  focus() {
    this._afterCreate(() => request('window.focus', { win: this._id }).catch(logReject('focus')));
  }
  close() {
    if (this._destroyed || this._closeRequested) return;
    this._closeRequested = true;
    this._afterCreate(() => request('window.close', { win: this._id }).catch(logReject('close')));
    if (!this._createP) this._destroyed = true; // never created
  }
  isDestroyed() {
    return this._destroyed;
  }

  static getAllWindows() {
    return Array.from(windows.values());
  }
  static fromId(id) {
    return windows.get(id) || null;
  }
}

function logReject(what) {
  return (e) => hostLog('warn', `window.${what} failed: ${errMessage(e)}`);
}

// ------------------------------------------------------------------------------------------------ ipcMain

/**
 * The event a listener or handler gets: Electron's IpcMainEvent / IpcMainInvokeEvent (docs/api/structures/ipc-main-event.md). The page is one
 * frame of one window, so `processId` is the window's id and `frameId` is 1. `sender` is the window's webContents, `senderWindow` is ours.
 * `returnValue` is not here: it answers a synchronous message, which a page cannot send (it would block on the VM; `invoke` is the replacement).
 */
function makeEvent(win, invoke) {
  const w = windows.get(win) || null;
  const sender = w ? w.webContents : null;
  const event = { type: 'frame', processId: win, frameId: 1, sender, senderWindow: w, preventDefault() {} };
  if (!invoke) {
    event.ports = [];
    // answers the frame that sent the message (Electron: event.sender.sendToFrame([processId, frameId], channel, ...args))
    event.reply = (channel, ...args) => {
      if (sender) sender.send(channel, ...args);
    };
  }
  return event;
}

/**
 * Electron's ipcMain (lib/browser/ipc-main-impl.ts): an EventEmitter whose events are the channels the page sends on (`on`, `once`, `off`,
 * `removeAllListeners`, `eventNames`, `listenerCount`, …, all from EventEmitter), plus `handle`, `handleOnce` and `removeHandler` for `invoke`.
 */
class IpcMain extends EventEmitter {
  constructor() {
    super();
    // a channel named "error" must not throw when nobody listens (Electron does the same)
    this.on('error', () => {});
  }

  handle(channel, fn) {
    if (invokeHandlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    if (typeof fn !== 'function') throw new TypeError(`Expected handler to be a function, but found type '${typeof fn}'`);
    invokeHandlers.set(channel, fn);
  }

  handleOnce(channel, fn) {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel);
      return fn(event, ...args);
    });
  }

  removeHandler(channel) {
    invokeHandlers.delete(channel);
  }
}
const ipcMain = new IpcMain();

// ------------------------------------------------------------------------------------------------ dialog / shell

/** Electron-style overloads: (options) or (browserWindow, options). */
function splitWinArg(args) {
  let win;
  let opts;
  if (args[0] instanceof BrowserWindow) {
    win = args[0];
    opts = args[1];
  } else {
    opts = args[0];
  }
  return { win: win && win.id !== null ? win.id : undefined, opts: opts || {} };
}

const dialog = {
  async showOpenDialog(...args) {
    const { win, opts } = splitWinArg(args);
    const props = Array.isArray(opts.properties) ? opts.properties : ['openFile'];
    const params = {
      win,
      title: opts.title,
      directory: props.includes('openDirectory'),
      multiple: props.includes('multiSelections'),
    };
    if (opts.access !== undefined) params.access = opts.access; // vmapp extension, see the header
    const r = await request('dialog.open', params);
    return r.canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: r.paths || [] };
  },
  async showSaveDialog(...args) {
    const { win, opts } = splitWinArg(args);
    const defaultName = path.basename(String(opts.defaultPath || '')) || 'untitled';
    const r = await request('dialog.save', { win, title: opts.title, defaultName });
    return r.canceled ? { canceled: true, filePath: undefined } : { canceled: false, filePath: r.path };
  },
  async showMessageBox(...args) {
    const { win, opts } = splitWinArg(args);
    const type = opts.type === 'none' || !opts.type ? 'info' : opts.type;
    const r = await request('dialog.message', {
      win,
      type,
      message: String(opts.message === undefined ? '' : opts.message),
      detail: opts.detail === undefined ? undefined : String(opts.detail),
      buttons: opts.buttons,
    });
    return { response: r.response, checkboxChecked: false };
  },
};

const shell = {
  async openExternal(url) {
    const r = await request('shell.openExternal', { url: String(url) });
    return !!r.opened;
  },
};

/**
 * The Mac's clipboard, plain text (SPEC 6, 8.4): Electron's clipboard.readText()/writeText(), but async (the Mac is across the
 * bridge). Needs the device "clipboard" in permissions.devices AND the user's allow; otherwise the promise rejects.
 */
const clipboard = {
  async readText() {
    const r = await request('clipboard.readText', {});
    return typeof r.text === 'string' ? r.text : '';
  },
  async writeText(text) {
    await request('clipboard.writeText', { text: String(text) });
  },
};

/**
 * Port forwarding (SPEC 6, 8.8): a server the app runs in the VM (a dev server, a preview) opened on the Mac's 127.0.0.1, so the
 * user's browser can reach it. Needs the device "ports" in permissions.devices AND the user's allow. vmapp-specific (Electron has
 * no equivalent): `const { ports } = require('vmapp')`.
 *   await ports.forward(3000)  -> { port: 3000, hostPort: 3000 (or another when 3000 is taken on the Mac), url: 'http://localhost:3000/' }
 *   await ports.close(3000)    -> { closed: <connections closed> }
 *   await ports.list()         -> [{ port, hostPort }]
 * shell.openExternal(url) accepts that url while the port is forwarded.
 */
const ports = {
  async forward(port) {
    return request('port.forward', { port: Number(port) });
  },
  async close(port) {
    return request('port.close', { port: Number(port) });
  },
  async list() {
    const r = await request('port.list', {});
    return Array.isArray(r.ports) ? r.ports : [];
  },
};

// ------------------------------------------------------------------------------------------------ Menu (SPEC 6 menu.set, 7 "Menus")
// Electron's Menu for the Mac menu bar: Menu.buildFromTemplate(template), Menu.setApplicationMenu(menu), Menu.getApplicationMenu(),
// menu.getMenuItemById(id). The template goes to the host as data; a click comes back as the window event 'menu' {id} and runs the
// item's click(menuItem, browserWindow, event). Roles: the standard edit and window ones work as in Electron; Electron's composite
// roles are expanded (editMenu, windowMenu, viewMenu); the ones the loader owns (appMenu, about, quit, hide, services, ...) and the
// developer ones (reload, toggleDevTools, ...) are left out. The loader keeps Cmd+Q, Cmd+H and Alt+Cmd+H.
const PASS_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'minimize', 'zoom', 'togglefullscreen'];
const COMPOSITE_ROLES = {
  editmenu: { label: 'Edit', submenu: ['undo', 'redo', null, 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'] },
  windowmenu: { label: 'Window', submenu: ['minimize', 'zoom'] },
  viewmenu: { label: 'View', submenu: ['togglefullscreen'] },
};
let menuSeq = 0;
let applicationMenu = null;
const menuClicks = new Map(); // id -> MenuItem (the items of the application menu)

class MenuItem {
  constructor(o) {
    const opts = o || {};
    this.id = opts.id !== undefined ? String(opts.id) : undefined;
    this.label = opts.label !== undefined ? String(opts.label) : '';
    this.type = opts.type || (opts.submenu ? 'submenu' : 'normal');
    this.role = opts.role;
    this.accelerator = opts.accelerator;
    this.enabled = opts.enabled !== false;
    this.visible = opts.visible !== false;
    this.checked = !!opts.checked;
    this.click = typeof opts.click === 'function' ? opts.click : null;
    this.submenu = opts.submenu ? (opts.submenu instanceof Menu ? opts.submenu : Menu.buildFromTemplate(opts.submenu)) : null;
    this.menu = null;
  }
}

class Menu {
  constructor() {
    this.items = [];
  }
  static buildFromTemplate(template) {
    if (!Array.isArray(template)) throw new TypeError('Menu.buildFromTemplate: the template must be an array');
    const m = new Menu();
    for (const t of template) m.append(t instanceof MenuItem ? t : new MenuItem(t));
    return m;
  }
  append(item) {
    item.menu = this;
    this.items.push(item);
  }
  getMenuItemById(id) {
    for (const it of this.items) {
      if (it.id === id) return it;
      const sub = it.submenu && it.submenu.getMenuItemById(id);
      if (sub) return sub;
    }
    return null;
  }
  /** Sets the app's menus in the Mac menu bar (null removes them). Resolves when the host has them; rejects on an invalid template. */
  static setApplicationMenu(menu) {
    applicationMenu = menu;
    menuClicks.clear();
    const toItem = (it) => {
      if (it.type === 'separator') return { type: 'separator' };
      if (it.role) {
        const r = String(it.role);
        if (PASS_ROLES.includes(r)) return Object.assign({ role: r }, it.label ? { label: it.label } : {}, it.accelerator ? { accelerator: it.accelerator } : {});
        return null; // a role the loader owns, or a developer role: left out
      }
      const out = { type: it.type, label: it.label };
      if (it.accelerator) out.accelerator = String(it.accelerator);
      if (!it.enabled) out.enabled = false;
      if (!it.visible) out.visible = false;
      if (it.type === 'checkbox' || it.type === 'radio') out.checked = it.checked;
      if (it.submenu) {
        out.type = 'submenu';
        out.submenu = it.submenu.items.map(toItem).filter(Boolean);
        return out;
      }
      const id = it.id !== undefined ? it.id : `vmapp-menu-${++menuSeq}`;
      menuClicks.set(id, it);
      out.id = id;
      return out;
    };
    const top = [];
    for (const it of menu ? menu.items : []) {
      const comp = it.role && COMPOSITE_ROLES[String(it.role).toLowerCase()];
      if (comp) {
        top.push({ label: it.label || comp.label, submenu: comp.submenu.map((r) => (r ? { role: r } : { type: 'separator' })) });
        continue;
      }
      if (it.role || !it.submenu) continue; // appMenu, fileMenu, ... and stray items: only labelled submenus are top-level menus
      top.push({ label: it.label, submenu: it.submenu.items.map(toItem).filter(Boolean) });
    }
    return request('menu.set', { template: menu ? top : null }).then((r) => r);
  }
  static getApplicationMenu() {
    return applicationMenu;
  }
}

/** A click of the app's menu item `id` (the window event 'menu'), with Electron's checkbox and radio behaviour. */
function menuClicked(id, win) {
  const it = menuClicks.get(id);
  if (!it) return;
  if (it.type === 'checkbox') it.checked = !it.checked;
  if (it.type === 'radio' && it.menu) {
    for (const s of it.menu.items) if (s.type === 'radio') s.checked = s === it;
  }
  if (it.click) {
    try {
      it.click(it, win || null, {});
    } catch (e) {
      process.stderr.write(`[D9010 VmApp] menu item ${id}: ${e && e.stack ? e.stack : e}\n`);
    }
  }
}

/** { <name>: path | null } from the user's grants; filled in place by `init`, before 'ready'. */
const folders = {};

// ------------------------------------------------------------------------------------------------ host capabilities

class InputSession {
  constructor(id) {
    this.id = id;
  }
  mouse(params) {
    return request('host.input.mouse', Object.assign({}, params, { sessionId: this.id })).then(() => undefined);
  }
  keys(params) {
    const p = typeof params === 'string' ? { text: params } : params;
    return request('host.input.keys', Object.assign({}, p, { sessionId: this.id })).then(() => undefined);
  }
  stop() {
    return request('host.input.stop', { sessionId: this.id }).then(() => undefined);
  }
}

const host = {
  screen: {
    windows: () => request('host.screen.windows', {}),
    async capture(opts) {
      const r = await request('host.screen.capture', opts || {});
      return Object.assign({}, r, { png: Buffer.from(r.png, 'base64') });
    },
  },
  input: {
    async start(reason) {
      const r = await request('host.input.start', { reason: reason === undefined ? '' : String(reason) });
      return new InputSession(r.sessionId);
    },
  },
  tool: {
    list: () => request('host.tool.list', {}),
    run: (id, args, opts) => request('host.tool.run', { id: String(id), args: args || [], stdin: opts && opts.stdin }),
  },
  mcp: {
    list: () => request('host.mcp.list', {}),
    call: (server, method, params) => request('host.mcp.call', { server: String(server), method, params }),
  },
};

// ------------------------------------------------------------------------------------------------ host messages

function handleInit(msg) {
  initInfo = { app: msg.app || {}, platform: msg.platform || {}, data: msg.data || '/data' };
  for (const k of Object.keys(folders)) delete folders[k];
  Object.assign(folders, msg.folders || {});
  if (!app._ready) {
    app._ready = true;
    safeEmit(app, 'ready'); // (2) listeners run now
    app._resolveReady(); // (3) whenReady() callbacks are scheduled, not yet run
  }
  send({ t: 'ready' }); // (4) before any window.create the scheduled callbacks will cause
}

/** The values of a message's `args`, as the page's structured clone made them (the codec's tags undone). */
function decodeArgs(args) {
  return Array.isArray(args) ? codec.decode(args) : [];
}

/**
 * What the page is told about an error thrown in a handler. Electron sends `error.toString()` and the renderer builds `Error invoking remote
 * method '<channel>': <that>`; so `text` is that string, and `message` stays for hosts that only know the bare message.
 */
function errorInfo(e) {
  let text;
  try {
    text = String(e);
  } catch {
    text = errMessage(e);
  }
  return { message: errMessage(e), text };
}

async function handleInvoke(msg) {
  const id = msg.id;
  const fn = invokeHandlers.get(msg.channel);
  let line;
  if (!fn) {
    line = { t: 'result', id, error: errorInfo(new Error(`No handler registered for '${msg.channel}'`)) };
  } else {
    try {
      const r = await fn(makeEvent(msg.win, true), ...decodeArgs(msg.args));
      line = { t: 'result', id, result: codec.encode(r) }; // throws "… could not be cloned." like Electron's reply would
      const text = JSON.stringify(line);
      if (Buffer.byteLength(text) > MAX_LINE) throw new Error('result is too large for the bridge (16 MiB limit)');
    } catch (e) {
      hostLog('warn', `Error occurred in handler for '${msg.channel}': ${(e && e.stack) || errMessage(e)}`); // Electron: console.error, same text
      line = { t: 'result', id, error: errorInfo(e) };
    }
  }
  try {
    send(line);
  } catch (e) {
    send({ t: 'result', id, error: errorInfo(e) });
  }
}

function handleSend(msg) {
  let args;
  try {
    args = decodeArgs(msg.args);
  } catch (e) {
    return hostLog('error', `a message on '${msg.channel}' was dropped: ${errMessage(e)}`);
  }
  try {
    // the channel is the event name, as in Electron; a listener that throws stops the listeners after it (EventEmitter), and is logged
    ipcMain.emit(msg.channel, makeEvent(msg.win, false), ...args);
  } catch (e) {
    hostLog('error', `error in '${msg.channel}' listener: ${errMessage(e)}`);
  }
  return undefined;
}

function handleWindow(msg) {
  const w = windows.get(msg.win);
  if (!w) return;
  if (msg.event === 'closed') {
    windows.delete(msg.win);
    w._destroyed = true;
    safeEmit(w, 'closed');
    if (windows.size === 0) windowAllClosed();
  } else if (msg.event === 'menu') {
    menuClicked(msg.data && msg.data.id, w);
  } else {
    safeEmit(w, msg.event, msg.data || {});
  }
}

function handleReply(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) return p.reject(new Error((msg.error && msg.error.message) || 'request failed'));
  const result = msg.result === undefined || msg.result === null ? {} : msg.result;
  try {
    if (p.sync) p.sync(result);
  } catch (e) {
    return p.reject(e);
  }
  p.resolve(result);
}

function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object' || typeof msg.t !== 'string') {
    return hostLog('warn', 'ignoring a bridge message without "t"');
  }
  switch (msg.t) {
    case 'init':
      return handleInit(msg);
    case 'invoke':
      return void handleInvoke(msg);
    case 'send':
      return handleSend(msg);
    case 'window':
      return handleWindow(msg);
    case 'reply':
      return handleReply(msg);
    case 'before-quit':
      return void beginQuit(false);
    case 'open-url':
      // a vmapp://<app id>/… link opened on the Mac (SPEC 6, 8.9): Electron's app.on('open-url', (event, url))
      if (typeof msg.url === 'string') safeEmit(app, 'open-url', { preventDefault() {} }, msg.url);
      return undefined;
    default:
      return hostLog('warn', `unknown bridge message type ${JSON.stringify(msg.t)} ignored`);
  }
}

// ------------------------------------------------------------------------------------------------ server

function onConnection(sock) {
  const prev = conn;
  conn = sock;
  if (prev) {
    process.stderr.write('[D9010 VmApp] a new host connection replaces the previous one\n');
    rejectAllPending('host connection replaced');
    prev.destroy();
  }
  let chunks = [];
  let bytes = 0;
  sock.on('data', (chunk) => {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      chunks.push(chunk.subarray(start, nl));
      const line = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      chunks = [];
      bytes = 0;
      start = nl + 1;
      if (!line.length) continue;
      let msg;
      try {
        msg = JSON.parse(line.toString('utf8'));
      } catch {
        hostLog('warn', 'ignoring a malformed bridge line');
        continue;
      }
      try {
        handleMessage(msg);
      } catch (e) {
        hostLog('error', `error handling '${msg && msg.t}': ${errMessage(e)}`);
      }
    }
    if (start < chunk.length) {
      chunks.push(chunk.subarray(start));
      bytes += chunk.length - start;
      if (bytes > MAX_LINE) {
        process.stderr.write('[D9010 VmApp] bridge line exceeds 16 MiB; closing the connection\n');
        sock.destroy();
      }
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (conn !== sock) return; // a replaced connection
    conn = null;
    rejectAllPending('host connection closed');
    process.exit(0); // the host is gone; the VM is the app
  });
}

function startServer() {
  if (!SOCKET_PATH) {
    process.stderr.write('[D9010 VmApp] VMAPP_SOCKET is not set; this process cannot talk to a host\n');
    return;
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const server = net.createServer(onConnection);
  server.on('error', (e) => {
    process.stderr.write(`[D9010 VmApp] cannot listen on ${SOCKET_PATH}: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(SOCKET_PATH);
}

if (process.listenerCount('uncaughtException') === 0) {
  process.on('uncaughtException', (e) => {
    const text = (e && e.stack) || String(e);
    hostLog('error', `uncaught exception: ${text}`);
    process.stderr.write(`uncaught exception: ${text}\n`);
    setTimeout(() => process.exit(1), 50);
  });
}
if (process.listenerCount('unhandledRejection') === 0) {
  process.on('unhandledRejection', (e) => {
    const text = (e && e.stack) || String(e);
    hostLog('error', `unhandled rejection: ${text}`);
    process.stderr.write(`unhandled rejection: ${text}\n`);
  });
}

startServer();

module.exports = { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ports, Menu, MenuItem, folders, host };
