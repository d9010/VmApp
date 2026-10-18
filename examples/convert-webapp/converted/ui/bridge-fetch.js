'use strict';
// bridge-fetch.js: "HTTP over the bridge". Must be the FIRST script of the page.
//
// A vmapp renderer has no network (CSP connect-src 'none'), so the original app.js cannot call
// fetch('/api/bookmarks') over a socket. This file replaces window.fetch for URLs that point at the page's own
// origin: the request is handed to the core with window.vmapp.invoke('http', {method, path, headers, body}); the
// core forwards it to the app's real HTTP server (which listens on 127.0.0.1 INSIDE the VM) and returns
// {status, headers: {'content-type'}, body}. This file turns that back into a Response, so app.js is unchanged.
//
// Scope, deliberately small:
//  - same-origin URLs only ("/api/x", "api/x", or the page's own origin); anything else falls through to the real
//    fetch, which the CSP then blocks (the honest result);
//  - string / URLSearchParams / empty request bodies, and text responses (JSON, HTML, ...). Binary bodies and
//    FormData/Blob uploads would need a base64 field on both sides; they are rejected with a TypeError here.
//  - no streaming, no cookies, no redirects (the core answers with what the server sent).
(function () {
  var w = window;
  var vmapp = w.vmapp;
  if (!vmapp || typeof vmapp.invoke !== 'function') throw new Error('bridge-fetch: window.vmapp is not available');

  var realFetch = typeof w.fetch === 'function' ? w.fetch.bind(w) : null;
  var NULL_BODY_STATUS = { 101: 1, 204: 1, 205: 1, 304: 1 };

  // "/api/x?y=1" for a URL that belongs to this page's origin, otherwise null.
  function localPath(raw) {
    var u;
    try {
      u = new w.URL(raw, w.location.href);
    } catch (e) {
      return null;
    }
    if (u.protocol !== w.location.protocol || u.host !== w.location.host) return null;
    return u.pathname + u.search;
  }

  // Headers / [[k, v]] / {k: v}  ->  {lowercase-k: v}
  function headerObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      h.forEach(function (value, key) { out[String(key).toLowerCase()] = String(value); });
    } else if (Array.isArray(h)) {
      h.forEach(function (pair) { out[String(pair[0]).toLowerCase()] = String(pair[1]); });
    } else {
      Object.keys(h).forEach(function (key) { out[key.toLowerCase()] = String(h[key]); });
    }
    return out;
  }

  // Minimal stand-in used only when the page has no global Response (never the case in Chromium).
  function MiniResponse(status, headers, body) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.statusText = '';
    this.url = '';
    this.bodyUsed = false;
    var lower = {};
    Object.keys(headers).forEach(function (k) { lower[k.toLowerCase()] = headers[k]; });
    this.headers = {
      get: function (name) { var v = lower[String(name).toLowerCase()]; return v === undefined ? null : v; },
      has: function (name) { return String(name).toLowerCase() in lower; },
      forEach: function (fn) { Object.keys(lower).forEach(function (k) { fn(lower[k], k); }); },
    };
    this._rawHeaders = headers;
    this._body = body;
  }
  MiniResponse.prototype.text = function () {
    this.bodyUsed = true;
    return Promise.resolve(this._body);
  };
  MiniResponse.prototype.json = function () {
    return this.text().then(function (t) { return JSON.parse(t); });
  };
  MiniResponse.prototype.clone = function () {
    return new MiniResponse(this.status, this._rawHeaders, this._body);
  };

  function makeResponse(r) {
    var status = Number(r && r.status);
    if (!(status >= 200 && status <= 599)) throw new TypeError('bridge-fetch: the core returned a bad status');
    var headers = (r && r.headers) || {};
    var body = r && r.body != null ? String(r.body) : '';
    if (typeof w.Response === 'function') {
      return new w.Response(NULL_BODY_STATUS[status] ? null : body, { status: status, headers: headers });
    }
    return new MiniResponse(status, headers, body);
  }

  function bridgeFetch(input, init) {
    return Promise.resolve().then(function () {
      init = init || {};
      var isRequest = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.method === 'string';
      var raw = isRequest ? input.url : input instanceof w.URL ? input.href : String(input);
      var path = localPath(raw);
      if (path === null) {
        if (realFetch) return realFetch(input, init);
        throw new TypeError('Failed to fetch');
      }

      var method = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase();
      var headers = Object.assign(headerObject(isRequest ? input.headers : null), headerObject(init.headers));

      var bodyPromise;
      if (init.body !== undefined && init.body !== null) {
        if (typeof init.body === 'string') {
          bodyPromise = Promise.resolve(init.body);
        } else if (typeof w.URLSearchParams === 'function' && init.body instanceof w.URLSearchParams) {
          if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
          bodyPromise = Promise.resolve(init.body.toString());
        } else {
          throw new TypeError('bridge-fetch supports string and URLSearchParams request bodies only');
        }
      } else if (isRequest && method !== 'GET' && method !== 'HEAD') {
        bodyPromise = input.clone().text();
      } else {
        bodyPromise = Promise.resolve(undefined);
      }

      var signal = init.signal || (isRequest ? input.signal : null);
      if (signal && signal.aborted) throw new w.DOMException('The operation was aborted.', 'AbortError');

      return bodyPromise.then(function (body) {
        var call = vmapp.invoke('http', { method: method, path: path, headers: headers, body: body });
        if (signal && typeof signal.addEventListener === 'function') {
          call = Promise.race([
            call,
            new Promise(function (_, reject) {
              signal.addEventListener('abort', function () {
                reject(new w.DOMException('The operation was aborted.', 'AbortError'));
              });
            }),
          ]);
        }
        return call.then(makeResponse, function (err) {
          // like a network failure: fetch rejects with a TypeError
          throw new TypeError('Failed to fetch: ' + (err && err.message ? err.message : err));
        });
      });
    });
  }

  w.fetch = bridgeFetch;
})();
