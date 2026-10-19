'use strict';
// The preload of every app window (SPEC 7). Apps can't ship a preload; this is the only one. It exposes exactly:
//
//   window.vmapp = {
//     invoke(channel, ...args) -> Promise,   // -> core ipcMain.handle;  rejects "Error invoking remote method '<channel>': <error>", as Electron's
//     send(channel, ...args),                // -> core ipcMain.on
//     on(channel, listener) -> unsubscribe,  // <- core webContents.send;  listener(...args)
//     serve(routes) -> boolean, served() -> boolean,   // "these paths are my server's": the launcher answers them itself (SPEC 7 "Files the app's server serves")
//     menu: { set(template) -> Promise, onClick(fn) -> unsubscribe },  // the window's menus in the Mac menu bar (SPEC 7 "Menus")
//     app: { id, name, version },
//     ipcRenderer: { invoke, send, on, once, addListener, removeAllListeners, eventNames, listenerCount,   // Electron's ipcRenderer, as far as the
//                    off, removeListener, sendSync },                                                      // context bridge allows (SPEC 7 "ipcRenderer")
//   }
//
// Arguments and results are anything the structured clone algorithm copies (Electron's rule for ipcRenderer.send/invoke): Date, Map, Set, typed
// arrays, BigInt, Error, cycles, … ; a function or a Symbol is refused the way Electron refuses it ("… could not be cloned."). The page -> launcher
// leg is Electron's own structured clone; the launcher <-> core leg is JSON lines with sdk/node/ipc-codec.js. The app identity comes from the
// loader (by the sender's webContents), never from the page.

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('vmapp:hello');
if (!info) throw new Error('vmapp: this window is not owned by a running app');

function checkChannel(channel) {
  if (typeof channel !== 'string' || !channel) throw new TypeError('vmapp: channel must be a non-empty string');
  return channel;
}

// The page's listeners: channel -> [{ fn, withEvent, once }], in the order they were added (an EventEmitter, as Electron's ipcRenderer is, without
// EventEmitter's special event names: a core can send a channel called "error" or "newListener" like any other).
const listeners = new Map();

function rethrowLater(e) {
  setTimeout(() => {
    throw e;
  }, 0);
}

ipcRenderer.on('vmapp:emit', (_event, channel, args) => {
  const list = listeners.get(channel);
  if (!list) return;
  // what Electron hands a listener of ipcRenderer.on: IpcRendererEvent { sender, ports }. `sender` is limited to what is safe to hand to the page.
  const event = { sender: { send, invoke }, ports: [] };
  for (const l of [...list]) {
    if (l.once) removeEntry(channel, l);
    try {
      if (l.withEvent) l.fn(event, ...args);
      else l.fn(...args);
    } catch (e) {
      rethrowLater(e);
    }
  }
});

async function invoke(channel, ...args) {
  checkChannel(channel);
  // a value that cannot be cloned rejects here, with Electron's own error ("… could not be cloned.")
  const r = await ipcRenderer.invoke('vmapp:invoke', channel, args);
  if (r && r.ok) return r.result;
  // Electron: `Error invoking remote method '${channel}': ${error}` with error = the handler's error.toString()
  throw new Error(`Error invoking remote method '${channel}': ${r && typeof r.text === 'string' ? r.text : `Error: ${(r && r.error) || 'invoke failed'}`}`);
}

function send(channel, ...args) {
  checkChannel(channel);
  ipcRenderer.send('vmapp:send', channel, args);
}

function removeEntry(channel, entry) {
  const list = listeners.get(channel);
  if (!list) return;
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) listeners.delete(channel);
}

function subscribe(channel, fn, withEvent, once) {
  checkChannel(channel);
  if (typeof fn !== 'function') throw new TypeError('vmapp: listener must be a function');
  if (!listeners.has(channel)) listeners.set(channel, []);
  const entry = { fn, withEvent, once };
  listeners.get(channel).push(entry);
  return function unsubscribe() {
    removeEntry(channel, entry);
  };
}

const on = (channel, listener) => subscribe(channel, listener, false, false);

// ipcRenderer.removeListener(channel, listener) needs the page's listener to be the same function when it is given again. Across the context bridge
// it never is: the bridge hands this preload a new proxy for the same function on every call (Electron has the same limit for any API exposed with
// contextBridge). So the two that match by identity say so, instead of silently removing nothing.
function removeByIdentity(name) {
  return function () {
    throw new Error(
      `vmapp.ipcRenderer.${name}: a listener cannot be matched by identity across the context bridge (Electron has the same limit under contextIsolation). ` +
        'Call the function that on() or once() returned, or use removeAllListeners(channel).'
    );
  };
}

function sendSync() {
  throw new Error('vmapp.ipcRenderer.sendSync is not available: it would block the page while the VM answers. Use invoke(), which returns a Promise.');
}

// The window's menus in the Mac menu bar (SPEC 7 "Menus"): data only; a click calls the onClick listeners with the item's id.
const menuListeners = new Set();
ipcRenderer.on('vmapp:menu-click', (_event, id) => {
  for (const fn of [...menuListeners]) {
    try {
      fn(id);
    } catch (e) {
      rethrowLater(e);
    }
  }
});
/** Shows these menus while this window is focused (null removes them). Resolves {items, dropped}; rejects on an invalid template. */
async function menuSet(template) {
  const r = await ipcRenderer.invoke('vmapp:menu-set', template === null ? null : template);
  if (r && r.ok) return { items: r.items, dropped: r.dropped };
  throw new Error(`vmapp.menu.set: ${(r && r.error) || 'refused'}`);
}
function menuOnClick(fn) {
  if (typeof fn !== 'function') throw new TypeError('vmapp: listener must be a function');
  menuListeners.add(fn);
  return () => menuListeners.delete(fn);
}

// Files the app's own server serves (SPEC 7): the page says which paths they are, and the launcher answers requests under them itself, the way an
// Electron main process does with a protocol handler. Synchronous on purpose: it must be settled before the page's next element asks for a file.
// `serve(routes)` returns true when the launcher serves them (then <img>, CSS url(), fonts, media and fetch() under them just work), false when it
// does not (an older launcher, or an app that is not running): the page then has to do it itself (sdk/web/vmapp-fetch.js does).
let served = false;
function serve(routes) {
  let list;
  try {
    list = JSON.parse(JSON.stringify(routes));
  } catch {
    throw new TypeError('vmapp.serve: routes must be JSON-serialisable');
  }
  served = ipcRenderer.sendSync('vmapp:serve', list) === true;
  return served;
}

contextBridge.exposeInMainWorld('vmapp', {
  invoke,
  send,
  on,
  serve,
  served: () => served,
  menu: { set: menuSet, onClick: menuOnClick },
  app: { id: info.id, name: info.name, version: info.version },
  ipcRenderer: {
    invoke,
    send,
    on: (channel, listener) => subscribe(channel, listener, true, false),
    once: (channel, listener) => subscribe(channel, listener, true, true),
    addListener: (channel, listener) => subscribe(channel, listener, true, false),
    off: removeByIdentity('off'),
    removeListener: removeByIdentity('removeListener'),
    removeAllListeners: (channel) => {
      if (channel === undefined) listeners.clear();
      else listeners.delete(channel);
    },
    eventNames: () => [...listeners.keys()],
    listenerCount: (channel) => (listeners.get(channel) || []).length,
    sendSync,
  },
});
