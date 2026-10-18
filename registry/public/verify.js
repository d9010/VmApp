'use strict';
// The link in the email opens this page. Nothing happens until the person presses the button, so a mail scanner that
// merely fetches the link cannot confirm anything.
(function () {
  var R = window.R;
  var code = document.getElementById('code');
  var status = document.getElementById('status');
  var go = document.getElementById('go');
  code.value = (new URLSearchParams(location.search).get('code') || '').slice(0, 64);

  document.getElementById('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    go.disabled = true;
    status.textContent = 'Checking...';
    R.api('/api/publisher/confirm-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.value.trim() }),
    }).then(function (r) {
      status.textContent = 'Your email is verified. Users now see: ' + r.publisher.label + '.';
    }).catch(function (e) {
      status.textContent = e.message;
      go.disabled = false;
    });
  });
})();
