'use strict';
// vscode-vmapp-shim.js: what the VS Code Server gave its web workbench, rebuilt on window.vmapp. Loaded by ui/index.html after
// vmapp-fetch.js and before the workbench (which this script loads once it has the configuration).
//
// In a browser the server renders workbench.html: the workbench's configuration as JSON in a <meta> element, two inline scripts
// (`_VSCODE_FILE_ROOT`, a performance mark), then the NLS messages and the workbench as module scripts; the workbench then opens a
// WebSocket to the server and fetches extension resources from it over HTTP. A vmapp page can have no inline script (CSP script-src
// 'self') and no network at all (connect-src 'none'), so:
//
//   server / browser                                     here
//   <meta id="vscode-workbench-web-configuration">       built from the core's `vscode:config` (the authority, the connection token,
//                                                        the folder the user shared) and inserted before the workbench loads
//   inline script: _VSCODE_FILE_ROOT                     set here: the package's ui/static/out/ (the server's /static/out/, same files)
//   new WebSocket('ws://<authority>/?…')                 `webSocketFactory`: a socket over the bridge to core/ws-bridge.js, which opens
//                                                        the same connection on the server in the VM
//   http://<authority>/vscode-remote-resource?path=…     `resourceUriProvider`: the page's own origin. fetch() goes over the bridge
//                                                        (vmapp-fetch.js, prefix /vscode-remote-resource); images and fonts of the
//                                                        built-in extensions come from ui/static/extensions/ (an <img> cannot go over
//                                                        the bridge); those of installed extensions are fetched over the bridge and
//                                                        swapped in as data: URLs (installMediaLoader)
//   window.open(url) (links, "Open in browser")          https links: core -> shell.openExternal, the platform asks the user
//   File > Open Folder… (browses the server's disk)      unchanged, plus "Open Folder from Your Mac…" (a native dialog through the core)
//   webviews at https://*.vscode-cdn.net                 `webviewEndpoint`: vmapp-frame://<uuid>/… isolated frames with their own
//                                                        service worker (SPEC 7 window feature "frames")
//
// The manifest declares the window features workers, wasm, self-fetch and frames (SPEC 7): VS Code's web workers, WebAssembly
// (Oniguruma for TextMate grammars), its own static files fetched from the package, and webviews run as they do in a browser.
//
// The functional options reach the workbench through globalThis.vscodeWebEmbedderOptions (patches/0001-web-embedder-options.patch).
// Nothing here is privileged: everything that touches the host goes through window.vmapp to the app's core.
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (global && global.document && global.vmapp && typeof global.vmapp.invoke === 'function') api.start(global);
})(typeof window !== 'undefined' ? window : undefined, function () {
  // ------------------------------------------------------------------ a tiny Event/Emitter with the shape of VS Code's
  function Emitter() {
    var listeners = [];
    this.event = function (listener, thisArgs, disposables) {
      var entry = { fn: listener, self: thisArgs };
      listeners.push(entry);
      var d = {
        dispose: function () {
          var i = listeners.indexOf(entry);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
      if (Array.isArray(disposables)) disposables.push(d);
      else if (disposables && typeof disposables.add === 'function') disposables.add(d);
      return d;
    };
    this.fire = function (value) {
      listeners.slice().forEach(function (e) {
        try {
          e.fn.call(e.self, value);
        } catch (err) {
          console.error(err);
        }
      });
    };
  }

  function bytesToBase64(u8) {
    var out = '';
    for (var i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(out);
  }

  function base64ToArrayBuffer(b64) {
    var s = atob(b64);
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8.buffer;
  }

  // ------------------------------------------------------------------ the WebSocket over the bridge (IWebSocketFactory)
  // Wire protocol: core/ws-bridge.js. Each socket is one connection of VS Code's remote protocol; VS Code frames its own messages, so
  // chunk boundaries do not matter.
  var SEND_CHUNK = 512 * 1024;

  function createSocketFactory(vmapp) {
    var nextId = 1;
    var sockets = new Map();
    vmapp.on('ws:ev', function (ev) {
      var s = ev && sockets.get(ev.id);
      if (s) s._onEvent(ev);
    });

    function BridgeSocket(url, debugLabel) {
      var self = this;
      this.id = nextId++;
      this.debugLabel = debugLabel;
      this.closed = false;
      this.opened = false;
      var onData = new Emitter();
      var onOpen = new Emitter();
      var onClose = new Emitter();
      var onError = new Emitter();
      this.onData = onData.event;
      this.onOpen = onOpen.event;
      this.onClose = onClose.event;
      this.onError = onError.event;
      sockets.set(this.id, this);

      var u;
      try {
        u = new URL(url);
      } catch (e) {
        u = { pathname: '/', search: '' };
      }
      vmapp.invoke('ws:open', { id: this.id, path: u.pathname || '/', query: String(u.search || '').replace(/^\?/, '') }).then(
        function () {
          if (self.closed) return;
          self.opened = true;
          onOpen.fire();
        },
        function (err) {
          sockets.delete(self.id);
          self.closed = true;
          onError.fire(err instanceof Error ? err : new Error(String(err)));
          onClose.fire({ code: 1006, reason: String((err && err.message) || err), wasClean: false, event: undefined });
        }
      );

      this._onEvent = function (ev) {
        if (ev.t === 'data') {
          if (self.closed) return;
          onData.fire(base64ToArrayBuffer(ev.b64));
          vmapp.send('ws:ack', { id: self.id, n: ev.n });
        } else if (ev.t === 'close') {
          if (self.closed) return;
          self.closed = true;
          sockets.delete(self.id);
          onClose.fire({ code: 1006, reason: String(ev.reason || ''), wasClean: false, event: undefined });
        }
        // 'ack': the core wrote our bytes to the server; nothing to do (the page's sends are small)
      };
    }
    BridgeSocket.prototype.send = function (data) {
      if (this.closed || !this.opened) return;
      var u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      for (var i = 0; i < u8.length; i += SEND_CHUNK) {
        this._send(u8.subarray(i, i + SEND_CHUNK));
      }
    };
    BridgeSocket.prototype._send = function (part) {
      vmapp.send('ws:data', { id: this.id, b64: bytesToBase64(part) });
    };
    BridgeSocket.prototype.close = function () {
      if (this.closed) return;
      this.closed = true;
      sockets.delete(this.id);
      vmapp.send('ws:close', { id: this.id });
    };

    return {
      create: function (url, debugLabel) {
        return new BridgeSocket(url, debugLabel);
      },
      get size() {
        return sockets.size;
      },
    };
  }

  // ------------------------------------------------------------------ resources of the server (IResourceUriProvider)
  var MEDIA = /\.(png|svg|jpe?g|gif|webp|woff2?|ttf|otf)$/i;

  /** The URL (on the page's own origin) of a file of the server: what RemoteAuthorities would have made of vscode-remote://…/path. */
  function resourcePath(fsPath, token, builtinExtensionsPath) {
    var prefix = builtinExtensionsPath.replace(/\/+$/, '') + '/';
    if (fsPath.indexOf(prefix) === 0 && MEDIA.test(fsPath)) {
      // a picture or a font of a built-in extension: the copy in the package (ui/static/extensions/), which <img> and @font-face can load
      return { path: '/static/extensions/' + fsPath.slice(prefix.length), query: '' };
    }
    return { path: '/vscode-remote-resource', query: 'path=' + encodeURIComponent(fsPath) + '&tkn=' + encodeURIComponent(token) };
  }

  // ------------------------------------------------------------------ pictures and fonts of installed extensions
  // resourcePath() above sends those to /vscode-remote-resource, which only fetch() can reach (over the bridge): the page's CSS
  // (`mask: url(…)` of an activity bar icon, `background-image` of a tab icon, `@font-face`) and its <img> elements cannot. The
  // workbench builds those URLs synchronously, so they are fixed up afterwards: each one is fetched over the bridge and replaced by a
  // data: URL, which the window's CSP allows for images and fonts (blob: it does not allow for fonts).
  var MEDIA_URL_IN_CSS = /url\(\s*(["']?)([^"')]*\/vscode-remote-resource\?[^"')]*)\1\s*\)/g;
  var MEDIA_MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
  var MEDIA_MAX_BYTES = 2 * 1024 * 1024; // a larger file stays as it is (and does not load)

  /** The extension (lower case) of the file a vscode-remote-resource URL asks for when it is a picture or a font, else ''. */
  function mediaExt(url) {
    var path = '';
    try {
      path = new URL(url).searchParams.get('path') || '';
    } catch (e) {
      return '';
    }
    var m = MEDIA.exec(path);
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * `text` (CSS) with each url(…) of a vscode-remote-resource picture replaced by what `lookup(url)` knows: a data: URL, or null when
   * loading failed (left as it is). `missing` lists the URLs `lookup` has not loaded yet (undefined): nothing is replaced while any is.
   */
  function rewriteMediaCss(text, lookup) {
    var missing = [];
    var out = text.replace(MEDIA_URL_IN_CSS, function (all, quote, url) {
      if (!mediaExt(url)) return all;
      var data = lookup(url);
      if (data === undefined) {
        if (missing.indexOf(url) < 0) missing.push(url);
        return all;
      }
      return data === null ? all : 'url("' + data + '")';
    });
    return { text: missing.length ? text : out, missing: missing };
  }

  /** Loads pictures over the bridge once each: `get(url)` is the data: URL, null (failed) or undefined (not loaded yet). */
  function createMediaLoader(w) {
    var done = new Map();
    var pending = new Map();
    return {
      get: function (url) {
        return done.get(url);
      },
      load: function (url) {
        if (pending.has(url)) return pending.get(url);
        var ext = mediaExt(url);
        var p = !ext
          ? Promise.resolve(null)
          : w
              .fetch(url)
              .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
              })
              .then(function (buf) {
                return buf.byteLength > MEDIA_MAX_BYTES ? null : 'data:' + MEDIA_MIME[ext] + ';base64,' + bytesToBase64(new Uint8Array(buf));
              })
              .catch(function () {
                return null;
              })
              .then(function (data) {
                done.set(url, data);
                return data;
              });
        pending.set(url, p);
        return p;
      },
    };
  }

  function installMediaLoader(w) {
    var d = w.document;
    var sheetProto = w.CSSStyleSheet && w.CSSStyleSheet.prototype;
    if (!sheetProto || !w.MutationObserver) return;
    var media = createMediaLoader(w);
    var insertRule = sheetProto.insertRule;

    /** `rule` (in `parent`: a style sheet or a grouping rule) with its remote pictures replaced, as soon as they are loaded. */
    function fixRule(parent, rule) {
      if (!rule) return;
      if (rule.cssRules && rule.cssRules.length) {
        Array.prototype.slice.call(rule.cssRules).forEach(function (child) {
          fixRule(rule, child);
        });
        return;
      }
      var text = rule.cssText;
      if (text.indexOf('vscode-remote-resource') < 0) return;
      var r = rewriteMediaCss(text, media.get);
      if (r.missing.length) {
        Promise.all(r.missing.map(media.load)).then(function () {
          fixRule(parent, rule);
        });
        return;
      }
      if (r.text === text) return;
      var i = Array.prototype.indexOf.call(parent.cssRules, rule);
      if (i < 0) return; // the workbench removed or replaced it meanwhile
      parent.deleteRule(i);
      if (sheetProto.isPrototypeOf(parent)) insertRule.call(parent, r.text, i);
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

    function fixImage(img) {
      var src = img.getAttribute('src') || '';
      if (src.indexOf('/vscode-remote-resource?') < 0 || !mediaExt(src)) return;
      media.load(src).then(function (data) {
        if (data && img.getAttribute('src') === src) img.setAttribute('src', data);
      });
    }

    // the workbench inserts most of its icon rules one by one (createCSSRule), at the index it passes
    sheetProto.insertRule = function (rule, index) {
      var i = insertRule.apply(this, arguments);
      if (String(rule).indexOf('vscode-remote-resource') >= 0) fixRule(this, this.cssRules[i]);
      return i;
    };

    // … and some by the text of a <style> element (tab icons of webviews, say), and pictures as <img> elements
    var styleQueued = new WeakSet();
    function fixStyle(el) {
      if (styleQueued.has(el)) return;
      styleQueued.add(el);
      Promise.resolve().then(function () {
        styleQueued.delete(el);
        fixSheet(el.sheet);
      });
    }
    function scan(node) {
      if (node.nodeType !== 1) return;
      if (node.tagName === 'STYLE') fixStyle(node);
      else if (node.tagName === 'IMG') fixImage(node);
      else if (node.querySelectorAll) {
        Array.prototype.forEach.call(node.querySelectorAll('style, img[src*="vscode-remote-resource"]'), scan);
      }
    }
    new w.MutationObserver(function (records) {
      records.forEach(function (rec) {
        if (rec.type === 'attributes') {
          if (rec.target.tagName === 'IMG') fixImage(rec.target);
          return;
        }
        var owner = rec.type === 'characterData' ? rec.target.parentNode : rec.target;
        if (owner && owner.tagName === 'STYLE') fixStyle(owner);
        Array.prototype.forEach.call(rec.addedNodes || [], scan);
      });
    }).observe(d.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src'] });
  }

  // ------------------------------------------------------------------ the page
  function start(w) {
    var d = w.document;
    var vmapp = w.vmapp;
    try {
      w.performance.mark('code/didStartRenderer');
    } catch (e) {
      /* ignore */
    }
    var origin = w.location.protocol + '//' + w.location.host;
    w._VSCODE_FILE_ROOT = origin + '/static/out/';
    serveExtensionHostFrames(w); // [step 14] the web worker extension host's frame asks this page for the server's files
    installMediaLoader(w); // the pictures and fonts of installed extensions (activity bar and tab icons), which CSS and <img> cannot fetch over the bridge

    // links leave the page through the core (https only; the platform asks the user). VS Code opens them with window.open(url,
    // '_blank', 'noopener'); everything else window.open could do is refused by the platform anyway.
    w.open = function (url) {
      var href;
      try {
        href = new URL(String(url), w.location.href).href;
      } catch (e) {
        return null;
      }
      // [step 18] this page with another folder, workspace or an empty window: a second app window (openAppWindow, below)
      if (isWorkbenchHref(w, href)) return openAppWindow(vmapp, href);
      // https, or a forwarded port on this Mac's localhost ("Open in Browser" in the Ports view)
      if (/^https:/i.test(href) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(href)) {
        vmapp.invoke('vscode:open-external', { url: href }).catch(function (err) {
          console.warn('vscode: could not open', href, err && err.message);
        });
      } else {
        console.warn('vscode: only https links can be opened from this window:', href);
      }
      return null;
    };

    function fail(message) {
      var box = d.getElementById('vscode-startup-fallback');
      if (box) {
        box.style.visibility = 'visible';
        box.style.animation = 'none';
        box.innerHTML = '';
        var h = d.createElement('h1');
        h.textContent = 'The editor could not start';
        var p = d.createElement('p');
        p.textContent = message;
        box.appendChild(h);
        box.appendChild(p);
      }
    }

    function load(src) {
      var s = d.createElement('script');
      s.type = 'module';
      s.async = false; // in order: the NLS messages before the workbench
      s.src = src;
      d.body.appendChild(s);
    }

    vmapp.invoke('vscode:config').then(function (cfg) {
      if (!cfg.serverReady) {
        fail('The VS Code server did not start in the VM' + (cfg.serverError ? ': ' + cfg.serverError : '.') + ' Restart the app; the app log in the loader has the details.');
        return;
      }
      applyWindowLocation(w, cfg); // [step 18] a new window's ?folder=/?ew= (before the workbench reads the URL)
      var authority = cfg.remoteAuthority;
      var config = {
        remoteAuthority: authority,
        connectionToken: cfg.connectionToken,
        // the folder: the one in the URL (?folder=, VS Code's own WorkspaceProvider), else the one shared at the first launch
        folderUri: cfg.folder ? { scheme: 'vscode-remote', authority: authority, path: cfg.folder } : undefined,
        callbackRoute: '/callback',
        enableWorkspaceTrust: true,
        _wrapWebWorkerExtHostInIframe: false,
        windowIndicator: { label: '$(vm) VM', tooltip: 'Code - OSS runs in its own VM: it sees only the folders you share with it' },
        // the extension marketplace the user chose (core/main.js GALLERIES; Open VSX by default): the workbench gives it to the server too
        // [step 14] webEndpointUrlTemplate: the web worker extension host (browser-only extensions) in an isolated frame
        // vmapp-frame://v--<hash>.exthost/, its host page ui/vmapp-exthost/… (shim/exthost/; patch 0006, serveExtensionHostFrames below)
        productConfiguration: { embedderIdentifier: 'vmapp', extensionsGallery: cfg.gallery && cfg.gallery.extensionsGallery, webEndpointUrlTemplate: EXTHOST_ENDPOINT },
        // webviews (Markdown preview, extension pages, image preview, notebooks): each in its own isolated frame, one origin per webview
        // (SPEC 7 "Isolated frames"; the manifest declares "frames"). The page is VS Code's own pre/index.html from the package.
        webviewEndpoint: 'vmapp-frame://{{uuid}}/static/out/vs/workbench/contrib/webview/browser/pre/',
        configurationDefaults: {
          // [step 14] every extension installed on the server runs in the server's extension host in the VM; the web worker host (in
          // its isolated frame) starts only when a browser-only extension needs it (VS Code's default, made lazy in a remote window
          // by patch 0004; `false` turns it off)
          'extensions.webWorker': 'auto',
          // the built-in extensions that could also run in the page run in the server's extension host (core/main.js, serverExtensions)
          'remote.extensionKind': Object.fromEntries((cfg.serverExtensions || []).map(function (id) {
            return [id, ['workspace', '-web']];
          })),
          // Chat needs the Copilot extension, a GitHub account and network access, none of which this app has (CONVERSION.md)
          'chat.disableAIFeatures': true,
        },
      };
      var meta = d.createElement('meta');
      meta.id = 'vscode-workbench-web-configuration';
      meta.setAttribute('data-settings', JSON.stringify(config));
      d.head.appendChild(meta);

      var sockets = createSocketFactory(vmapp);
      w.vscodeWebEmbedderOptions = {
        webSocketFactory: sockets,
        resourceUriProvider: function (uri) {
          var r = resourcePath(uri.path, cfg.connectionToken, cfg.builtinExtensionsPath);
          return uri.with({ scheme: w.location.protocol.replace(/:$/, ''), authority: w.location.host, path: r.path, query: r.query, fragment: '' });
        },
        commands: [
          createDownloadCommand(vmapp), // [step 18] the Explorer's Download… saves on the Mac through the core
          {
            id: 'vmapp.openFolderFromMac',
            label: 'Open Folder from Your Mac…',
            menu: [0 /* Menu.CommandPalette */, 1 /* Menu.StatusBarWindowIndicatorMenu */],
            handler: function () {
              return vmapp.invoke('vscode:pick-folder', { title: 'Open Folder' }).then(function (r) {
                if (r && r.path) w.location.href = origin + '/index.html?folder=' + encodeURIComponent(r.path).replace(/%2F/g, '/');
                return r && r.path;
              });
            },
          },
          // the marketplace: both are offered; the window reloads with the one chosen (the workbench reads it at start)
          {
            id: 'vmapp.useOpenVsx',
            label: 'Extensions: Use the Open VSX Registry' + (cfg.gallery && cfg.gallery.id === 'open-vsx' ? ' (in use)' : ''),
            menu: [0 /* Menu.CommandPalette */],
            handler: function () {
              return vmapp.invoke('vscode:set-gallery', { gallery: 'open-vsx' }).then(function () {
                w.location.reload();
              });
            },
          },
          {
            id: 'vmapp.useMicrosoftMarketplace',
            label: 'Extensions: Use the Visual Studio Marketplace' + (cfg.gallery && cfg.gallery.id === 'microsoft' ? ' (in use)' : ''),
            menu: [0 /* Menu.CommandPalette */],
            handler: function () {
              return vmapp.invoke('vscode:set-gallery', { gallery: 'microsoft' }).then(function () {
                w.location.reload();
              });
            },
          },
        ],
        // VS Code's menu bar in the Mac menu bar (patch 0005: the workbench gives it as data, as the desktop does to Electron)
        nativeMenubar: vmapp.menu ? createNativeMenubar(vmapp) : undefined,
        // the Ports view (SPEC 8.8): VS Code's own port detection and "Forward a Port" open the VM's port on this Mac's localhost
        tunnelProvider: createTunnelProvider(vmapp),
      };

      load(origin + '/static/out/nls.messages.js');
      try {
        w.performance.mark('code/willLoadWorkbenchMain');
      } catch (e) {
        /* ignore */
      }
      load(origin + '/static/out/vs/code/browser/workbench/workbench.js');
    }, function (err) {
      fail(String((err && err.message) || err));
    });
  }

  /**
   * The embedder's native menu bar for VS Code (patch 0005, IEmbedderMenubar): the workbench's IMenubarData becomes a vmapp menu
   * template (SPEC 7 "Menus"), shown in the Mac menu bar while the window is focused; a click runs the command in the workbench.
   * As VS Code's desktop menu does on macOS: no mnemonics, cut/copy/paste are the native roles, keybindings are the accelerators
   * (chords cannot be: they are left out). If the platform refuses a shortcut, the menus are shown without shortcuts.
   */
  function createNativeMenubar(vmapp) {
    var ROLES = { 'editor.action.clipboardCutAction': 'cut', 'editor.action.clipboardCopyAction': 'copy', 'editor.action.clipboardPasteAction': 'paste' };
    var listeners = [];
    var items = {}; // template id -> { id: command id, uri?, remoteAuthority? }
    vmapp.menu.onClick(function (tid) {
      var it = items[tid];
      if (!it) return;
      listeners.slice().forEach(function (fn) {
        fn(it.id, it.uri ? { uri: it.uri, remoteAuthority: it.remoteAuthority } : undefined);
      });
    });
    var clean = function (label) {
      return String(label || '').replace(/&&/g, '').slice(0, 120);
    };
    function toTemplate(data, withKeys) {
      var seq = 0;
      var map = {};
      var conv = function (list) {
        var out = [];
        (list || []).forEach(function (it) {
          if (it.id === 'vscode.menubar.separator') {
            if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' });
            return;
          }
          if (it.submenu) {
            var sub = conv(it.submenu.items);
            if (sub.length) out.push({ type: 'submenu', label: clean(it.label), submenu: sub });
            return;
          }
          if (ROLES[it.id]) {
            out.push({ role: ROLES[it.id], label: clean(it.label) });
            return;
          }
          var tid = 'm' + ++seq;
          map[tid] = { id: it.id, uri: it.uri, remoteAuthority: it.remoteAuthority };
          var item = { id: tid, label: clean(it.label) };
          if (it.enabled === false) item.enabled = false;
          if (it.checked) {
            item.type = 'checkbox';
            item.checked = true;
          }
          var kb = withKeys && data.keybindings ? data.keybindings[it.id] : null;
          if (kb && kb.isNative !== false && typeof kb.label === 'string') item.accelerator = kb.label;
          out.push(item);
        });
        while (out.length && out[out.length - 1].type === 'separator') out.pop();
        return out;
      };
      var menus = Object.keys(data.menus || {}).map(function (title) {
        return { label: clean(title), submenu: conv(data.menus[title].items) };
      });
      return { menus: menus, map: map };
    }
    return {
      update: function (data) {
        var t = toTemplate(data, true);
        vmapp.menu.set(t.menus).then(
          function () {
            items = t.map;
          },
          function (e) {
            console.warn('D9010 VmApp: the menu bar with shortcuts was refused (' + e.message + '); showing it without them');
            var plain = toTemplate(data, false);
            return vmapp.menu.set(plain.menus).then(function () {
              items = plain.map;
            });
          },
        );
      },
      onDidRun: function (fn) {
        listeners.push(fn);
        return {
          dispose: function () {
            listeners = listeners.filter(function (x) {
              return x !== fn;
            });
          },
        };
      },
    };
  }

  /**
   * The web workbench's tunnel factory (IWorkbenchConstructionOptions.tunnelProvider): a forwarded port is the platform's port forward
   * (SPEC 8.8, the device "ports"), made by the core (`vscode:forward-port`). VS Code shows it in the Ports view as localhost:<port>,
   * opens it with "Open in Browser" (a link the platform accepts while the port is forwarded), and disposes it with "Stop Forwarding".
   */
  function createTunnelProvider(vmapp) {
    return {
      tunnelFactory: function (options) {
        var remote = options && options.remoteAddress ? options.remoteAddress : {};
        return vmapp.invoke('vscode:forward-port', { port: remote.port, host: remote.host }).then(function (r) {
          var onDidDispose = new Emitter();
          var disposed = false;
          return {
            remoteAddress: { port: remote.port, host: remote.host },
            localAddress: 'localhost:' + r.hostPort,
            privacy: 'private',
            protocol: options.protocol || 'http',
            onDidDispose: onDidDispose.event,
            dispose: function () {
              if (disposed) return;
              disposed = true;
              return vmapp.invoke('vscode:close-port', { port: remote.port }).then(
                function () {
                  onDidDispose.fire();
                },
                function () {
                  onDidDispose.fire();
                },
              );
            },
          };
        });
      },
      features: { elevation: false, privacyOptions: [], protocol: true },
    };
  }

  // ================================================================== New Window and Download to the Mac (DEV-APPS §11 step 18)
  // Both go through the core: a page cannot open a window (window.open is denied, SPEC 7) and cannot save a file on the Mac.

  /**
   * VS Code's own WorkspaceProvider (workbench.ts) opens a new window with window.open(<this page>?folder=… | ?workspace=… | ?ew=true
   * [&payload=…]): "New Window", "Open Folder" in a new window, "Duplicate Workspace in New Window". `isWorkbenchHref` recognises such a
   * URL (this page with another query) and `openAppWindow` asks the core for a second app window (`vscode:new-window`), which starts
   * with that query (the core cannot put a query in the entry of a window, so the new page gets it from `vscode:config`, `location`).
   * Each window is its own workbench with its own connection to the same server in the VM.
   */
  function isWorkbenchHref(w, href) {
    try {
      var u = new URL(href);
      return u.protocol === w.location.protocol && u.host === w.location.host && u.pathname === w.location.pathname;
    } catch (e) {
      return false;
    }
  }

  function openAppWindow(vmapp, href) {
    var query = new URL(href).search;
    vmapp.invoke('vscode:new-window', { query: query }).catch(function (err) {
      console.warn('vscode: could not open a new window:', err && err.message);
    });
    // what window.open returns: VS Code only checks that a window was opened (else it says the browser blocked a pop-up)
    return { closed: false, close: function () {}, focus: function () {}, postMessage: function () {} };
  }

  /** A new window's query, from the core (`vscode:config` location), put in this page's URL before the workbench reads it. */
  function applyWindowLocation(w, cfg) {
    if (!cfg || typeof cfg.location !== 'string' || !/^\?/.test(cfg.location) || w.location.search) return;
    try {
      w.history.replaceState(null, '', w.location.pathname + cfg.location);
    } catch (e) {
      console.warn('vscode: could not apply the window location', e && e.message);
    }
  }

  /**
   * The Explorer's "Download…" (`explorer.download`). VS Code's web version saves through the File System Access API or an
   * <a download>, which a vmapp window has not; this command replaces it (an embedder command is registered after the workbench's
   * own, and the newest registration of an id is the one that runs). The Explorer's context menu passes the clicked item and the
   * selection (explorerView.ts: arg + getActionsContext); the core copies them from the VM to where the user chooses in the platform's
   * save dialog (`vscode:download`; core/download.js): one file as it is, a folder or several items as one .tar.
   */
  function createDownloadCommand(vmapp) {
    var vmPath = function (uri) {
      return uri && typeof uri === 'object' && uri.scheme === 'vscode-remote' && typeof uri.path === 'string' ? uri.path : null;
    };
    return {
      id: 'explorer.download',
      handler: function (arg, selection) {
        var list = Array.isArray(selection) && selection.length ? selection : arg && arg.scheme ? [arg] : [];
        if (!list.length) return Promise.reject(new Error('Right-click a file or folder in the Explorer and choose Download… to save it on your Mac.'));
        var paths = list.map(vmPath);
        if (paths.some(function (p) { return !p; })) return Promise.reject(new Error('Only files of the VM can be downloaded to your Mac.'));
        return vmapp.invoke('vscode:download', { paths: paths }).then(function (r) {
          if (r && r.skipped) console.warn('vscode: the download left out ' + r.skipped + ' item(s) it could not read');
          return undefined;
        });
      },
    };
  }

  // ================================================================== end of New Window and Download

  // ================================================================== Browser-only extensions (DEV-APPS §11 step 14)
  // VS Code's web worker extension host runs in an iframe whose origin comes from the product's webEndpointUrlTemplate (patch 0006):
  // here an isolated frame vmapp-frame://v--<hash of this page's origin and a salt>.exthost/ (SPEC 7 "Isolated frames": no window.vmapp,
  // no permission, no network but the window's grants, SPEC 8.3), its host page shim/exthost/ (in the package at ui/vmapp-exthost/out/vs/
  // workbench/services/extensions/worker/, the path the workbench appends to the template). The page's CSP is unchanged: frame-src
  // admits vmapp-frame: (the feature "frames"); eval and the blob: worker happen only inside the frame.
  // A browser-only extension from the marketplace is installed in the browser and its code is fetched from the marketplace (https,
  // the window's network grant). One installed on the server has its files at this page's vscode-remote-resource URLs, which only this
  // page can fetch (over the bridge, vmapp-fetch.js): the frame asks for them on a MessagePort, and gets nothing else (GET, that path,
  // this origin). The extension host could read the same files anyway through its API (the remote file system).
  var EXTHOST_ENDPOINT = 'vmapp-frame://{{uuid}}.exthost/vmapp-exthost';
  var EXTHOST_ORIGIN = /^vmapp-frame:\/\/v--[0-9a-v]{52}\.exthost$/;

  function serveExtensionHostFrames(w) {
    var origin = w.location.protocol + '//' + w.location.host;
    var served = new WeakSet();
    w.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'vmapp.exthost.fetchPort' || !EXTHOST_ORIGIN.test(e.origin) || !e.ports || !e.ports[0] || !e.source) return;
      var isHostFrame = Array.prototype.some.call(w.document.querySelectorAll('iframe.web-worker-ext-host-iframe'), function (f) {
        return f.contentWindow === e.source;
      });
      if (!isHostFrame || served.has(e.source)) return;
      served.add(e.source);
      var port = e.ports[0];
      port.onmessage = function (m) {
        var req = m.data || {};
        var reply = function (msg, transfer) {
          msg.id = req.id;
          port.postMessage(msg, transfer || []);
        };
        var u = null;
        try {
          u = new URL(String(req.url));
        } catch (err) {
          /* not a URL */
        }
        if (!u || u.origin !== origin || u.pathname !== '/vscode-remote-resource') return reply({ error: 'only files of the server (vscode-remote-resource) are served to the extension host' });
        w.fetch(u.href).then(function (r) {
          var headers = [];
          r.headers.forEach(function (v, k) {
            headers.push([k, v]);
          });
          return (r.status === 204 || r.status === 304 ? Promise.resolve(null) : r.arrayBuffer()).then(function (body) {
            reply({ status: r.status, statusText: r.statusText, headers: headers, body: body }, body ? [body] : []);
          });
        }).catch(function (err) {
          reply({ error: String((err && err.message) || err) });
        });
      };
    });
  }

  // ================================================================== end of browser-only extensions

  return { start: start, createSocketFactory: createSocketFactory, resourcePath: resourcePath, rewriteMediaCss: rewriteMediaCss, createMediaLoader: createMediaLoader, Emitter: Emitter, createNativeMenubar: createNativeMenubar, createTunnelProvider: createTunnelProvider, isWorkbenchHref: isWorkbenchHref, createDownloadCommand: createDownloadCommand, applyWindowLocation: applyWindowLocation };
});
