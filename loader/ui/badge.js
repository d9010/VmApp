'use strict';
/* global h, badge */
// The control badge page (INV-H3). The text comes from the loader (it names the app that is controlling the computer);
// it is inserted as text only. Stop ends that app's control; with several apps there is also Stop all.

const rowsEl = document.getElementById('rows');
let busy = false;

function render(list) {
  rowsEl.replaceChildren();
  for (const e of list || []) {
    rowsEl.appendChild(
      h(
        'div',
        { class: 'row', dataset: { app: e.appId, kind: e.kind } },
        h('span', { class: 'dot' }),
        h('span', { class: 'text', dataset: { role: 'badge-text' }, title: `${e.text} — Stop` }, `${e.text} — `),
        h('button', { dataset: { action: 'badge-stop' }, onclick: () => press(() => badge.stop(e.appId)) }, 'Stop'),
      ),
    );
  }
  if ((list || []).length > 1) {
    rowsEl.appendChild(
      h(
        'div',
        { class: 'row', dataset: { kind: 'all' } },
        h('span', { class: 'text' }, 'Stop everything now'),
        h('span', { class: 'hint' }, '⌃⌥⌘.'),
        h('button', { dataset: { action: 'badge-stop-all' }, onclick: () => press(() => badge.stopAll()) }, 'Stop all'),
      ),
    );
  }
}

async function press(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch {
    /* the main process refuses what is no longer active; the next state replaces this view */
  } finally {
    busy = false;
  }
}

badge.onState(render);
badge.ready();
