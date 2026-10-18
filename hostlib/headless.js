'use strict';
// Headless stand-ins for the loader's window manager and dialogs: used by tests and `vmapp run --headless`.

const { EventEmitter } = require('events');

/**
 * Records windows and lets tests/scripts act as the renderer.
 * Implements the window-manager interface of hostlib/README.md. Not an EventEmitter itself (its `emit` is the
 * interface method core->renderer); use `wm.events` for notifications:
 *   'window-created' (rec), 'window-closed' (rec), 'emit' (win, channel, args), 'title' (rec), 'focus' (rec)
 */
class FakeWindowManager {
  constructor() {
    this.windows = new Map();
    this.nextId = 1;
    this.session = null;
    this.events = new EventEmitter();
    this.log = []; // chronological record of interface calls
  }

  /** Binds the session so that wm.invoke/send/userClose can call back into it. */
  attach(session) {
    this.session = session;
    return this;
  }

  // ---- window-manager interface (called by the session) ----
  async create(params) {
    const id = this.nextId++;
    const rec = { id, params, title: params.title || '', closed: false, focusCount: 0, received: [] };
    this.windows.set(id, rec);
    this.log.push({ call: 'create', win: id, params });
    this.events.emit('window-created', rec);
    return id;
  }
  async close(win) {
    const rec = this.windows.get(win);
    if (!rec || rec.closed) return;
    rec.closed = true;
    this.log.push({ call: 'close', win });
    this.events.emit('window-closed', rec);
    // a real manager reports the close back to the core, whatever the reason
    if (this.session) setImmediate(() => this.session.windowEvent(win, 'closed', {}));
  }
  async setTitle(win, title) {
    const rec = this._rec(win);
    rec.title = title;
    this.log.push({ call: 'setTitle', win, title });
    this.events.emit('title', rec);
  }
  async focus(win) {
    const rec = this._rec(win);
    rec.focusCount++;
    this.log.push({ call: 'focus', win });
    this.events.emit('focus', rec);
  }
  /** The core's menus (menu.set, validated by the session): kept so a test can read them and "click" one with menuClick. */
  async setMenu(menus) {
    this.menus = menus;
    this.log.push({ call: 'setMenu', items: menus ? JSON.stringify(menus).length : 0 });
    this.events.emit('menu', menus);
  }
  /** The user chooses the core's menu item `id` while window `win` is focused (the window event 'menu' {id}, as the loader sends). */
  menuClick(win, id) {
    this.session.windowEvent(win, 'menu', { id });
  }
  emit(win, channel, args) {
    const rec = this.windows.get(win);
    if (!rec) throw new Error(`emit to unknown window ${win}`);
    rec.received.push({ channel, args });
    this.log.push({ call: 'emit', win, channel, args });
    this.events.emit('emit', win, channel, args);
  }

  _rec(win) {
    const rec = this.windows.get(win);
    if (!rec) throw new Error(`unknown window ${win}`);
    return rec;
  }

  // ---- helpers acting as the renderer / user ----
  invoke(win, channel, ...args) {
    return this.session.invoke(win, channel, args);
  }
  send(win, channel, ...args) {
    return this.session.send(win, channel, args);
  }
  /** The user closes the window. */
  userClose(win) {
    const rec = this._rec(win);
    rec.closed = true;
    this.events.emit('window-closed', rec);
    this.session.windowEvent(win, 'closed', {});
  }
  windowEvent(win, event, data) {
    this.session.windowEvent(win, event, data || {});
  }
  list() {
    return [...this.windows.values()];
  }
  /** Waits until at least `count` windows were created. */
  waitForWindows(count = 1, timeoutMs = 10000) {
    if (this.windows.size >= count) return Promise.resolve(this.list());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.events.removeListener('window-created', on);
        reject(new Error(`timed out waiting for ${count} window(s); have ${this.windows.size}`));
      }, timeoutMs);
      const on = () => {
        if (this.windows.size >= count) {
          clearTimeout(t);
          this.events.removeListener('window-created', on);
          resolve(this.list());
        }
      };
      this.events.on('window-created', on);
    });
  }
  /** Waits for a core -> renderer emit on `channel` (optionally only for window `win`). Resolves with args. */
  waitForEmit(channel, { win, timeoutMs = 10000 } = {}) {
    for (const rec of this.windows.values()) {
      if (win !== undefined && rec.id !== win) continue;
      const i = rec.received.findIndex((r) => r.channel === channel && !r.consumed);
      if (i >= 0) {
        rec.received[i].consumed = true;
        return Promise.resolve(rec.received[i].args);
      }
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.events.removeListener('emit', on);
        reject(new Error(`timed out waiting for emit on "${channel}"`));
      }, timeoutMs);
      const on = (w, c, args) => {
        if (c !== channel || (win !== undefined && w !== win)) return;
        clearTimeout(t);
        this.events.removeListener('emit', on);
        const rec = this.windows.get(w);
        const e = rec.received[rec.received.length - 1];
        e.consumed = true;
        resolve(args);
      };
      this.events.on('emit', on);
    });
  }
}

/**
 * Scripted dialogs. Each option is a value or a function (params) -> value:
 *   open:  host paths array | single path | null     (default null = cancel)
 *   save:  host path | null                          (default null)
 *   message: button index                            (default 0)
 *   confirmExternal: boolean                         (default false)
 * `calls` records every invocation; `opened` the URLs passed to openExternal (nothing is really opened).
 */
class FakeDialogs {
  constructor(opts = {}) {
    this.opts = Object.assign({ open: null, save: null, message: 0, confirmExternal: false }, opts);
    this.calls = [];
    this.opened = [];
  }
  _answer(kind, params) {
    this.calls.push({ kind, params });
    const v = this.opts[kind];
    return typeof v === 'function' ? v(params) : v;
  }
  async open(params) {
    return this._answer('open', params);
  }
  async save(params) {
    return this._answer('save', params);
  }
  async message(params) {
    return this._answer('message', params);
  }
  async confirmExternal(url, app) {
    return this._answer('confirmExternal', { url, app });
  }
  async openExternal(url) {
    this.opened.push(url);
  }
}

/**
 * Scripted stand-in for the loader's capability UI (hostlib/README.md "Capability UI"): answers confirmUse from
 * `allow` and records the badge calls. Used by tests and `vmapp run --headless` (--allow-host).
 *   allow: false (default: deny) | true | 'session' | (request) => value
 * `calls` records confirmUse requests, `badges` the badge calls in order:
 *   {badge:'input'|'shell', state:'on'|'off', ...info}. `events` emits 'confirm' (request, answer) and 'badge' (entry).
 */
class FakeCapabilitiesUi {
  constructor(opts = {}) {
    this.allow = opts.allow === undefined ? false : opts.allow;
    this.calls = [];
    this.badges = [];
    this.activity = [];
    this.events = new EventEmitter();
    this.caps = null;
  }
  /** Called by HostCapabilities with itself, so a script can reach `ui.caps.stopAll()` (the badge's Stop button). */
  attach(caps) {
    this.caps = caps;
  }
  async confirmUse(req) {
    this.calls.push(req);
    const v = typeof this.allow === 'function' ? this.allow(req) : this.allow;
    this.events.emit('confirm', req, v);
    return v;
  }
  _badge(badge, state, info) {
    const e = Object.assign({ badge, state }, info);
    this.badges.push(e);
    this.events.emit('badge', e);
  }
  /** What the app did with its input session (the loader draws it as the overlay). Recorded in `ui.activity`. */
  inputActivity(ev) {
    this.activity.push(ev);
    this.events.emit('activity', ev);
  }
  inputStarted(info) {
    this._badge('input', 'on', info);
  }
  inputStopped(info) {
    this._badge('input', 'off', info);
  }
  shellStarted(info) {
    this._badge('shell', 'on', info);
  }
  shellStopped(info) {
    this._badge('shell', 'off', info);
  }
}

/** An in-memory clipboard for headless runs and tests: `text` starts as given; `writes` records what the app wrote. */
class FakeClipboard {
  constructor(text = '') {
    this.text = text;
    this.writes = [];
  }
  async readText() {
    return this.text;
  }
  async writeText(t) {
    this.text = t;
    this.writes.push(t);
  }
}

module.exports = { FakeWindowManager, FakeDialogs, FakeCapabilitiesUi, FakeClipboard };
