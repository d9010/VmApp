'use strict';
// Menu Test page: sets its own menus (window.vmapp.menu) when the test asks, and lists every click it hears, from its own menus and
// (through the core) from the core's.
const seen = [];
window.__menuLog = seen;
const note = (s) => {
  seen.push(s);
  const li = document.createElement('li');
  li.textContent = s;
  document.getElementById('log').appendChild(li);
};
window.vmapp.menu.onClick((id) => note(`page:${id}`));
window.vmapp.on('core-click', (id) => note(`core:${id}`));

window.__setPageMenu = () =>
  window.vmapp.menu.set([
    {
      label: 'File',
      submenu: [
        { id: 'open', label: 'Open…', accelerator: 'CmdOrCtrl+O' },
        { type: 'separator' },
        { id: 'quit-app', label: 'Quit Menu Test', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { id: 'wrap', label: 'Word Wrap', type: 'checkbox', checked: false },
        { label: 'Panels', submenu: [{ id: 'panel-1', label: 'Panel 1', accelerator: 'CmdOrCtrl+1' }] },
      ],
    },
  ]);
