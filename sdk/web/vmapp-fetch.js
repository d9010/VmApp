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
    api.install({ routes: routes });
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
  function newId() {
    counter += 1;
    return 'f' + counter.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * @param {object} o
   * @param {object} o.vmapp         the bridge: {invoke(channel, ...args) -> Promise, send(channel, ...args), on(channel, fn) -> off}
   * @param {{href:string, protocol:string, host:string}} o.location   the page's location (default: globalThis.location)
   * @param {string[]} [o.prefixes]  paths that go over the bridge (default ['/api/'])
   * @param {string} [o.channel]     channel prefix, the same as the core's (default 'fetch')
   * @param {{prefix:string, channel:string}[]} [o.routes]   instead of prefixes + channel: several servers, one channel each
   * @param {Function} [o.realFetch] what everything else goes to (default: the fetch that was there)
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
          var id = newId();
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

    return { fetch: bridgeFetch, pending: pending };
  }

  /** Replaces window.fetch. Options as createFetch; `vmapp` and `location` default to the page's. */
  function install(options) {
    var w = (options && options.window) || g;
    var o = Object.assign({ vmapp: w.vmapp, location: w.location, realFetch: typeof w.fetch === 'function' ? w.fetch.bind(w) : null }, options || {});
    if (!o.vmapp || typeof o.vmapp.invoke !== 'function') throw new Error('vmapp-fetch: window.vmapp is not available');
    var f = createFetch(o);
    w.fetch = f.fetch;
    return f;
  }

  return { createFetch: createFetch, install: install, PART_BYTES: PART_BYTES };
});
