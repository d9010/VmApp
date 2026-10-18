'use strict';
// Portions (the key, mouse, drag-and-drop and context-menu guards, the file extension list and the 10 MB limit) are taken from
// app/ui/app/index.html and app/cmd/app/webview.go of Ollama v0.35.0 (https://github.com/ollama/ollama, MIT licence, Copyright (c)
// Ollama; the licence text is ui/LICENSE.ollama in the package). INV-G4: this notice names the source.
//
// ollama-desktop-shim.js: what the Ollama desktop app's native shell gave its web page, rebuilt on window.vmapp.
//
// Ollama's page (app/ui/app, a React app) is shown by the desktop app in a native webview (app/cmd/app/webview.go). That shell injects
// a script, binds Go functions to window.* names, and the page's own index.html wires them (a long inline <script>, which a vmapp page
// cannot have: CSP script-src 'self'). This file is the same wiring, in a file, on the one API a vmapp page has. It must be loaded
// BEFORE the page's own script (index.html lists it first, after vmapp-fetch.js).
//
// Nothing here is privileged. Everything that touches the host goes through window.vmapp.invoke to the app's core, which asks the
// platform (core/main.js): opening a link asks the user first, a folder is picked in a native dialog the platform shows.
//
//   native shell                                       here
//   window.selectFiles() + __selectFilesCallback       window.webview.selectMultipleFiles / selectFile: an <input type=file> in the
//                                                      page (the user picks; the page reads the bytes it was given, like a drop)
//   window.selectModelsDirectory()                     window.webview.selectModelsDirectory: core dialog (read-write folder grant)
//   window.selectWorkingDirectory()                    window.webview.selectWorkingDirectory: the same dialog (the UI never calls it)
//   window.setContextMenuItems + handleContextMenuResult  window.menu(items): a menu drawn by the page (a vmapp page has no native menus)
//   window.open(url) / links that leave the page       core shell.openExternal (https only, the platform asks the user)
//   window.OLLAMA_PLATFORM, OLLAMA_WEBSEARCH           set here (the webview init script sets them); the platform is "windows" on every host,
//                                                      see below
//   keyboard / mouse / drag-and-drop guards            the same guards the inline script had (no history navigation, no refresh)
//   zoomIn / zoomOut / zoomReset, ready, resize, close, drag, doubleClick, setOnboardingWindow
//                                                      not mapped (window chrome belongs to the host): the page calls each of them
//                                                      only when it exists, so they are left undefined
(function () {
  var w = window;
  var d = document;
  var vmapp = w.vmapp;
  if (!vmapp || typeof vmapp.invoke !== 'function') throw new Error('ollama-desktop-shim: window.vmapp is not available');

  // ------------------------------------------------------------------ the page is served from index.html: the router wants "/"
  try {
    if (/^\/index\.html$/.test(w.location.pathname)) w.history.replaceState(w.history.state, '', '/' + w.location.search + w.location.hash);
  } catch (e) {
    /* the router then starts on /index.html and shows its not-found page: nothing else to do */
  }

  // ------------------------------------------------------------------ flags the webview init script sets
  // The page knows two flavours (types/webview.d.ts: "darwin" | "windows"). "windows" is the one for a window with a standard title bar
  // and without the macOS desktop integrations: the sidebar toggle sits at the left edge instead of beside the traffic lights, and the
  // settings page and the onboarding leave out "Show apps in menu" and the Claude Desktop / ChatGPT model mappings, which configure other
  // apps of a Mac and cannot work from a VM. A vmapp window is exactly that, on any host.
  w.OLLAMA_PLATFORM = 'windows';
  w.OLLAMA_WEBSEARCH = true;

  // ------------------------------------------------------------------ a little UI of its own (toast, menu), styled like the page
  var style = d.createElement('style');
  style.textContent =
    '.vmapp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,90vw);padding:10px 14px;' +
    'border-radius:10px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#262626;color:#fafafa;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:2147483647}' +
    '.vmapp-menu{position:fixed;min-width:160px;padding:4px;border-radius:10px;border:1px solid #e5e5e5;background:#fff;color:#171717;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.18);font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:2147483647}' +
    '.vmapp-menu button{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:transparent;' +
    'color:inherit;font:inherit;cursor:default}' +
    '.vmapp-menu button:hover:not([disabled]){background:#2563eb;color:#fff}' +
    '.vmapp-menu button[disabled]{opacity:.45}' +
    '.vmapp-menu hr{border:0;border-top:1px solid #e5e5e5;margin:4px 2px}' +
    '@media (prefers-color-scheme:dark){.vmapp-menu{background:#262626;color:#fafafa;border-color:#404040}.vmapp-menu hr{border-color:#404040}}';
  (d.head || d.documentElement).appendChild(style);

  var toastTimer = null;
  function toast(message) {
    var old = d.querySelector('.vmapp-toast');
    if (old) old.remove();
    var el = d.createElement('div');
    el.className = 'vmapp-toast';
    el.setAttribute('role', 'status');
    el.textContent = String(message);
    d.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.remove();
    }, 6000);
  }

  // ------------------------------------------------------------------ files: window.webview.selectMultipleFiles / selectFile
  // The same extensions and the same 10 MB limit as the native dialog had (app/cmd/app/webview.go, "selectFiles").
  var FILE_EXTS = (
    'pdf docx txt md csv json xml html htm js jsx ts tsx py java cpp c cc h cs php rb go rs swift kt scala sh bat yaml yml toml ini ' +
    'cfg conf log rtf png jpg jpeg webp'
  ).split(' ');
  var MAX_FILE_BYTES = 10 * 1024 * 1024;

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new w.FileReader();
      r.onload = function () {
        resolve(String(r.result));
      };
      r.onerror = function () {
        reject(r.error || new Error('could not read ' + file.name));
      };
      r.readAsDataURL(file);
    });
  }

  // Resolves [{filename, path, dataURL}] or null when the user cancelled or nothing usable was picked.
  function pickFiles(multiple) {
    return new Promise(function (resolve) {
      var input = d.createElement('input');
      input.type = 'file';
      input.multiple = !!multiple;
      input.accept = FILE_EXTS.map(function (e) {
        return '.' + e;
      }).join(',');
      input.setAttribute('data-vmapp-file-input', '');
      input.style.display = 'none';
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        input.remove();
        resolve(value);
      }
      input.addEventListener('cancel', function () {
        finish(null);
      });
      input.addEventListener('change', function () {
        var picked = Array.prototype.slice.call(input.files || []).filter(function (f) {
          var ext = f.name.toLowerCase().split('.').pop();
          return FILE_EXTS.indexOf(ext) >= 0 && f.size <= MAX_FILE_BYTES;
        });
        if (!picked.length) return finish(null);
        Promise.all(
          picked.map(function (f) {
            return readAsDataURL(f).then(function (dataURL) {
              return { filename: f.name, path: f.name, dataURL: dataURL };
            });
          }),
        ).then(finish, function () {
          finish(null);
        });
      });
      d.body.appendChild(input);
      input.click();
    });
  }

  // ------------------------------------------------------------------ folders and links: through the core
  function pickDirectory(title) {
    return vmapp.invoke('ollama:pick-directory', { title: title }).then(
      function (r) {
        return r && r.path ? String(r.path) : null;
      },
      function (err) {
        toast(err && err.message ? err.message : 'Could not open the folder dialog.');
        return null;
      },
    );
  }

  function openExternal(url) {
    return vmapp.invoke('ollama:open-external', { url: String(url) }).then(
      function (r) {
        return !!(r && r.opened);
      },
      function (err) {
        toast(err && err.message ? err.message : 'Could not open the link.');
        return false;
      },
    );
  }

  w.webview = {
    selectFile: function () {
      return pickFiles(false).then(function (r) {
        return r && r.length ? r[0] : null;
      });
    },
    selectMultipleFiles: function () {
      return pickFiles(true);
    },
    selectModelsDirectory: function () {
      return pickDirectory('Select Model Directory');
    },
    selectWorkingDirectory: function () {
      return pickDirectory('Select Working Directory');
    },
  };

  // window.open(url, '_blank') is how the page leaves for ollama.com (sign in, account, upgrade). A vmapp page cannot open windows:
  // https links go to the user's browser, after the platform asked; anything else is dropped.
  w.open = function (url) {
    var u = null;
    try {
      u = new w.URL(String(url), w.location.href);
    } catch (e) {
      /* not a URL */
    }
    if (u && u.protocol === 'https:') openExternal(u.href);
    return null;
  };
  // A link in a message ([text](https://...)) does the same instead of navigating the window away.
  d.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var u;
      try {
        u = new w.URL(a.getAttribute('href'), w.location.href);
      } catch (err) {
        return;
      }
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        e.preventDefault();
        if (u.protocol === 'https:') openExternal(u.href);
      }
    },
    true,
  );

  // ------------------------------------------------------------------ the context menu: window.menu(items) -> label | null
  var openMenu = null;
  var lastMouse = { x: 0, y: 0 };
  d.addEventListener(
    'contextmenu',
    function (e) {
      lastMouse = { x: e.clientX, y: e.clientY };
      // Only elements that opted in keep their context menu; the page's own handlers then call window.menu().
      var target = e.target;
      while (target && target !== d) {
        if (target.classList && target.classList.contains('allow-context-menu')) return;
        target = target.parentElement;
      }
      e.preventDefault();
    },
    true,
  );

  function closeMenu(result) {
    if (!openMenu) return;
    var m = openMenu;
    openMenu = null;
    m.el.remove();
    d.removeEventListener('mousedown', m.onDown, true);
    d.removeEventListener('keydown', m.onKey, true);
    w.removeEventListener('blur', m.onBlur);
    m.resolve(result);
  }

  w.menu = function (items) {
    closeMenu(null);
    return new Promise(function (resolve) {
      var el = d.createElement('div');
      el.className = 'vmapp-menu';
      el.setAttribute('role', 'menu');
      (items || []).forEach(function (item) {
        if (item && item.separator) {
          el.appendChild(d.createElement('hr'));
          return;
        }
        var b = d.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.textContent = item && item.label ? String(item.label) : '';
        if (item && item.enabled === false) b.disabled = true;
        b.addEventListener('click', function () {
          closeMenu(item.label);
        });
        el.appendChild(b);
      });
      d.body.appendChild(el);
      var r = el.getBoundingClientRect();
      el.style.left = Math.max(4, Math.min(lastMouse.x, w.innerWidth - r.width - 4)) + 'px';
      el.style.top = Math.max(4, Math.min(lastMouse.y, w.innerHeight - r.height - 4)) + 'px';
      openMenu = {
        el: el,
        resolve: resolve,
        onDown: function (ev) {
          if (!el.contains(ev.target)) closeMenu(null);
        },
        onKey: function (ev) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            closeMenu(null);
          }
        },
        onBlur: function () {
          closeMenu(null);
        },
      };
      d.addEventListener('mousedown', openMenu.onDown, true);
      d.addEventListener('keydown', openMenu.onKey, true);
      w.addEventListener('blur', openMenu.onBlur);
    });
  };
  w.handleContextMenuResult = function () {}; // the native menu's callback: not used, the menu above resolves its own promise
  w.setContextMenuItems = function () {};

  // ------------------------------------------------------------------ guards the inline script of index.html had
  d.addEventListener('keydown', function (e) {
    var editable = e.target && e.target.matches && e.target.matches('input, textarea, [contenteditable], select');
    if (e.key === 'Backspace' && !editable) e.preventDefault();
    if (!editable) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
    }
    if (e.key === 'F5') e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'r') e.preventDefault();
  });
  d.addEventListener('mousedown', function (e) {
    if (e.button === 3 || e.button === 4) e.preventDefault(); // the mouse's back and forward buttons
  });
  d.addEventListener('dragover', function (e) {
    e.preventDefault();
  });
  d.addEventListener('drop', function (e) {
    e.preventDefault(); // dropping a file on the window must not navigate to it; the page's own drop zones handle their drops first
  });
})();
