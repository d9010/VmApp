'use strict';
// The preload of every app window (SPEC 7). Apps can't ship a preload; this is the only one. It exposes exactly:
//
//   window.vmapp = {
//     invoke(channel, ...args) -> Promise,   // -> core ipcMain.handle
//     send(channel, ...args),                // -> core ipcMain.on
//     on(channel, listener) -> unsubscribe,  // <- core webContents.send;  listener(...args)
//     menu: { set(template) -> Promise, onClick(fn) -> unsubscribe },  // the window's menus in the Mac menu bar (SPEC 7 "Menus")
//     app: { id, name, version },
//     ipcRenderer: { invoke, send, on },     // alias for porting Electron renderers; on(): listener(event, ...args)
//   }
//
// Arguments and results must be JSON-serialisable. The app identity comes from the loader (by the sender's
// webContents), never from the page.

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('vmapp:hello');
if (!info) throw new Error('vmapp: this window is not owned by a running app');

function jsonArgs(args) {
  // fail early, in the page, with a clear message (structured clone would accept more than the bridge can carry)
  try {
    JSON.stringify(args);
  } catch (e) {
    throw new TypeError(`vmapp: arguments must be JSON-serialisable (${e.message})`);
  }
  return args;
}

function checkChannel(channel) {
  if (typeof channel !== 'string' || !channel) throw new TypeError('vmapp: channel must be a non-empty string');
  return channel;
}

const listeners = new Map(); // channel -> Set<{fn, withEvent}>

ipcRenderer.on('vmapp:emit', (_event, channel, args) => {
  const set = listeners.get(channel);
  if (!set) return;
  for (const l of [...set]) {
    try {
      if (l.withEvent) l.fn({ sender: null }, ...args);
      else l.fn(...args);
    } catch (e) {
      setTimeout(() => {
        throw e;
      }, 0);
    }
  }
});

async function invoke(channel, ...args) {
  checkChannel(channel);
  const r = await ipcRenderer.invoke('vmapp:invoke', channel, jsonArgs(args));
  if (r && r.ok) return r.result;
  throw new Error((r && r.error) || 'invoke failed');
}

function send(channel, ...args) {
  checkChannel(channel);
  ipcRenderer.send('vmapp:send', channel, jsonArgs(args));
}

function subscribe(channel, fn, withEvent) {
  checkChannel(channel);
  if (typeof fn !== 'function') throw new TypeError('vmapp: listener must be a function');
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  const entry = { fn, withEvent };
  listeners.get(channel).add(entry);
  return function unsubscribe() {
    const set = listeners.get(channel);
    if (set) {
      set.delete(entry);
      if (!set.size) listeners.delete(channel);
    }
  };
}

const on = (channel, listener) => subscribe(channel, listener, false);

// The window's menus in the Mac menu bar (SPEC 7 "Menus"): data only; a click calls the onClick listeners with the item's id.
const menuListeners = new Set();
ipcRenderer.on('vmapp:menu-click', (_event, id) => {
  for (const fn of [...menuListeners]) {
    try {
      fn(id);
    } catch (e) {
      setTimeout(() => {
        throw e;
      }, 0);
    }
  }
});
/** Shows these menus while this window is focused (null removes them). Resolves {items, dropped}; rejects on an invalid template. */
async function menuSet(template) {
  const r = await ipcRenderer.invoke('vmapp:menu-set', template === null ? null : jsonArgs([template])[0]);
  if (r && r.ok) return { items: r.items, dropped: r.dropped };
  throw new Error(`vmapp.menu.set: ${(r && r.error) || 'refused'}`);
}
function menuOnClick(fn) {
  if (typeof fn !== 'function') throw new TypeError('vmapp: listener must be a function');
  menuListeners.add(fn);
  return () => menuListeners.delete(fn);
}

contextBridge.exposeInMainWorld('vmapp', {
  invoke,
  send,
  on,
  menu: { set: menuSet, onClick: menuOnClick },
  app: { id: info.id, name: info.name, version: info.version },
  ipcRenderer: {
    invoke,
    send,
    on: (channel, listener) => subscribe(channel, listener, true),
  },
});
