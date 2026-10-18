'use strict';
// The preload of the loader's own windows (library and inspector): a narrow, page-specific API over IPC.
// The main process checks the sender again for every call; this file only decides what each page can name.

const { contextBridge, ipcRenderer } = require('electron');

const page = (location.pathname || '').replace(/^\//, '');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.result;
  throw new Error((r && r.error) || 'failed');
}

function listen(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

if (page === 'library.html') {
  contextBridge.exposeInMainWorld('loader', {
    list: () => call('lib:list'),
    launch: (id, opts) => call('lib:launch', id, opts && opts.skipUpdate === true ? { skipUpdate: true } : undefined),
    sheet: (id) => call('lib:sheet', id),
    // `extra` = {network?: {<host>: {allow, ports?}}, resources?: {cpus, memoryMiB} | null}: the sheet's network section and Resources row
    launchWithGrants: (id, choices, askEveryTime, hostChoices, deviceChoices, extra) => call('lib:launchWithGrants', id, choices, askEveryTime, hostChoices, deviceChoices, extra),
    savePermissions: (id, choices, askEveryTime, hostChoices, deviceChoices, extra) => call('lib:savePermissions', id, choices, askEveryTime, hostChoices, deviceChoices, extra),
    // network (SPEC 8.3): save the choices and, if the app is running, apply them to it at once
    saveNetwork: (id, netChoices) => call('lib:saveNetwork', id, netChoices),
    // the GPU (SPEC 8.6): 'session' (Allow while the app runs) or 'none' (Don't allow); taking it away applies to a running app at once
    saveGpu: (id, mode) => call('lib:saveGpu', id, mode === 'session' ? 'session' : 'none'),
    // the sheet's live warning (INV-N4): what the choices on screen would give the app
    riskPreview: (id, preview) => call('lib:riskPreview', id, preview),
    // the VM's size (SPEC 2.2, 8): {cpus, memoryMiB} within what this Mac allows, or null for the defaults
    setResources: (id, choice) => call('lib:setResources', id, choice === null ? null : choice),
    // live activity (the "Activity" section): the running apps and what each can reach; Stop is `stop`, Inspect is `inspect`
    activity: () => call('lib:activity'),
    onActivity: (cb) => listen('lib:activityState', cb),
    showData: (id) => call('lib:showData', String(id)),
    // host capabilities (SPEC 8.2): who controls the computer right now, Stop, and the settings window
    control: () => call('lib:control'),
    stopControl: (appId) => call('lib:stopControl', String(appId)),
    stopAllControl: () => call('lib:stopAllControl'),
    openSettings: () => call('lib:openSettings'),
    onNotice: (cb) => listen('lib:notice', cb),
    chooseFolder: (id, name) => call('lib:chooseFolder', id, name),
    stop: (id) => call('lib:stop', id),
    inspect: (id, tab) => call('lib:inspect', id, tab),
    uninstall: (id, purge) => call('lib:uninstall', id, !!purge),
    reset: (id) => call('lib:reset', id),
    pickPackage: () => call('lib:pickPackage'),
    installPackage: (token) => call('lib:installPackage', token),
    cancelInstall: () => call('lib:cancelInstall'),
    // Load examples: the sample apps that came with the loader. The page names them by file name (from the list) and nothing else.
    examplesInfo: () => call('lib:examplesInfo'),
    examplesList: () => call('lib:examplesList'),
    examplesInstall: (names) => call('lib:examplesInstall', Array.isArray(names) ? names.map((n) => String(n)) : []),
    onExamplesProgress: (cb) => listen('lib:examplesProgress', cb),
    // the File menu (main.js): 'examples', 'browse' or 'install'
    onMenu: (cb) => listen('lib:menu', cb),
    // developer: run / rebuild a project folder; publish an installed app to a registry (each is something the user clicked)
    runFolder: () => call('lib:runFolder'),
    rebuildDev: (id) => call('lib:rebuildDev', id),
    publishInfo: (id, registry) => call('lib:publishInfo', id, registry === undefined ? undefined : String(registry)),
    publish: (id, opts) => call('lib:publish', id, opts),
    openPage: (url) => call('lib:openPage', String(url)),
    copyText: (text) => call('lib:copyText', String(text)),
    // registry: install, update choice, versions (each is something the user clicked)
    registryDefault: () => call('lib:registryDefault'),
    // Browse registry…: one page of the launcher's registry (fixed in the main process; the page cannot name another): the search text, the sort and the offset
    registryBrowse: (opts) => call('lib:registryBrowse', { q: String((opts && opts.q) || ''), sort: String((opts && opts.sort) || 'new'), offset: Number(opts && opts.offset) || 0 }),
    registryFetch: (registry, app) => call('lib:registryFetch', String(registry), String(app)),
    setPolicy: (id, choice) => call('lib:setPolicy', id, choice),
    versions: (id) => call('lib:versions', id),
    registryVersions: (id) => call('lib:registryVersions', id),
    useVersion: (id, version) => call('lib:useVersion', id, version),
    prepareRegistryVersion: (id, version) => call('lib:prepareRegistryVersion', id, version),
    checkUpdates: (id) => call('lib:checkUpdates', id),
    onChanged: (cb) => listen('lib:changed', () => cb()),
    // the launcher's own updates (SPEC 8.10): the state of the update card, and what each button does. Each is a click.
    update: {
      state: () => call('upd:state'),
      onState: (cb) => listen('upd:state', cb),
      check: () => call('upd:check'),
      install: () => call('upd:install'),
      restart: () => call('upd:restart'),
      skip: () => call('upd:skip'),
      later: () => call('upd:later'),
      dismiss: () => call('upd:dismiss'),
      open: (kind) => call('upd:open', kind === 'changelog' ? 'changelog' : 'download'),
    },
  });
} else if (page === 'settings.html') {
  // The Host Capabilities window: the user's catalog, the macOS permissions, Stop everything. Each call is a click.
  contextBridge.exposeInMainWorld('settings', {
    state: () => call('set:state'),
    setPref: (name, value) => call('set:setPref', String(name), value === true),
    status: () => call('set:status'),
    askMacos: (which) => call('set:askMacos', String(which)),
    openSystemSettings: (pane) => call('set:openSystemSettings', String(pane)),
    saveTool: (def) => call('set:saveTool', def),
    removeTool: (id) => call('set:removeTool', String(id)),
    saveMcp: (def) => call('set:saveMcp', def),
    removeMcp: (id) => call('set:removeMcp', String(id)),
    pickFile: () => call('set:pickFile'),
    stopAll: () => call('set:stopAll'),
    stopControl: (appId) => call('set:stopControl', String(appId)),
    onChanged: (cb) => listen('set:changed', () => cb()),
  });
} else if (page === 'monitor.html') {
  // The menu-bar popover (live activity monitor): the loader pushes the state, the page can press Stop, Inspect and "show data".
  contextBridge.exposeInMainWorld('monitor', {
    state: () => call('mon:state'),
    onState: (cb) => listen('mon:state', cb),
    stop: (appId) => call('mon:stop', String(appId)),
    inspect: (appId) => call('mon:inspect', String(appId)),
    showData: (appId) => call('mon:showData', String(appId)),
    openLibrary: () => call('mon:openLibrary'),
    resize: (height) => call('mon:resize', Number(height)),
  });
} else if (page === 'badge.html') {
  // The control badge (INV-H3): shows what the loader sends and can only press Stop.
  contextBridge.exposeInMainWorld('badge', {
    onState: (cb) => listen('badge:state', cb),
    ready: () => ipcRenderer.send('badge:ready'),
    stop: (appId) => call('badge:stop', String(appId)),
    stopAll: () => call('badge:stopAll'),
  });
} else if (page === 'picker.html') {
  // The screenshot picker (SPEC 8.2): the user chooses what the app may see. The page can only answer with what it was offered.
  contextBridge.exposeInMainWorld('picker', {
    ready: () => call('picker:ready'),
    onThumb: (cb) => listen('picker:thumb', cb),
    selectRegion: (display) => call('picker:region', Number(display)),
    answer: (allow, choice) => call('picker:answer', String(allow), choice === null || choice === undefined ? null : JSON.parse(JSON.stringify(choice))),
  });
} else if (page === 'region.html') {
  // "Select a region…": a rectangle in window points, or a cancel.
  contextBridge.exposeInMainWorld('region', {
    done: (rect) => call('region:done', { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) }),
    cancel: () => call('region:cancel'),
  });
} else if (page === 'overlay.html') {
  // The virtual-input overlay (INV-H3): draws what the loader sends; it has no way to send anything back but "ready".
  contextBridge.exposeInMainWorld('overlay', {
    onEvent: (cb) => listen('overlay:event', cb),
    ready: () => ipcRenderer.send('overlay:ready'),
  });
} else if (page === 'inspector.html') {
  contextBridge.exposeInMainWorld('inspector', {
    apps: () => call('insp:apps'),
    snapshot: (appId) => call('insp:snapshot', appId),
    clear: (appId) => call('insp:clear', appId),
    consoleTail: (appId) => call('insp:console', appId),
    onEvents: (cb) => listen('insp:events', cb),
    onApps: (cb) => listen('insp:apps', cb),
    onSelect: (cb) => listen('insp:select', cb),
  });
}
