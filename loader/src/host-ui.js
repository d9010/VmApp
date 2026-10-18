'use strict';
// The loader's side of host capabilities (hostlib/README.md "Capability UI"): the confirmation for every use that is on
// `ask`, the screenshot picker, the control badge and the virtual-input overlay. Everything here is loader-owned UI
// (INV-B5): the wording comes from host-text.js, the dialog is a native sheet on the app's window, the picker, the badge and
// the overlay are the loader's own windows. Nothing an app sends is ever rendered as markup; the app only supplies the text
// that is quoted (its name, its purpose, the arguments it wants to use) and the positions the overlay draws.

const { confirmText, splitCap } = require('./host-text');
const { Badge } = require('./badge');
const { Overlay } = require('./overlay');
const { CapturePicker } = require('./capture-picker');

class HostUi {
  /**
   * @param {object} o
   * @param {NativeDialogs} o.nativeDialogs
   * @param {(appId)=>BrowserWindow|null} o.parentOf the app's window the sheet opens on
   * @param {object} o.catalog read access to the user's catalog (tool(id), mcpServer(id))
   * @param {object} o.ctl the vmapp-hostctl client (to name a window in a screenshot request, to offer displays and windows)
   * @param {object} o.cfg resolveConfig() result
   * @param {Map} o.senders
   * @param {LoaderPrefs} [o.prefs] the loader's preferences: "Show typed text in the overlay" (off by default)
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.dialogs = o.nativeDialogs;
    this.parentOf = o.parentOf;
    this.catalog = o.catalog;
    this.ctl = o.ctl;
    this.log = o.log || (() => {});
    this.caps = null;
    this.badge = new Badge({ cfg: o.cfg, senders: o.senders, caps: () => this.caps, log: this.log });
    this.overlay = new Overlay({ cfg: o.cfg, senders: o.senders, prefs: o.prefs, log: this.log });
    this.picker = new CapturePicker({
      cfg: o.cfg,
      senders: o.senders,
      ctl: o.ctl,
      dialogs: o.nativeDialogs,
      parentOf: o.parentOf,
      excludePids: () => (this.caps ? this.caps.excludePids : [process.pid]),
      log: this.log,
    });
  }

  /** Called by HostCapabilities with itself: the badge's Stop buttons and its list come from the broker. */
  attach(caps) {
    this.caps = caps;
    caps.on('active-changed', () => {
      this.badge.update(caps.active()).catch(() => {});
      this.overlay.update(this._wantOverlay()).catch(() => {});
    });
    // panic: a question that is still open is answered "no" (and a region selection closes)
    caps.on('panic', () => this.picker.cancelAll());
  }

  active() {
    return this.caps ? this.caps.active() : [];
  }

  // ---------------------------------------------------------------------------------------------- confirmation

  /** ui.confirmUse: false | true (this once) | 'session' (while the app runs). Throwing counts as no. */
  async confirmUse(req) {
    const lookup = {};
    const { kind, id } = splitCap(req.cap);
    try {
      if (kind === 'tool' && id && id !== '*') lookup.tool = this.catalog.tool(id);
      if (kind === 'mcp' && id && id !== '*') lookup.server = this.catalog.mcpServer(id);
    } catch (e) {
      this.log('warn', `catalog: ${e.message}`);
    }
    if (req.op === 'host.screen.capture') {
      const s = req.suggestion || req.params;
      if (s && s.target === 'window') lookup.windows = await this._windows();
    }
    const text = confirmText(req, lookup);
    return this.dialogs.confirmHostUse(this.parentOf(req.app.id), text, req);
  }

  /**
   * ui.chooseCapture (SPEC 8.2): the USER picks what a screenshot contains. The app's parameters are only the suggestion
   * (req.suggestion, validated by the broker). Resolves with false, or {allow: true | 'session', target:{kind, display? |
   * windowId? | region?}}. The picker is a loader window parented to the app's window (src/capture-picker.js).
   */
  async chooseCapture(req) {
    const lookup = {};
    const s = req.suggestion;
    if (s && s.target === 'window') lookup.windows = await this._windows();
    const text = confirmText(req, lookup);
    const scripted = this.dialogs.scriptedCapture(text, req);
    if (scripted !== undefined) return scripted;
    return this.picker.choose(req, text);
  }

  /** The open windows, to name the one a screenshot request is about. Best effort: the question never waits for long. */
  async _windows() {
    if (!this.ctl) return [];
    try {
      const list = await this.ctl.request('windows', {}, { timeoutMs: 3000 });
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------------------------- the badge (INV-H3)

  async _show() {
    await this.badge.update(this.active()); // rejects when the badge cannot be shown: the broker then refuses the use
  }

  _wantOverlay() {
    return this.active().some((e) => e.kind === 'input');
  }

  /** The overlay is an addition to the badge: it can fail (and is logged) without refusing the input session. */
  async _overlay() {
    try {
      await this.overlay.update(this._wantOverlay());
    } catch (e) {
      this.log('warn', `input overlay: ${e.message}`);
    }
  }

  async inputStarted() {
    await this._show();
    await this._overlay();
  }
  async inputStopped() {
    await this._show();
    await this._overlay();
  }
  shellStarted() {
    return this._show();
  }
  shellStopped() {
    return this._show();
  }

  /** ui.inputActivity: what the app just did with its input session. Drawn by the overlay, shown to the user only. */
  inputActivity(ev) {
    this.overlay.activity(ev);
  }

  dispose() {
    this.badge.dispose();
    this.overlay.dispose();
    this.picker.dispose();
  }
}

module.exports = { HostUi };
