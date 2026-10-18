'use strict';
/* global h */
// The activity view shared by the library (compact) and the menu-bar popover: the running apps and, for each, what it can reach
// right now (pills). A pill pulses while that thing is in use: an event within the last `pulseMs`, or a continuous use (a mouse
// and keyboard session, a live microphone). Everything from a manifest (app names, folder names) is inserted as text, never as
// markup. The loader decides what is listed; this file only draws it.

/* exported Activity */
const Activity = (() => {
  let pulseMs = 2000;

  /** Is this pill in use right now? (`live` is continuous use; `lastAt` is the time of the last event.) */
  function inUse(p, now) {
    return !!p.live || (p.lastAt > 0 && now - p.lastAt < pulseMs);
  }

  function pillEl(p) {
    return h(
      'span',
      { class: `pill k-${p.kind}`, title: p.title, tabindex: 0, dataset: { pill: p.kind, last: String(p.lastAt || 0), live: p.live ? '1' : '0' } },
      h('span', { class: 'pdot', 'aria-hidden': 'true' }),
      p.label,
      p.live ? h('span', { class: 'plive' }, p.kind === 'mic' ? ' listening' : ' active') : null,
    );
  }

  function rowEl(app, opts) {
    const h2 = opts.handlers || {};
    const btn = (action, label, title, fn, cls) => h('button', { class: cls || '', dataset: { action }, title, onclick: () => fn && fn(app.id) }, label);
    return h(
      'div',
      { class: `act-row${opts.compact ? ' compact' : ''}`, dataset: { actApp: app.id, state: app.state } },
      h(
        'div',
        { class: 'act-head' },
        h('div', { class: 'act-name' }, app.name, h('span', { class: 'version' }, app.version)),
        h(
          'div',
          { class: 'act-buttons' },
          opts.compact ? null : btn('act-inspect', 'Inspect', 'Open the Bridge Inspector for this app', h2.inspect),
          opts.compact ? null : btn('act-data', 'Show app data in Finder', 'Show this app’s private data folder in Finder', h2.showData),
          btn('act-stop', 'Stop', 'Stop this app', h2.stop, 'danger'),
        ),
      ),
      app.pills.length
        ? h('div', { class: 'pills', dataset: { role: 'pills' } }, app.pills.map(pillEl))
        : h('div', { class: 'muted act-none', dataset: { role: 'no-pills' } }, 'Can reach nothing on this Mac beyond its own private data.'),
    );
  }

  /** Draws `state` ({apps, pulseMs}) into `container`. opts: { compact, handlers: {stop, inspect, showData} }. */
  function render(container, state, opts = {}) {
    if (state && Number.isFinite(state.pulseMs)) pulseMs = state.pulseMs;
    const apps = (state && state.apps) || [];
    container.replaceChildren(
      ...(apps.length ? apps.map((a) => rowEl(a, opts)) : [h('div', { class: 'muted act-empty', dataset: { role: 'act-empty' } }, 'No app is running.')]),
    );
    tick(container);
  }

  /** Turns the "in use" look on and off. Called by render and about twice a second. */
  function tick(container) {
    const now = Date.now();
    for (const el of container.querySelectorAll('.pill')) {
      const on = el.dataset.live === '1' || (Number(el.dataset.last) > 0 && now - Number(el.dataset.last) < pulseMs);
      el.classList.toggle('pulse', on);
      el.dataset.use = on ? '1' : '0';
    }
  }

  function watch(container) {
    setInterval(() => tick(container), 400);
  }

  return { render, tick, watch, inUse };
})();
