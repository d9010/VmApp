'use strict';
(function () {
  var R = window.R;
  var root = document.getElementById('app');
  var status = document.getElementById('status');
  var id = decodeURIComponent(location.pathname.split('/')[2] || '');

  function dl(rows) {
    var node = R.el('dl', { class: 'facts' });
    rows.forEach(function (r) {
      node.append(R.el('dt', { text: r[0] }), R.el('dd', { class: r[2] ? 'mono' : null, text: r[1] }));
    });
    return node;
  }

  function permissions(p) {
    var ul = R.el('ul');
    p.folders.forEach(function (f) {
      ul.append(R.el('li', null,
        R.el('strong', { text: 'A folder called "' + f.name + '"' }),
        R.el('span', { class: 'badge', text: f.access }),
        R.el('span', { class: 'why', text: 'Lets the app ' + (R.accessWords[f.access] || f.access) + ' a folder you choose. Why: ' + (f.purpose || 'no reason given') })));
    });
    if (p.dialogs) {
      ul.append(R.el('li', null,
        R.el('strong', { text: 'File open and save dialogs' }),
        R.el('span', { class: 'why', text: 'Lets the app ask you to pick a file or a place to save one. It only sees what you pick.' })));
    }
    if (p.external) {
      ul.append(R.el('li', null,
        R.el('strong', { text: 'Open web links in your browser' }),
        R.el('span', { class: 'why', text: 'You are shown each address and confirm before it opens.' })));
    }
    (p.devices || []).forEach(function (d) {
      ul.append(R.el('li', null,
        R.el('strong', { text: 'Your ' + d.device }),
        R.el('span', { class: 'badge', text: 'listens' }),
        R.el('span', { class: 'why', text: 'Lets the app’s window hear your ' + d.device + ' while it runs, only if you allow it in the D9010 VmApp Launcher (the default is no). Why: ' + (d.purpose || 'no reason given') })));
    });
    // SPEC 8.2, INV-H6: control of the computer is labelled as such
    (p.host || []).forEach(function (h) {
      ul.append(R.el('li', null,
        R.el('strong', { text: R.hostWords[h.cap] || h.cap }),
        h.control ? R.el('span', { class: 'badge danger', text: 'requests control of your computer' }) : null,
        R.el('span', { class: 'why', text: 'Only if you allow it in the D9010 VmApp Launcher (the default is no). Why: ' + (h.purpose || 'no reason given') })));
    });
    // SPEC 8.3: the internet addresses it asks to reach. The Loader lets you allow each one (or none); nothing is allowed by default.
    (p.network || []).forEach(function (n) {
      var ports = (n.ports || [443]).map(function (x) { return x === 80 ? '80 (not encrypted)' : String(x); }).join(', ');
      ul.append(R.el('li', null,
        R.el('strong', { text: 'The internet: ' + n.host }),
        R.el('span', { class: 'badge', text: 'port ' + ports }),
        n.wildcard ? R.el('span', { class: 'badge danger', text: 'wildcard' }) : null,
        n.insecure ? R.el('span', { class: 'badge danger', text: 'not encrypted' }) : null,
        R.el('span', { class: 'why', text: 'Lets the app connect to ' + (n.wildcard ? 'any address under ' + n.host.slice(2) + ' (many servers)' : n.host) + ', only if you allow it in the D9010 VmApp Launcher (the default is no). Why: ' + (n.purpose || 'no reason given') })));
    });
    var nothing = !p.folders.length && !p.dialogs && !p.external && !(p.devices || []).length && !(p.host || []).length && !(p.network || []).length;
    if (nothing) {
      ul.append(R.el('li', { text: 'Nothing. This app asks for no folders and no dialogs.' }));
    }
    var warning = null;
    if ((p.network || []).length && p.folders.some(function (f) { return f.access !== 'writeonly'; })) {
      warning = R.el('p', { class: 'warnbox', text: 'This app asks to read folders and to reach internet addresses, so it could send what it reads to those addresses if you allow both. The D9010 VmApp Launcher warns you again before you do.' });
    }
    return R.el('section', { class: 'card perms', 'aria-labelledby': 'perm-h' },
      R.el('h2', { id: 'perm-h', text: 'This app will ask for:' }),
      ul,
      warning,
      R.el('p', { class: 'muted', text: 'You approve each folder, each internet address and each device in the D9010 VmApp Launcher, and can say no to any of them. Until you allow it, the app cannot reach anything but its own private data.' }));
  }

  // Only verified facts. The server sends company/url only for a verified domain; unverified publishers have
  // nothing but the label, and the manifest's own "publisher" string is deliberately never shown.
  function publisherBlock(pub) {
    var box = R.el('p', { class: 'publisher' }, R.pubBadge(pub));
    if (pub.level === 'domain') {
      if (pub.company) box.append(' ', R.el('strong', { text: pub.company }));
      if (pub.url) {
        // only an https: address becomes a link (lib/pages.js does the same)
        if (/^https:\/\//i.test(pub.url)) box.append(' ', R.el('a', { href: pub.url, rel: 'noopener noreferrer nofollow', text: pub.url }));
        else box.append(' ', R.el('span', { text: pub.url }));
      }
    }
    if (pub.level === 'unverified') {
      box.append(' ', R.el('span', { class: 'muted', text: 'Nobody has confirmed who made this app.' }));
    }
    return box;
  }

  function downloadHref(v) {
    return '/api/apps/' + encodeURIComponent(id) + '/' + encodeURIComponent(v) + '/download';
  }

  function render(a) {
    document.title = a.name + ' - D9010 VmApp Registry';
    R.clear(root);
    status.textContent = '';
    root.append(
      R.el('h1', null, a.name, R.el('span', { class: 'muted', text: '  v' + a.latestVersion })),
      publisherBlock(a.publisher),
      a.description ? R.el('p', { text: a.description }) : null,
      R.el('p', null, R.el('a', { class: 'button', href: downloadHref(a.latestVersion), text: 'Download v' + a.latestVersion + ' (' + R.fmtBytes(a.sizeBytes) + ')' })),

      permissions(a.permissions),

      R.el('section', { class: 'card' },
        R.el('h2', { text: 'How to install' }),
        R.el('p', { text: 'Download the file, then choose Install... in the D9010 VmApp Launcher and open it. The Loader shows the permissions above before anything is installed. Or, from a terminal:' }),
        R.el('pre', { class: 'cmd', text: 'vmapp get ' + a.id + ' --install' })),

      R.el('section', null,
        R.el('h2', { text: 'Details' }),
        dl([
          ['App id', a.id, true],
          ['Package id', a.packageId, true],
          ['Runtime', a.runtime],
          ['Size', R.fmtBytes(a.sizeBytes)],
          ['Contents', R.plural(a.manifest.files.count, 'file', 'files') + ' (UI ' + R.fmtBytes(a.manifest.files.uiBytes) + ', core ' + R.fmtBytes(a.manifest.files.coreBytes) + ')'],
          ['Recommended size', a.manifest.core.memoryMiB + ' MiB, ' + R.plural(a.manifest.core.cpus, 'CPU', 'CPUs') + ' (you choose the real size in the D9010 VmApp Launcher)'],
          ['Downloads', a.downloads + ' (' + a.downloads30d + ' in the last 30 days)'],
          ['First published', R.fmtDate(a.createdAt)],
          ['Last updated', R.fmtDate(a.updatedAt)],
        ])),

      R.el('section', null,
        R.el('h2', { text: 'Versions' }),
        versionChoices(),
        versions(a)));
  }

  // What the version numbers mean, and where the update choice is made (SPEC 8.1). Text only.
  function versionChoices() {
    return R.el('div', { class: 'card' },
      R.el('p', { text: 'Version numbers tell you how big a change is. A new major version (1.x to 2.0, or a new minor version while the app is still 0.x) is a breaking change; anything else should be safe to take.' }),
      R.el('p', { text: 'After you install an app, the D9010 VmApp Launcher lets you choose how it updates: "Stay on this version" (never changes), "Latest compatible" (newer versions that are not breaking changes) or "Always latest". You can go back to an older version yourself at any time. If the app asks for new access, the Loader always asks you first.'}),
      R.el('p', { class: 'muted', text: 'A withdrawn version was pulled by its publisher, with the reason shown below. It is never offered as an update, but you can still download it by its exact version.' }));
  }

  function versions(a) {
    var ul = R.el('ul', { class: 'versions' });
    a.versions.forEach(function (v) {
      var w = v.withdrawn;
      ul.append(R.el('li', null,
        R.el('span', { class: 'v', text: v.version }),
        R.el('span', { class: 'grow' },
          R.el('span', { class: 'meta', text: R.fmtDate(v.publishedAt) + ' · ' + R.fmtBytes(v.size) + ' · ' + R.plural(v.downloads, 'download', 'downloads') }),
          R.el('br'),
          R.el('span', { class: 'meta mono', text: 'sha256 ' + v.sha256.slice(0, 16) + '...' }),
          w ? R.el('br') : null,
          w ? R.el('span', { class: 'withdrawn', text: 'Withdrawn: ' + w.reason }) : null),
        R.el('a', { class: 'button secondary', href: downloadHref(v.version), text: 'Download' })));
    });
    return ul;
  }

  // The server renders this page (lib/pages.js) and marks the container with data-ssr. This script is the fallback: it
  // fills #app from the API when the page arrived without server-rendered content.
  if (root.getAttribute('data-ssr') !== null) return;
  if (!id) {
    status.textContent = 'No app id in the address.';
    return;
  }
  R.api('/api/apps/' + encodeURIComponent(id)).then(render).catch(function (e) {
    status.textContent = e.status === 404 ? 'There is no app with the id "' + id + '".' : 'Could not load this app: ' + e.message;
  });
})();
