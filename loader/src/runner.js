'use strict';
// Runs installed apps: one AppSession per app, with the real window manager and dialogs. Keeps the per-app
// inspector buffers (bridge traffic, core log, delivered files), which survive the run so they can be read afterwards.
//
// Events:  'changed' (appId)                       run state changed (starting/running/stopping/stopped)
//          'inspect' (appId, kind, item)           kind: 'traffic' | 'log' | 'exported'

const { EventEmitter } = require('events');
const { AppSession } = require('../../hostlib/session');
const { AppWindowManager, lockPartition } = require('./window-manager');
const { AppDialogs } = require('./dialogs');

const LIMITS = { traffic: 5000, log: 2000, exported: 500 };

function pushLimited(arr, item, max) {
  arr.push(item);
  if (arr.length > max + max / 10) arr.splice(0, arr.length - max);
}

class Runner extends EventEmitter {
  /**
   * @param {object} o
   * @param {Store} o.store
   * @param {object} o.cfg resolveConfig() result
   * @param {Map} o.registry webContents id -> window record (shared with the IPC layer)
   * @param {Map} o.uiContexts app id -> { app, verified } (shared with the vmapp-ui protocol handler)
   * @param {Function} o.handleAppUi the vmapp-ui protocol handler
   * @param {NativeDialogs} o.nativeDialogs
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    super();
    this.store = o.store;
    this.cfg = o.cfg;
    this.registry = o.registry;
    this.uiContexts = o.uiContexts;
    this.handleAppUi = o.handleAppUi;
    this.nativeDialogs = o.nativeDialogs;
    this.capabilities = o.capabilities || null; // the one HostCapabilities of this loader, shared by every AppSession (SPEC 8.2)
    this.devices = o.devices || null; // the DeviceGate: the microphone answer of every app window's session (SPEC 7); none = all denied
    this.gpu = o.gpu || null; // the GpuBroker: the sandboxed GPU servers (SPEC 8.6); none = no app gets a GPU
    this.prefs = o.prefs || null; // the loader's preferences: "Experimental GPU (Vulkan)" (SPEC 8.7); none = the normal backend only
    this.log = o.log || (() => {});
    this.onMenuChanged = o.onMenuChanged || (() => {}); // an app's core set its menus (SPEC 7 "Menus")
    this.runs = new Map(); // app id -> run (the latest run of that app, running or not)
    this.seq = 0;
  }

  /** 'stopped' | 'starting' | 'running' | 'stopping' */
  state(id) {
    const r = this.runs.get(id);
    return r ? r.state : 'stopped';
  }
  isActive(id) {
    return this.state(id) !== 'stopped';
  }
  error(id) {
    const r = this.runs.get(id);
    return r ? r.error || null : null;
  }
  note(id) {
    const r = this.runs.get(id);
    return r ? r.note || null : null;
  }
  /** The AppSession of an app that is starting or running (the library applies a changed network grant to it, SPEC 8.3), or null. */
  sessionOf(id) {
    const r = this.runs.get(id);
    return r && r.state !== 'stopped' && r.session ? r.session : null;
  }
  /** The app's window that loader dialogs about it open on, or null. */
  parentWindow(id) {
    const r = this.runs.get(id);
    return r && r.state !== 'stopped' && r.wm ? r.wm.anyBrowserWindow() : null;
  }
  buffers(id) {
    const r = this.runs.get(id);
    return r ? r.buffers : null;
  }
  clearBuffers(id) {
    const r = this.runs.get(id);
    if (r) r.buffers = { traffic: [], log: [], exported: [] };
  }
  /** App ids that have a run (running now, or whose buffers remain from the last run). */
  knownIds() {
    return [...this.runs.keys()];
  }
  activeIds() {
    return [...this.runs.keys()].filter((id) => this.isActive(id));
  }

  _emit(id, kind, item) {
    const r = this.runs.get(id);
    if (!r) return;
    item.seq = ++this.seq;
    pushLimited(r.buffers[kind], item, LIMITS[kind]);
    this.emit('inspect', id, kind, item);
  }

  /** Adds a loader-made event (for example a microphone request) to the app's Inspector traffic. */
  emitTraffic(id, ev) {
    this._emit(id, 'traffic', ev);
  }

  /** Starts the app. Resolves when the core is ready; rejects (and records the error) if it could not start. */
  async launch(id) {
    if (this.isActive(id)) throw new Error('the app is already running');
    let app;
    try {
      app = this.store.get(id);
      if (!app) throw new Error(`${id} is not installed`);
      if (!this.store.hasRuntime(app.manifest.runtime)) throw new Error(`runtime "${app.manifest.runtime}" is not installed`);
      this.store.verifyInstalled(id); // throws if a file is missing or modified
    } catch (e) {
      const prev = this.runs.get(id);
      this.runs.set(id, { appId: id, state: 'stopped', error: e.message, note: null, buffers: prev ? prev.buffers : { traffic: [], log: [], exported: [] } });
      this.emit('changed', id);
      throw e;
    }
    const m = app.manifest;

    this.uiContexts.set(id, { app, verified: new Map() });
    lockPartition(`persist:vmapp-${id}`, this.handleAppUi, this.devices, this.uiContexts);

    const run = { appId: id, state: 'starting', error: null, note: null, stopRequested: false, buffers: { traffic: [], log: [], exported: [] } };
    const appLog = (level, message) => this.log(level, `[${id}] ${message}`);
    const wm = new AppWindowManager({
      app: { id, name: m.name, version: m.version },
      registry: this.registry,
      preload: this.cfg.preloadApp,
      log: appLog,
      dialogs: this.nativeDialogs, // "Leave this page?" when a page vetoes its unload (SPEC 7)
      // the core changed its menus (menu.set): the loader rebuilds the menu bar if one of its windows is focused
      onMenuChanged: () => this.onMenuChanged(),
    });
    const dialogs = new AppDialogs(this.nativeDialogs, (win) => wm.browserWindow(win) || wm.anyBrowserWindow());
    const session = new AppSession({
      appId: id,
      store: this.store,
      vmappVmPath: this.cfg.vmappVm,
      kernel: this.cfg.kernel,
      initramfs: this.cfg.initramfs,
      windowManager: wm,
      dialogs,
      // the Mac's clipboard for the core's clipboard.* (the session checks the device grant at every call)
      clipboard: { readText: () => this.nativeDialogs.readClipboard(), writeText: (t) => this.nativeDialogs.writeClipboard(t) },
      capabilities: this.capabilities || undefined,
      gpu: this.gpu || undefined,
      // the experimental Vulkan backend (SPEC 8.7), used only for an app that asks for it AND was allowed AND while the setting is on
      krun: this.prefs
        ? { path: this.cfg.krunVm, kernel: this.cfg.krunKernel, enabled: () => this.prefs.get('experimentalGpuVulkan') === true }
        : undefined,
      onLog: (e) => {
        appLog(e.level === 'debug' ? 'debug' : e.level, `${e.source}: ${e.message}`);
      },
    });
    wm.attach(session);
    run.session = session;
    run.wm = wm;
    this.runs.set(id, run);

    session.on('log', (e) => this._emit(id, 'log', { ts: Date.now(), level: e.level, source: e.source, message: e.message }));
    session.on('traffic', (ev) => this._emit(id, 'traffic', ev));
    session.on('exported', (ev) => this._emit(id, 'exported', { ts: Date.now(), share: ev.share, files: ev.files }));
    session.on('grant', (g) =>
      this._emit(id, 'traffic', {
        ts: Date.now(),
        dir: 'host',
        t: 'grant',
        op: g.name,
        bytes: 0,
        preview: JSON.stringify(g).slice(0, 200),
      }),
    );
    session.on('stopped', (info) => {
      run.state = 'stopped';
      wm.closeAll();
      if (this.devices) this.devices.forgetApp(id); // no window is left to listen
      if (!run.stopRequested && info && info.reason === 'core-exited' && info.exitCode) run.note = `The app exited with code ${info.exitCode}.`;
      this.emit('changed', id);
    });

    this.emit('changed', id);
    try {
      await session.start();
    } catch (e) {
      run.state = 'stopped';
      if (!run.stopRequested) run.error = e.message;
      wm.closeAll();
      this.emit('changed', id);
      throw e;
    }
    if (run.state === 'starting') run.state = 'running';
    this.emit('changed', id);
    return session;
  }

  async stop(id) {
    const run = this.runs.get(id);
    if (!run || run.state === 'stopped') return;
    run.stopRequested = true;
    if (run.state !== 'stopping') {
      run.state = 'stopping';
      this.emit('changed', id);
    }
    await run.session.stop();
    run.state = 'stopped';
    run.wm.closeAll();
    this.emit('changed', id);
  }

  /** Stops every running app; after `maxMs` the remaining VMs are killed. */
  async stopAll(maxMs = 10000) {
    const ids = this.activeIds();
    if (!ids.length) return;
    const all = Promise.allSettled(ids.map((id) => this.stop(id)));
    let timer;
    const timeout = new Promise((r) => {
      timer = setTimeout(r, maxMs, 'timeout');
    });
    const first = await Promise.race([all, timeout]);
    clearTimeout(timer);
    if (first === 'timeout') {
      for (const id of ids) {
        const run = this.runs.get(id);
        if (run && run.session && run.session.child && !run.session._exited) {
          this.log('warn', `[${id}] did not stop in ${maxMs} ms; killing vmapp-vm`);
          try {
            run.session.child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      await Promise.race([all, new Promise((r) => setTimeout(r, 3000))]);
    }
  }
}

module.exports = { Runner };
