'use strict';
// Native dialogs with loader-owned wording (SPEC 10: real decisions are native dialogs or loader UI, never app UI).
// The app only supplies an optional title that is appended after the loader's own sentence.
//
// Test hook (only when the app is not packaged): VMAPP_TEST_DIALOGS = JSON
//   { open: [path | [paths] | null, ...], save: path, message: index, external: bool }
// `open` is a queue: each open dialog (the loader's own pickers included) takes the next entry; an empty queue cancels.
// `host` is a queue of answers to the host-capability confirmations: 'deny' | 'once' | 'session'; an empty queue denies.
// `capture` is a queue for the screenshot picker (SPEC 8.2): 'ui' shows the REAL picker window (the test drives it over
// CDP); 'deny' | 'once' | 'session' answer without a window and keep the app's suggestion; {answer, target:{kind, ...}} also
// picks what is captured. When `capture` is empty a screenshot question takes the next `host` answer (suggestion kept).
// `region` is a queue of rectangles {x,y,w,h} (global points) or null (cancel) for "Select a region…"; an empty queue
// cancels, and no selection window is shown for those. The entry 'ui' shows the REAL selection window instead (the test
// drags in it over CDP).
// `leave` is a queue of answers to "Leave this page?" (SPEC 7): 'leave' | 'stay'; an empty queue stays.

const { dialog, shell, clipboard, Notification } = require('electron');
const { CONFIRM_BUTTONS } = require('./host-text');

// The fixed addresses of the two macOS privacy panes the settings window opens (no app can name another).
const SYSTEM_SETTINGS_URLS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
const { classifyFolder } = require('./folder-guard');

function parseTestHook(isPackaged, log) {
  if (isPackaged || !process.env.VMAPP_TEST_DIALOGS) return null;
  try {
    const h = JSON.parse(process.env.VMAPP_TEST_DIALOGS);
    if (!h || typeof h !== 'object') throw new Error('not an object');
    // broad: queue of answers (true = "share it anyway") to the too-broad-folder warning; an empty queue declines
    // host: queue of answers to the host-capability confirmations ('deny' | 'once' | 'session'); an empty queue denies
    return {
      open: Array.isArray(h.open) ? h.open.slice() : [],
      save: h.save,
      message: h.message,
      external: h.external,
      broad: Array.isArray(h.broad) ? h.broad.slice() : [],
      host: Array.isArray(h.host) ? h.host.slice() : [],
      capture: Array.isArray(h.capture) ? h.capture.slice() : [],
      region: Array.isArray(h.region) ? h.region.slice() : [],
      leave: Array.isArray(h.leave) ? h.leave.slice() : [],
      // clipboard: the text an app's core reads (clipboard.readText); what it writes replaces it. The real clipboard is not touched.
      clipboard: typeof h.clipboard === 'string' ? h.clipboard : '',
      log: [],
    };
  } catch (e) {
    log('error', `VMAPP_TEST_DIALOGS ignored: ${e.message}`);
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const clean = (s, max = 120) => String(s === undefined ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

class NativeDialogs {
  /** @param {string} [o.dataDir] the loader's data root, used to refuse / warn about folders that expose it */
  constructor({ isPackaged, log = () => {}, dataDir = '' }) {
    this.hook = parseTestHook(isPackaged, log);
    this.log = log;
    this.dataDir = dataDir;
  }

  /**
   * Gate for every folder an app is about to get (permission sheet and dialog.open folders). Returns true when the
   * folder may be shared: fine as it is, or too broad and the user confirmed a second time. Refused folders (the disk
   * root, the loader's own data) get an explanation and false; declining the warning gives false.
   */
  async confirmFolder(parent, appName, folder) {
    const verdict = classifyFolder(folder, { dataDir: this.dataDir });
    if (verdict.level === 'ok') return true;
    const who = `“${clean(appName, 60)}”`;
    if (verdict.level === 'refuse') {
      this.log('warn', `refused to share ${folder}: ${verdict.reason}`);
      await this.message(
        parent,
        { type: 'error', title: 'This folder cannot be shared', message: `${who} cannot get “${clean(folder, 200)}”.`, detail: verdict.reason, buttons: ['OK'], defaultId: 0, noLink: true },
        'folder-refused',
      );
      return false;
    }
    const opts = {
      type: 'warning',
      title: 'Share this large folder?',
      message: `Are you sure you want to share “${clean(folder, 200)}” with ${who}?`,
      detail: `${verdict.reason}\n\nChoose a more specific folder unless you really want ${who} to reach everything in it.`,
      buttons: ['Choose a different folder', 'Share this folder anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    let share;
    if (this.hook) {
      share = this.hook.broad.length ? !!this.hook.broad.shift() : false;
      this._note('broad-folder', { folder, level: verdict.level, reason: verdict.reason, message: opts.message, buttons: opts.buttons, answer: share });
    } else {
      const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      share = r.response === 1;
    }
    return share;
  }

  _note(kind, detail) {
    if (!this.hook) return;
    this.hook.log.push({ kind, detail });
    this.log('info', `[test dialog] ${kind} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    // VMAPP_TEST_DIALOG_LOG: the tests read the exact wording the user would have seen
    if (process.env.VMAPP_TEST_DIALOG_LOG) {
      try {
        require('fs').appendFileSync(process.env.VMAPP_TEST_DIALOG_LOG, JSON.stringify({ kind, detail }) + '\n');
      } catch {
        /* ignore */
      }
    }
  }

  /** Native open dialog. Returns an array of paths, or null when cancelled. `descr` is shown for the test hook log. */
  async open(parent, options, descr) {
    if (this.hook) {
      const next = this.hook.open.length ? this.hook.open.shift() : null;
      this._note('open', { descr, title: options.title, message: options.message, properties: options.properties, answer: next });
      if (next === null || next === undefined) return null;
      return Array.isArray(next) ? next : [next];
    }
    const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return r.canceled || !r.filePaths.length ? null : r.filePaths;
  }

  async save(parent, options, descr) {
    if (this.hook) {
      this._note('save', { descr, title: options.title, message: options.message, answer: this.hook.save || null });
      return this.hook.save || null;
    }
    const r = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return r.canceled || !r.filePath ? null : r.filePath;
  }

  async message(parent, options, descr) {
    if (this.hook) {
      const idx = Number.isInteger(this.hook.message) ? this.hook.message : 0;
      this._note('message', { descr, message: options.message, buttons: options.buttons, answer: idx });
      return idx;
    }
    const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return r.response;
  }

  /** The loader's own picker for a package file. */
  pickPackage(parent) {
    return this.open(
      parent,
      { title: 'Install a D9010 VmApp package', message: 'Choose a .vmapp package to install', properties: ['openFile'], filters: [{ name: 'D9010 VmApp packages', extensions: ['vmapp'] }] },
      'package',
    ).then((r) => (r ? r[0] : null));
  }

  /**
   * The clipboard of an app's core (clipboard.readText / writeText, SPEC 6 and 8.4; the session checks the manifest and the
   * grant first). Under the test hook a string stands in for the real clipboard, and every use is noted with its length only.
   */
  readClipboard() {
    if (this.hook) {
      this._note('clipboard-read', { length: this.hook.clipboard.length });
      return this.hook.clipboard;
    }
    return clipboard.readText();
  }

  writeClipboard(text) {
    if (this.hook) {
      this._note('clipboard-write', { length: text.length });
      this.hook.clipboard = text;
      return;
    }
    clipboard.writeText(text);
  }

  /** Copy button of the Publish… sheet. Tests never touch the real clipboard (the hook only records that it was asked). */
  copyToClipboard(text) {
    if (this.hook) {
      this._note('copy', { length: text.length });
      return;
    }
    clipboard.writeText(text);
  }

  /** The loader's own picker for a developer's project folder ("Run project folder…"). */
  pickProjectFolder(parent) {
    return this.open(
      parent,
      { title: 'Run a project folder', message: 'Choose the D9010 VmApp project folder (it contains vmapp.json, ui/ and core/)', buttonLabel: 'Choose', properties: ['openDirectory'] },
      'project',
    ).then((r) => (r ? r[0] : null));
  }

  /**
   * Opens the app page of a registry after a publish: the loader asks first (like every link), then hands the address to
   * the browser. Only http(s) addresses the loader itself got back from a publish are ever passed here. Returns true if opened.
   */
  async openPublishedPage(parent, url) {
    const message = `Open ${url} in your browser?`;
    if (this.hook) {
      const answer = !!this.hook.external;
      this._note('open-page', { url, message, answer });
      if (answer) this._note('openExternal', url); // never launch a browser from tests
      return answer;
    }
    const r = await this.message(parent, { type: 'question', title: 'Open the app page', message, detail: 'This is the page of your app on the registry you published to.', buttons: ['Open in Browser', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true }, 'open-page');
    if (r !== 0) return false;
    await shell.openExternal(url);
    return true;
  }

  /**
   * Opens a page about the launcher's own update ("What's new", "Download") in the browser, after asking. The address is one the
   * update logic validated (src/updater.js pageFor: an https address on vmapp.dev). Returns true if opened.
   */
  async openLauncherPage(parent, url) {
    const message = `Open ${url} in your browser?`;
    if (this.hook) {
      const answer = !!this.hook.external;
      this._note('open-page', { url, message, answer });
      if (answer) this._note('openExternal', url); // never launch a browser from tests
      return answer;
    }
    const r = await this.message(parent, { type: 'question', title: 'Open the D9010 VmApp website', message, detail: 'This is a page of the D9010 VmApp website about launcher versions.', buttons: ['Open in Browser', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true }, 'open-page');
    if (r !== 0) return false;
    await shell.openExternal(url);
    return true;
  }

  /** The loader's own picker for a manifest folder request (permission sheet). */
  pickGrantFolder(parent, app, req) {
    const rw = req.access === 'readwrite';
    const what = rw ? '(it will be able to change files in this folder)' : req.access === 'writeonly' ? '(files it saves here are delivered to this folder)' : '(read only)';
    return this.open(
      parent,
      {
        title: `Choose a folder for “${clean(app.name, 60)}”`,
        message: `“${clean(app.name, 60)}” asks for the folder “${req.name}” ${what}. ${req.purpose ? clean(req.purpose, 200) : 'No reason given.'}`,
        buttonLabel: 'Choose',
        properties: ['openDirectory', 'createDirectory'],
      },
      `grant:${req.name}`,
    ).then(async (r) => (r && (await this.confirmFolder(parent, app.name, r[0])) ? r[0] : null));
  }

  /**
   * The host-capability confirmation (SPEC 8.2, ui.confirmUse): a native sheet on the app's window, worded by the loader
   * (`text` is host-text.confirmText). Deny is the default and the answer to Escape. Returns false | true | 'session'.
   */
  async confirmHostUse(parent, text, req) {
    const appName = clean(req.app && req.app.name, 60);
    if (this.hook) {
      const answer = this.hook.host.length ? String(this.hook.host.shift()) : 'deny';
      this._note('host-confirm', { cap: req.cap, op: req.op, app: req.app, title: appName, message: text.message, detail: text.detail, buttons: text.buttons, shell: text.shell, answer });
      return answer === 'session' ? 'session' : answer === 'once';
    }
    const opts = { type: text.shell ? 'warning' : 'question', title: appName, message: text.message, detail: text.detail, buttons: CONFIRM_BUTTONS, defaultId: 0, cancelId: 0, noLink: true };
    if (parent && !parent.isDestroyed()) {
      // the question must be seen: bring the app's window forward, the sheet opens on it
      if (parent.isMinimized()) parent.restore();
      parent.show();
      parent.focus();
    }
    const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    return r.response === 2 ? 'session' : r.response === 1;
  }

  /**
   * "Leave this page?" (SPEC 7): a page vetoed its unload. A native sheet on the app's window, worded by the loader (`text` is
   * leave-page.leaveText, never the page's own text); Stay is the default and the answer to Escape. SYNCHRONOUS, because Electron's
   * will-prevent-unload is answered before its handler returns. Returns true for Leave.
   */
  confirmLeave(parent, text, app) {
    if (this.hook) {
      const answer = this.hook.leave.length > 0 && String(this.hook.leave.shift()) === 'leave';
      this._note('leave-page', { app: app && app.id, title: text.title, message: text.message, buttons: text.buttons, answer: answer ? 'leave' : 'stay' });
      return answer;
    }
    const opts = { type: 'question', title: text.title, message: text.message, buttons: text.buttons, defaultId: text.defaultId, cancelId: text.cancelId, noLink: true };
    const r = parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
    return r === 0;
  }

  /**
   * Test hook for the screenshot picker. Returns undefined when the REAL picker must be shown (no hook, or the queue says
   * 'ui'); otherwise the scripted answer for ui.chooseCapture: false, or {allow: true | 'session', target?}.
   */
  scriptedCapture(text, req) {
    if (!this.hook) return undefined;
    let entry = this.hook.capture.length ? this.hook.capture.shift() : undefined;
    if (entry === 'ui') {
      this._note('capture-picker', { cap: req.cap, app: req.app, message: text.message, detail: text.detail, buttons: text.buttons });
      return undefined;
    }
    if (entry === undefined) entry = this.hook.host.length ? String(this.hook.host.shift()) : 'deny'; // the plain-confirmation queue
    const answer = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? String(entry.answer) : 'deny';
    const target = entry && typeof entry === 'object' ? entry.target : undefined;
    this._note('host-confirm', { cap: req.cap, op: req.op, app: req.app, title: clean(req.app && req.app.name, 60), message: text.message, detail: text.detail, buttons: text.buttons, shell: text.shell, answer, target });
    if (answer === 'session') return { allow: 'session', target };
    if (answer === 'once') return { allow: true, target };
    return false;
  }

  /** What the user picked in the real picker, for the test log (the wording and the target the app gets). */
  noteCapturePick(req, answer, target) {
    this._note('capture-pick', { app: req.app, answer, target });
  }

  /** How the real picker window was made (modal sheet on the app's window, its title), for the test log. */
  noteCaptureWindow(win) {
    if (!this.hook) return;
    this._note('capture-window', { modal: win.isModal(), hasParent: !!win.getParentWindow(), title: win.getTitle() });
  }

  /**
   * "Select a region…": the test hook gives the rectangle (global points) instead of showing the selection window.
   * undefined = no hook, show the real window; null = cancelled.
   */
  regionAnswer(display) {
    if (!this.hook) return undefined;
    const next = this.hook.region.length ? this.hook.region.shift() : null;
    this._note('region-select', { display, answer: next });
    if (next === 'ui') return undefined; // the REAL selection window: the test drives it over CDP
    return next && typeof next === 'object' ? next : null;
  }

  /** The real selection window: where it opened (its own bounds, and the origin that turns its points into global ones). */
  noteRegionWindow(bounds, origin) {
    this._note('region-window', { bounds, origin });
  }

  /** The two macOS privacy panes (loader-owned fixed addresses, so no confirmation is needed). */
  async openSystemSettings(pane) {
    const url = SYSTEM_SETTINGS_URLS[pane];
    if (!url) throw new Error('unknown settings pane');
    if (this.hook) {
      this._note('openExternal', url); // never open System Settings from tests
      return;
    }
    await shell.openExternal(url);
  }

  /**
   * "Show app data in Finder" (library and activity monitor): reveals a folder the LOADER names (an installed app's data/<id>,
   * never a path from a page). Opens nothing and runs nothing. Tests only record it.
   */
  showInFolder(dir) {
    if (this.hook) {
      this._note('show-in-folder', dir);
      return;
    }
    shell.showItemInFolder(dir);
  }

  /** A short system notification (panic). Tests only record it. */
  notify(title, body) {
    if (this.hook) {
      this._note('notice', { title, body });
      return;
    }
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch (e) {
      this.log('warn', `notification: ${e.message}`);
    }
  }
}

/** The dialogs object of one running app (hostlib/README.md "Dialogs interface"). */
class AppDialogs {
  /**
   * @param {NativeDialogs} native
   * @param {(winId)=>BrowserWindow|null} parentOf the app window for a host window id (falls back to any window of the app)
   */
  constructor(native, parentOf) {
    this.native = native;
    this.parentOf = parentOf;
  }

  _name(app) {
    return `“${clean(app.name, 60)}”`;
  }

  async open({ win, title, directory, multiple, access, app }) {
    const extra = title ? `: ${clean(title, 150)}` : '';
    let message;
    if (directory) {
      message =
        access === 'readwrite'
          ? `${this._name(app)} wants to open a folder (it will be able to change files in this folder)${extra}`
          : `${this._name(app)} wants to open a folder (read only)${extra}`;
    } else {
      message = `${this._name(app)} wants to open ${multiple ? 'files' : 'a file'}${extra}`;
    }
    const properties = [directory ? 'openDirectory' : 'openFile'];
    if (directory) properties.push('createDirectory');
    if (multiple) properties.push('multiSelections');
    const parent = this.parentOf(win);
    const picked = await this.native.open(
      parent,
      { title: message, message, buttonLabel: directory ? 'Share folder' : 'Open', properties },
      directory ? `folder:${access}` : 'file',
    );
    if (!picked || !directory) return picked;
    // same gate as the permission sheet: the disk root and the loader's data are refused, broad folders confirmed twice
    return (await this.native.confirmFolder(parent, app.name, picked[0])) ? picked : null;
  }

  async save({ win, title, defaultName, app }) {
    const message = `${this._name(app)} wants to save a file${title ? `: ${clean(title, 150)}` : ''}`;
    return this.native.save(this.parentOf(win), { title: message, message, defaultPath: defaultName, buttonLabel: 'Save' }, 'file');
  }

  async message({ win, type, message, detail, buttons, app }) {
    const idx = await this.native.message(
      this.parentOf(win),
      {
        type: type === 'question' ? 'question' : type === 'warning' ? 'warning' : type === 'error' ? 'error' : 'info',
        title: clean(app.name, 60),
        message: `${this._name(app)}: ${message}`,
        detail,
        buttons,
        defaultId: 0,
        noLink: true,
      },
      'message',
    );
    return idx;
  }

  async confirmExternal(url, app) {
    if (this.native.hook) {
      this.native._note('external', {
        url,
        message: `${this._name(app)} wants to open ${url} in your browser`,
        answer: !!this.native.hook.external,
      });
      return !!this.native.hook.external;
    }
    const r = await this.native.message(
      this.parentOf(undefined),
      {
        type: 'question',
        title: clean(app.name, 60),
        message: `${this._name(app)} wants to open ${url} in your browser`,
        detail: 'Only continue if you expect this link.',
        buttons: ['Open in Browser', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      },
      'external',
    );
    return r === 0;
  }

  async openExternal(url) {
    if (this.native.hook) {
      this.native._note('openExternal', url); // never launch a browser from tests
      return;
    }
    await shell.openExternal(url);
  }
}

module.exports = { NativeDialogs, AppDialogs };
