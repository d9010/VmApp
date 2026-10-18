'use strict';
// ui/app.js: the UI half of the Starter app. It runs in a sandboxed browser window on your Mac.
//
// What this window CAN'T do: use Node, read files, or reach the network (the page's security policy forbids it,
// so `fetch('https://...')` fails). Everything real happens in the core (core/main.js).
//
// What it CAN do: talk to the core through `window.vmapp`, which the loader provides:
//   vmapp.invoke(channel, ...args)  ask the core something, get a Promise with the answer  (core: ipcMain.handle)
//   vmapp.send(channel, ...args)    tell the core something, no answer                      (core: ipcMain.on)
//   vmapp.on(channel, listener)     hear messages the core pushes                           (core: webContents.send)
//   vmapp.app                       { id, name, version } of this app
// Arguments and answers must be plain JSON.

const $ = (id) => document.getElementById(id);

// We always write results with textContent, never innerHTML. File names and file contents come from the outside
// world; textContent shows them as plain text, so they can never run as code.

// A helper that runs a core call and shows a failure in `statusEl` instead of throwing. invoke() rejects with the
// message of any error thrown in the core's handler.
async function ask(statusEl, channel, ...args) {
  try {
    return await window.vmapp.invoke(channel, ...args);
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
    statusEl.className = 'status error';
    return undefined;
  }
}

function say(statusEl, text) {
  statusEl.textContent = text;
  statusEl.className = 'status';
}

// ---- 1. Info ------------------------------------------------------------------------------------------------------
async function showInfo() {
  const info = await window.vmapp.invoke('info');
  const rows = [
    ['App', `${info.name} ${info.version}`],
    ['Core runs on', info.platform],
    ['Node (in the VM)', info.node],
    ['Linux kernel', info.kernel],
    ['User id', String(info.uid)],
    ['Private data folder', info.userData],
  ];
  $('info').replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    $('info').append(dt, dd);
  }
}

// ---- 2. Your documents folder -------------------------------------------------------------------------------------
$('documents-refresh').addEventListener('click', async () => {
  const status = $('documents-status');
  const list = $('documents-list');
  const names = await ask(status, 'documents:list');
  if (names === undefined) return;
  list.replaceChildren();
  if (names === null) {
    say(status, 'You did not share a documents folder. You can change that in the permissions of this app in the loader.');
    return;
  }
  say(status, names.length ? `${names.length} item(s):` : 'The folder is empty.');
  for (const name of names) {
    const li = document.createElement('li');
    li.textContent = name;
    list.append(li);
  }
});

// ---- 3. Counter ---------------------------------------------------------------------------------------------------
function showCounter(c) {
  $('counter-value').textContent = String(c.value);
  $('counter-launches').textContent = `(app started ${c.launches} time${c.launches === 1 ? '' : 's'})`;
}
$('counter-increment').addEventListener('click', async () => {
  const c = await window.vmapp.invoke('counter:increment');
  showCounter(c);
});

// ---- 4. Open a file -----------------------------------------------------------------------------------------------
$('open-file').addEventListener('click', async () => {
  const status = $('open-status');
  const preview = $('open-preview');
  const r = await ask(status, 'file:open');
  if (r === undefined) return;
  if (r.canceled) {
    say(status, 'No file chosen.');
    preview.hidden = true;
    return;
  }
  say(status, `${r.name} (${r.size} bytes), first 2 KB:`);
  preview.textContent = r.preview;
  preview.hidden = false;
});

// ---- 5. Save a file -----------------------------------------------------------------------------------------------
$('save-file').addEventListener('click', async () => {
  const status = $('save-status');
  const r = await ask(status, 'file:save', $('save-text').value);
  if (r === undefined) return;
  say(status, r.canceled ? 'Save canceled.' : `Saved ${r.bytes} bytes.`);
});

// ---- 6. Open a link -----------------------------------------------------------------------------------------------
$('open-link').addEventListener('click', async () => {
  const status = $('link-status');
  const opened = await ask(status, 'link:open');
  if (opened === undefined) return;
  say(status, opened ? 'Opened in your browser.' : 'You chose not to open it.');
});

// ---- 7. Live events (core -> UI) ----------------------------------------------------------------------------------
// vmapp.on returns a function that stops listening. We never need to stop here, but this is how you would.
const stopListening = window.vmapp.on('tick', (n) => {
  $('tick-count').textContent = `tick #${n}`;
});
window.addEventListener('beforeunload', stopListening);

// ---- start-up -----------------------------------------------------------------------------------------------------
showInfo();
window.vmapp.invoke('counter:get').then(showCounter);
