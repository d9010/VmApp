'use strict';
// The launcher's own updates (SPEC 8.10, INV-U1). A small state machine around two things:
//   - hostlib/updates.js fetchLauncherFeed: THE network code. It asks one fixed address for a tiny JSON file naming the newest
//     launcher (no identifier, no version, nothing about the user). Whether that is newer is decided here, never by the server.
//   - Electron's autoUpdater (Squirrel.Mac): downloads the zip named in the feed and, on "restart", swaps the app in place. It
//     refuses a new app that is not signed by the same Developer ID as the running one, so a lying feed can at worst point at a
//     zip that is refused. This file never downloads, unzips, signs or spawns anything itself (INV-A1, INV-G3).
//
// When it asks: a few seconds after EVERY start-up, then at least once a day while the launcher runs (it looks every 15 minutes whether a
// day has passed since the last answer, so a Mac that slept does not skip a day, and a check that failed for want of a network is tried
// again then), unless the user turned "Check for launcher updates" off (src/prefs.js); and whenever the user chooses "Check for Updates…".
// Nothing is downloaded until the user presses "Update now" and nothing restarts until they press "Restart to update".
//
//   phase: idle | checking | available | downloading | ready | upToDate | error
//   `available` carries the cleaned feed record (version, notes, changes, links); `error` carries a sentence for the user.
// A launcher that cannot update itself (a development build, or one signed ad hoc) still tells the user what is available and
// offers "Download" (the page on the website) instead of "Update now".
// A launcher that sits where it cannot replace itself (macOS runs an app opened from Downloads from a temporary read-only copy, "app
// translocation"; or it is on a disk image or a read-only volume) says so, before "Update now" can fail, and offers "Move to Applications"
// (Electron's app.moveToApplicationsFolder, given in as `moveToApplications`; the launcher restarts from there).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { fetchLauncherFeed, launcherUpdateState, LAUNCHER_FEED_URL } = require('../../hostlib/updates');

const STARTUP_DELAY_MS = 5 * 1000; // after every start-up
const RECHECK_MS = 24 * 3600 * 1000; // at least this often while it runs
const TICK_MS = 15 * 60 * 1000; // how often it looks whether RECHECK_MS has passed since the last answer
const DOWNLOAD_PAGE = 'https://vmapp.dev/download';
const CHANGELOG_PAGE = 'https://vmapp.dev/docs/changelog';

/** Compares dotted numbers ("14.5.0" against "13"): <0, 0 or >0. Missing parts are 0; anything that is not a number counts as 0. */
function compareDotted(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** What the user is told when this copy cannot replace itself where it is. */
const BLOCK_TEXT = {
  translocated:
    'macOS is running this copy from a temporary, read-only place (it does that for apps opened straight from Downloads), so it cannot replace itself. Move it to your Applications folder and it can update.',
  readonly: 'This copy is on a read-only disk, or in a folder you cannot change, so it cannot replace itself. Move it to your Applications folder and it can update.',
};

class LauncherUpdater extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.home          the loader's data root (the file launcher-update.json lives there)
   * @param {string} o.version       the running launcher's version (app.getVersion())
   * @param {boolean} o.packaged     app.isPackaged
   * @param {{get: (name: string) => any}} o.prefs  the loader's preferences (checkForUpdates)
   * @param {object|null} [o.autoUpdater]  Electron's autoUpdater; null where updating in place is impossible (not macOS, not packaged)
   * @param {string} [o.feedUrl]     the feed address (dev builds and tests may override it; the default is the fixed one)
   * @param {boolean} [o.dev]        dev build: addresses on this Mac are accepted in the feed
   * @param {string} [o.osVersion]   this Mac's macOS version (process.getSystemVersion()), for the feed's minimumOS
   * @param {number} [o.startupDelayMs]
   * @param {''|'translocated'|'readonly'} [o.installBlock]  why this copy cannot replace itself where it is ('' = it can)
   * @param {(() => Promise<void>)|null} [o.moveToApplications]  moves this app to the Applications folder and restarts it from there
   * @param {number} [o.tickMs]
   */
  constructor(o) {
    super();
    this.home = o.home;
    this.version = o.version;
    this.packaged = !!o.packaged;
    this.prefs = o.prefs;
    this.autoUpdater = o.autoUpdater || null;
    this.feedUrl = o.feedUrl || LAUNCHER_FEED_URL;
    this.dev = !!o.dev;
    this.osVersion = o.osVersion || '';
    this.startupDelayMs = o.startupDelayMs === undefined ? STARTUP_DELAY_MS : o.startupDelayMs;
    this.log = o.log || (() => {});
    this.now = o.now || Date.now;
    this.file = path.join(this.home, 'launcher-update.json');
    this.saved = this._read();
    this.phase = 'idle';
    this.update = null;
    this.error = '';
    this.manual = false;
    this.installBlock = o.installBlock || '';
    this.moveFn = typeof o.moveToApplications === 'function' ? o.moveToApplications : null;
    this.tickMs = o.tickMs === undefined ? TICK_MS : o.tickMs;
    this.canInstall = !!this.autoUpdater && this.packaged && process.platform === 'darwin' && !this.installBlock;
    this.timer = null;
    this.interval = null;
    this.wired = false;
  }

  // ------------------------------------------------------------------------------------------------ what the page sees
  autoEnabled() {
    try {
      return this.prefs.get('checkForUpdates') !== false;
    } catch {
      return true;
    }
  }

  state() {
    return {
      phase: this.phase,
      current: this.version,
      update: this.update,
      error: this.error,
      canInstall: this.canInstall,
      installBlock: this.installBlock,
      canMove: !!this.installBlock && !!this.moveFn,
      manual: this.manual,
      autoCheck: this.autoEnabled(),
    };
  }

  _set(phase, extra = {}) {
    this.phase = phase;
    this.update = extra.update !== undefined ? extra.update : phase === 'idle' || phase === 'upToDate' ? null : this.update;
    this.error = extra.error || '';
    if (extra.manual !== undefined) this.manual = extra.manual;
    this.emit('state', this.state());
    return this.state();
  }

  // ------------------------------------------------------------------------------------------------ schedule
  /**
   * Starts the automatic checks: one a few seconds after every start-up, then one whenever a day has passed since the last answer.
   * The answer time is kept in launcher-update.json; it is set only by a check that got an answer, so a check that could not reach the
   * server is tried again at the next tick instead of waiting a day.
   */
  start() {
    if (this.timer || this.interval) return;
    const run = () => {
      if (this.autoEnabled()) this.check({ manual: false }).catch((e) => this.log('warn', `launcher update check: ${e.message}`));
    };
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
      this.interval = setInterval(() => {
        if (this.now() - this.saved.lastCheck >= RECHECK_MS) run();
      }, this.tickMs);
      if (this.interval.unref) this.interval.unref();
    }, this.startupDelayMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  // ------------------------------------------------------------------------------------------------ checking
  /**
   * Asks the feed. `manual`: the user asked (the answer is always shown: an update, "up to date" or the error); otherwise it is
   * silent unless there is an update, and a failure (no network) is only logged.
   */
  async check({ manual = false } = {}) {
    if (['checking', 'downloading', 'ready'].includes(this.phase)) {
      // already busy (or waiting for the restart): nothing new to ask; a manual check shows the card again
      if (manual) this.emit('state', this.state());
      return this.state();
    }
    if (!manual && !this.autoEnabled()) return this.state();
    this._set('checking', { manual, update: this.update });
    try {
      const feed = await fetchLauncherFeed(this.feedUrl, { dev: this.dev });
      this.saved.lastCheck = this.now();
      this._write();
      if (feed.minimumOS && this.osVersion && compareDotted(this.osVersion, feed.minimumOS) < 0) {
        const text = `Launcher ${feed.version} needs macOS ${feed.minimumOS} or later; this Mac has macOS ${this.osVersion}.`;
        this.log('info', text);
        return manual ? this._set('error', { error: text, update: null }) : this._set('idle', { update: null });
      }
      const st = launcherUpdateState(this.version, feed, this.saved.skipped);
      if (st === 'newer' || (st === 'skipped' && manual)) {
        this.log('info', `launcher update available: ${feed.version} (running ${this.version})`);
        return this._set('available', { update: feed, manual });
      }
      return manual ? this._set('upToDate', { update: null }) : this._set('idle', { update: null });
    } catch (e) {
      this.log('warn', `launcher update check: ${e.message}`);
      return manual ? this._set('error', { error: e.message, update: null }) : this._set('idle', { update: null });
    }
  }

  // ------------------------------------------------------------------------------------------------ installing
  /** "Update now": Electron's updater downloads the zip and checks that the new app is signed like this one. */
  install() {
    // from `available`, or again after a download that failed (the update is still known and this copy can update itself)
    const again = this.phase === 'error' && this.update && this.canInstall;
    if ((this.phase !== 'available' && !again) || !this.update) throw new Error('There is no update to install.');
    if (this.installBlock) throw new Error('This copy of the launcher is where it cannot replace itself. Move it to the Applications folder first.');
    if (!this.canInstall) throw new Error('This copy of the launcher cannot update itself. Use Download to get the new version.');
    this._wire();
    this._set('downloading', { update: this.update });
    try {
      this.autoUpdater.setFeedURL({ url: this.feedUrl, serverType: 'json' });
      this.autoUpdater.checkForUpdates();
    } catch (e) {
      this._failInstall(e);
    }
    return this.state();
  }

  _wire() {
    if (this.wired) return;
    this.wired = true;
    const au = this.autoUpdater;
    au.on('update-downloaded', () => {
      if (this.phase === 'downloading') {
        this.log('info', 'launcher update downloaded; waiting for the user to restart');
        this._set('ready', { update: this.update });
      }
    });
    au.on('update-not-available', () => {
      if (this.phase === 'downloading') this._set('error', { error: 'The update server had nothing newer to download.', update: this.update });
    });
    au.on('error', (e) => {
      if (this.phase === 'downloading' || this.phase === 'available') this._failInstall(e);
      else this.log('warn', `updater: ${e && e.message}`);
    });
  }

  _failInstall(e) {
    const raw = e && e.message ? String(e.message) : String(e);
    this.log('warn', `launcher update could not be installed: ${raw}`);
    // an unsigned or ad-hoc signed copy cannot be replaced in place: say so and offer the download page instead
    const signature = /signature|code sign|codesign|not signed|unsigned/i.test(raw);
    // Squirrel.Mac: "Cannot update while running on a read-only volume" (an app opened from Downloads or a disk image)
    const location = /read-only volume|translocat/i.test(raw);
    if (signature || location) this.canInstall = false;
    if (location && !this.installBlock) this.installBlock = 'translocated';
    const text = signature
      ? 'This copy of the launcher is not signed in a way that lets it update itself. Download the new version instead.'
      : location
        ? BLOCK_TEXT[this.installBlock]
        : `The update could not be downloaded or checked: ${raw.slice(0, 300)}`;
    this._set('error', { error: text, update: this.update });
  }

  /**
   * "Move to Applications": for a copy that cannot replace itself where it is. `prepare` (async) asks the user about running apps and
   * stops them; false from it cancels. Electron then copies the app into the Applications folder and starts it from there (this copy quits).
   */
  async moveToApplications(prepare) {
    if (!this.installBlock || !this.moveFn) throw new Error('This copy of the launcher cannot be moved from here. Drag it into the Applications folder in Finder.');
    if (prepare && (await prepare()) === false) return this.state();
    this.log('info', `moving the launcher to the Applications folder (it ran from a ${this.installBlock} place)`);
    try {
      await this.moveFn();
    } catch (e) {
      this.log('warn', `move to Applications: ${e.message}`);
      return this._set('error', { error: `The launcher could not move itself: ${String(e.message || e).slice(0, 300)} Drag it into the Applications folder in Finder instead.`, update: this.update });
    }
    return this.state();
  }

  /** "Restart to update": `prepare` (async) asks the user about running apps and stops them; false from it cancels. */
  async restart(prepare) {
    if (this.phase !== 'ready') throw new Error('The update is not downloaded yet.');
    if (prepare && (await prepare()) === false) return this.state();
    this.log('info', 'restarting to install the launcher update');
    this.autoUpdater.quitAndInstall();
    return this.state();
  }

  // ------------------------------------------------------------------------------------------------ the user's choices
  /** "Skip this version": it is not offered again by the automatic checks (a manual check still shows it); a newer one is. */
  skip() {
    if (this.phase !== 'available' || !this.update) throw new Error('There is no update to skip.');
    this.saved.skipped = this.update.version;
    this._write();
    return this._set('idle', { update: null });
  }

  /** "Later": the card goes away; the next check offers it again. */
  later() {
    if (this.phase === 'downloading') throw new Error('The update is downloading.');
    return this._set('idle', { update: null });
  }

  /** "Dismiss" after a result or an error. */
  dismiss() {
    if (['upToDate', 'error'].includes(this.phase)) return this._set('idle', { update: null });
    return this.state();
  }

  /** The address "What's new" or "Download" opens: always one the feed validation allowed, or the fixed fallback on vmapp.dev. */
  pageFor(kind) {
    const u = this.update;
    if (kind === 'changelog') return (u && u.changelogUrl) || CHANGELOG_PAGE;
    if (kind === 'download') return (u && u.pageUrl) || DOWNLOAD_PAGE;
    throw new Error('unknown page');
  }

  // ------------------------------------------------------------------------------------------------ the little file
  _read() {
    const out = { skipped: '', lastCheck: 0 };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j === 'object') {
        if (typeof j.skipped === 'string' && j.skipped.length <= 64) out.skipped = j.skipped;
        if (Number.isFinite(j.lastCheck)) out.lastCheck = j.lastCheck;
      }
    } catch {
      /* none yet, or damaged: start again */
    }
    return out;
  }

  _write() {
    try {
      fs.mkdirSync(this.home, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(this.saved) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log('warn', `launcher-update.json: ${e.message}`);
    }
  }
}

module.exports = { LauncherUpdater, compareDotted, STARTUP_DELAY_MS, RECHECK_MS, TICK_MS, BLOCK_TEXT, DOWNLOAD_PAGE, CHANGELOG_PAGE };
