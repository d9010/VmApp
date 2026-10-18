'use strict';
// IPC of the library window (the loader's own UI): installed apps, install, permission sheet, launch/stop,
// uninstall, reset. Every handler checks that the sender is the library window; the renderer is never trusted for
// paths or ids it did not get from here (install goes through a token, grants are re-validated against the manifest).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, ipcMain, session: electronSession } = require('electron');
const pkg = require('../../hostlib/package');
const { compareVersions } = require('../../hostlib/manifest');
const { parseAppRef, newestInstallable, isInsecureRemote, publish: publishPackage, getPublishToken, savePublishToken, publishRegistriesFor, publishTokensFile } = require('../../hostlib/updates');
const { normalizeRegistryUrl } = require('../../hostlib/store');
const { partitionOf } = require('./window-manager');
const { classifyFolder } = require('./folder-guard');
const { checkHostGrant, hostRequestSummary } = require('../../hostlib/capabilities');
const netperm = require('../../hostlib/network');
const resperm = require('../../hostlib/resources');
const examples = require('./examples');

// A grant may be narrower than the request, never wider (same table as hostlib/session.js).
const ALLOWED_ACCESS = { readwrite: ['readwrite', 'read'], read: ['read'], writeonly: ['writeonly'] };
// What the permission sheet may save for a host capability. `always` is never offered (SPEC 8.2: not the default, and
// not for input or shell tools at all); `session` goes back to `ask` when the app stops.
const SHEET_HOST_MODES = ['ask', 'session'];
// What the File menu may ask the library page to do (main.js `buildMenu`).
const MENU_ACTIONS = ['examples', 'browse', 'install'];

const kib = examples.fmtSize;

class Library {
  /**
   * @param {object} o
   * @param {Store} o.store
   * @param {Runner} o.runner
   * @param {Inspector} o.inspector
   * @param {NativeDialogs} o.nativeDialogs
   * @param {Map} o.senders webContents id -> 'library' | 'inspector'
   * @param {object|null} o.testGrants VMAPP_TEST_GRANTS (dev only)
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.store = o.store;
    this.runner = o.runner;
    this.inspector = o.inspector;
    this.dialogs = o.nativeDialogs;
    this.senders = o.senders;
    this.testGrants = o.testGrants || null;
    this.log = o.log || (() => {});
    this.updates = o.updates;
    this.catalog = o.catalog; // the WRITABLE catalog: read here for the sheets, written only by the settings window (INV-H1)
    this.caps = o.capabilities; // the broker: active control, Stop buttons
    this.devices = o.devices || null; // the DeviceGate: is the microphone in use now (SPEC 7)
    this.hostLimits = o.hostLimits || (() => resperm.hostLimits()); // what this Mac allows a VM: its logical cores, half its memory
    this.activityState = o.activity || (() => ({ apps: [] })); // the live monitor's state, for the "Activity" section
    this.onNotify = null; // set by the monitor: something in the library changed, look again
    this.openSettings = o.openSettings || (() => {});
    this.registryDefault = o.registryDefault || '';
    this.examplesDir = o.examplesDir || ''; // the folder "Load examples" reads (src/config.js); the page never names a path
    this.packaged = !!o.packaged;
    this.examplesBusy = false; // an examples install is in progress
    // token ->{ id?, file, temp, source, force, downgrade, useVersion, version }: what the user is looking at in a review
    this.installs = new Map();
    this.notices = new Map(); // app id -> { text, kind: 'info'|'warn' }: inline note on the card (update results)
    this.withdrawn = new Map(); // `${id}@${version}` -> { reason, at }: what the last registry contact said
    this.checking = new Set(); // app ids with a launch-time update check in progress
    this.devBusy = false; // a developer build (pack + install) is in progress
    this.publishedPages = new Set(); // app page addresses a publish just returned: the only ones "Open page" may open
    this.runner.on('changed', () => this.notify());
    this._register();
  }

  notify() {
    for (const [id, kind] of this.senders) {
      if (kind !== 'library') continue;
      const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && b.webContents.id === id);
      if (w) w.webContents.send('lib:changed');
    }
    if (this.onNotify) this.onNotify();
  }

  /** The live monitor's state, for the library's "Activity" section (pushed whenever it changes). */
  pushActivity(state) {
    for (const [id, kind] of this.senders) {
      if (kind !== 'library') continue;
      const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && b.webContents.id === id);
      if (w) w.webContents.send('lib:activityState', state);
    }
  }

  /** A message for the library window (a banner): kind 'info' | 'warn' | 'error'. */
  notice(kind, text) {
    for (const [id, k] of this.senders) {
      if (k !== 'library') continue;
      const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && b.webContents.id === id);
      if (w) w.webContents.send('lib:notice', { kind, text });
    }
  }

  /** Sends `channel` to every library window. */
  _toLibrary(channel, payload) {
    for (const [id, k] of this.senders) {
      if (k !== 'library') continue;
      const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && b.webContents.id === id);
      if (w) w.webContents.send(channel, payload);
    }
  }

  /** Sends one message to the library window(s): the launcher updater's state (`upd:state`). */
  push(channel, payload) {
    this._toLibrary(channel, payload);
  }

  /** The File menu asks the library page to open a loader sheet ("Load examples…", "Browse registry…", "Install from file…"). */
  menuAction(action) {
    if (!MENU_ACTIONS.includes(action)) throw new Error(`unknown menu action ${String(action).slice(0, 40)}`);
    this._toLibrary('lib:menu', action);
  }

  // ------------------------------------------------------------------------------------------ Load examples

  /** {available, count, show, packaged, dir?}: is there anything to load, and does the UI offer it at all (src/examples.js infoOf). */
  examplesInfo() {
    return examples.infoOf(this.examplesDir, this.packaged);
  }

  /**
   * The rows of the "Load examples" sheet, read from the packages themselves (name, description, version, size, what they ask for)
   * and, for the "What to allow" hint, from the folder's README.md when it has a line for the package. Reading a manifest is a few
   * KiB per package; the full verification happens when the package is installed.
   */
  async examplesList() {
    const info = this.examplesInfo();
    const entries = examples.listPackageFiles(this.examplesDir);
    const readme = examples.readReadme(this.examplesDir);
    const deps = { currentVersion: (id) => this.store.currentVersion(id), hasRuntime: (rt) => this.store.hasRuntime(rt) };
    const items = [];
    for (const e of entries) {
      items.push(examples.describeExample(e, readme, deps));
      await new Promise((r) => setImmediate(r)); // let the loader breathe between packages
    }
    return Object.assign({}, info, { items });
  }

  /**
   * "Install selected": the chosen examples, one after the other, through the SAME install path as "Install from file…"
   * (`_installFile`: the full verification, then Store.install). The page names examples by file name only; every name is
   * checked against what the folder holds right now, and nothing is installed if any is not one of them. A package that fails
   * verification, or whose version is already installed (or older than the installed one), does not stop the others.
   * Nothing is ever granted and nothing is launched. Progress goes to the library page as `lib:examplesProgress`.
   * Returns {results, counts, text}.
   */
  async installExamples(names) {
    if (this.examplesBusy) throw new Error('The examples are already being installed.');
    if (!Array.isArray(names)) throw new Error('Choose at least one example.');
    const here = new Map(examples.listPackageFiles(this.examplesDir).map((e) => [e.name, e]));
    const entries = [];
    for (const n of names) {
      if (typeof n !== 'string' || !here.has(n)) throw new Error(`“${String(n).slice(0, 60)}” is not one of the examples.`);
      if (!entries.some((e) => e.name === n)) entries.push(here.get(n));
    }
    if (!entries.length) throw new Error('Choose at least one example.');
    this.examplesBusy = true;
    try {
      const results = await examples.installExamples(entries, {
        verify: (file) => pkg.read(file),
        currentVersion: (id) => this.store.currentVersion(id),
        hasRuntime: (rt) => this.store.hasRuntime(rt),
        isRunning: (id) => this.runner.isActive(id),
        install: (file) => this._installFile(file),
        onProgress: (ev) => this._toLibrary('lib:examplesProgress', ev),
      });
      const counts = examples.countsOf(results);
      const text = examples.summaryText(counts);
      this.log('info', `examples: ${text}`);
      for (const r of results) if (r.status === 'failed') this.log('warn', `examples: ${r.file}: ${r.error}`);
      return { results, counts, text };
    } finally {
      this.examplesBusy = false;
    }
  }

  // ------------------------------------------------------------------------------------------ Browse registry

  /**
   * "Browse registry…": one page of the app list of the launcher's registry (`registryDefault`, fixed in loader/src/config.js: the page
   * cannot name another; hostlib/updates.js browseRegistry is the only network code). Called when the user opens the sheet, presses
   * Search, changes the sort or presses "Show more"; never by itself. `opts` = {q, sort, offset} from the page, re-checked there. The
   * request carries the search text, the sort and the page: no app id, no list of what is installed here (INV-G3); the page marks
   * the apps it already has from its own list. What comes back is untrusted text cut down to plain fields (a publisher's name and
   * description, the registry's publisher label): the page inserts it as text only. Installing from a card is `lib:registryFetch`,
   * with its review and permission sheet.
   * Returns {registry (normalized), insecure (plain http to another computer), q, sort, offset, total, next, items}.
   */
  async registryBrowse(opts) {
    const registry = normalizeRegistryUrl(this.registryDefault || '');
    if (!registry) throw new Error('This launcher has no registry to browse.');
    const o = opts && typeof opts === 'object' ? opts : {};
    const r = await this.updates.browseRegistry(registry, { q: o.q, sort: o.sort, offset: o.offset, deadlineMs: 10000 });
    return { registry: r.registry, insecure: isInsecureRemote(r.registry), q: r.q, sort: r.sort, offset: r.offset, total: r.total, next: r.next, items: r.items };
  }

  // ------------------------------------------------------------------------------------------ data

  /**
   * What an app's `permissions.host` asks for, joined with the user's catalog and (for an installed app) its grants:
   * [{cap, purpose, risk, control, grant, candidates}] (hostlib hostRequestSummary). An unreadable catalog file shows
   * as an empty catalog; the settings window reports the error.
   */
  hostSummary(manifest, appId) {
    if (!((manifest.permissions && manifest.permissions.host) || []).length) return [];
    let grants = null;
    if (appId) {
      try {
        grants = { host: this.store.loadHostGrants(appId) };
      } catch {
        grants = null;
      }
    }
    try {
      return hostRequestSummary(manifest, this.catalog, grants);
    } catch {
      return hostRequestSummary(manifest, null, grants);
    }
  }

  /**
   * What an app's `permissions.devices` asks for, with the user's choice for an installed app (SPEC 2.2, SPEC 7):
   * [{device, purpose, grant: {mode:'allow'} | null}]. Nothing is allowed until the user says so (the default is “Don't allow”).
   */
  deviceSummary(manifest, appId) {
    const asked = (manifest.permissions && manifest.permissions.devices) || [];
    if (!asked.length) return [];
    let grants = {};
    if (appId) {
      try {
        grants = this.store.loadDeviceGrants(appId);
      } catch {
        grants = {}; // shown as not allowed
      }
    }
    return asked.map((d) => ({ device: d.device, purpose: d.purpose || '', grant: grants[d.device] || null }));
  }

  /**
   * What an app's `permissions.network` asks for, with the user's grants for an installed app (SPEC 8.3, hostlib netRequestSummary):
   * [{host, ports, purpose, wildcard, insecure, odd, grant, allowed, allowedPorts}]. Nothing is allowed until the user says so.
   */
  netSummary(manifest, appId) {
    if (!((manifest.permissions && manifest.permissions.network) || []).length) return [];
    let grants = null;
    if (appId) {
      try {
        grants = { network: this.store.loadNetGrants(appId) };
      } catch {
        grants = null; // shown as not allowed
      }
    }
    return netperm.netRequestSummary(manifest, grants);
  }

  /**
   * INV-N4: where an app asks to read folders (or the screen) AND reach hosts, the loader says so in its own words:
   * {atRisk, message} for what the manifest asks ("could"), {active, activeMessage} for what the user's saved grants give ("can").
   * With no `appId` (the install review) only the request is judged.
   */
  riskOf(manifest, appId) {
    let grants = null;
    if (appId) {
      try {
        grants = this.store.loadGrants(appId);
      } catch {
        grants = null;
      }
    }
    const r = netperm.riskSummary(manifest, grants);
    return { atRisk: r.atRisk, message: r.message, active: r.active, activeMessage: r.activeMessage };
  }

  /** The `Resources` row (SPEC 2.2, 8): the app's recommendation, what this Mac allows, and the current size. */
  resourceSummaryOf(manifest, appId) {
    let grants = null;
    if (appId) {
      try {
        grants = this.store.loadGrants(appId);
      } catch {
        grants = null; // shown with the defaults
      }
    }
    return resperm.resourceSummary(manifest, grants, this.hostLimits());
  }

  describe(a) {
    if (a.error) return { id: a.id, broken: true, error: a.error, state: this.runner.state(a.id) };
    const m = a.manifest;
    let grants = {};
    try {
      grants = this.store.loadGrants(a.id).folders;
    } catch {
      /* shown as undecided */
    }
    const src = this.store.getSource(a.id);
    const dev = this.store.getDevSource(a.id);
    const wd = this.withdrawn.get(`${a.id}@${a.version}`) || null;
    return {
      source: src ? { registry: src.registry } : null,
      dev: dev ? { path: dev.path, folder: path.basename(dev.path) || dev.path } : null,
      policy: this.store.getPolicy(a.id),
      installedVersions: this.store.listVersions(a.id),
      withdrawnCurrent: wd,
      notice: this.notices.get(a.id) || null,
      checking: this.checking.has(a.id),
      id: a.id,
      name: m.name,
      version: m.version,
      publisher: m.publisher || '',
      description: m.description || '',
      runtime: m.runtime,
      runtimeInstalled: this.store.hasRuntime(m.runtime),
      packageId: a.packageId,
      icon: a.iconPath ? `vmapp-loader://icon/${a.id}?v=${a.packageId.slice(0, 8)}` : null,
      folders: m.permissions.folders.map((f) => ({
        name: f.name,
        access: f.access,
        purpose: f.purpose || '',
        grant: grants[f.name] === undefined ? undefined : grants[f.name],
      })),
      dialogs: m.permissions.dialogs,
      external: m.permissions.external,
      host: this.hostSummary(m, a.id),
      devices: this.deviceSummary(m, a.id),
      network: this.netSummary(m, a.id),
      risk: this.riskOf(m, a.id),
      resources: this.resourceSummaryOf(m, a.id),
      listening: !!this.devices && this.devices.listening(a.id), // a live audio track in the app's window right now (best effort)
      controlling: this.caps ? this.caps.active().filter((e) => e.appId === a.id).map((e) => ({ kind: e.kind, since: e.since })) : [],
      state: this.runner.state(a.id),
      error: this.runner.error(a.id),
      note: this.runner.note(a.id),
    };
  }

  list() {
    return this.store.list().map((a) => this.describe(a));
  }

  _app(id) {
    if (typeof id !== 'string') throw new Error('bad app id');
    const a = this.store.get(id);
    if (!a) throw new Error(`${id} is not installed`);
    return a;
  }

  _needStopped(id) {
    if (this.runner.isActive(id)) throw new Error('Stop the app first.');
  }

  sheetData(a) {
    const g = this.store.loadGrants(a.id);
    return {
      id: a.id,
      appName: a.manifest.name,
      dialogs: a.manifest.permissions.dialogs,
      external: a.manifest.permissions.external,
      askEveryTime: g.askEveryTime,
      folders: a.manifest.permissions.folders.map((f) => ({
        name: f.name,
        access: f.access,
        purpose: f.purpose || '',
        grant: g.folders[f.name] === undefined ? undefined : g.folders[f.name],
      })),
      // "Control of your computer" (SPEC 8.2): each requested capability with the user's current choice, and the
      // catalog entries a tool:* / mcp:* request can be mapped to
      host: this.hostSummary(a.manifest, a.id),
      // "Devices" (SPEC 7): the microphone, off until the user chooses “Allow while the app runs”
      devices: this.deviceSummary(a.manifest, a.id),
      // "Network" (SPEC 8.3): each requested host, off until the user allows it; `risk` is the loader's own warning (INV-N4)
      network: this.netSummary(a.manifest, a.id),
      risk: this.riskOf(a.manifest, a.id),
      // "Resources" (SPEC 2.2, 8): the VM's size is the user's choice; the manifest only recommends
      resources: this.resourceSummaryOf(a.manifest, a.id),
    };
  }

  /**
   * SPEC 8.2.1: first launch, after an update that adds folder requests, or "ask every time". An app that requests host
   * capabilities (SPEC 8.2) also gets the sheet at its first launch, when no grants have been saved yet; a capability the
   * user has not allowed stays off (INV-H2), so a later version that adds one is handled by the update flow's question.
   */
  needsSheet(a) {
    const folders = a.manifest.permissions.folders;
    const host = a.manifest.permissions.host || [];
    const devices = a.manifest.permissions.devices || [];
    const network = a.manifest.permissions.network || [];
    if (!folders.length && !host.length && !devices.length && !network.length) return false;
    const g = this.store.loadGrants(a.id);
    if (g.askEveryTime) return true;
    if (folders.some((f) => g.folders[f.name] === undefined)) return true;
    // (a grants file that holds only the VM size, chosen on the card, is not a decision: the sheet still comes first)
    return (host.length > 0 || devices.length > 0 || network.length > 0) && !this.store.hasDecided(a.id);
  }

  /**
   * Re-validates the user's network choices against the manifest: {<host>: {allow: boolean, ports?: number[]}}. Every entry the
   * manifest lists is saved: allowed (on all its ports, or on the ports the user kept) or declined (the default, “Don't allow”).
   * A host the manifest does not list is ignored; a port it does not list is refused (INV-N2: never wider than the request).
   * Returns the network grants to save.
   */
  normalizeNetChoices(a, choices) {
    const out = {};
    const given = choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {};
    for (const e of a.manifest.permissions.network || []) {
      const c = given[e.host];
      if (c === undefined || c === null) {
        out[e.host] = { allow: false };
        continue;
      }
      if (typeof c !== 'object' || Array.isArray(c) || typeof c.allow !== 'boolean') throw new Error(`“${e.host}”: the choice must be allow or don't allow`);
      if (!c.allow) {
        out[e.host] = { allow: false };
        continue;
      }
      if (c.ports !== undefined && (!Array.isArray(c.ports) || !c.ports.length)) throw new Error(`“${e.host}”: pick at least one port, or choose Don't allow`);
      out[e.host] = netperm.checkNetGrant(a.manifest, e.host, { allow: true, ports: c.ports });
    }
    return out;
  }

  /**
   * Checks the VM size the user chose (the sheet, the card): {cpus, memoryMiB} within what this Mac allows. A value below the
   * app's recommendation is fine (the sheet warned). `null` means “use the defaults” (forget the choice).
   */
  normalizeResources(choice) {
    if (choice === null) return null;
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('The resources are not valid.');
    if (choice.cpus === undefined || choice.memoryMiB === undefined) throw new Error('Choose the vCPUs and the memory.');
    return resperm.checkResources(choice, this.hostLimits()); // (refuses any other key)
  }

  /** What the live risk banner of the sheet needs: the loader's sentence for the choices on screen (INV-N4). */
  riskPreview(a, preview) {
    const p = preview && typeof preview === 'object' && !Array.isArray(preview) ? preview : {};
    const grants = { folders: {}, host: {}, network: {} };
    const folders = p.folders && typeof p.folders === 'object' ? p.folders : {};
    for (const req of a.manifest.permissions.folders) {
      const c = folders[req.name];
      if (c && typeof c === 'object' && ALLOWED_ACCESS[req.access].includes(c.access)) grants.folders[req.name] = { path: String(c.path || '/'), access: c.access };
    }
    const host = p.host && typeof p.host === 'object' ? p.host : {};
    if (host.screen && typeof host.screen === 'object' && ['ask', 'session'].includes(host.screen.mode)) grants.host.screen = { mode: host.screen.mode };
    const network = p.network && typeof p.network === 'object' ? p.network : {};
    for (const e of a.manifest.permissions.network || []) {
      const c = network[e.host];
      if (c && c.allow === true) grants.network[e.host] = { allow: true };
    }
    const r = netperm.riskSummary(a.manifest, grants);
    return { atRisk: r.atRisk, message: r.message, active: r.active, activeMessage: r.activeMessage };
  }

  /**
   * Re-validates the user's device choices against the manifest: {<device>: {mode:'allow'}} (a missing device, or mode 'none',
   * is “Don't allow”). Only a device the manifest asks for can be allowed, and only with the one mode the sheet offers.
   * Returns the device grants to save.
   */
  normalizeDeviceChoices(a, choices) {
    const out = {};
    const given = choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {};
    for (const req of a.manifest.permissions.devices || []) {
      const c = given[req.device];
      if (!c || typeof c !== 'object' || c.mode === 'none' || c.mode === undefined) continue;
      if (c.mode !== 'allow') throw new Error(`“${req.device}”: the mode “${String(c.mode).slice(0, 20)}” cannot be set here`);
      out[req.device] = { mode: 'allow' };
    }
    return out;
  }

  /**
   * Re-validates the user's host choices against the manifest and the catalog: {<cap>: {mode:'ask'|'session', tools?, servers?}}
   * (a missing cap, or mode 'none', is "Don't allow"). Returns the host grants to save.
   */
  normalizeHostChoices(a, choices) {
    const out = {};
    const given = choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {};
    const current = this.store.loadHostGrants(a.id);
    for (const req of a.manifest.permissions.host || []) {
      const c = given[req.cap];
      if (!c || typeof c !== 'object' || c.mode === 'none' || c.mode === undefined) continue;
      // `always` can only be kept, never newly chosen here (it is set with the vmapp command; never for input or shell tools)
      const keepsAlways = c.mode === 'always' && current[req.cap] && current[req.cap].mode === 'always';
      if (!SHEET_HOST_MODES.includes(c.mode) && !keepsAlways) throw new Error(`“${req.cap}”: the mode “${String(c.mode).slice(0, 20)}” cannot be set here`);
      // the GPU (SPEC 8.6) is a stream of requests: nobody can be asked about each one, so it is allowed while the app runs, or not at all
      if (req.cap === 'gpu' && c.mode !== 'session') throw new Error('“gpu”: the GPU can only be allowed while the app runs, or not at all');
      const spec = { mode: c.mode };
      if (req.cap === 'tool:*' || req.cap === 'mcp:*') {
        const key = req.cap === 'tool:*' ? 'tools' : 'servers';
        const list = Array.isArray(c[key]) ? c[key].filter((x) => typeof x === 'string') : [];
        if (!list.length) continue; // nothing picked: nothing is allowed
        spec[key] = list;
      }
      out[req.cap] = checkHostGrant(a.manifest, this.catalog, req.cap, spec);
    }
    return out;
  }

  /**
   * Saves what the permission sheet chose: the folders, "ask every time", and (when given) the host capabilities, the devices,
   * the network (`extra.network`) and the VM size (`extra.resources`, only when the user changed it). Everything is validated
   * before anything is saved.
   */
  _saveSheet(a, choices, askEveryTime, hostChoices, deviceChoices, extra) {
    const x = extra && typeof extra === 'object' ? extra : {};
    const folders = this.normalizeChoices(a, choices);
    const host = hostChoices === undefined ? undefined : this.normalizeHostChoices(a, hostChoices);
    const devices = deviceChoices === undefined ? undefined : this.normalizeDeviceChoices(a, deviceChoices);
    const network = x.network === undefined ? undefined : this.normalizeNetChoices(a, x.network);
    const size = x.resources === undefined ? undefined : this.normalizeResources(x.resources);
    this.store.saveGrants(a.id, { folders, askEveryTime: !!askEveryTime });
    if (host !== undefined) this.store.saveHostGrants(a.id, host);
    if (devices !== undefined) this.store.saveDeviceGrants(a.id, devices);
    if (network !== undefined) this.store.saveNetGrants(a.id, network);
    if (size !== undefined) this.store.saveResources(a.id, size);
  }

  /**
   * The network section changed for an app that may be running (the card's “Network…”): saves the choices and, if the VM is up,
   * applies them at once (`syncNetwork`: a revoked host's open connections are closed). Returns {allowed, revoked} (empty if stopped).
   */
  async saveNetwork(a, netChoices) {
    const state = this.runner.state(a.id);
    if (state === 'starting' || state === 'stopping') throw new Error(`The app is ${state === 'starting' ? 'starting' : 'stopping'}. Try again in a moment.`);
    const network = this.normalizeNetChoices(a, netChoices);
    this.store.saveNetGrants(a.id, network);
    let synced = { allowed: [], revoked: [] };
    const session = state === 'running' ? this.runner.sessionOf(a.id) : null;
    if (session) {
      try {
        synced = await session.syncNetwork();
      } catch (e) {
        this.notify();
        throw new Error(`Saved, but the running app could not be updated (${e.message}). Stop it and start it again to apply the change.`);
      }
    }
    this.notify();
    return synced;
  }

  /**
   * The card's “GPU…” (SPEC 8.6): like the network, the GPU can be switched off while the app runs. `mode` is 'session' (Allow
   * while the app runs) or 'none' (Don't allow). Taking it away stops the app's GPU server and closes its tunnels at once; allowing
   * it for an app that is running takes effect at its next launch (its VM was started without the service). Returns
   * {gpu: 'allowed'|'revoked', running, appliesNow}.
   */
  async saveGpu(a, mode) {
    if (!(a.manifest.permissions.host || []).some((h) => h.cap === 'gpu')) throw new Error('This app does not ask to use the GPU.');
    if (mode !== 'session' && mode !== 'none') throw new Error('The GPU can only be allowed while the app runs, or not at all.');
    const state = this.runner.state(a.id);
    if (state === 'starting' || state === 'stopping') throw new Error(`The app is ${state === 'starting' ? 'starting' : 'stopping'}. Try again in a moment.`);
    if (mode === 'session') this.store.setHostGrant(a.id, 'gpu', checkHostGrant(a.manifest, this.catalog, 'gpu', { mode: 'session' }));
    else this.store.setHostGrant(a.id, 'gpu', null);
    let appliesNow = false;
    const session = state === 'running' ? this.runner.sessionOf(a.id) : null;
    if (mode === 'none' && session && typeof session.revokeGpu === 'function') {
      try {
        appliesNow = await session.revokeGpu('revoked');
      } catch (e) {
        this.notify();
        throw new Error(`Saved, but the running app could not be updated (${e.message}). It loses the GPU within a second anyway, or stop it.`);
      }
    }
    this.notify();
    return { gpu: mode === 'session' ? 'allowed' : 'revoked', running: state === 'running', appliesNow };
  }

  /** Re-validates the user's choices against the manifest and returns the grants to save. */
  normalizeChoices(a, choices) {
    const out = {};
    const given = choices && typeof choices === 'object' ? choices : {};
    for (const req of a.manifest.permissions.folders) {
      const c = given[req.name];
      if (!c) {
        out[req.name] = null;
        continue;
      }
      if (typeof c.path !== 'string' || !path.isAbsolute(c.path)) throw new Error(`folder "${req.name}": the path is not absolute`);
      if (!ALLOWED_ACCESS[req.access].includes(c.access)) throw new Error(`folder "${req.name}": access "${c.access}" is wider than requested`);
      let st;
      try {
        st = fs.statSync(c.path);
      } catch {
        throw new Error(`folder "${req.name}": ${c.path} does not exist`);
      }
      if (!st.isDirectory()) throw new Error(`folder "${req.name}": ${c.path} is not a folder`);
      // the sheet already asked about broad folders; whatever the renderer sends, the disk root and our own data stay refused
      const verdict = classifyFolder(c.path, { dataDir: this.store.home });
      if (verdict.level === 'refuse') throw new Error(`folder "${req.name}": ${verdict.reason}`);
      out[req.name] = { path: c.path, access: c.access };
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ launching

  /** Kicks off a launch without waiting for the VM; errors land on the card. */
  _startAsync(id) {
    this.runner.launch(id).catch((e) => this.log('error', `launch ${id}: ${e.message}`));
  }

  /**
   * Launch. For an app installed from a registry whose update choice is not "Stay on this version", the registry is
   * asked first (5 s, INV-G3: the user chose this). Results:
   *   { started, updated? }   launched (maybe a newly installed version; offline/errors leave an inline notice)
   *   { sheet }               the permission sheet must be shown first
   *   { askMore }             the new version asks for more permissions: the user decides (token to apply or discard)
   * opts.skipUpdate: launch what is installed without asking the registry (the user kept the current version).
   */
  async launch(id, opts = {}) {
    this._app(id);
    if (this.runner.isActive(id)) throw new Error('the app is already running');
    if (this.checking.has(id)) throw new Error('Still checking for updates.');
    this.notices.delete(id);
    let updated = null;
    // a developer build runs what the developer built: no registry is asked, whatever the update choice is
    if (!(opts && opts.skipUpdate === true) && !this.store.getDevSource(id) && this.store.getSource(id) && this.store.getPolicy(id) !== 'manual') {
      this.checking.add(id);
      this.notify();
      try {
        const r = await this._launchCheck(id);
        if (r.askMore) return { askMore: r.askMore };
        updated = r.updated || null;
      } finally {
        this.checking.delete(id);
        this.notify();
      }
    }
    const a = this._app(id); // may be a new version now
    if (this.testGrants && Object.prototype.hasOwnProperty.call(this.testGrants, id)) {
      // dev/test hook: pre-seeded grants, no sheet
      const grants = this.normalizeChoices(a, this.testGrants[id]);
      this.store.saveGrants(id, { folders: grants, askEveryTime: false });
    } else if (this.needsSheet(a)) {
      return { sheet: this.sheetData(a), updated };
    }
    this._startAsync(id);
    return { started: true, updated };
  }

  _notice(id, text, kind = 'info') {
    this.notices.set(id, { text, kind });
    this.notify();
  }

  _noteWithdrawn(id, res) {
    const key = `${id}@${res.current}`;
    if (res.withdrawnCurrent) this.withdrawn.set(key, res.withdrawnCurrent);
    else if (!res.offline && !res.error) this.withdrawn.delete(key);
    this.notify();
  }

  /**
   * THE install path of a .vmapp file: "Install from file…", a registry install, an update and "Load examples" all end here.
   * Verifies the package again (the file may have changed since it was reviewed), refuses to replace a running app, then
   * Store.install (which verifies the bytes it installs, checks the runtime and the downgrade rule). Grants are never written:
   * what an app may reach is decided at its first launch. `rec` = {id?, force?, source?, downgrade?} of a staged review.
   * Returns Store.install's {id, version, packageId, previous, dir}.
   */
  _installFile(file, rec = {}) {
    const p = pkg.read(file);
    this._needStopped(p.manifest.id);
    if (rec.id && p.manifest.id !== rec.id) throw new Error(`Expected ${rec.id} but the package is ${p.manifest.id}.`);
    const r = this.store.install(file, { force: !!rec.force, source: rec.source || undefined });
    if (rec.downgrade && this.store.getPolicy(r.id) !== 'manual') this.store.setPolicy(r.id, 'manual'); // never bounce back by itself
    this.runner.uiContexts.delete(r.id);
    this.notices.delete(r.id);
    this.notify();
    return r;
  }

  _dropInstalls() {
    for (const rec of this.installs.values()) if (rec.temp && rec.file) this.updates.discard(rec.file);
    this.installs.clear();
  }

  _stage(rec) {
    this._dropInstalls(); // only the latest review can be confirmed
    const token = crypto.randomBytes(8).toString('hex');
    this.installs.set(token, rec);
    return token;
  }

  _stageUpdate(id, prepared, extra = {}) {
    return this._stage(Object.assign({ id, version: prepared.version, file: prepared.installed ? null : prepared.file, temp: !prepared.installed, source: prepared.installed ? null : { registry: prepared.registry }, useVersion: !!prepared.installed }, extra));
  }

  /** The check at launch: installs a harmless update by itself, hands a permission-growing one to the user. */
  async _launchCheck(id) {
    const res = await this.updates.check(id, { download: true });
    this._noteWithdrawn(id, res);
    const cur = res.current;
    if (res.offline) {
      this._notice(id, `Could not check for updates (the registry is not reachable). Launched version ${cur}.`, 'warn');
      return {};
    }
    if (!res.candidate) {
      if (res.error) this._notice(id, `Could not check for updates: ${res.error} Launched version ${cur}.`, 'warn');
      return {};
    }
    if (res.error || !res.prepared) {
      this._notice(id, `Could not get version ${res.candidate}: ${res.error || 'unknown error'} Launched version ${cur}.`, 'warn');
      return {};
    }
    if (res.permissionDiff.any) {
      const token = this._stageUpdate(id, res.prepared);
      return { askMore: { token, id, appName: this.store.get(id).manifest.name, current: cur, candidate: res.candidate, diff: res.permissionDiff, registry: res.registry, review: this._reviewOf(res.prepared) } };
    }
    try {
      await this.updates.apply(id, res.candidate, { prepared: res.prepared });
    } catch (e) {
      if (res.prepared.file) this.updates.discard(res.prepared.file);
      this._notice(id, `Could not install version ${res.candidate}: ${e.message} Launched version ${cur}.`, 'warn');
      return {};
    }
    this.runner.uiContexts.delete(id);
    this._notice(id, `Updated to ${res.candidate} (was ${cur}).`, 'info');
    return { updated: res.candidate };
  }

  /** What the install review shows for something fetched or already installed. */
  _review(manifest, packageId, sizes, extra = {}) {
    const prev = this.store.currentVersion(manifest.id);
    let kind = 'new';
    if (prev) {
      const c = compareVersions(manifest.version, prev);
      kind = c > 0 ? 'update' : c === 0 ? 'same' : 'downgrade';
    }
    return Object.assign(
      {
        manifest,
        packageId,
        sizes,
        hasIcon: false,
        kind,
        previous: prev,
        runtimeInstalled: this.store.hasRuntime(manifest.runtime),
        running: this.runner.isActive(manifest.id),
        // INV-H6: the review says plainly when the app asks to control the computer
        host: this.hostSummary(manifest, null),
        // the same for devices: installing allows none of it
        devices: this.deviceSummary(manifest, null),
        // and for the hosts it wants to reach (SPEC 8.3, INV-N4): listed with their purpose; `risk.message` says it in words
        // when the app could also read folders or the screen
        network: this.netSummary(manifest, null),
        risk: this.riskOf(manifest, null),
        // the VM size is chosen at the first launch; the manifest only recommends
        resources: { recommended: resperm.recommendedOf(manifest), limits: this.hostLimits() },
      },
      extra,
    );
  }

  _reviewOf(prepared, extra = {}) {
    const src = prepared.installed ? this.store.getSource(prepared.manifest.id) : { registry: prepared.registry };
    const registryInfo = src ? { registry: src.registry, insecure: isInsecureRemote(src.registry) } : null;
    if (prepared.installed) {
      const dir = this.store.appDir(prepared.manifest.id, prepared.version);
      const manifest = prepared.manifest;
      const fileSize = (rel) => {
        try {
          return fs.statSync(path.join(dir, ...rel.split('/'))).size;
        } catch {
          return 0;
        }
      };
      const coreName = pkg.coreEntryName(manifest);
      const core = fileSize(coreName);
      const ui = Object.keys(manifest.files).filter((r) => r !== coreName && r !== 'icon.png').reduce((n, r) => n + fileSize(r), 0);
      const packageId = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'vmapp.json'))).digest('hex');
      return this._review(manifest, packageId, { package: 'already installed', ui: kib(ui), core: kib(core) }, Object.assign({ source: registryInfo, switchOnly: true }, extra));
    }
    const p = pkg.read(prepared.file); // sizes; also verifies once more
    return this._review(p.manifest, p.packageId, { package: kib(p.size), ui: kib(p.uiBytes), core: kib(p.coreBytes) }, Object.assign({ hasIcon: !!p.hasIcon, source: registryInfo }, extra));
  }

  // ------------------------------------------------------------------------------------------ developer builds

  /**
   * "Run project folder…" and "Rebuild & run": pack the folder (hostlib/package.js; its messages are precise and are shown
   * as they are), install the result as a developer build (force: the developer's folder wins over any installed version,
   * including a higher one) and launch it. A running copy is stopped first. `expectId`: the card the rebuild came from;
   * a folder whose id changed is refused rather than installed as a different app.
   * Returns { id, name, version, packageId, previous, launch } where `launch` is what launch() returns (maybe the sheet).
   */
  async buildAndRun(folder, expectId) {
    if (this.devBusy) throw new Error('Another build is still in progress.');
    this.devBusy = true;
    const tmpDir = path.join(this.store.home, 'tmp');
    let scratch = null;
    let devFile = null;
    try {
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('The project folder is not an absolute path.');
      let st;
      try {
        st = fs.statSync(folder);
      } catch {
        throw new Error(`The project folder ${folder} does not exist.`);
      }
      if (!st.isDirectory()) throw new Error(`${folder} is not a folder.`);
      if (!fs.existsSync(path.join(folder, 'vmapp.json'))) {
        throw new Error(`${folder} is not a D9010 VmApp project: there is no vmapp.json in it. A project has vmapp.json, a UI folder (ui/) and core/. Make one with “vmapp new”.`);
      }
      fs.mkdirSync(tmpDir, { recursive: true });
      scratch = path.join(tmpDir, `dev-${crypto.randomBytes(6).toString('hex')}.vmapp`);
      const packed = pkg.pack(folder, scratch); // throws the precise reason (missing ui/core folders, bad manifest, ...)
      const m = packed.manifest;
      if (expectId && m.id !== expectId) throw new Error(`The project now has the id ${m.id}, but this card is ${expectId}. Use “Run project folder…” to run it as its own app.`);
      devFile = path.join(tmpDir, `${m.id}-dev.vmapp`);
      fs.renameSync(scratch, devFile);
      scratch = null;
      if (this.runner.isActive(m.id)) await this.runner.stop(m.id);
      const r = this.store.install(devFile, { force: true, dev: { path: folder } });
      this.runner.uiContexts.delete(r.id);
      this.notices.delete(r.id);
      this.notify();
      this.log('info', `developer build ${r.id} ${r.version} from ${folder}`);
      const launch = await this.launch(r.id, { skipUpdate: true });
      return { id: r.id, name: m.name, version: r.version, packageId: r.packageId, previous: r.previous, launch };
    } finally {
      for (const f of [scratch, devFile]) if (f) fs.rmSync(f, { force: true });
      this.devBusy = false;
    }
  }

  // ------------------------------------------------------------------------------------------ publishing

  /** What the Publish… sheet starts from (and refreshes when the registry address changes). Sends no network request. */
  publishInfo(id, registryText) {
    const a = this._app(id);
    let registry;
    if (registryText === undefined || registryText === null || registryText === '') {
      const src = this.store.getSource(id);
      registry = (src && src.registry) || publishRegistriesFor(this.store.home, id)[0] || normalizeRegistryUrl(this.registryDefault) || '';
    } else {
      registry = normalizeRegistryUrl(String(registryText)) || '';
    }
    let token = null;
    try {
      token = registry ? getPublishToken(this.store.home, registry, id) : null;
    } catch (e) {
      this.log('warn', `publish tokens: ${e.message}`);
    }
    const dev = this.store.getDevSource(id);
    return {
      id,
      name: a.manifest.name,
      version: a.version,
      registry,
      valid: !!registry,
      insecure: registry ? isInsecureRemote(registry) : false,
      token,
      hasPackage: !!this.store.getPackageFile(id),
      dev: dev ? { path: dev.path, folder: path.basename(dev.path) || dev.path } : null,
    };
  }

  /** Uploads the installed package (the file the store kept) to the registry the user typed. The user pressed Publish. */
  async publish(id, o) {
    const a = this._app(id);
    const opts = o && typeof o === 'object' ? o : {};
    const file = this.store.getPackageFile(id);
    if (!file) {
      throw new Error('The package file of this installation was not kept (it was installed by an older loader). Install it again from its .vmapp file, or use “Rebuild & run” on a developer build, then publish.');
    }
    const registry = normalizeRegistryUrl(String(opts.registry || ''));
    if (!registry) throw new Error('Enter the registry address (an http or https address).');
    const token = typeof opts.token === 'string' ? opts.token.trim() : '';
    const p = opts.publisher && typeof opts.publisher === 'object' ? opts.publisher : {};
    const publisher = {};
    for (const k of ['name', 'company', 'email', 'url']) if (typeof p[k] === 'string') publisher[k] = p[k].slice(0, 200);
    this.log('info', `publishing ${id} ${a.version} to ${registry}${token ? ' (with an owner token)' : ' (first publish)'}`);
    const res = await publishPackage(file, { registry, token, publisher });
    // keep the owner token before anything else can go wrong: the registry shows it once
    const out = { id: res.id, version: res.version, packageId: res.packageId, registry, ownerToken: res.ownerToken || null, tokensFile: publishTokensFile(this.store.home), tokenSaved: false, tokenSaveError: null, publisherLabel: res.publisher && res.publisher.label ? String(res.publisher.label) : null, insecure: isInsecureRemote(registry) };
    try {
      if (res.ownerToken) {
        savePublishToken(this.store.home, registry, res.id, res.ownerToken);
        out.tokenSaved = true;
      } else if (token && getPublishToken(this.store.home, registry, res.id) !== token) {
        savePublishToken(this.store.home, registry, res.id, token); // a token the user pasted worked: remember it for the next version
        out.tokenSaved = true;
      }
    } catch (e) {
      out.tokenSaveError = e.message;
      this.log('error', `could not save the owner token: ${e.message}`);
    }
    let page = `${registry}/apps/${res.id}`;
    try {
      const u = new URL(registry + (res.url && res.url.startsWith('/') ? res.url : `/apps/${res.id}`));
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === new URL(registry).origin) page = u.href;
    } catch {
      /* keep the default */
    }
    this.publishedPages.add(page);
    out.pageUrl = page;
    this.log('info', `published ${res.id} ${res.version} to ${registry}`);
    return out;
  }

  // ------------------------------------------------------------------------------------------ IPC

  _register() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          if (this.senders.get(event.sender.id) !== 'library' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
          const parent = BrowserWindow.fromWebContents(event.sender);
          return { ok: true, result: await fn(parent, ...args) };
        } catch (e) {
          this.log('warn', `${channel}: ${e.message}`);
          return { ok: false, error: e.message };
        }
      });

    handle('lib:list', () => this.list());

    handle('lib:launch', (parent, id, opts) => this.launch(id, { skipUpdate: !!(opts && opts.skipUpdate === true) }));

    handle('lib:sheet', (parent, id) => this.sheetData(this._app(id)));

    handle('lib:launchWithGrants', (parent, id, choices, askEveryTime, hostChoices, deviceChoices, extra) => {
      const a = this._app(id);
      this._needStopped(id);
      this._saveSheet(a, choices, askEveryTime, hostChoices, deviceChoices, extra);
      this._startAsync(id);
      return { started: true };
    });

    handle('lib:savePermissions', (parent, id, choices, askEveryTime, hostChoices, deviceChoices, extra) => {
      const a = this._app(id);
      this._needStopped(id);
      this._saveSheet(a, choices, askEveryTime, hostChoices, deviceChoices, extra);
      this.notify();
      return {};
    });

    // ---- network (SPEC 8.3): a changed grant applies to the running app at once ----
    handle('lib:saveNetwork', (parent, id, netChoices) => this.saveNetwork(this._app(id), netChoices));

    // ---- the GPU (SPEC 8.6): switched off while the app runs applies at once ----
    handle('lib:saveGpu', (parent, id, mode) => this.saveGpu(this._app(id), mode));

    // the sheet's live warning: what the choices on screen would give the app (the loader's own words, INV-N4)
    handle('lib:riskPreview', (parent, id, preview) => this.riskPreview(this._app(id), preview));

    // ---- the VM's size (SPEC 2.2, 8): the user chooses, before launch ----
    handle('lib:setResources', (parent, id, choice) => {
      const a = this._app(id);
      this._needStopped(id); // a VM cannot change size while it runs
      this.store.saveResources(id, this.normalizeResources(choice === undefined ? null : choice));
      return this.resourceSummaryOf(a.manifest, id); // no notify: the card updates its own row, so the control keeps the focus
    });

    // ---- live activity: the running apps and what each can reach (the “Activity” section; Stop is lib:stop) ----
    handle('lib:activity', () => this.activityState());

    handle('lib:showData', (parent, id) => {
      this._app(id); // an installed app's own data folder, named by the loader
      this.dialogs.showInFolder(this.store.dataDir(id));
      return {};
    });

    // ---- host capabilities: what is active, Stop, the settings window ----
    handle('lib:control', () => (this.caps ? this.caps.active().map((e) => ({ kind: e.kind, appId: e.appId, appName: e.appName, since: e.since })) : []));

    handle('lib:stopControl', (parent, id) => {
      if (typeof id !== 'string') throw new Error('bad app id');
      if (this.caps) this.caps.stopControl(id, 'user');
      return {};
    });

    handle('lib:stopAllControl', () => {
      if (this.caps) this.caps.stopAll('user');
      return {};
    });

    handle('lib:openSettings', () => {
      this.openSettings();
      return {};
    });

    handle('lib:chooseFolder', async (parent, id, name) => {
      const a = this._app(id);
      const req = a.manifest.permissions.folders.find((f) => f.name === name);
      if (!req) throw new Error(`the app does not request a folder "${name}"`);
      const p = await this.dialogs.pickGrantFolder(parent, { name: a.manifest.name }, req);
      return p ? { path: p } : { canceled: true };
    });

    handle('lib:stop', async (parent, id) => {
      this._app(id);
      await this.runner.stop(id);
      return {};
    });

    handle('lib:inspect', (parent, id, tab) => {
      if (id !== undefined && id !== null && typeof id !== 'string') throw new Error('bad app id');
      this.inspector.show(id || undefined, ['traffic', 'log', 'files'].includes(tab) ? tab : undefined);
      return {};
    });

    handle('lib:uninstall', async (parent, id, purge) => {
      if (typeof id !== 'string') throw new Error('bad app id');
      this._needStopped(id);
      this.store.uninstall(id, { purge: !!purge });
      if (purge) await this._clearPartition(id);
      this.runner.uiContexts.delete(id);
      this.notify();
      return {};
    });

    handle('lib:reset', async (parent, id) => {
      this._app(id);
      this._needStopped(id);
      this.store.resetApp(id);
      await this._clearPartition(id); // the UI's own storage (localStorage, IndexedDB, ...) is app data too
      this.notify();
      return {};
    });

    // ---- install ----
    handle('lib:pickPackage', async (parent) => {
      const file = await this.dialogs.pickPackage(parent);
      if (!file) return { canceled: true };
      const p = pkg.read(file); // throws a precise error for an invalid package
      const review = this._review(p.manifest, p.packageId, { package: kib(p.size), ui: kib(p.uiBytes), core: kib(p.coreBytes) }, { hasIcon: !!p.hasIcon, source: null });
      const token = this._stage({ file, temp: false, source: null });
      return { token, review };
    });

    handle('lib:installPackage', (parent, token) => {
      const rec = this.installs.get(token);
      if (!rec) throw new Error('This install review is no longer valid. Choose the package again.');
      this.installs.delete(token);
      if (rec.useVersion) {
        // the version is already on this Mac: switch to it (files are re-checked by the store)
        this._needStopped(rec.id);
        const r = this.store.useVersion(rec.id, rec.version);
        this.runner.uiContexts.delete(rec.id);
        this.notify();
        return { id: rec.id, version: r.version, packageId: '' };
      }
      try {
        const r = this._installFile(rec.file, rec);
        return { id: r.id, version: r.version, packageId: r.packageId };
      } finally {
        if (rec.temp && rec.file) this.updates.discard(rec.file);
      }
    });

    handle('lib:cancelInstall', () => {
      this._dropInstalls();
      return {};
    });

    // ---- Load examples: the sample apps that came with the loader (src/examples.js); the page names them by file name only ----
    handle('lib:examplesInfo', () => this.examplesInfo());
    handle('lib:examplesList', () => this.examplesList());
    handle('lib:examplesInstall', (parent, names) => this.installExamples(names));

    // ---- developer: run a project folder, rebuild it; publish ----
    handle('lib:runFolder', async (parent) => {
      const folder = await this.dialogs.pickProjectFolder(parent);
      if (!folder) return { canceled: true };
      return this.buildAndRun(folder);
    });

    handle('lib:rebuildDev', async (parent, id) => {
      this._app(id);
      const dev = this.store.getDevSource(id);
      if (!dev) throw new Error('This app was not built from a project folder.');
      if (!fs.existsSync(dev.path)) throw new Error(`The project folder ${dev.path} no longer exists. Use “Run project folder…” to choose it again.`);
      return this.buildAndRun(dev.path, id);
    });

    handle('lib:publishInfo', (parent, id, registry) => this.publishInfo(id, registry));

    handle('lib:publish', (parent, id, o) => this.publish(id, o));

    handle('lib:openPage', async (parent, url) => {
      if (typeof url !== 'string' || !this.publishedPages.has(url)) throw new Error('That address is not one this loader just published to.');
      return { opened: await this.dialogs.openPublishedPage(parent, url) };
    });

    handle('lib:copyText', (parent, text) => {
      if (typeof text !== 'string' || !text || text.length > 4096) throw new Error('nothing to copy');
      this.dialogs.copyToClipboard(text);
      return {};
    });

    // ---- registry: install, update choice, versions (SPEC 8.1). Each handler is something the user clicked. ----
    handle('lib:registryDefault', () => ({ registry: this.registryDefault }));

    handle('lib:registryBrowse', (parent, opts) => this.registryBrowse(opts));

    handle('lib:registryFetch', async (parent, registryText, appText) => {
      const ref = parseAppRef(String(appText), String(registryText));
      const versions = await this.updates.listRegistryVersions(ref.id, { registry: ref.registry, deadlineMs: 10000 });
      const wanted = newestInstallable(versions);
      if (!wanted) throw new Error(versions.length ? `Every version of ${ref.id} has been withdrawn by its publisher. Install a specific version from its Versions list if you still want one.` : `${ref.id} has no versions in this registry.`);
      const prepared = await this.updates.fetchAndVerify(ref.id, wanted, { registry: ref.registry });
      const review = this._reviewOf(prepared);
      const token = this._stage({ id: ref.id, version: prepared.version, file: prepared.file, temp: true, source: { registry: prepared.registry } });
      return { token, review };
    });

    handle('lib:setPolicy', (parent, id, choice) => {
      this._app(id);
      if (!this.store.getSource(id)) throw new Error('This app was installed from a file, so there is no registry to ask for updates.');
      this.store.setPolicy(id, choice);
      this.notify();
      return {};
    });

    handle('lib:versions', (parent, id) => {
      const a = this._app(id);
      const current = this.store.currentVersion(id);
      return {
        id,
        name: a.manifest.name,
        current,
        policy: this.store.getPolicy(id),
        source: this.store.getSource(id),
        running: this.runner.isActive(id),
        installed: this.store.listVersions(id).map((v) => ({ version: v, current: v === current, older: compareVersions(v, current) < 0, withdrawn: this.withdrawn.get(`${id}@${v}`) || null })).reverse(),
      };
    });

    handle('lib:registryVersions', async (parent, id) => {
      this._app(id);
      const src = this.store.getSource(id);
      if (!src) throw new Error('This app was installed from a file, so there is no registry to ask.');
      const list = await this.updates.listRegistryVersions(id, { registry: src.registry, deadlineMs: 10000 });
      const installed = new Set(this.store.listVersions(id));
      const current = this.store.currentVersion(id);
      for (const v of list) {
        if (v.withdrawn) this.withdrawn.set(`${id}@${v.version}`, v.withdrawn);
        else this.withdrawn.delete(`${id}@${v.version}`);
      }
      this.notify();
      return { registry: src.registry, versions: list.map((v) => ({ version: v.version, publishedAt: v.publishedAt, withdrawn: v.withdrawn, installed: installed.has(v.version), current: v.version === current, older: compareVersions(v.version, current) < 0 })).reverse() };
    });

    handle('lib:useVersion', (parent, id, version) => {
      const a = this._app(id);
      this._needStopped(id);
      if (typeof version !== 'string') throw new Error('bad version');
      const was = a.version;
      const r = this.store.useVersion(id, version);
      let policyChanged = false;
      const downgraded = compareVersions(version, was) < 0;
      if (downgraded && this.store.getSource(id) && this.store.getPolicy(id) !== 'manual') {
        this.store.setPolicy(id, 'manual'); // going back is a decision; an update choice must not undo it at the next launch
        policyChanged = true;
      }
      this.runner.uiContexts.delete(id);
      this.notices.delete(id);
      this.notify();
      return { version: r.version, previous: was, downgraded, policyChanged };
    });

    handle('lib:prepareRegistryVersion', async (parent, id, version) => {
      const a = this._app(id);
      this._needStopped(id);
      const src = this.store.getSource(id);
      if (!src) throw new Error('This app was installed from a file, so there is no registry to ask.');
      const prepared = await this.updates.fetchAndVerify(id, String(version), { registry: src.registry });
      const downgrade = compareVersions(prepared.version, a.version) < 0;
      const review = this._reviewOf(prepared, { explicit: true });
      const token = this._stage({ id, version: prepared.version, file: prepared.file, temp: true, source: { registry: prepared.registry }, force: downgrade, downgrade });
      return { token, review };
    });

    // "Check for updates": asks, and on a candidate downloads and verifies it so the user sees exactly what it asks for
    handle('lib:checkUpdates', async (parent, id) => {
      const a = this._app(id);
      if (!this.store.getSource(id)) throw new Error('This app was installed from a file, so there is no registry to ask.');
      const res = await this.updates.check(id, { download: true });
      this._noteWithdrawn(id, res);
      const out = { id, appName: a.manifest.name, current: res.current, candidate: res.candidate, latest: res.latest, policy: res.policy, offline: res.offline, error: res.error, withdrawnCurrent: res.withdrawnCurrent, registry: res.registry };
      if (res.candidate && res.prepared) {
        out.diff = res.permissionDiff;
        out.review = this._reviewOf(res.prepared);
        out.token = this._stageUpdate(id, res.prepared);
      }
      return out;
    });
  }

  async _clearPartition(id) {
    try {
      const ses = electronSession.fromPartition(partitionOf(id));
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (e) {
      this.log('warn', `clearing storage of ${id}: ${e.message}`);
    }
  }
}

module.exports = { Library };
