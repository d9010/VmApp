'use strict';
/* global Activity, monitor */
// The menu-bar popover (loader-owned page). The loader pushes the state; this page only draws it and presses Stop, Inspect and
// "Show app data in Finder". It can name only an app that the loader listed, and the loader checks that again.

const root = document.getElementById('activity');
const failed = (e) => {
  const old = document.querySelector('.mon-error');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'muted mon-error';
  el.dataset.role = 'mon-error';
  el.textContent = e && e.message ? e.message : String(e);
  root.parentNode.insertBefore(el, root);
  setTimeout(() => el.remove(), 6000);
};
const guarded = (fn) => async (id) => {
  try {
    await fn(id);
  } catch (e) {
    failed(e);
  }
};

function draw(state) {
  Activity.render(root, state, { handlers: { stop: guarded(monitor.stop), inspect: guarded(monitor.inspect), showData: guarded(monitor.showData) } });
  // the popover is as tall as its content (the loader keeps it between a minimum and a maximum)
  monitor.resize(document.getElementById('activity').scrollHeight + document.querySelector('.mon-head').offsetHeight + document.querySelector('.mon-foot').offsetHeight + 8).catch(() => {});
}

Activity.watch(root);
monitor.onState(draw);
monitor.state().then(draw, failed);
document.getElementById('btn-library').addEventListener('click', guarded(() => monitor.openLibrary()));
