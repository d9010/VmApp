'use strict';
// The launcher update card (SPEC 8.10). It shows what src/updater.js says and offers the buttons; it decides nothing. Everything the
// update feed said (names, notes, the list of changes) is inserted as text, never as HTML (the main process has already cut it down).

(function () {
  const root = document.getElementById('update-root');
  const api = window.loader && window.loader.update;
  if (!root || !api) return;

  let hiddenReady = false; // "Later" on the restart card hides it until the next state message (the update stays downloaded)
  let upToDateTimer = null;

  const mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
  const say = (kind, text) => {
    if (typeof banner === 'function') banner(kind, text);
  };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      say('error', e && e.message ? e.message : String(e));
    }
  };
  const when = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  };

  function whatsNew(u) {
    const items = (u.changes || []).map((c) => h('li', {}, c));
    return h(
      'div',
      { class: 'update-new' },
      h('div', { class: 'update-new-title' }, 'What’s new'),
      items.length ? h('ul', {}, items) : h('p', {}, u.notes || 'See the changelog for details.'),
      h('button', { class: 'link', dataset: { action: 'update-changelog' }, onclick: run(() => api.open('changelog')) }, 'Read the full changelog'),
    );
  }

  function card(cls, title, ...kids) {
    return h('section', { class: `update-card ${cls}`, role: 'status', dataset: { role: 'update-card', phase: cls } }, h('h2', {}, title), ...kids);
  }

  function render(st) {
    clearTimeout(upToDateTimer);
    root.replaceChildren();
    const u = st.update;
    if (st.phase !== 'ready') hiddenReady = false;

    if (st.phase === 'checking' && st.manual) {
      root.append(card('checking', 'Checking for updates…', h('div', { class: 'update-bar' }, h('span', {}))));
    } else if (st.phase === 'available' && u) {
      const meta = [`You have ${st.current}.`, when(u.pubDate) ? `Released ${when(u.pubDate)}.` : '', `The download is about ${mb(u.size)}.`].filter(Boolean).join(' ');
      root.append(
        card(
          'available',
          `Launcher ${u.version} is available`,
          h('p', { class: 'muted' }, meta),
          whatsNew(u),
          st.canInstall ? null : h('p', { class: 'muted' }, 'This copy of the launcher cannot update itself, so you download the new version and replace this one.'),
          h(
            'div',
            { class: 'update-actions' },
            st.canInstall
              ? h('button', { class: 'primary', dataset: { action: 'update-install' }, onclick: run(() => api.install()) }, 'Update now')
              : h('button', { class: 'primary', dataset: { action: 'update-download' }, onclick: run(() => api.open('download')) }, 'Download'),
            h('button', { dataset: { action: 'update-later' }, onclick: run(() => api.later()) }, 'Later'),
            h('button', { dataset: { action: 'update-skip' }, title: 'Do not offer this version again', onclick: run(() => api.skip()) }, 'Skip this version'),
          ),
        ),
      );
    } else if (st.phase === 'downloading' && u) {
      root.append(
        card(
          'downloading',
          `Downloading launcher ${u.version}…`,
          h('p', { class: 'muted' }, `About ${mb(u.size)}. You can keep using the launcher. Nothing restarts until you say so.`),
          h('div', { class: 'update-bar' }, h('span', {})),
        ),
      );
    } else if (st.phase === 'ready' && u && !hiddenReady) {
      root.append(
        card(
          'ready',
          `Launcher ${u.version} is ready to install`,
          h('p', { class: 'muted' }, 'The new version is downloaded and checked. Restarting finishes the update; any apps that are running are stopped first, and you are asked before that happens.'),
          h(
            'div',
            { class: 'update-actions' },
            h('button', { class: 'primary', dataset: { action: 'update-restart' }, onclick: run(() => api.restart()) }, 'Restart to update'),
            h(
              'button',
              {
                dataset: { action: 'update-later' },
                onclick: () => {
                  hiddenReady = true;
                  render(st);
                },
              },
              'Later',
            ),
          ),
        ),
      );
    } else if (st.phase === 'upToDate') {
      root.append(
        card(
          'uptodate',
          `You have the newest launcher (${st.current}).`,
          h('div', { class: 'update-actions' }, h('button', { dataset: { action: 'update-dismiss' }, onclick: run(() => api.dismiss()) }, 'OK')),
        ),
      );
      upToDateTimer = setTimeout(() => api.dismiss().catch(() => {}), 8000);
    } else if (st.phase === 'error') {
      const retry = u && st.canInstall;
      root.append(
        card(
          'error',
          'The launcher could not check or update',
          h('p', {}, st.error || 'Something went wrong.'),
          h(
            'div',
            { class: 'update-actions' },
            retry ? h('button', { class: 'primary', dataset: { action: 'update-install' }, onclick: run(() => api.install()) }, 'Try again') : null,
            u && !st.canInstall ? h('button', { class: 'primary', dataset: { action: 'update-download' }, onclick: run(() => api.open('download')) }, 'Download') : null,
            h('button', { dataset: { action: 'update-dismiss' }, onclick: run(() => api.dismiss()) }, 'Dismiss'),
          ),
        ),
      );
    }
  }

  api.onState(render);
  api.state().then(render, () => {});
})();
