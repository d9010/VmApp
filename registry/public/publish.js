'use strict';
(function () {
  var R = window.R;
  var MAX = 512 * 1024 * 1024;
  var form = document.getElementById('form');
  var fileInput = document.getElementById('file');
  var tokenInput = document.getElementById('token');
  var go = document.getElementById('go');
  var status = document.getElementById('status');
  var result = document.getElementById('result');

  function showToken(token) {
    var field = R.el('input', { type: 'text', readonly: true, value: token, 'aria-label': 'Owner token', spellcheck: 'false' });
    field.value = token;
    var copy = R.el('button', { type: 'button', class: 'secondary', text: 'Copy', on: { click: function () {
      field.select();
      if (navigator.clipboard) navigator.clipboard.writeText(token).catch(function () { /* the field is selected: copy by hand */ });
      copy.textContent = 'Copied';
    } } });
    return R.el('section', { class: 'card warn', role: 'alert' },
      R.el('h2', { text: 'Save your owner token now. It is shown once.' }),
      R.el('p', { text: 'You need this token to publish new versions of this app. The registry stores only a hash of it, so it cannot show it again or recover it. Anyone who has it can publish as you.' }),
      R.el('div', { class: 'tokenbox' }, field, copy),
      R.el('p', { class: 'muted', text: 'With the command line, "vmapp publish" saves it for you.' }));
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    R.clear(result);
    var file = fileInput.files && fileInput.files[0];
    if (!file) { status.textContent = 'Choose a .vmapp file first.'; return; }
    if (file.size > MAX) { status.textContent = 'That file is larger than 512 MiB.'; return; }
    var headers = { 'Content-Type': 'application/octet-stream' };
    var token = tokenInput.value.trim();
    if (token) headers.Authorization = 'Bearer ' + token;
    var profile = {};
    [['name', 'pname'], ['company', 'pcompany'], ['email', 'pemail'], ['url', 'purl']].forEach(function (f) {
      var v = document.getElementById(f[1]).value.trim();
      if (v) profile[f[0]] = v;
    });
    if (Object.keys(profile).length) {
      // header-safe JSON: non-ASCII characters as \uXXXX escapes
      headers['X-Vmapp-Publisher'] = JSON.stringify(profile).replace(/[\u007f-￿]/g, function (c) {
        return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
      });
    }
    go.disabled = true;
    status.textContent = 'Uploading and checking ' + file.name + ' (' + R.fmtBytes(file.size) + ')...';
    R.api('/api/publish', { method: 'POST', headers: headers, body: file }).then(function (r) {
      status.textContent = '';
      result.append(R.el('section', { class: 'card' },
        R.el('h2', { class: 'ok', text: 'Published ' + r.id + ' ' + r.version }),
        R.el('p', null, R.el('a', { href: '/apps/' + encodeURIComponent(r.id), text: 'Open the app page' })),
        R.el('p', { class: 'muted mono', text: 'package id ' + r.packageId }),
        R.el('p', null, 'Shown to users as: ', R.pubBadge(r.publisher), ' ', R.el('a', { href: '/publisher', text: 'Verify your identity' }))));
      if (r.ownerToken) result.append(showToken(r.ownerToken));
      form.reset();
    }).catch(function (e) {
      status.textContent = '';
      result.append(R.el('section', { class: 'card' }, R.el('h2', { class: 'err', text: 'Not published' }), R.el('p', { text: e.message })));
    }).then(function () {
      go.disabled = false;
    });
  });
})();
