'use strict';
// The launcher updater's state machine (loader/src/updater.js, SPEC 8.10, INV-U1), with a stand-in for Electron's autoUpdater and a
// stand-in feed server on this Mac. What is tested: when it asks (and when it must not), what the user sees for each answer, that
// nothing downloads or restarts without a click, "skip" and "later", a copy that cannot update itself, and the little state file.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { LauncherUpdater, compareDotted, STARTUP_DELAY_MS, RECHECK_MS, TICK_MS, BLOCK_TEXT, DOWNLOAD_PAGE, CHANGELOG_PAGE } = require('../../loader/src/updater');

const SHA = 'b'.repeat(64);
const FEED = (over = {}) => Object.assign({
  version: '0.2.0',
  url: 'http://127.0.0.1:1/launcher.zip',
  sha256: SHA,
  size: 1234,
  name: 'D9010 VmApp 0.2.0',
  notes: 'Notes.',
  changes: ['One thing.', 'Another thing.'],
  pub_date: '2026-10-20T10:00:00Z',
  changelogUrl: 'https://vmapp.dev/docs/changelog',
  pageUrl: 'https://vmapp.dev/download',
}, over);

function tmpHome(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-updater-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function feedServer(t, initial) {
  let body = initial;
  let status = 200;
  const state = { hits: 0, set: (b, s = 200) => { body = b; status = s; } };
  const server = http.createServer((req, res) => {
    state.hits++;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  state.url = `http://127.0.0.1:${server.address().port}/updates/mac-arm64/latest.json`;
  return state;
}

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  setFeedURL(o) {
    this.calls.push(['setFeedURL', o]);
  }

  checkForUpdates() {
    this.calls.push(['checkForUpdates']);
  }

  quitAndInstall() {
    this.calls.push(['quitAndInstall']);
  }
}

function make(t, over = {}) {
  const prefs = { value: true, get(name) { assert.equal(name, 'checkForUpdates'); return this.value; } };
  const au = over.autoUpdater === undefined ? new FakeAutoUpdater() : over.autoUpdater;
  const logs = [];
  const u = new LauncherUpdater(Object.assign({
    home: tmpHome(t), version: '0.1.0', packaged: true, prefs, autoUpdater: au, dev: true, osVersion: '14.5.0', log: (l, m) => logs.push(`${l} ${m}`),
  }, over));
  // these tests need darwin semantics for "can install in place"
  if (over.autoUpdater !== null && au && u.packaged && !over.installBlock) u.canInstall = true;
  const phases = [];
  u.on('state', (s) => phases.push(s.phase));
  return { u, prefs, au, phases, logs };
}

test('compareDotted compares macOS versions', () => {
  assert.ok(compareDotted('14.5.0', '13') > 0);
  assert.ok(compareDotted('13', '13.0.0') === 0);
  assert.ok(compareDotted('12.7', '13.0') < 0);
  assert.ok(compareDotted('13.0.1', '13.0') > 0);
  assert.equal(compareDotted('x', '0'), 0);
});

test('a manual check that finds a newer launcher says so, with the notes', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, phases } = make(t, { feedUrl: s.url });
  const st = await u.check({ manual: true });
  assert.equal(st.phase, 'available');
  assert.equal(st.update.version, '0.2.0');
  assert.deepEqual(st.update.changes, ['One thing.', 'Another thing.']);
  assert.equal(st.current, '0.1.0');
  assert.equal(st.canInstall, true);
  assert.deepEqual(phases, ['checking', 'available']);
});

test('an automatic check that finds nothing stays silent; a manual one says "up to date"', async (t) => {
  const s = await feedServer(t, FEED({ version: '0.1.0' }));
  const a = make(t, { feedUrl: s.url });
  assert.equal((await a.u.check({ manual: false })).phase, 'idle');
  const m = make(t, { feedUrl: s.url });
  assert.equal((await m.u.check({ manual: true })).phase, 'upToDate');
  assert.equal(m.u.dismiss().phase, 'idle');
});

test('a failed automatic check is silent (only logged); a failed manual check explains', async (t) => {
  const s = await feedServer(t, '', 500);
  s.set('nope', 500);
  const a = make(t, { feedUrl: s.url });
  const st = await a.u.check({ manual: false });
  assert.equal(st.phase, 'idle');
  assert.equal(st.error, '');
  assert.ok(a.logs.some((l) => /launcher update check/.test(l)));
  const m = make(t, { feedUrl: s.url });
  const st2 = await m.u.check({ manual: true });
  assert.equal(st2.phase, 'error');
  assert.match(st2.error, /HTTP 500/);
  assert.equal(m.u.dismiss().phase, 'idle');
});

test('the switch: with it off, automatic checks do not ask; a manual one still does', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, prefs } = make(t, { feedUrl: s.url });
  prefs.value = false;
  assert.equal((await u.check({ manual: false })).phase, 'idle');
  assert.equal(s.hits, 0, 'nothing was requested');
  assert.equal(u.state().autoCheck, false);
  assert.equal((await u.check({ manual: true })).phase, 'available');
  assert.equal(s.hits, 1);
});

test('start-up: asks once after the delay, and not at all when the switch is off', async (t) => {
  const s = await feedServer(t, FEED());
  const on = make(t, { feedUrl: s.url, startupDelayMs: 30 });
  on.u.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.hits, 1);
  assert.equal(on.u.state().phase, 'available');
  on.u.stop();

  s.hits = 0;
  const off = make(t, { feedUrl: s.url, startupDelayMs: 30 });
  off.prefs.value = false;
  off.u.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.hits, 0);
  off.u.stop();

  assert.ok(STARTUP_DELAY_MS <= 10000 && RECHECK_MS === 24 * 3600 * 1000 && TICK_MS <= 3600 * 1000, 'a few seconds after start-up; a day; looked at least hourly');
});

test('every launch asks, even when the last answer was a minute ago (the same data folder)', async (t) => {
  const s = await feedServer(t, FEED());
  const home = tmpHome(t);
  for (let i = 1; i <= 3; i++) {
    const run = make(t, { feedUrl: s.url, home, startupDelayMs: 10 });
    run.u.start();
    await new Promise((r) => setTimeout(r, 200));
    run.u.stop();
    assert.equal(s.hits, i, `launch ${i} asked`);
  }
});

test('while it runs it asks again once a day, also after the Mac slept, and a check that could not reach the server is tried again soon', async (t) => {
  const s = await feedServer(t, FEED());
  let clock = 1_000_000_000_000;
  const { u } = make(t, { feedUrl: s.url, startupDelayMs: 10, tickMs: 20, now: () => clock });
  u.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.hits, 1, 'the launch check, and not again on the ticks while less than a day has passed');
  clock += 23 * 3600 * 1000;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.hits, 1, '23 hours later: not yet');
  clock += 2 * 3600 * 1000; // the Mac slept and woke up 25 hours after the last answer
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.hits, 2, 'a day has passed: asked once more');
  u.stop();

  // the server cannot be reached at the launch check: the next tick tries again instead of waiting a day
  s.set('server trouble', 500);
  const { u: v } = make(t, { feedUrl: s.url, startupDelayMs: 10, tickMs: 20, now: () => clock });
  const before = s.hits;
  v.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(s.hits - before >= 2, `failed answers do not count as "checked today" (${s.hits - before} tries)`);
  s.set(FEED());
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(v.state().phase, 'available', 'and the first answer that works is shown');
  v.stop();
});

test('"Skip this version": not offered again automatically, still shown to a manual check, a newer one is offered', async (t) => {
  const s = await feedServer(t, FEED());
  const home = tmpHome(t);
  const a = make(t, { feedUrl: s.url, home });
  await a.u.check({ manual: true });
  assert.equal(a.u.skip().phase, 'idle');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'launcher-update.json'), 'utf8')).skipped, '0.2.0');
  // a new run of the launcher remembers it
  const b = make(t, { feedUrl: s.url, home });
  assert.equal((await b.u.check({ manual: false })).phase, 'idle');
  assert.equal((await b.u.check({ manual: true })).phase, 'available', 'the user asked, so it is shown');
  s.set(FEED({ version: '0.3.0' }));
  const c = make(t, { feedUrl: s.url, home });
  assert.equal((await c.u.check({ manual: false })).phase, 'available');
  assert.equal(c.u.state().update.version, '0.3.0');
});

test('"Later" only closes the card; the next check offers it again', async (t) => {
  const s = await feedServer(t, FEED());
  const { u } = make(t, { feedUrl: s.url });
  await u.check({ manual: false });
  assert.equal(u.later().phase, 'idle');
  assert.equal((await u.check({ manual: false })).phase, 'available');
});

test('a launcher that needs a newer macOS than this Mac has says so, and offers nothing', async (t) => {
  const s = await feedServer(t, FEED({ minimumOS: '15.0' }));
  const a = make(t, { feedUrl: s.url, osVersion: '14.5.0' });
  assert.equal((await a.u.check({ manual: false })).phase, 'idle');
  const m = make(t, { feedUrl: s.url, osVersion: '14.5.0' });
  const st = await m.u.check({ manual: true });
  assert.equal(st.phase, 'error');
  assert.match(st.error, /needs macOS 15\.0 or later; this Mac has macOS 14\.5\.0/);
  const ok = make(t, { feedUrl: s.url, osVersion: '15.1' });
  assert.equal((await ok.u.check({ manual: true })).phase, 'available');
});

test('nothing downloads until "Update now": a check alone never touches the updater', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au } = make(t, { feedUrl: s.url });
  await u.check({ manual: false });
  assert.equal(u.state().phase, 'available');
  assert.deepEqual(au.calls, []);
});

test('"Update now" hands the feed to the updater, then waits for the user before restarting', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au, phases } = make(t, { feedUrl: s.url });
  await u.check({ manual: true });
  assert.equal(u.install().phase, 'downloading');
  assert.deepEqual(au.calls, [['setFeedURL', { url: s.url, serverType: 'json' }], ['checkForUpdates']]);
  assert.equal(await u.check({ manual: true }).then((x) => x.phase), 'downloading', 'a check while downloading changes nothing');
  assert.throws(() => u.later(), /downloading/);
  au.emit('update-downloaded');
  assert.equal(u.state().phase, 'ready');
  assert.ok(!au.calls.some((c) => c[0] === 'quitAndInstall'), 'no restart yet');
  // (the second 'downloading' is the manual check above re-sending the state so that the card shows again)
  assert.deepEqual(phases.filter((p) => p !== 'checking'), ['available', 'downloading', 'downloading', 'ready']);
});

test('"Restart to update": the caller can ask about running apps first, and can cancel', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au } = make(t, { feedUrl: s.url });
  await u.check({ manual: true });
  await assert.rejects(u.restart(), /not downloaded yet/);
  u.install();
  au.emit('update-downloaded');
  let asked = 0;
  await u.restart(async () => { asked++; return false; });
  assert.equal(asked, 1);
  assert.ok(!au.calls.some((c) => c[0] === 'quitAndInstall'), 'cancelled');
  await u.restart(async () => { asked++; return true; });
  assert.equal(au.calls.filter((c) => c[0] === 'quitAndInstall').length, 1);
});

test('an updater error while downloading is shown, in words', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au } = make(t, { feedUrl: s.url });
  await u.check({ manual: true });
  u.install();
  au.emit('error', new Error('Network connection lost'));
  const st = u.state();
  assert.equal(st.phase, 'error');
  assert.match(st.error, /could not be downloaded or checked: Network connection lost/);
  assert.equal(st.canInstall, true, 'a network error does not mean it cannot update');
  assert.ok(st.update, 'the update is still known, so the card can say what failed');
});

test('after a failed download, "Try again" starts it again; a manual check while busy re-shows the card', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au, phases } = make(t, { feedUrl: s.url });
  await u.check({ manual: true });
  u.install();
  au.emit('error', new Error('Network connection lost'));
  assert.equal(u.state().phase, 'error');
  assert.equal(u.install().phase, 'downloading', 'the same call again');
  assert.equal(au.calls.filter((c) => c[0] === 'checkForUpdates').length, 2);
  const before = phases.length;
  assert.equal((await u.check({ manual: true })).phase, 'downloading');
  assert.equal(phases.length, before + 1, 'the state was sent again so the card shows');
  assert.equal(s.hits, 1, 'and nothing was asked of the server');
});

test('a copy that is not signed for in-place updates is told to download instead', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au } = make(t, { feedUrl: s.url });
  await u.check({ manual: true });
  u.install();
  au.emit('error', new Error('Could not get code signature for running application'));
  const st = u.state();
  assert.equal(st.phase, 'error');
  assert.equal(st.canInstall, false);
  assert.match(st.error, /not signed in a way that lets it update itself/);
  assert.equal(u.pageFor('download'), 'https://vmapp.dev/download');
});

test('a copy that macOS runs from a temporary read-only place says so before "Update now", and offers to move itself', async (t) => {
  const s = await feedServer(t, FEED());
  const moved = [];
  const { u, au, phases } = make(t, { feedUrl: s.url, installBlock: 'translocated', moveToApplications: async () => void moved.push('move') });
  const st = await u.check({ manual: false });
  assert.equal(st.phase, 'available', 'the update is still announced');
  assert.deepEqual([st.canInstall, st.installBlock, st.canMove], [false, 'translocated', true]);
  assert.throws(() => u.install(), /Move it to the Applications folder first/);
  assert.equal(au.calls.length, 0, 'the updater is never asked to download from where it cannot replace itself');
  // the user is asked about running apps first, and can cancel
  assert.equal((await u.moveToApplications(async () => false)).phase, 'available');
  assert.deepEqual(moved, []);
  await u.moveToApplications(async () => true);
  assert.deepEqual(moved, ['move']);
  assert.ok(phases.includes('available'));
});

test('a failed move is explained in words, and the update stays known', async (t) => {
  const s = await feedServer(t, FEED());
  const { u } = make(t, { feedUrl: s.url, installBlock: 'readonly', moveToApplications: async () => { throw new Error('A copy of the launcher is already open in the Applications folder.'); } });
  await u.check({ manual: true });
  const st = await u.moveToApplications(null);
  assert.equal(st.phase, 'error');
  assert.match(st.error, /could not move itself: A copy of the launcher is already open.*Drag it into the Applications folder/);
  assert.ok(st.update, 'the card can still say what is available');
  assert.equal(st.canMove, true, 'and the user can try again');
});

test('without a way to move (not packaged), a blocked copy is told to drag it in Finder', async (t) => {
  const { u } = make(t, { installBlock: 'translocated', moveToApplications: null });
  assert.equal(u.state().canMove, false);
  await assert.rejects(u.moveToApplications(null), /Drag it into the Applications folder in Finder/);
  await assert.rejects(make(t, {}).u.moveToApplications(null), /cannot be moved from here/);
});

test('Squirrel saying "read-only volume" (the app was opened from Downloads) becomes the same advice, not a raw error', async (t) => {
  const s = await feedServer(t, FEED());
  const { u, au } = make(t, { feedUrl: s.url, moveToApplications: async () => {} });
  await u.check({ manual: true });
  u.install();
  au.emit('error', new Error('Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.'));
  const st = u.state();
  assert.equal(st.phase, 'error');
  assert.equal(st.error, BLOCK_TEXT.translocated);
  assert.deepEqual([st.canInstall, st.installBlock, st.canMove], [false, 'translocated', true]);
  assert.ok(st.update);
});

test('a development or unpackaged launcher still shows the update but cannot install it', async (t) => {
  const s = await feedServer(t, FEED());
  const { u } = make(t, { feedUrl: s.url, autoUpdater: null, packaged: false });
  const st = await u.check({ manual: true });
  assert.equal(st.phase, 'available');
  assert.equal(st.canInstall, false);
  assert.throws(() => u.install(), /cannot update itself/);
});

test('install and skip need an update to be showing', async (t) => {
  const { u } = make(t, {});
  assert.throws(() => u.install(), /no update to install/);
  assert.throws(() => u.skip(), /no update to skip/);
});

test('"What\'s new" and "Download" open only addresses the feed validation allowed, or the fixed fallbacks', async (t) => {
  const s = await feedServer(t, FEED({ changelogUrl: 'https://evil.example.com/x', pageUrl: undefined }));
  const { u } = make(t, { feedUrl: s.url });
  assert.equal(u.pageFor('changelog'), CHANGELOG_PAGE, 'before any update is known');
  await u.check({ manual: true });
  assert.equal(u.pageFor('changelog'), CHANGELOG_PAGE, 'a link off vmapp.dev was dropped');
  assert.equal(u.pageFor('download'), DOWNLOAD_PAGE);
  assert.throws(() => u.pageFor('anything-else'), /unknown page/);
  assert.ok(CHANGELOG_PAGE.startsWith('https://vmapp.dev/') && DOWNLOAD_PAGE.startsWith('https://vmapp.dev/'));
});

test('a damaged state file is ignored', (t) => {
  const home = tmpHome(t);
  fs.writeFileSync(path.join(home, 'launcher-update.json'), '{ not json');
  const { u } = make(t, { home });
  assert.deepEqual(u.saved, { skipped: '', lastCheck: 0 });
});
