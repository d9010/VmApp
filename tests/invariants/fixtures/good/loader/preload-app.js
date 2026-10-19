'use strict';
// Fixture of the app-window preload: exposes exactly window.vmapp.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('vmapp:hello');

async function invoke(channel, ...args) {
  const r = await ipcRenderer.invoke('vmapp:invoke', channel, args);
  if (r && r.ok) return r.result;
  throw new Error('invoke failed');
}
function send(channel, ...args) {
  ipcRenderer.send('vmapp:send', channel, args);
}
const on = (channel, listener) => () => void [channel, listener];
const menuSet = (template) => ipcRenderer.invoke('vmapp:menu-set', template);
const menuOnClick = (fn) => () => void fn;
let served = false;
function serve(routes) {
  served = ipcRenderer.sendSync('vmapp:serve', routes) === true;
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
    on: (channel, listener) => on(channel, listener),
    once: (channel, listener) => on(channel, listener),
    addListener: (channel, listener) => on(channel, listener),
    off: () => {
      throw new Error('a listener cannot be matched across the context bridge');
    },
    removeListener: () => {
      throw new Error('a listener cannot be matched across the context bridge');
    },
    removeAllListeners: (channel) => void channel,
    eventNames: () => [],
    listenerCount: () => 0,
    sendSync: () => {
      throw new Error('use invoke()');
    },
  },
});
