'use strict';
/**
 * vmapp-fetch.js: the page half of "HTTP over the bridge" with streamed bodies (docs/CONVERTING.md section 5.3).
 *
 * A vmapp window has no network (CSP connect-src 'none'). This script replaces `window.fetch` for URLs that point at the page's own
 * origin and start with one of the configured prefixes: the request is handed to the core over the bridge, which forwards it to a server
 * on the VM's loopback (sdk/node/http-bridge.js is the other half, and describes the wire protocol), and the answer comes back as a real
 * `Response` whose body is a ReadableStream fed by the core's chunks as the server writes them. Everything else falls through to the
 * original fetch (which the CSP then refuses: the honest result).
 *
 * Load it as the FIRST script of the page, as a classic script (not a module):
 *
 *     <script src="vmapp-fetch.js" data-prefix="/api/"></script>          several prefixes: data-prefix="/api/,/v1/"
 *     <script src="vmapp-fetch.js" data-prefix="/api/" data-route="/ollama/:raw"></script>   a second server on its own channel
 *
 * What it supports:
 *   - every request body fetch accepts: string, URLSearchParams, Blob/File, ArrayBuffer and views, FormData (multipart, with the boundary
 *     fetch would choose), a Request. Bodies are sent in pieces of at most 768 KiB, each piece after the core wrote the previous one.
 *   - streamed answers: `response.body` is a ReadableStream, `response.json()`, `.text()`, `.arrayBuffer()` and `.blob()` work as usual.
 *     Backpressure holds end to end: the core sends at most 256 KiB that the page has not read; a page that stops reading stops the server.
 *   - AbortSignal (`signal` in init or in a Request) and `reader.cancel()`: the connection to the server is destroyed at once, which is
 *     what stops a generation or a download there.
 * What it does not: cookies, redirects (the core returns the server's own 3xx), `credentials`/`mode`/`cache` options (ignored),
 * request bodies that are streams (read them yourself first), WebSocket and EventSource, XMLHttpRequest.
 *
 * Pictures, fonts and media from the core need no code in the app: an <img>, a CSS background or mask, an @font-face, an icon set with
 * element.style..., an <audio> or <video> whose address is under one of the prefixes is fetched over the bridge and shown (docs/CONVERTING.md
 * section 5.3.1; the long comment "Pictures, fonts and media" below lists what is covered and the limits). Options on the script tag:
 *     data-native="off"                   do not ask the launcher to answer these paths itself (vmapp.serve): use this script's own layer
 *     data-media="off"                    turn the script's own picture layer off for this page
 *     data-media="/avatars/,/icons/"      only for these paths (default: every prefix of data-prefix and data-route)
 *     data-media-max-data="16777216"      bytes above which an image becomes a blob: URL instead of a data: URL (fonts above it are refused)
 *     data-media-max-blob="134217728"     bytes above which nothing is shown
 *
 * Also usable as a module in tests: `const { createFetch } = require('./vmapp-fetch.js')`.
 */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  var doc = global && global.document;
  if (doc && doc.currentScript && global.vmapp && typeof global.vmapp.invoke === 'function') {
    var script = doc.currentScript;
    var channel = script.getAttribute('data-channel') || 'fetch';
    var list = function (s) {
      return String(s || '')
        .split(',')
        .map(function (x) {
          return x.trim();
        })
        .filter(Boolean);
    };
    var routes = list(script.getAttribute('data-prefix') || '/api/').map(function (p) {
      return { prefix: p, channel: channel };
    });
    // data-route="/ollama/:raw,/other/:chan": more servers, each on its own channel (the core attaches one http-bridge per channel)
    list(script.getAttribute('data-route')).forEach(function (r) {
      var i = r.lastIndexOf(':');
      if (i > 0) routes.push({ prefix: r.slice(0, i), channel: r.slice(i + 1) });
    });
    // pictures, fonts and media from the core (see "Pictures, fonts and media" below): on by default for every bridged prefix;
    // data-media="off" turns it off, data-media="/avatars/,/icons/" limits it to those paths
    var mediaAttr = (script.getAttribute('data-media') || '').trim();
    var media = false;
    if (mediaAttr.toLowerCase() !== 'off') {
      media = {};
      if (mediaAttr && mediaAttr.toLowerCase() !== 'on') media.only = list(mediaAttr);
      var maxData = Number(script.getAttribute('data-media-max-data'));
      var maxBlob = Number(script.getAttribute('data-media-max-blob'));
      if (maxData > 0) media.maxDataBytes = maxData;
      if (maxBlob > 0) media.maxBlobBytes = maxBlob;
    }
    // First choice: tell the launcher which paths the app's server serves. A launcher that knows (vmapp.serve) answers requests under them itself,
    // the way an Electron main process does with protocol.handle: every <img>, CSS url(), font, <video>, <link> and fetch() under them just works, and
    // this script's own picture layer has nothing to do. An older launcher has no vmapp.serve (or answers false): the layer below does the work.
    var native = false;
    if ((script.getAttribute('data-native') || '').toLowerCase() !== 'off' && typeof global.vmapp.serve === 'function') {
      try {
        native = global.vmapp.serve(routes) === true;
      } catch (e) {
        native = false;
      }
    }
    api.install({ routes: routes, media: native ? false : media });
  }
})(typeof window !== 'undefined' ? window : undefined, function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  var PART_BYTES = 768 * 1024;
  var NULL_BODY = { 101: 1, 103: 1, 204: 1, 205: 1, 304: 1 };

  function bytesToBase64(u8) {
    var out = '';
    for (var i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return g.btoa(out);
  }

  function base64ToBytes(b64) {
    var bin = g.atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function abortError() {
    if (typeof g.DOMException === 'function') return new g.DOMException('The operation was aborted.', 'AbortError');
    var e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    return e;
  }

  var counter = 0;
  // A request's id says whose it is: 'f' for a page's own fetch, and whatever `idPrefix` is for another client of the same core (the launcher,
  // loader/src/app-serve.js, uses 'h'), so that each side can tell its own events from the other's even after a request has been forgotten.
  function newId(prefix) {
    counter += 1;
    return (prefix || 'f') + counter.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * @param {object} o
   * @param {object} o.vmapp         the bridge: {invoke(channel, ...args) -> Promise, send(channel, ...args), on(channel, fn) -> off}
   * @param {{href:string, protocol:string, host:string}} o.location   the page's location (default: globalThis.location)
   * @param {string[]} [o.prefixes]  paths that go over the bridge (default ['/api/'])
   * @param {string} [o.channel]     channel prefix, the same as the core's (default 'fetch')
   * @param {{prefix:string, channel:string}[]} [o.routes]   instead of prefixes + channel: several servers, one channel each
   * @param {Function} [o.realFetch] what everything else goes to (default: the fetch that was there)
   * @param {string} [o.idPrefix]    first letter(s) of this client's request ids (default 'f'); a second client of the same core must use another
   * @returns {{fetch: Function, pending: Map}}
   */
  function createFetch(o) {
    var vmapp = o.vmapp;
    var location = o.location || g.location;
    var pageHostname = location.hostname || String(location.host || '').replace(/:\d+$/, '');
    // routes: which paths go over which bridge channel (one http-bridge.js instance in the core per channel)
    var routes =
      o.routes ||
      (o.prefixes || ['/api/']).map(function (p) {
        return { prefix: p, channel: o.channel || 'fetch' };
      });
    var realFetch = o.realFetch || null;
    var encoder = new g.TextEncoder();
    var pending = new Map();

    function ch(entry, name) {
      return entry.channel + ':' + name;
    }
    function routeOf(pathname) {
      for (var i = 0; i < routes.length; i++) if (pathname.indexOf(routes[i].prefix) === 0) return routes[i];
      return null;
    }
    // The route a URL (absolute or relative to the page) belongs to, or null when it is not one of the page's bridged addresses.
    // The page's own origin; the port is not compared (see bridgeFetch).
    function routeFor(raw) {
      var u;
      try {
        u = new g.URL(String(raw), location.href);
      } catch (e) {
        return null;
      }
      return u.protocol === location.protocol && u.hostname === pageHostname ? routeOf(u.pathname) : null;
    }

    // ---- events from the core
    function wake(entry) {
      var w = entry.wake;
      entry.wake = null;
      if (w) w();
    }

    function onEvent(ev) {
      var entry = ev && pending.get(ev.id);
      if (!entry) return; // a late event of a request that is over
      if (ev.t === 'head') {
        entry.gotHead = true;
        entry.headResolve(ev);
      } else if (ev.t === 'data') {
        var bytes = ev.enc === 't' ? encoder.encode(ev.d) : base64ToBytes(ev.d);
        entry.queue.push({ bytes: bytes, n: Number(ev.n) || bytes.length });
        wake(entry);
      } else if (ev.t === 'end') {
        entry.ended = true;
        wake(entry);
        if (!entry.queue.length) pending.delete(entry.id);
      } else if (ev.t === 'error') {
        var err = new TypeError('Failed to fetch: ' + (ev.message || 'network error'));
        if (!entry.gotHead) {
          entry.headReject(err);
          pending.delete(entry.id);
        } else {
          entry.failure = err;
          wake(entry);
          pending.delete(entry.id);
        }
      }
    }
    var subscribed = {};
    routes.forEach(function (r) {
      if (subscribed[r.channel]) return;
      subscribed[r.channel] = true;
      vmapp.on(r.channel + ':ev', onEvent);
    });

    function abort(entry, err) {
      if (entry.over) return;
      entry.over = true;
      pending.delete(entry.id);
      try {
        vmapp.send(ch(entry, 'abort'), { id: entry.id });
      } catch (e) {
        /* the bridge is gone */
      }
      if (!entry.gotHead) entry.headReject(err || abortError());
      else {
        entry.failure = err || abortError();
        wake(entry);
      }
    }

    // ---- the answer as a stream
    function makeStream(entry) {
      return new g.ReadableStream(
        {
          pull: function (controller) {
            function next() {
              if (entry.queue.length) {
                var chunk = entry.queue.shift();
                controller.enqueue(chunk.bytes);
                if (!entry.over) {
                  try {
                    vmapp.send(ch(entry, 'ack'), { id: entry.id, n: chunk.n });
                  } catch (e) {
                    /* the bridge is gone */
                  }
                }
                return undefined;
              }
              if (entry.failure) {
                controller.error(entry.failure);
                return undefined;
              }
              if (entry.ended) {
                entry.over = true;
                pending.delete(entry.id);
                controller.close();
                return undefined;
              }
              return new Promise(function (resolve) {
                entry.wake = resolve;
              }).then(next);
            }
            return next();
          },
          cancel: function () {
            abort(entry, abortError());
          },
        },
        { highWaterMark: 0 },
      );
    }

    // ---- the request
    function bridgeFetch(input, init) {
      return Promise.resolve().then(function () {
        var raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
        var u;
        try {
          u = new g.URL(raw, location.href);
        } catch (e) {
          u = null;
        }
        // The page's own origin. The port is not compared: a window's origin has no port (vmapp-ui://<app id>), and HTTP client libraries
        // add one (ollama-js turns "vmapp-ui://app" into "vmapp-ui://app:80"); no other server answers on this host name anyway.
        var route = u && u.protocol === location.protocol && u.hostname === pageHostname ? routeOf(u.pathname) : null;
        if (!route) {
          if (realFetch) return realFetch(input, init);
          throw new TypeError('Failed to fetch');
        }

        // Request normalises every kind of init and body (FormData gets its boundary, URLSearchParams its content type, ...).
        var req = typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function' ? new g.Request(input, init) : new g.Request(u.href, init);
        var method = req.method.toUpperCase();
        var signal = req.signal;
        if (signal && signal.aborted) throw abortError();

        var headers = {};
        req.headers.forEach(function (value, name) {
          headers[String(name).toLowerCase()] = String(value);
        });

        var textBody = init && typeof init.body === 'string' ? init.body : null;
        var bodyPromise;
        if (method === 'GET' || method === 'HEAD') bodyPromise = Promise.resolve(null);
        else if (textBody !== null) bodyPromise = Promise.resolve(null);
        else bodyPromise = req.arrayBuffer().then(function (ab) {
          return new Uint8Array(ab);
        });

        return bodyPromise.then(function (bytes) {
          var id = newId(o.idPrefix);
          var entry = {
            id: id, channel: route.channel, queue: [], ended: false, over: false, gotHead: false, failure: null, wake: null,
            headResolve: null, headReject: null,
          };
          var headP = new Promise(function (resolve, reject) {
            entry.headResolve = resolve;
            entry.headReject = reject;
          });
          pending.set(id, entry);
          if (signal) {
            signal.addEventListener('abort', function () {
              abort(entry, abortError());
            });
          }

          var openArgs = { id: id, method: method, path: u.pathname + u.search, headers: headers, length: 0 };
          var rest = null;
          if (textBody !== null) {
            openArgs.length = encoder.encode(textBody).length;
            if (openArgs.length <= PART_BYTES) openArgs.text = textBody;
            else rest = encoder.encode(textBody);
          } else if (bytes && bytes.length) {
            openArgs.length = bytes.length;
            if (bytes.length <= PART_BYTES) openArgs.b64 = bytesToBase64(bytes);
            else rest = bytes;
          }

          var sent = vmapp.invoke(ch(entry, 'open'), openArgs).then(function () {
            if (!rest) return undefined;
            var chain = Promise.resolve();
            var _loop = function (off) {
              chain = chain.then(function () {
                if (entry.over) return undefined;
                return vmapp.invoke(ch(entry, 'part'), { id: id, b64: bytesToBase64(rest.subarray(off, Math.min(off + PART_BYTES, rest.length))) });
              });
            };
            for (var off = 0; off < rest.length; off += PART_BYTES) _loop(off);
            return chain;
          });
          sent.catch(function (err) {
            abort(entry, new TypeError('Failed to fetch: ' + (err && err.message ? err.message : err)));
          });

          return headP.then(function (head) {
            var status = Number(head.status);
            var body = NULL_BODY[status] || method === 'HEAD' ? null : makeStream(entry);
            if (!body) {
              entry.over = true;
              pending.delete(id);
            }
            var res = new g.Response(body, { status: status, statusText: head.statusText || '', headers: head.headers || [] });
            try {
              Object.defineProperty(res, 'url', { value: u.href });
            } catch (e) {
              /* read-only in this environment: the url stays empty */
            }
            return res;
          });
        });
      });
    }

    return { fetch: bridgeFetch, pending: pending, routeFor: routeFor, routes: routes };
  }

  // =============================================================================================================================
  // Pictures, fonts and media that come from the core (the page half's second job; docs/CONVERTING.md section 5.3.1)
  //
  // The window's CSP lets a page load only its own package (and data:/blob: for images and fonts). A picture, a font or a sound that the
  // app's SERVER serves, at an address under one of the bridged prefixes, can therefore be fetched (over the bridge, above) but not shown:
  // `<img src="/api/avatar/7">`, `background-image: url(/assets/logo.svg)`, `@font-face { src: url(/fonts/x.woff2) }`, an icon that a
  // toolbar sets as `button.style.backgroundImage`. This part watches the page and, for every such address, fetches the file over the
  // bridge and puts a data: URL (images, fonts) or a blob: URL (big images, audio and video) in its place. Nothing in the app has to know.
  //
  //   where     <img src|srcset>, <source src|srcset> (picture, audio, video), <input type=image>, <audio|video src>, <video poster>,
  //             SVG <image href>, <link rel=stylesheet> (inlined), <style> elements and rules added later with insertRule(), constructable and
  //             adopted style sheets, inline style="" and element.style.x = ..., inside shadow roots too
  //   what      only addresses of the page's own origin under a bridged prefix; everything else is left alone
  //   type      the server's Content-Type if it names an image, font, audio or video type; else (none, application/octet-stream, text/plain,
  //             a wrong one) the file's own bytes decide (PNG, JPEG, GIF, WebP, BMP, ICO, SVG, WOFF, WOFF2, TTF, OTF, WAV, OGG, MP3, MP4,
  //             WebM), then the file name's extension
  //   limits    data: up to 16 MiB (images and fonts); an image above that, and audio/video, become blob: URLs up to 128 MiB; a font above
  //             16 MiB cannot (the CSP allows data: only) and is left as it is. Both numbers can be set (data-media-max-data, -max-blob).
  //   when it cannot   the element is left as it was, one console warning names the address, and the element gets the `error` event it would
  //             have got (the app's own onerror fallback then runs)
  // Not covered (give the page a data: URL or an ArrayBuffer yourself): `new FontFace(name, "url(...)")`, @import url() inside a
  // stylesheet, <svg><use href="sprite.svg#id">, <object>, <embed>, <iframe>, scripts (script-src is 'self').
  // Off for a page: <script src="vmapp-fetch.js" data-media="off">; only for some prefixes: data-media="/avatars/,/icons/".
  // =============================================================================================================================
  var MIB = 1024 * 1024;
  var MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    ico: 'image/x-icon', cur: 'image/x-icon', svg: 'image/svg+xml', svgz: 'image/svg+xml',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  };

  function ascii(bytes, from, to) {
    var s = '';
    for (var i = from; i < to && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /** The type of a file from its first bytes, or ''. */
  function sniff(bytes) {
    if (!bytes || bytes.length < 4) return '';
    var b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return 'audio/wav';
    if (b[0] === 0x42 && b[1] === 0x4d && b.length > 14) return 'image/bmp';
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
    if (ascii(b, 0, 4) === 'wOF2') return 'font/woff2';
    if (ascii(b, 0, 4) === 'wOFF') return 'font/woff';
    if (ascii(b, 0, 4) === 'OTTO') return 'font/otf';
    if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return 'font/ttf';
    if (ascii(b, 0, 4) === 'OggS') return 'audio/ogg';
    if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    if (ascii(b, 4, 8) === 'ftyp') return ascii(b, 8, 12) === 'avif' ? 'image/avif' : 'video/mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
    var head = ascii(b, 0, Math.min(b.length, 1024)).replace(/^﻿/, '').replace(/^\s+/, '');
    if (head.indexOf('<svg') >= 0 && /^(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(head)) return 'image/svg+xml';
    return '';
  }

  /** 'image' | 'font' | 'audio' | 'video' | 'css' | '' for a MIME type. */
  function kindOf(mime) {
    var m = String(mime || '').toLowerCase();
    if (/^image\//.test(m)) return 'image';
    if (/^font\//.test(m) || /^application\/(x-)?font-/.test(m) || m === 'application/vnd.ms-fontobject' || m === 'application/x-woff') return 'font';
    if (/^audio\//.test(m)) return 'audio';
    if (/^video\//.test(m) || m === 'application/ogg') return 'video';
    if (m === 'text/css') return 'css';
    return '';
  }

  function extOf(pathname) {
    var m = /\.([A-Za-z0-9]{2,5})$/.exec(String(pathname || '').replace(/[?#].*$/, ''));
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * The MIME type to use for a file: the server's, when it names an image, font, audio or video type; otherwise what the bytes say; otherwise
   * what the file name's extension says; otherwise ''. (A server that answers a picture with application/octet-stream or text/plain is
   * common, and an SVG served as text/xml is not an image to the browser.)
   */
  function resolveMime(contentType, pathname, bytes) {
    var ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    var k = kindOf(ct);
    if (k && k !== 'css') return ct;
    return sniff(bytes) || MIME_BY_EXT[extOf(pathname)] || '';
  }

  var CSS_URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s'"]*))\s*\)/gi;
  var unescapeCss = function (s) {
    return s.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, function (all, c) {
      return /^[0-9a-fA-F]/.test(c) ? String.fromCodePoint(parseInt(c, 16)) : c;
    });
  };

  /**
   * `text` (CSS) with each url(...) of a bridged address replaced by what `lookup(absoluteUrl)` knows: a data:/blob: URL, null (loading
   * failed: left as it is) or undefined (not loaded yet: listed in `missing`, nothing is replaced while any is). `absolute(u)` gives the
   * absolute address of a bridged URL, or '' for any other (left alone).
   */
  function rewriteCssUrls(text, lookup, absolute) {
    var missing = [];
    var failed = false;
    var out = String(text).replace(CSS_URL_RE, function (all, dq, sq, bare) {
      var abs = absolute(unescapeCss(dq !== undefined ? dq : sq !== undefined ? sq : bare || ''));
      if (!abs) return all;
      var v = lookup(abs);
      if (v === undefined) {
        if (missing.indexOf(abs) < 0) missing.push(abs);
        return all;
      }
      if (v === null) {
        failed = true;
        return all;
      }
      return 'url("' + v + '")';
    });
    return { text: missing.length ? String(text) : out, missing: missing, failed: failed };
  }

  /** `srcset` ("a.png 1x, b.png 2x": candidates are separated by a comma and a space) with each bridged address replaced the same way. */
  function rewriteSrcset(value, lookup, absolute) {
    var missing = [];
    var failed = false;
    var out = String(value).split(/,\s+/).map(function (part) {
      var m = /^\s*(\S+)([\s\S]*)$/.exec(part);
      if (!m) return part;
      var abs = absolute(m[1]);
      if (!abs) return part;
      var v = lookup(abs);
      if (v === undefined) {
        if (missing.indexOf(abs) < 0) missing.push(abs);
        return part;
      }
      if (v === null) {
        failed = true;
        return part;
      }
      return v + m[2];
    });
    return { text: missing.length ? String(value) : out.join(', '), missing: missing, failed: failed };
  }

  /** Every relative url(...) of a stylesheet's text made absolute against the stylesheet's own address (before it is inlined). */
  function absolutizeCssUrls(text, base) {
    return String(text).replace(CSS_URL_RE, function (all, dq, sq, bare) {
      var u = unescapeCss(dq !== undefined ? dq : sq !== undefined ? sq : bare || '');
      if (!u || /^(data:|blob:|about:|#)/i.test(u)) return all;
      try {
        return 'url("' + new g.URL(u, base).href + '")';
      } catch (e) {
        return all;
      }
    });
  }

  /**
   * Loads files over the bridge, once each, and says what to show in their place: `get(url)` is the data:/blob: URL, null (could not) or
   * undefined (not loaded yet); `load(url)` loads it. o: {fetch, maxDataBytes, maxBlobBytes, warn, makeBlobUrl}.
   */
  function createMediaLoader(o) {
    var done = new Map();
    var pending = new Map();
    var maxData = o.maxDataBytes || 16 * MIB;
    var maxBlob = o.maxBlobBytes || 128 * MIB;
    var warned = {};
    function fail(url, why) {
      if (!warned[url]) {
        warned[url] = true;
        o.warn('vmapp-fetch: ' + url + ' could not be shown (' + why + '); it is left as it is');
      }
      return null;
    }
    function readCapped(res) {
      if (res.body && typeof res.body.getReader === 'function') {
        var reader = res.body.getReader();
        var chunks = [];
        var total = 0;
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) return concat(chunks, total);
            total += r.value.length;
            if (total > maxBlob) {
              reader.cancel();
              throw new Error('larger than ' + Math.round(maxBlob / MIB) + ' MiB');
            }
            chunks.push(r.value);
            return pump();
          });
        };
        return pump();
      }
      return res.arrayBuffer().then(function (ab) {
        if (ab.byteLength > maxBlob) throw new Error('larger than ' + Math.round(maxBlob / MIB) + ' MiB');
        return new Uint8Array(ab);
      });
    }
    function concat(chunks, total) {
      var out = new Uint8Array(total);
      var off = 0;
      chunks.forEach(function (c) {
        out.set(c, off);
        off += c.length;
      });
      return out;
    }
    // The server's own redirects are followed, as a browser does and as Electron's protocol handler does (it turns a 3xx with a Location into a real
    // redirect): a picture at /avatar/7 that the server redirects to /avatar/7.png is shown. The new address must still be one of the app's server.
    function fetchFollowing(url) {
      var hops = 0;
      function step(u) {
        return Promise.resolve(o.fetch(u)).then(function (res) {
          var loc = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
          if (!loc) return { res: res, url: u };
          if (++hops > 10) throw new Error('too many redirects');
          var next;
          try {
            next = new g.URL(loc, u).href;
          } catch (e) {
            throw new Error('a redirect to an address that is not valid');
          }
          if (o.isBridged && !o.isBridged(next)) throw new Error('a redirect to an address that is not the app\'s server');
          return step(next);
        });
      }
      return step(url);
    }
    function load(url) {
      if (done.has(url)) return Promise.resolve(done.get(url));
      if (pending.has(url)) return pending.get(url);
      var p = Promise.resolve()
        .then(function () {
          return fetchFollowing(url);
        })
        .then(function (got) {
          var res = got.res;
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var ct = res.headers.get('content-type');
          return readCapped(res).then(function (bytes) {
            var mime = resolveMime(ct, new g.URL(got.url).pathname, bytes);
            var kind = kindOf(mime);
            if (kind === 'audio' || kind === 'video') return o.makeBlobUrl(new g.Blob([bytes], { type: mime }));
            if (bytes.length <= maxData) return 'data:' + (mime || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
            if (kind === 'image') return o.makeBlobUrl(new g.Blob([bytes], { type: mime }));
            throw new Error((kind || 'this kind of file') + ' above ' + Math.round(maxData / MIB) + ' MiB cannot be shown (the window allows only data: URLs for it)');
          });
        })
        .catch(function (e) {
          return fail(url, e && e.message ? e.message : String(e));
        })
        .then(function (v) {
          done.set(url, v);
          pending.delete(url);
          return v;
        });
      pending.set(url, p);
      return p;
    }
    return {
      get: function (url) {
        return done.get(url);
      },
      load: load,
    };
  }

  /**
   * Starts watching `w` (a window). o: {routeFor(raw) -> route|null, fetch, prefixes (the bridged prefixes, as hints for the cheap
   * selectors), only (a list of prefixes: media for these only), maxDataBytes, maxBlobBytes}. Returns {stop(), loader}.
   */
  function installMedia(w, o) {
    var d = w.document;
    var Sheet = w.CSSStyleSheet;
    var sheetProto = Sheet && Sheet.prototype;
    if (!d || !w.MutationObserver || !sheetProto) return null;
    var only = o.only && o.only.length ? o.only : null;
    var warn = o.warn || function (m) {
      if (w.console && w.console.warn) w.console.warn(m);
    };
    var loader = createMediaLoader({
      fetch: o.fetch,
      isBridged: function (u) {
        return !!o.routeFor(u);
      },
      maxDataBytes: o.maxDataBytes,
      maxBlobBytes: o.maxBlobBytes,
      warn: warn,
      makeBlobUrl: function (blob) {
        return w.URL.createObjectURL(blob);
      },
    });
    var hints = (o.prefixes || []).filter(Boolean);
    var hint = function (text) {
      for (var i = 0; i < hints.length; i++) if (text.indexOf(hints[i]) >= 0) return true;
      return false;
    };
    var attrHints = function (name, tags) {
      return hints.map(function (p) {
        return tags.map(function (t) {
          return t + '[' + name + '*="' + p.replace(/"/g, '\\"') + '"]';
        }).join(', ');
      }).join(', ');
    };

    // the absolute address of `raw` when it is one the core serves (and media is on for it), else ''
    function absolute(raw, base) {
      if (!raw || /^(data:|blob:|about:|javascript:|#)/i.test(raw)) return '';
      var u;
      try {
        u = new w.URL(String(raw), base || d.baseURI);
      } catch (e) {
        return '';
      }
      var route = o.routeFor(u.href);
      if (!route) return '';
      if (only) {
        var ok = only.some(function (p) {
          return u.pathname.indexOf(p) === 0;
        });
        if (!ok) return '';
      }
      return u.href;
    }
    var abs = function (raw) {
      return absolute(raw);
    };

    // ---- style sheets
    function fixRule(parent, rule) {
      if (!rule) return;
      if (rule.cssRules && rule.cssRules.length && !rule.style) {
        Array.prototype.slice.call(rule.cssRules).forEach(function (child) {
          fixRule(rule, child);
        });
        return;
      }
      var text = rule.cssText;
      if (text.indexOf('url(') < 0 || !hint(text)) return;
      var r = rewriteCssUrls(text, loader.get, abs);
      if (r.missing.length) {
        Promise.all(r.missing.map(loader.load)).then(function () {
          fixRule(parent, rule);
        });
        return;
      }
      if (r.text === text) return;
      var i = Array.prototype.indexOf.call(parent.cssRules, rule);
      if (i < 0) return; // the page removed or replaced it meanwhile
      parent.deleteRule(i);
      if (sheetProto.isPrototypeOf(parent)) origInsertRule.call(parent, r.text, i);
      else parent.insertRule(r.text, i);
    }
    function fixSheet(sheet) {
      var rules;
      try {
        rules = sheet && sheet.cssRules;
      } catch (e) {
        return; // a sheet of another origin
      }
      Array.prototype.slice.call(rules || []).forEach(function (rule) {
        fixRule(sheet, rule);
      });
    }
    var origInsertRule = sheetProto.insertRule;
    sheetProto.insertRule = function (rule, index) {
      var i = origInsertRule.apply(this, arguments);
      if (hint(String(rule))) fixRule(this, this.cssRules[i]);
      return i;
    };
    ['replaceSync', 'replace'].forEach(function (name) {
      var orig = sheetProto[name];
      if (typeof orig !== 'function') return;
      sheetProto[name] = function (text) {
        var self = this;
        var res = orig.apply(this, arguments);
        if (hint(String(text))) {
          if (res && typeof res.then === 'function') res.then(function () {
            fixSheet(self);
          });
          else fixSheet(self);
        }
        return res;
      };
    });

    var styleQueued = new WeakSet();
    function fixStyleElement(el) {
      if (styleQueued.has(el)) return;
      styleQueued.add(el);
      Promise.resolve().then(function () {
        styleQueued.delete(el);
        fixSheet(el.sheet);
      });
    }

    // ---- inline style: element.style.backgroundImage = 'url(...)' and style="..." (the CSSOM, never setAttribute: the CSP is not asked for)
    function fixInlineStyle(el) {
      var st = el.style;
      if (!st || !st.length) return;
      for (var i = 0; i < st.length; i++) {
        var name = st[i];
        var value = st.getPropertyValue(name);
        if (value.indexOf('url(') < 0 || !hint(value)) continue;
        var r = rewriteCssUrls(value, loader.get, abs);
        if (r.missing.length) {
          Promise.all(r.missing.map(loader.load)).then(function () {
            fixInlineStyle(el);
          });
        } else if (r.text !== value) {
          st.setProperty(name, r.text, st.getPropertyPriority(name));
        }
      }
    }

    // ---- elements that show a file by an attribute
    var ATTRS = { IMG: ['src', 'srcset'], SOURCE: ['src', 'srcset'], image: ['href', 'xlink:href'], VIDEO: ['poster', 'src'], AUDIO: ['src'], INPUT: ['src'] };
    var held = new WeakSet(); // images whose first (refused) attempt is hidden from the page while the real one is on its way
    function fixAttr(el, attr) {
      if (el.tagName === 'INPUT' && String(el.type).toLowerCase() !== 'image') return;
      var value = el.getAttribute(attr);
      if (!value || !hint(value)) return;
      var r;
      if (attr === 'srcset') r = rewriteSrcset(value, loader.get, abs);
      else {
        var a = abs(value);
        if (!a) return; // not an address the core serves
        var v = loader.get(a);
        r = { text: typeof v === 'string' ? v : value, missing: v === undefined ? [a] : [], failed: v === null };
      }
      if (r.missing.length) {
        if (el.tagName === 'IMG' || el.tagName === 'image') held.add(el);
        Promise.all(r.missing.map(loader.load)).then(function () {
          if (el.getAttribute(attr) === value) fixAttr(el, attr); // still what we saw
        });
        return;
      }
      if (r.failed && r.text === value) {
        // it could not be loaded: the page gets the error it would have got (its own onerror fallback runs)
        if (held.delete(el)) {
          try {
            el.dispatchEvent(new w.Event('error'));
          } catch (e) {
            /* nothing */
          }
        }
        return;
      }
      if (r.text === value) return;
      held.delete(el);
      el.setAttribute(attr, r.text);
      if (el.tagName === 'SOURCE' && el.parentNode && /^(VIDEO|AUDIO)$/.test(el.parentNode.tagName)) el.parentNode.load();
    }
    // hide the refused first attempt of an image from the page's own onerror (a fallback image, a hidden element) while the file is on its
    // way; only the browser's own event (isTrusted) is hidden, never the one fixAttr sends when the file could not be loaded
    w.addEventListener(
      'error',
      function (ev) {
        var t = (ev.composedPath && ev.composedPath()[0]) || ev.target;
        if (t && held.has(t) && ev.isTrusted) {
          ev.stopImmediatePropagation();
          ev.stopPropagation();
        }
      },
      true,
    );

    // ---- <link rel=stylesheet href=bridged>: style-src is 'self', so the text is fetched and inlined as a <style>
    var linked = new WeakSet();
    function fixLink(link) {
      if (linked.has(link) || !/(^|\s)stylesheet(\s|$)/i.test(link.rel || '')) return;
      var href = link.getAttribute('href') || '';
      var url = hint(href) ? abs(href) : '';
      if (!url) return;
      linked.add(link);
      Promise.resolve(o.fetch(url))
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(function (text) {
          var style = d.createElement('style');
          style.setAttribute('data-vmapp-from', url);
          if (link.media) style.media = link.media;
          style.textContent = absolutizeCssUrls(text, url);
          if (link.parentNode) {
            link.parentNode.insertBefore(style, link);
            link.remove();
          }
          link.dispatchEvent(new w.Event('load'));
        })
        .catch(function (e) {
          linked.delete(link);
          warn('vmapp-fetch: ' + url + ' could not be shown (' + (e && e.message ? e.message : e) + '); it is left as it is');
          link.dispatchEvent(new w.Event('error'));
        });
    }

    var WATCH = ['style', 'link[rel~="stylesheet"]']
      .concat(hints.length ? [attrHints('style', ['*']), attrHints('src', ['img', 'source', 'audio', 'video', 'input']), attrHints('srcset', ['img', 'source']), attrHints('poster', ['video']), attrHints('href', ['image'])] : [])
      .filter(Boolean)
      .join(', ');
    try {
      d.createDocumentFragment().querySelector(WATCH);
    } catch (e) {
      WATCH = 'style, link[rel~="stylesheet"]'; // a prefix that is not a valid selector part: the cheap hints are dropped, the exact checks stay
    }
    function scan(node) {
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'STYLE') fixStyleElement(node);
      else if (tag === 'LINK') fixLink(node);
      else {
        if (ATTRS[tag]) ATTRS[tag].forEach(function (a) {
          if (node.hasAttribute(a)) fixAttr(node, a);
        });
        if (node.hasAttribute('style')) fixInlineStyle(node);
      }
      if (node.shadowRoot) watchRoot(node.shadowRoot);
      if (node.querySelectorAll && WATCH) Array.prototype.forEach.call(node.querySelectorAll(WATCH), scan);
    }
    var observers = [];
    var watched = new WeakSet();
    function watchRoot(root) {
      if (watched.has(root)) return;
      watched.add(root);
      var mo = new w.MutationObserver(function (records) {
        records.forEach(function (rec) {
          if (rec.type === 'attributes') {
            var t = rec.target;
            if (rec.attributeName === 'style') fixInlineStyle(t);
            else if (rec.attributeName === 'href' && t.tagName === 'LINK') fixLink(t);
            else if (ATTRS[t.tagName] && ATTRS[t.tagName].indexOf(rec.attributeName) >= 0) fixAttr(t, rec.attributeName);
            return;
          }
          var owner = rec.type === 'characterData' ? rec.target.parentNode : rec.target;
          if (owner && owner.tagName === 'STYLE') fixStyleElement(owner);
          Array.prototype.forEach.call(rec.addedNodes || [], scan);
        });
      });
      mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'href', 'xlink:href', 'poster', 'style'] });
      observers.push(mo);
      if (root.styleSheets) Array.prototype.forEach.call(root.styleSheets, fixSheet);
      if (root.adoptedStyleSheets) Array.prototype.forEach.call(root.adoptedStyleSheets, fixSheet);
    }
    // shadow roots made later (custom elements, menus, widgets) are watched from their first moment
    var proto = w.Element && w.Element.prototype;
    var origAttach = proto && proto.attachShadow;
    if (origAttach) {
      proto.attachShadow = function () {
        var root = origAttach.apply(this, arguments);
        watchRoot(root);
        return root;
      };
    }
    watchRoot(d);
    scan(d.documentElement);
    return {
      loader: loader,
      stop: function () {
        observers.forEach(function (m) {
          m.disconnect();
        });
        if (origAttach) proto.attachShadow = origAttach;
        sheetProto.insertRule = origInsertRule;
      },
    };
  }

  /** Replaces window.fetch. Options as createFetch; `vmapp` and `location` default to the page's. `media: false` leaves pictures alone. */
  function install(options) {
    var w = (options && options.window) || g;
    var o = Object.assign({ vmapp: w.vmapp, location: w.location, realFetch: typeof w.fetch === 'function' ? w.fetch.bind(w) : null }, options || {});
    if (!o.vmapp || typeof o.vmapp.invoke !== 'function') throw new Error('vmapp-fetch: window.vmapp is not available');
    var f = createFetch(o);
    w.fetch = f.fetch;
    if (o.media !== false && w.document) {
      var m = typeof o.media === 'object' && o.media ? o.media : {};
      f.media = installMedia(w, {
        routeFor: f.routeFor,
        fetch: f.fetch,
        prefixes: f.routes.map(function (r) {
          return r.prefix;
        }),
        only: m.only,
        maxDataBytes: m.maxDataBytes,
        maxBlobBytes: m.maxBlobBytes,
      });
    }
    return f;
  }

  return {
    createFetch: createFetch,
    install: install,
    installMedia: installMedia,
    PART_BYTES: PART_BYTES,
    // exported for tests
    media: { sniff: sniff, kindOf: kindOf, resolveMime: resolveMime, rewriteCssUrls: rewriteCssUrls, rewriteSrcset: rewriteSrcset, absolutizeCssUrls: absolutizeCssUrls, createMediaLoader: createMediaLoader, MIME_BY_EXT: MIME_BY_EXT },
  };
});
