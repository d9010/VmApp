'use strict';
// Device permissions of app windows (SPEC 2.2 permissions.devices, SPEC 7, GOVERNANCE INV-B3).
//
// An app window is denied every permission (camera, notifications, geolocation, clipboard-read, ...) with ONE exception that
// SPEC defines: the microphone. It is allowed for an app only when BOTH
//   1. the app's manifest asks for it (permissions.devices has {device:"microphone"}), and
//   2. the user allowed it in the permission sheet (grants/<id>.json, devices.microphone),
// and only for getUserMedia({audio}) with mediaTypes exactly ['audio'] (a request that includes video is denied as a whole),
// made by the main frame of one of THIS app's own windows (vmapp-ui://<id>/). Grants are read at every request, so revoking
// one applies at once. Nothing an app sends can change any of this.
//
// microphoneRequestAllowed / microphoneCheckAllowed below are the only code that may turn a permission answer into `true`
// (window-manager.js calls them, nothing else). tools/check-invariants (rule b3-csp-nav-perms) reads them: every `return`
// is `false` except the last, which must ask the gate, and 'audio' must be the only media type named.
//
// The loader never records audio itself: the app's own window listens, and the loader only shows that it does (the card chip,
// the activity monitor). macOS asks for its own consent as well (NSMicrophoneUsageDescription, the audio-input entitlement).

const { EventEmitter } = require('events');
const { deviceAllowed } = require('../../hostlib/store');

/** setPermissionRequestHandler answer for an app window of `appId`. `gate` is a DeviceGate (no gate: everything is denied). */
function microphoneRequestAllowed(gate, appId, wc, permission, details) {
  if (!gate) return false;
  if (permission !== 'media') {
    gate.refused(appId, permission, details);
    return false;
  }
  const types = details && details.mediaTypes;
  if (!Array.isArray(types) || types.length !== 1 || types[0] !== 'audio') {
    gate.refused(appId, permission, details);
    return false;
  }
  return gate.requestAllowed(appId, wc, details) === true;
}

/** setPermissionCheckHandler answer (navigator.permissions.query, device labels). Never allows anything but the audio check. */
function microphoneCheckAllowed(gate, appId, wc, permission, details) {
  if (!gate) return false;
  if (permission !== 'media') return false;
  if (!details || details.mediaType !== 'audio') return false;
  return gate.checkAllowed(appId, wc, details) === true;
}

// The clipboard (DEV-APPS C5): navigator.clipboard.readText/read ('clipboard-read') and writeText/write ('clipboard-sanitized-write')
// of the main page of one of THIS app's windows, when the manifest asks for the device "clipboard" AND the user allowed it. Keyboard
// copy and paste (Cmd+C, Cmd+V: the loader's Edit menu) never needed a permission and are unchanged. Every other permission
// stays denied. clipboardRequestAllowed / clipboardCheckAllowed are the only code besides the microphone's that may answer `true`.
function clipboardRequestAllowed(gate, appId, wc, permission, details) {
  if (!gate) return false;
  if (permission !== 'clipboard-read' && permission !== 'clipboard-sanitized-write') {
    gate.refused(appId, permission, details);
    return false;
  }
  return gate.clipboardAllowed(appId, wc, details, permission) === true;
}

function clipboardCheckAllowed(gate, appId, wc, permission, details) {
  if (!gate) return false;
  if (permission !== 'clipboard-read' && permission !== 'clipboard-sanitized-write') return false;
  return gate.clipboardChecked(appId, wc, details) === true;
}

// ---------------------------------------------------------------------------------------------------- listening state
// "Is the app's window capturing audio right now?" is shown on the app's card and in the activity monitor. Chromium gives the
// embedder no event for it, so while a window has been granted the microphone the loader asks the window, from the main
// process (the page gets no script, no API and no binding), for live audio tracks through DevTools' Runtime.queryObjects. It
// is best effort and informational: a hostile page can hide a track from this view, which is why the card also says, without
// any such check, that the microphone is ALLOWED, and why every granted request is logged in the Inspector. The OS shows its own
// microphone indicator regardless.

const COUNT_LIVE_AUDIO = 'function () { let n = 0; for (const t of this) { try { if (t.kind === "audio" && t.readyState === "live") n++; } catch (e) { /* not a track */ } } return n; }';

class MicWatch {
  /**
   * @param {object} [o]
   * @param {number} [o.intervalMs] time between two looks while armed (default 1000)
   * @param {number} [o.idlePolls] looks without a live track before the watch ends (default 4)
   * @param {(appId:string, count:number)=>void} [o.onChange] a window's number of live audio tracks changed
   * @param {(level:string, msg:string)=>void} [o.log]
   */
  constructor(o = {}) {
    this.intervalMs = o.intervalMs || 1000;
    this.idlePolls = o.idlePolls || 4;
    this.onChange = o.onChange || (() => {});
    this.log = o.log || (() => {});
    this.wins = new Map(); // webContents id -> { wc, appId, count, idle, timer, busy, attached }
  }

  /** The window was just granted the microphone: start looking (or keep looking). */
  arm(wc, appId) {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    const id = wc.id; // read once: a destroyed web contents no longer answers
    let st = this.wins.get(id);
    if (!st) {
      st = { id, wc, appId, count: 0, idle: 0, timer: null, busy: false, attached: false };
      this.wins.set(id, st);
      if (typeof wc.once === 'function') wc.once('destroyed', () => this._drop(id));
    }
    st.idle = 0;
    if (!st.timer) {
      st.timer = setInterval(() => this._poll(st), this.intervalMs);
      st.timer.unref();
      setTimeout(() => this._poll(st), 250).unref();
    }
  }

  /** Live audio tracks across the windows of one app. */
  count(appId) {
    let n = 0;
    for (const st of this.wins.values()) if (st.appId === appId) n += st.count;
    return n;
  }

  async _count(st) {
    const dbg = st.wc.debugger;
    if (!st.attached) {
      if (!dbg.isAttached()) dbg.attach('1.3');
      st.attached = true;
    }
    const group = 'vmapp-mic';
    try {
      const proto = await dbg.sendCommand('Runtime.evaluate', { expression: 'MediaStreamTrack.prototype', objectGroup: group, silent: true });
      if (!proto || !proto.result || !proto.result.objectId) return 0;
      const q = await dbg.sendCommand('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: group });
      if (!q || !q.objects || !q.objects.objectId) return 0;
      const r = await dbg.sendCommand('Runtime.callFunctionOn', { objectId: q.objects.objectId, functionDeclaration: COUNT_LIVE_AUDIO, returnByValue: true, silent: true });
      const n = r && r.result ? r.result.value : 0;
      return Number.isInteger(n) && n > 0 ? n : 0;
    } finally {
      await dbg.sendCommand('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    }
  }

  async _poll(st) {
    if (st.busy || !this.wins.has(st.id)) return;
    if (typeof st.wc.isDestroyed === 'function' && st.wc.isDestroyed()) return this._drop(st.id);
    st.busy = true;
    let n = 0;
    try {
      n = await this._count(st);
    } catch (e) {
      this.log('debug', `microphone watch: ${e.message}`);
      n = 0;
    } finally {
      st.busy = false;
    }
    if (!this.wins.has(st.id)) return;
    if (n !== st.count) {
      st.count = n;
      this.onChange(st.appId, this.count(st.appId));
    }
    if (n > 0) st.idle = 0;
    else if (++st.idle >= this.idlePolls) this._stopTimer(st);
  }

  _stopTimer(st) {
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    if (st.attached) {
      st.attached = false;
      try {
        if (!st.wc.isDestroyed() && st.wc.debugger.isAttached()) st.wc.debugger.detach();
      } catch {
        /* already detached */
      }
    }
  }

  _drop(id) {
    const st = this.wins.get(id);
    if (!st) return;
    this._stopTimer(st);
    this.wins.delete(id);
    if (st.count) this.onChange(st.appId, this.count(st.appId));
  }

  /** The app stopped: forget its windows. */
  forgetApp(appId) {
    for (const [id, st] of [...this.wins]) if (st.appId === appId) this._drop(id);
  }

  dispose() {
    for (const id of [...this.wins.keys()]) this._drop(id);
  }
}

// ---------------------------------------------------------------------------------------------------- the gate

class DeviceGate extends EventEmitter {
  /**
   * @param {object} o
   * @param {Store} o.store grants and manifests are read from here at every request
   * @param {Map} o.registry webContents id -> app window record {appId, ...} (the loader's window registry)
   * @param {(level,msg)=>void} [o.log]
   * @param {MicWatch} [o.watch] default: a MicWatch wired to 'listening'
   *
   * Events: 'event' ({appId, ev}: an Inspector row {kind:'host', cap, op, detail, allowed, ...} for every microphone request,
   * allowed or denied), 'listening' (appId, liveTracks).
   */
  constructor(o) {
    super();
    this.store = o.store;
    this.registry = o.registry;
    this.log = o.log || (() => {});
    this.watch = o.watch || new MicWatch({ log: this.log, onChange: (appId, n) => this.emit('listening', appId, n) });
  }

  /** null when `device` ('microphone', the default, or 'clipboard') may be used by this window, else the plain reason it may not. */
  _why(appId, wc, details, device = 'microphone') {
    try {
      if (device !== 'microphone' && device !== 'clipboard') return 'not a device a window can use';
      const rec = wc && this.registry.get(wc.id);
      if (!rec || rec.appId !== appId) return 'the request did not come from a window of this app';
      if (!details || details.isMainFrame === false) return 'the request did not come from the window’s main page';
      const url = details.requestingUrl || details.securityOrigin || '';
      if (typeof url !== 'string' || !url.startsWith(`vmapp-ui://${appId}/`)) return 'the request did not come from the app’s own page';
      const app = this.store.get(appId);
      if (!app) return 'the app is not installed';
      const asked = ((app.manifest.permissions && app.manifest.permissions.devices) || []).some((d) => d && d.device === device);
      if (!asked) return `the app’s manifest does not ask for the ${device}`;
      if (!deviceAllowed(app.manifest, this.store.loadGrants(appId), device)) return `you have not allowed this app to use the ${device}`;
      return null;
    } catch (e) {
      return `could not check: ${e.message}`;
    }
  }

  /** navigator.clipboard from a window: read or write. Every request is an Inspector row (never its text). */
  clipboardAllowed(appId, wc, details, permission) {
    const why = this._why(appId, wc, details, 'clipboard');
    const op = permission === 'clipboard-read' ? 'clipboard.read' : 'clipboard.write';
    this._record(appId, { cap: 'clipboard', op, detail: `the window ${op === 'clipboard.read' ? 'reads' : 'writes'} the clipboard`, allowed: why === null, message: why });
    return why === null;
  }

  clipboardChecked(appId, wc, details) {
    return this._why(appId, wc, details, 'clipboard') === null;
  }

  /** getUserMedia({audio}) from a window. Logged either way; a granted request starts the listening watch. */
  requestAllowed(appId, wc, details) {
    const why = this._why(appId, wc, details);
    this._record(appId, { cap: 'microphone', op: 'media.audio', detail: 'getUserMedia (audio)', allowed: why === null, message: why });
    if (why === null) this.watch.arm(wc, appId);
    return why === null;
  }

  checkAllowed(appId, wc, details) {
    return this._why(appId, wc, details) === null;
  }

  /** A permission that is never available (everything but the microphone, and video even next to audio). */
  refused(appId, permission, details) {
    if (permission === 'media') {
      const types = details && Array.isArray(details.mediaTypes) ? details.mediaTypes.join('+') : 'unknown';
      this._record(appId, { cap: types.includes('video') ? 'camera' : 'microphone', op: 'media.' + (types.includes('video') ? 'video' : 'unknown'), detail: `getUserMedia (${types})`, allowed: false, message: 'only the microphone can be requested, on its own; the camera is not available' });
    } else {
      this.log('debug', `[${appId}] permission "${String(permission).slice(0, 40)}" denied`);
    }
  }

  /** Whether the app's windows hold live audio tracks right now (best effort, see MicWatch). */
  listening(appId) {
    return this.watch.count(appId) > 0;
  }

  forgetApp(appId) {
    this.watch.forgetApp(appId);
  }

  dispose() {
    this.watch.dispose();
  }

  _record(appId, r) {
    const ev = {
      ts: Date.now(),
      dir: 'from-core',
      t: 'host',
      kind: 'host',
      appId,
      cap: r.cap,
      op: r.op,
      detail: r.detail,
      allowed: r.allowed,
      durationMs: 0,
      bytes: 0,
      preview: `${r.op} ${r.detail || ''}`.slice(0, 200),
    };
    if (!r.allowed && r.message) {
      ev.error = true;
      ev.message = `permission denied: ${r.message}`;
    }
    this.emit('event', { appId, ev });
  }
}

module.exports = { microphoneRequestAllowed, microphoneCheckAllowed, clipboardRequestAllowed, clipboardCheckAllowed, DeviceGate, MicWatch };
