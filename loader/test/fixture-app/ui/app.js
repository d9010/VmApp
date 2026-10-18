'use strict';
// The fixture's UI: runs in the sandboxed renderer. Records what the core pushes so the test can read it.
window.__hello = null;
window.__ticks = [];

window.vmapp.on('hello', (info) => {
  window.__hello = info;
  document.getElementById('hello').textContent = `Hello from the core: ${info.name} ${info.version}`;
});
window.vmapp.on('tick', (t) => {
  window.__ticks.push(t);
  const li = document.createElement('li');
  li.textContent = `tick ${t.n} from ${t.from}`;
  document.getElementById('ticks').appendChild(li);
});
