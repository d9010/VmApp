'use strict';
// Serving the files of an app's own server to its page, natively (SPEC 7 "Files the app's server serves";
// docs/design/ELECTRON-PARITY.md stage 1).
//
// This is Electron's own mechanism. In Electron the main process registers a protocol handler (`protocol.handle(scheme, handler)`): the
// handler gets a standard web `Request` and returns a standard web `Response` whose body is a stream, and the page then loads images, CSS,
// fonts, scripts, <video> and <audio>, @import and fetch() under that scheme with no change at all (Electron's own example for an API is a
// handler that proxies `app://api/...` to a server). Here the "server" is the app's core in its VM. The launcher answers the page's requests
// under the paths the app's page announced (`vmapp.serve`, sent by sdk/web/vmapp-fetch.js) by asking the core over the same bridge
// protocol that script uses (`fetch:open`, `fetch:ev`; sdk/node/http-bridge.js is the core half), and returns the answer as a `Response`.
//
// What it adds to the page: nothing it could not already do (the page may `fetch()` any of these paths over the bridge). What it must not do:
//   - shadow a file of the app's own package: package files are answered first (loader/src/protocols.js), and a package file whose hash does
//     not match is refused, never replaced by what the core says;
//   - widen what the page may ask: the core's bridge still refuses a path outside its prefixes, a method outside its list, a host that is not
//     the loopback, a body above its limit, more than 64 requests at once, and request headers a page must not set;
//   - let a page announce a path that is not a safe prefix (the whole origin, a query, a dot segment): see cleanRoutes.
// It is per app and per run: the requests go through the app's session (hostlib/session.js), by way of one of its open windows (the core
// answers a window), and the core's answers are read with the session's `tapEmit` before they reach the window, so the window never sees them.

const { createFetch } = require('../../sdk/web/vmapp-fetch.js');

const MAX_ROUTES = 16;
const MAX_PREFIX = 200;
const CHANNEL_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,39}$/;
const PREFIX_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const MAX_ACTIVE = 24; // requests in flight at once (the core's bridge refuses more than 64 in all, the page's own fetches included)
const MAX_QUEUE = 4000; // requests waiting for a place; a page cannot make the launcher queue without bound
const HOST_ID = 'h'; // the request ids of the launcher's own requests to the core (a page's own start with 'f': sdk/web/vmapp-fetch.js)
const WAIT_MS = 2500; // how long a request for a file the package lacks waits for the page's announcement, once per run (see covers)

/** The routes a page announced, checked: [{prefix, channel}]. Throws Error with a message for the page's developer. */
function cleanRoutes(routes) {
  if (!Array.isArray(routes) || !routes.length || routes.length > MAX_ROUTES) throw new Error(`vmapp.serve: give 1 to ${MAX_ROUTES} routes`);
  const out = [];
  for (const r of routes) {
    if (!r || typeof r !== 'object' || typeof r.prefix !== 'string' || typeof r.channel !== 'string') throw new Error('vmapp.serve: a route is {prefix, channel}');
    const { prefix, channel } = r;
    if (prefix.length < 2 || prefix.length > MAX_PREFIX || !PREFIX_RE.test(prefix)) throw new Error(`vmapp.serve: ${JSON.stringify(prefix.slice(0, 40))} is not a path prefix of an app's server (it starts with "/" and names something)`);
    if (prefix.split('/').some((c) => c === '..' || c === '.')) throw new Error('vmapp.serve: a prefix has no dot segments');
    if (!CHANNEL_RE.test(channel)) throw new Error(`vmapp.serve: ${JSON.stringify(channel.slice(0, 40))} is not a channel name`);
    out.push({ prefix, channel });
  }
  return out;
}

// Electron's contract for a handler that cannot answer (lib/browser/api/protocol.ts): the page gets a NETWORK error, not an invented HTTP status.
// `Response.error()` is net::ERR_FAILED; an exception or a rejection in the handler is net::ERR_UNEXPECTED (and is logged with console.error).
// fetch() rejects with "Failed to fetch" and an <img> fires `error`, exactly as for a server that is down. The reason goes to the launcher's log.
function networkError() {
  return Response.error();
}

class AppServe {
  /**
   * @param {object} o
   * @param {string} o.appId
   * @param {() => object|null} o.getSession  the running session of the app (hostlib/session.js), or null
   * @param {string} [o.csp]                  added to an HTML answer (a page the core serves is still under the window's policy)
   * @param {boolean} [o.enabled]             false: the app's page is told the launcher does not serve (the page-side layer then does)
   * @param {(m: string) => void} [o.log]
   */
  constructor(o) {
    this.appId = o.appId;
    this.getSession = o.getSession;
    this.csp = o.csp || '';
    this.enabled = o.enabled !== false;
    this.log = o.log || (() => {});
    this.routes = new Map(); // prefix -> channel
    this.active = 0;
    this.queue = [];
    this._sess = null;
    this._f = null;
    this._offs = [];
    this._routesSess = undefined;
    this._announced = false;
    this._waitedOut = false;
    this._waiters = [];
  }

  /** The page says which paths its server serves. Returns true when the launcher will answer them. A later call adds routes. */
  announce(routes) {
    const clean = cleanRoutes(routes);
    if (!this.enabled) return false;
    this._run();
    for (const r of clean) this.routes.set(r.prefix, r.channel);
    this._dispose(); // the next request builds its client with all the routes
    this._announced = true;
    for (const wake of this._waiters.splice(0)) wake();
    return true;
  }

  // routes belong to one run of the app: a new run (a new session) starts from what its own page announces
  _run() {
    const sess = this.getSession();
    if (sess !== this._routesSess) {
      this.routes.clear();
      this._routesSess = sess;
      this._announced = false;
      this._waitedOut = false;
    }
    return sess;
  }

  /** Is `pathname` under a path the page announced? */
  matches(pathname) {
    for (const p of this.routes.keys()) if (pathname.startsWith(p)) return true;
    return false;
  }

  /**
   * Should the launcher answer `pathname` itself? Yes when it is under an announced path. Before the page has announced anything in this run, a
   * request for a file the package does not have waits for the announcement (at most WAIT_MS, once per run): Chromium's preload scanner asks for
   * the <img> and <link> elements that follow a blocking script while that script, `vmapp-fetch.js`, is still loading, and it keeps a refusal.
   * (Electron has no such wait because its protocol handler is registered once, at start-up, before any window exists.)
   */
  async covers(pathname) {
    if (!this.enabled) return false;
    this._run();
    if (this.matches(pathname)) return true;
    if (this._announced || this._waitedOut) return false;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waitedOut = true;
        resolve();
      }, WAIT_MS);
      this._waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.matches(pathname);
  }

  _dispose() {
    for (const off of this._offs.splice(0)) {
      try {
        off();
      } catch {
        /* the session is gone */
      }
    }
    this._f = null;
    this._sess = null;
  }

  /** The app stopped (or the launcher quits): nothing more is answered from this run. */
  close() {
    this._dispose();
    for (const wake of this.queue.splice(0)) wake(null);
    for (const wake of this._waiters.splice(0)) wake();
  }

  _clientFor(sess) {
    if (this._f && this._sess === sess) return this._f;
    this._dispose();
    this._sess = sess;
    const winId = () => {
      const w = sess.windows && [...sess.windows][0];
      if (w === undefined || w === null) throw new Error('the app has no window open');
      return w;
    };
    let f = null;
    const vmapp = {
      invoke: (channel, ...args) => sess.invoke(winId(), channel, args),
      send: (channel, ...args) => sess.send(winId(), channel, args),
      // the core's events of the launcher's requests (ids that start with HOST_ID) are taken here, also the last ones of a request that is already
      // forgotten (an empty answer, a cancelled body); every other event (the page's own fetches: ids that start with 'f') goes on to the window
      on: (channel, fn) => {
        const off = sess.tapEmit(channel, (args) => {
          const ev = args && args[0];
          if (ev && typeof ev.id === 'string' && ev.id.startsWith(HOST_ID)) {
            fn(ev);
            return true;
          }
          return false;
        });
        this._offs.push(off);
        return off;
      },
    };
    f = createFetch({ vmapp, idPrefix: HOST_ID, location: new URL(`vmapp-ui://${this.appId}/`), routes: [...this.routes].map(([prefix, channel]) => ({ prefix, channel })) });
    this._f = f;
    return f;
  }

  _releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next) next(this._releaser());
      else this.active--;
    };
  }

  _acquire() {
    if (this.active < MAX_ACTIVE) {
      this.active++;
      return Promise.resolve(this._releaser());
    }
    if (this.queue.length >= MAX_QUEUE) return Promise.resolve(null);
    return new Promise((resolve) => this.queue.push(resolve));
  }

  /** Electron's contract: a standard Request in, a standard Response (streamed body) out. */
  async handle(request) {
    const sess = this.getSession();
    if (!sess || !sess.windows || !sess.windows.size) {
      this.log(`vmapp-ui: ${this.appId}: ${request.method} ${new URL(request.url).pathname}: the app is not running`);
      return networkError();
    }
    const release = await this._acquire();
    if (!release) {
      this.log(`vmapp-ui: ${this.appId}: too many requests are waiting for the app's server`);
      return networkError();
    }
    let res;
    try {
      res = await this._clientFor(sess).fetch(request);
    } catch (e) {
      release();
      this.log(`vmapp-ui: ${this.appId}: ${request.method} ${new URL(request.url).pathname}: ${e.message}`);
      return networkError();
    }
    const headers = new Headers(res.headers);
    if (this.csp && /^text\/html/i.test(headers.get('content-type') || '')) headers.set('content-security-policy', this.csp);
    if (!res.body) {
      release();
      return new Response(null, { status: res.status, statusText: res.statusText, headers });
    }
    // the place is held until the body is read to its end or cancelled (a video can take long; a closed window cancels it)
    const reader = res.body.getReader();
    const body = new ReadableStream(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              release();
              controller.close();
            } else controller.enqueue(value);
          } catch (e) {
            release();
            controller.error(e);
          }
        },
        cancel(reason) {
          release();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  }
}

module.exports = { AppServe, cleanRoutes, MAX_ACTIVE, MAX_ROUTES };
