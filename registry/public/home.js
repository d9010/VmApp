'use strict';
// The home page. The server renders the list (and the search form, the sort links and the page links) so that it works
// without this script; this script takes over from there: search and sorting without a page load, "Show more" in
// place of the page links. A page that arrives without server-rendered content (no data-total on the list) is filled from the API.
(function () {
  var R = window.R;
  var PAGE = 20; // the same as PAGE_SIZE in lib/pages.js
  var state = { sort: 'popular', q: '', offset: 0, loading: false };

  var list = document.getElementById('list');
  var status = document.getElementById('status');
  var more = document.getElementById('more');
  var pager = document.getElementById('pager'); // the server-rendered page links; absent on a page without them
  var input = document.getElementById('q');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-sort]'));

  function readUrl() {
    var p = new URLSearchParams(location.search);
    var s = p.get('sort');
    if (s === 'popular' || s === 'new' || s === 'updated') state.sort = s;
    state.q = (p.get('q') || '').trim().slice(0, 100);
    input.value = state.q;
  }

  /** "" or "?sort=new&q=notes": the part of the address that says what is shown. */
  function query(sort, q) {
    var p = new URLSearchParams();
    if (sort !== 'popular') p.set('sort', sort);
    if (q) p.set('q', q);
    var qs = p.toString();
    return qs ? '?' + qs : '';
  }

  function writeUrl() {
    history.replaceState(null, '', location.pathname + query(state.sort, state.q));
  }

  function renderTabs() {
    tabs.forEach(function (t) {
      var sort = t.getAttribute('data-sort');
      t.setAttribute('aria-current', sort === state.sort ? 'page' : 'false');
      t.setAttribute('href', '/' + query(sort, state.q)); // so that "open in a new tab" asks for what is shown
    });
  }

  function item(a) {
    return R.el('li', null,
      R.el('div', { class: 'title' },
        R.el('a', { href: '/apps/' + encodeURIComponent(a.id), text: a.name }),
        R.el('span', { class: 'ver', text: 'v' + a.latestVersion })),
      R.el('p', { class: 'meta' },
        R.pubBadge(a.publisher),
        R.el('span', { text: a.id })),
      a.description ? R.el('p', { text: a.description }) : null,
      R.el('p', { class: 'meta' },
        R.el('span', { text: R.plural(a.downloads, 'download', 'downloads') }),
        R.el('span', { text: R.fmtBytes(a.sizeBytes) }),
        R.el('span', { text: a.runtime }),
        R.el('span', { text: 'updated ' + R.fmtDate(a.updatedAt) })),
      R.el('p', { class: 'meta' }, R.el('span', { text: 'Asks for: ' + a.permissionsSummary })));
  }

  function load(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      state.offset = 0;
      R.clear(list);
      more.hidden = true;
      if (pager) pager.hidden = true; // "Show more" replaces the page links
      status.textContent = 'Loading...';
    }
    var qs = new URLSearchParams({ sort: state.sort, limit: String(PAGE), offset: String(state.offset) });
    // note: the search matches the app's own text and verified publisher facts only
    if (state.q) qs.set('q', state.q);
    R.api('/api/apps?' + qs.toString()).then(function (r) {
      r.items.forEach(function (a) { list.append(item(a)); });
      state.offset += r.items.length;
      more.hidden = state.offset >= r.total;
      if (r.total === 0) {
        status.textContent = state.q ? 'No apps match "' + state.q + '".' : 'No apps yet. Be the first to publish one.';
      } else {
        status.textContent = R.plural(r.total, 'app', 'apps') + (state.q ? ' match "' + state.q + '"' : '');
      }
    }).catch(function (e) {
      status.textContent = 'Could not load apps: ' + e.message;
    }).then(function () {
      state.loading = false;
    });
  }

  /** A click that should change the page in place; with a modifier key the browser opens the link as usual. */
  function plainClick(ev) {
    return !(ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || (ev.button && ev.button !== 0)));
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function (ev) {
      if (!plainClick(ev)) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      state.sort = t.getAttribute('data-sort');
      renderTabs();
      writeUrl();
      load(true);
    });
  });
  document.getElementById('search').addEventListener('submit', function (ev) {
    ev.preventDefault();
    state.q = input.value.trim();
    renderTabs();
    writeUrl();
    load(true);
  });
  more.addEventListener('click', function () { load(false); });

  readUrl();
  renderTabs();
  if (list.getAttribute('data-total') !== null) {
    // the server rendered this very list (its address says which: ?q=, ?sort=, ?page=): continue after what is shown
    state.offset = (Number(list.getAttribute('data-offset')) || 0) + list.children.length;
    more.hidden = state.offset >= Number(list.getAttribute('data-total'));
    if (pager) pager.hidden = true;
  } else {
    load(true);
  }

  var stats = document.getElementById('stats');
  if (stats && !stats.textContent) { // the server rendered the totals too; only a page without them asks
    R.api('/api/stats').then(function (s) {
      stats.textContent =
        R.plural(s.apps, 'app', 'apps') + ', ' + R.plural(s.versions, 'version', 'versions') + ', ' + R.plural(s.downloads, 'download', 'downloads');
    }).catch(function () { /* the footer is optional */ });
  }
})();
