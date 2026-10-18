'use strict';
(function () {
  var R = window.R;
  var token = '';
  var $ = function (id) { return document.getElementById(id); };

  function call(path, method, body) {
    var init = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return R.api(path, init);
  }

  function show(me) {
    $('panel').hidden = false;
    R.clear($('current'));
    $('current').append(R.pubBadge(me.publisher));
    if (me.publisher.level === 'domain') {
      if (me.publisher.company) $('current').append(' ', R.el('strong', { text: me.publisher.company }));
      if (me.publisher.url) $('current').append(' ', R.el('span', { class: 'muted', text: me.publisher.url }));
    }
    $('pname').value = me.profile.name;
    $('pcompany').value = me.profile.company;
    $('pemail').value = me.profile.email;
    $('purl').value = me.profile.url;
    $('mailmsg').textContent = me.emailVerified ? 'Your email is verified.' : me.pendingEmail ? 'A link was sent and has not been used yet.' : '';
    if (me.pendingDomain) instructions(me.pendingDomain);
    if (me.domainVerified) $('domainmsg').textContent = 'Your domain is verified.';
    if (me.publisher.level === 'domain' && me.profile.url && !me.publisher.url) {
      $('domainmsg').textContent += ' Your website is not on the verified domain, so it is not shown.';
    }
  }

  function instructions(d) {
    $('instructions').hidden = false;
    $('domain').value = d.domain;
    $('fileurl').textContent = d.file.url;
    $('filecontent').textContent = d.file.content;
    $('dnsname').textContent = d.dns.name;
    $('dnsvalue').textContent = d.dns.value;
  }

  function fail(target) {
    return function (e) { target.textContent = e.message; };
  }

  function refresh() {
    return call('/api/publisher/me', 'GET').then(show);
  }

  $('login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    token = $('token').value.trim();
    $('status').textContent = 'Checking...';
    refresh().then(function () {
      $('status').textContent = '';
      $('login').hidden = true;
    }).catch(fail($('status')));
  });

  $('profile').addEventListener('submit', function (ev) {
    ev.preventDefault();
    call('/api/publisher/profile', 'POST', {
      name: $('pname').value, company: $('pcompany').value, email: $('pemail').value, url: $('purl').value,
    }).then(function (me) { $('status').textContent = 'Saved.'; show(me); }).catch(fail($('status')));
  });

  $('sendmail').addEventListener('click', function () {
    $('mailmsg').textContent = 'Sending...';
    call('/api/publisher/verify-email', 'POST', {}).then(function (r) {
      $('mailmsg').textContent = 'Sent to your address at @' + r.emailDomain + '. Open the link within ' + r.expiresInMinutes + ' minutes.';
    }).catch(fail($('mailmsg')));
  });

  $('startdomain').addEventListener('click', function () {
    $('domainmsg').textContent = '';
    call('/api/publisher/verify-domain', 'POST', { domain: $('domain').value }).then(instructions).catch(fail($('domainmsg')));
  });

  $('checkdomain').addEventListener('click', function () {
    $('domainmsg').textContent = 'Checking...';
    call('/api/publisher/check-domain', 'POST', {}).then(function () {
      $('domainmsg').textContent = 'Verified.';
      return refresh();
    }).catch(fail($('domainmsg')));
  });
})();
