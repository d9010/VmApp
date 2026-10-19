'use strict';
// Shared helpers for the registry pages. Everything dynamic reaches the page as a text node or through
// setAttribute with a value built here: there is no HTML parsing of server data anywhere.
(function () {
  var R = {};

  /** el('a', {class: 'x', href: '/y', text: 'label', on: {click: fn}}, child, 'text', ...) */
  R.el = function (tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = String(v);
        else if (k === 'on') Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === undefined || kid === null || kid === false) continue;
      node.append(kid);
    }
    return node;
  };

  R.clear = function (node) {
    node.replaceChildren();
  };

  R.fmtBytes = function (n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
    return n + ' B';
  };

  R.fmtDate = function (iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };

  R.plural = function (n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  };

  /** Fetches JSON from the registry API; throws an Error carrying the server's message. */
  R.api = function (path, init) {
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        if (!res.ok) {
          var msg = body && body.error && body.error.message ? body.error.message : 'The server answered ' + res.status;
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  };

  /** A small badge for a publisher view {level, label}: only verified facts are ever in it. */
  R.pubBadge = function (pub) {
    // an unverified publisher shows nothing: an empty string, which append() and R.el() both accept
    if (pub.level !== 'domain' && pub.level !== 'email') return '';
    var mark = pub.level === 'domain' ? '✓ ' : '✉ ';
    return R.el('span', { class: 'pubbadge level-' + pub.level, text: mark + pub.label });
  };

  R.accessWords = { read: 'read the files in', readwrite: 'read and change files in', writeonly: 'save new files into' };

  /** What a host capability (SPEC 8.2) lets an app do, in plain words. Unknown ones are shown as they are (as text). */
  R.hostWords = {
    screen: 'See your screen',
    input: 'Control your mouse and keyboard',
    'tool:*': 'Run tools from your own catalog',
    'mcp:*': 'Use MCP servers from your own catalog',
    gpu: "Run work on your Mac's GPU, through a sandboxed helper",
  };

  window.R = R;
})();
