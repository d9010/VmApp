'use strict';
/* global h, picker */
// The screenshot picker page (SPEC 8.2). Everything the app supplied (its name, its purpose, the suggestion) is inserted as
// text. The page can only answer with a choice among the displays and windows the main process sent it, and a region the
// user drew; the main process checks that again. Thumbnails arrive from the loader and are shown here only.

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let sel = null; // {kind:'display', display} | {kind:'window', windowId} | {kind:'region'}
  let suggested = false;
  let busy = false;
  const thumbEls = new Map(); // 'display:2' | 'region' -> element
  const thumbData = new Map(); // key -> {src} | {error}

  const keyOf = (s) => (!s ? '' : s.kind === 'display' ? `display:${s.display}` : s.kind === 'window' ? `window:${s.windowId}` : 'region');
  const dims = (b) => `${Math.round(b.w)} × ${Math.round(b.h)}`;

  function error(msg) {
    const b = $('banner');
    b.hidden = !msg;
    b.textContent = msg || '';
  }

  function setThumb(key, t) {
    thumbData.set(key, t);
    const el = thumbEls.get(key);
    if (el) paintThumb(el, t);
  }
  function paintThumb(el, t) {
    el.replaceChildren();
    if (t && t.src) el.appendChild(h('img', { src: t.src, alt: '' }));
    else if (t && t.error === 'permission') el.textContent = 'No preview: Screen Recording is not allowed for D9010 VmApp Launcher yet';
    else if (t && t.error) el.textContent = 'No preview available';
    else el.textContent = 'Loading preview…';
  }

  function choice(key, sel0, children, role) {
    return h(
      'label',
      { class: `choice${children.row ? ' row' : ''}`, dataset: { pick: key, role } },
      h('input', {
        type: 'radio',
        name: 'pick',
        value: key,
        checked: keyOf(sel) === key,
        onchange: () => {
          sel = sel0;
          suggested = false;
          updateUi();
        },
      }),
      children.nodes,
    );
  }

  function displayCard(d) {
    const key = `display:${d.display}`;
    const th = h('div', { class: 'thumb', dataset: { role: 'thumb' } });
    thumbEls.set(key, th);
    paintThumb(th, thumbData.get(key));
    return choice(
      key,
      { kind: 'display', display: d.display },
      {
        nodes: [
          th,
          h('div', { class: 'cname', dataset: { role: 'display-name' } }, d.name, d.main ? h('span', { class: 'tag' }, 'main') : null),
          h('div', { class: 'cmeta', dataset: { role: 'display-size' } }, `${dims(d.bounds)} points`),
        ],
      },
      'display',
    );
  }

  function windowRow(w) {
    return choice(
      `window:${w.windowId}`,
      { kind: 'window', windowId: w.windowId },
      {
        row: true,
        nodes: [h('span', { class: 'app', dataset: { role: 'window-app' } }, w.app), h('span', { class: 'wtitle', dataset: { role: 'window-title' } }, w.title || '(no title)'), h('span', { class: 'cmeta' }, dims(w.bounds))],
      },
      'window',
    );
  }

  function regionCard() {
    const r = state.region;
    const d = state.displays.find((x) => x.display === r.display);
    const th = h('div', { class: 'thumb', dataset: { role: 'thumb' } });
    thumbEls.set('region', th);
    paintThumb(th, thumbData.get('region'));
    return choice(
      'region',
      { kind: 'region' },
      {
        nodes: [
          th,
          h('div', { class: 'cname', dataset: { role: 'region-name' } }, 'A part of the screen'),
          h('div', { class: 'cmeta', dataset: { role: 'region-size' } }, `${dims(r)} points on ${d ? d.name : 'a display'}`),
        ],
      },
      'region',
    );
  }

  function group(title, role, ...kids) {
    return h('section', { class: 'group', dataset: { role } }, h('h2', null, title), kids);
  }

  function render() {
    const list = $('list');
    thumbEls.clear();
    list.replaceChildren();
    list.setAttribute('aria-busy', 'false');
    if (!state.displays.length) {
      list.appendChild(h('div', { class: 'empty', dataset: { role: 'no-displays' } }, 'No display is available right now (is the screen asleep?). You can only deny.'));
    } else {
      list.appendChild(group('Displays', 'displays', h('div', { class: 'cards' }, state.displays.map(displayCard))));
    }
    if (state.windows.length) {
      list.appendChild(
        group(
          'Windows',
          'windows',
          h('div', { class: 'rows' }, state.windows.map(windowRow)),
          state.titlesHidden ? h('p', { class: 'hint muted', dataset: { role: 'titles-hint' } }, 'Window titles are hidden until you allow Screen Recording for D9010 VmApp Launcher in System Settings.') : null,
        ),
      );
    }
    if (state.displays.length) {
      list.appendChild(
        group(
          'A part of a screen',
          'region',
          h(
            'div',
            { class: 'regionbtns' },
            state.displays.map((d) =>
              h('button', { dataset: { action: 'region', display: d.display }, onclick: () => pickRegion(d.display) }, state.displays.length > 1 ? `Select a region on ${d.name}…` : 'Select a region…'),
            ),
          ),
          state.region ? h('div', { class: 'cards' }, regionCard()) : null,
        ),
      );
    }
    updateUi();
  }

  function summaryText() {
    if (!sel) return 'Nothing is selected yet.';
    let what = '';
    if (sel.kind === 'display') {
      const d = state.displays.find((x) => x.display === sel.display);
      what = d ? `display “${d.name}” (${dims(d.bounds)} points)` : 'a display';
    } else if (sel.kind === 'window') {
      const w = state.windows.find((x) => x.windowId === sel.windowId);
      what = w ? `the window “${w.title || '(no title)'}” of ${w.app}` : 'a window';
    } else {
      const r = state.region;
      what = r ? `a part of the screen (${dims(r)} points)` : 'a part of the screen';
    }
    return `It will receive: ${what}.${suggested ? ' (This is what the app suggested.)' : ''}`;
  }

  function updateUi() {
    $('summary').textContent = summaryText();
    $('once').disabled = busy || !sel;
    $('session').disabled = busy || !sel;
    $('deny').disabled = busy;
  }

  async function pickRegion(display) {
    if (busy) return;
    busy = true;
    updateUi();
    error('');
    try {
      const r = await picker.selectRegion(display);
      if (r && r.region) {
        state.region = r.region;
        sel = { kind: 'region' };
        suggested = false;
        thumbData.delete('region');
        render();
      }
    } catch (e) {
      error(e.message);
    } finally {
      busy = false;
      updateUi();
    }
  }

  async function answer(allow) {
    if (busy) return;
    busy = true;
    updateUi();
    error('');
    try {
      await picker.answer(allow, allow === 'deny' ? null : sel);
    } catch (e) {
      busy = false;
      error(e.message);
      updateUi();
    }
  }

  $('deny').addEventListener('click', () => answer('deny'));
  $('once').addEventListener('click', () => answer('once'));
  $('session').addEventListener('click', () => answer('session'));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer('deny');
  });

  picker.onThumb((t) => {
    if (t && t.region) setThumb('region', t);
    else if (t) setThumb(`display:${t.display}`, t);
  });

  picker
    .ready()
    .then((s) => {
      state = s;
      sel = s.selected;
      suggested = !!s.suggested;
      $('title').textContent = `“${s.app.name}” wants to take a screenshot`;
      $('note').textContent = s.sessionNote;
      if (s.purpose) {
        $('purpose').hidden = false;
        $('purpose').textContent = `Why the app says it needs this: “${s.purpose}”`;
      }
      if (s.suggestion) {
        $('suggest').hidden = false;
        $('suggest').textContent = `It suggests: ${s.suggestion}.`;
      }
      render();
    })
    .catch((e) => error(e.message));
})();
