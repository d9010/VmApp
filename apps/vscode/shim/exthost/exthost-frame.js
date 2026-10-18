'use strict';
// exthost-frame.js: the script of the web worker extension host's page (webWorkerExtensionHostIframe.html next to it), which runs in an
// isolated frame vmapp-frame://v--<hash>.exthost/ (SPEC 7 "Isolated frames": its own origin, no window.vmapp, no permission, no network
// but the window's, SPEC 8.3; eval and blob: workers are allowed there by FRAME_CSP, never in the page).
//
// Derived from VS Code 1.142.0 src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html (its inline script; MIT,
// Copyright (c) Microsoft Corporation, ui/LICENSE.vscode.txt). The protocol with the workbench is VS Code's, unchanged: the origin check
// (v--<hash of parentOrigin and salt>), `vscode.bootstrap.nls`, the MessagePort of the extension host, nested workers. What differs:
//   * there is no same-origin mode: the frame starts only in its own v--<hash> origin, for a vmapp-ui:// parent;
//   * the worker's code (extensionHostWorkerMain.js) and _VSCODE_FILE_ROOT are taken from THIS origin (vmapp-frame serves the package's
//     files), not from the page's: a frame may not load scripts from vmapp-ui://;
//   * the worker's fetch() of a URL of the page (what the workbench's resourceUriProvider makes of a vscode-remote:// file: an extension
//     installed on the server) is answered by the page over a MessagePort (vscode-vmapp-shim.js, serveExtensionHostFrames), GET only;
//     the page's own static files come from this origin. Everything else (https, data:, blob:, this origin) is the worker's own fetch.
(function () {
  const searchParams = new URL(document.location.href).searchParams;
  const vscodeWebWorkerExtHostId = searchParams.get('vscodeWebWorkerExtHostId') || '';
  // DO NOT CHANGE the name of the worker (js-debug filters its targets by it, VS Code #232544)
  const name = searchParams.get('debugged') ? 'DebugExtensionHostWorker' : 'ExtensionHostWorker';
  const parentOrigin = searchParams.get('parentOrigin') || '';
  const salt = searchParams.get('salt') || '';
  const ownOrigin = window.origin;
  const FILE_ROOT = ownOrigin + '/static/out/';
  const WORKER_MAIN = FILE_ROOT + 'vs/workbench/api/worker/extensionHostWorkerMain.js';

  function sendError(error) {
    window.parent.postMessage(
      { vscodeWebWorkerExtHostId, error: { name: error ? error.name : '', message: error ? error.message : '', stack: error ? error.stack : [] } },
      '*',
    );
  }

  (async function () {
    const marker = 'v--';
    if (window.parent === window || !/^vmapp-ui:\/\/[^/]+$/.test(parentOrigin) || !location.hostname.startsWith(marker)) {
      return sendError(new Error('Refusing to load: this page runs only in its own v-- origin, framed by the app page.'));
    }
    if (!crypto.subtle) return sendError(new Error('Cannot validate in current context!'));
    // VS Code's parentOriginHash() (src/vs/base/browser/iframe.ts): sha-256 of {parentOrigin, salt}, in base 32
    let hash;
    try {
      const digest = await crypto.subtle.digest('sha-256', new TextEncoder().encode(JSON.stringify({ parentOrigin, salt })));
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      hash = BigInt(`0x${hex}`).toString(32).padStart(52, '0');
    } catch (err) {
      return sendError(err instanceof Error ? err : new Error(String(err)));
    }
    const required = `${marker}${hash}.`;
    if (location.hostname.substring(0, required.length) !== required) return sendError(new Error(`Expected '${required}' as subdomain!`));
    start();
  })();

  function start() {
    // the NLS messages come from the page, as in VS Code (its workerUrl and fileRoot are the page's: not used here)
    window.onmessage = (event) => {
      if (event.source !== window.parent || event.origin !== parentOrigin || !event.data || event.data.type !== 'vscode.bootstrap.nls') return;
      const { data } = event.data;
      createWorker(data.nls.messages, data.nls.language);
    };
    window.parent.postMessage({ vscodeWebWorkerExtHostId, type: 'vscode.bootstrap.nls' }, parentOrigin);
  }

  // Runs IN the worker, before VS Code's extension host (which keeps the fetch it finds as its "native" one). Stringified into the worker's
  // blob: it can use nothing from outside but its arguments.
  function vmappWorkerFetch(pageOrigin, ownOrigin) {
    return new Promise((ready) => {
      self.onmessage = (e) => {
        if (!e.data || e.data.type !== 'vmapp.exthost.fetchPort' || !e.ports || !e.ports[0]) return;
        self.onmessage = null;
        const port = e.ports[0];
        const pending = new Map();
        let seq = 0;
        port.onmessage = (m) => {
          const r = m.data;
          const p = r && pending.get(r.id);
          if (!p) return;
          pending.delete(r.id);
          if (r.error) p.reject(new TypeError(r.error));
          else p.resolve(new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers }));
        };
        const nativeFetch = self.fetch.bind(self);
        self.fetch = function (input, init) {
          const url = input instanceof Request ? input.url : String(input);
          if (!url.startsWith(pageOrigin + '/')) return nativeFetch(input, init);
          const u = new URL(url);
          // the package's own files: this frame's origin serves the same ones
          if (u.pathname.startsWith('/static/')) return nativeFetch(ownOrigin + u.pathname + u.search, init);
          const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
          if (method !== 'GET') return Promise.reject(new TypeError(`${method} ${u.pathname}: only GET of the server's files`));
          return new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            port.postMessage({ id, url: u.href });
          });
        };
        ready();
      };
    });
  }

  function createWorker(nlsMessages, nlsLanguage) {
    try {
      let workerUrl = WORKER_MAIN;
      if (globalThis.crossOriginIsolated) workerUrl += '?vscode-coi=2'; // COEP
      // the page answers the worker's requests for the server's files on this channel (vscode-vmapp-shim.js)
      const files = new MessageChannel();
      window.parent.postMessage({ type: 'vmapp.exthost.fetchPort' }, parentOrigin, [files.port1]);
      const blob = new Blob(
        [
          [
            `/*extensionHostWorker*/`,
            `globalThis._VSCODE_NLS_MESSAGES = ${JSON.stringify(nlsMessages)};`,
            `globalThis._VSCODE_NLS_LANGUAGE = ${JSON.stringify(nlsLanguage)};`,
            `globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(FILE_ROOT)};`,
            `await (${vmappWorkerFetch.toString()})(${JSON.stringify(parentOrigin)}, ${JSON.stringify(ownOrigin)});`,
            `await import(${JSON.stringify(workerUrl)});`,
            `/*extensionHostWorker*/`,
          ].join('\n'),
        ],
        { type: 'application/javascript' },
      );
      const worker = new Worker(URL.createObjectURL(blob), { name, type: 'module' });
      worker.postMessage({ type: 'vmapp.exthost.fetchPort' }, [files.port2]);
      const nestedWorkers = new Map();

      worker.onmessage = (event) => {
        const { data } = event;
        if (data && data.type === '_newWorker') {
          const { id, port, url, options } = data;
          const newWorker = new Worker(url, options);
          newWorker.postMessage(port, [port]);
          newWorker.onerror = console.error.bind(console);
          nestedWorkers.set(id, newWorker);
        } else if (data && data.type === '_terminateWorker') {
          const { id } = data;
          if (nestedWorkers.has(id)) {
            nestedWorkers.get(id).terminate();
            nestedWorkers.delete(id);
          }
        } else {
          worker.onerror = console.error.bind(console);
          window.parent.postMessage({ vscodeWebWorkerExtHostId, data }, parentOrigin, [data]);
        }
      };
      worker.onerror = (event) => {
        console.error(event.message, event.error);
        sendError(event.error);
      };
      window.onmessage = (event) => {
        if (event.source !== window.parent || event.origin !== parentOrigin) return;
        worker.postMessage(event.data, event.ports);
      };
    } catch (err) {
      console.error(err);
      sendError(err);
    }
  }
})();
