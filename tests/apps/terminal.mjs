// Terminal (node22 runtime, ptyd + the bundled Gemini CLI): a real VM, real pseudo-terminals, the real Gemini CLI. The test plays the
// window: it starts profiles, types into them, reads the output the core batches up, and acks it like the UI does.
// Run by run-all.sh three times, selected with TERMINAL_PHASE (the app's data folder carries over from one to the next):
//   nokey  a fresh app: the Gemini CLI profile starts without a key and shows its sign-in choice (the bundle runs in the VM)
//   shell  the Shell profile: echo/uname, resize, files in the granted folder, tty group, flow control, stop, the key's storage
//          (0600, never echoed), and the network: refused with the proxy's 403 once revoked, reaching Google while granted
//   key    the Gemini CLI profile with the (dummy) key: it is authenticated from its environment, and a prompt gets Google's
//          "API key not valid" answer through the allowlist proxy
// TERMINAL_ONLINE=0 skips the checks that need the real internet. No real API key is ever used: the "key" is a fixed dummy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, requireEnv, sleep, waitFor } from './lib.mjs';

const PHASE = process.env.TERMINAL_PHASE || 'shell';
const ONLINE = process.env.TERMINAL_ONLINE !== '0';
const GOOGLE = 'generativelanguage.googleapis.com';
const DUMMY_KEY = 'dummy-not-a-real-key-0123456789';
const PINNED = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../apps/terminal/core/package.json', import.meta.url)), 'utf8')).dependencies['@google/gemini-cli'];

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
/** What a person would read: escape sequences and carriage returns removed. */
const plain = (s) => s.replace(ANSI, '').replace(/\r/g, '');

/** The window's side of one terminal: starts a profile, types, collects and acks output, waits for text. */
class Term {
  constructor(wm, win) {
    this.wm = wm;
    this.win = win;
    this.out = ''; // everything received, raw
    this.bytes = 0;
    this.exit = null;
    this.id = null;
    this.ack = true; // like the UI: tell the core what has been drawn
    this.held = 0; // bytes received but not acked while `ack` is false
    this.starting = false;
    this.early = []; // events that arrive before terminal:start has answered (the UI does the same)
    wm.events.on('emit', (w, channel, args) => {
      if (channel !== 'terminal:data' && channel !== 'terminal:exit') return;
      if (this.starting) this.early.push([channel, args[0]]);
      else this.route(channel, args[0]);
    });
  }
  route(channel, m) {
    if (m.id !== this.id) return; // an earlier session's late output
    if (channel === 'terminal:data') {
      const b = Buffer.from(m.b64, 'base64');
      this.out += b.toString('utf8');
      this.bytes += b.length;
      if (this.ack) this.sendAck(b.length);
      else this.held += b.length;
    } else {
      this.exit = m;
    }
  }
  sendAck(n) {
    this.wm.send(this.win, 'terminal:ack', { id: this.id, bytes: n });
  }
  releaseAcks() {
    this.ack = true;
    if (this.held) this.sendAck(this.held);
    this.held = 0;
  }
  async start(profile, rows = 24, cols = 120) {
    this.out = '';
    this.bytes = 0;
    this.exit = null;
    this.id = null;
    this.early = [];
    this.starting = true;
    try {
      const r = await this.wm.invoke(this.win, 'terminal:start', { profile, rows, cols });
      this.id = r.id;
      return r;
    } finally {
      this.starting = false;
      for (const [channel, m] of this.early.splice(0)) this.route(channel, m);
    }
  }
  type(data) {
    this.wm.send(this.win, 'terminal:input', { id: this.id, data });
  }
  resize(rows, cols) {
    this.wm.send(this.win, 'terminal:resize', { id: this.id, rows, cols });
  }
  /** The readable output since character offset `since`. */
  text(since = 0) {
    return plain(this.out.slice(since));
  }
  /** Waits until the readable output since `since` matches `re`; returns that text. */
  async waitFor(re, { since = 0, timeoutMs = 20000, what = String(re) } = {}) {
    let seen = '';
    await waitFor(
      () => {
        seen = this.text(since);
        return re.test(seen);
      },
      { timeoutMs, intervalMs: 50, what: `terminal output matching ${what}; the output so far:\n${seen.slice(-1500)}` },
    );
    return seen;
  }
  waitExit(timeoutMs = 20000) {
    return waitFor(() => this.exit, { timeoutMs, intervalMs: 50, what: 'the program to exit' });
  }
  /** Shell only: runs one command and returns its output (the echoed command line and the next prompt removed). */
  async run(cmd, timeoutMs = 30000) {
    const mark = this.out.length;
    this.type(`${cmd}\n`);
    const text = await this.waitFor(/\nvmapp:[^\n]*\$ $/, { since: mark, timeoutMs, what: `the prompt after "${cmd}"` });
    const lines = text.split('\n');
    lines.shift(); // the echoed command
    lines.pop(); // the prompt
    return lines.join('\n').trimEnd();
  }
}

export default async function ({ session, wm, store }) {
  const fix = requireEnv('APPS_FIX');
  const ws = path.join(fix, 'terminal-ws'); // the granted workspace folder on the host
  const dataDir = store.dataDir(session.appId);
  const settingsFile = path.join(dataDir, 'settings.json');
  const win = 1;

  await wm.waitForWindows(1, 30000);
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  assert.equal(wm.windows.get(win).params.title, 'Terminal');
  ok('window created: index.html, title "Terminal"');

  const net = [];
  session.on('traffic', (ev) => ev.kind === 'net' && net.push(ev));
  const term = new Term(wm, win);

  const init = await wm.invoke(win, 'terminal:init');
  assert.deepEqual(init.profiles.map((p) => p.id), ['shell', 'gemini']);
  assert.ok(init.profiles.every((p) => p.available), JSON.stringify(init.profiles));
  assert.deepEqual(init.workspace, { granted: true, path: '/host/f-workspace' });
  const gemini = init.profiles.find((p) => p.id === 'gemini');
  assert.equal(gemini.secret.env, 'GEMINI_API_KEY');
  ok(`terminal:init lists the profiles Shell and Gemini CLI (both available); the workspace is /host/f-workspace; the key is ${gemini.secret.set ? 'set' : 'not set'}`);

  if (PHASE === 'nokey') await nokey();
  else if (PHASE === 'shell') await shell();
  else if (PHASE === 'key') await withKey();
  else throw new Error(`unknown TERMINAL_PHASE ${PHASE}`);

  // ------------------------------------------------------------------------------------------------ nokey
  async function nokey() {
    assert.equal(gemini.secret.set, false, 'a fresh app has no key');
    assert.equal(fs.existsSync(settingsFile), false);
    const r = await term.start('gemini', 40, 120);
    assert.equal(r.profile, 'gemini');
    assert.equal(r.cwd, '/host/f-workspace');
    assert.equal(r.inWorkspace, true);
    ok('terminal:start gemini -> a session in /host/f-workspace');

    // a folder the CLI has never seen: it asks whether to trust it (the answer is kept in /data/.gemini)
    await term.waitFor(/Do you trust the files in this folder\?/, { timeoutMs: 120000 });
    const banner = await term.waitFor(/Gemini CLI v(\d+\.\d+\.\d+)/, { timeoutMs: 30000 });
    assert.equal(banner.match(/Gemini CLI v(\d+\.\d+\.\d+)/)[1], PINNED);
    ok(`the bundled Gemini CLI v${PINNED} runs in the VM and asks to trust the workspace folder`);
    await sleep(1500); // let the dialog start reading the keyboard
    term.type('\r');

    // no key and no sign-in method: its own sign-in choice. Google sign-in is offered, but cannot finish (no browser, no callback).
    const t = await term.waitFor(/How would you like to authenticate/, { timeoutMs: 120000 });
    assert.match(t, /Use Gemini API Key/);
    assert.match(t, /No authentication method selected/);
    ok('without a key the CLI shows its authentication choice ("No authentication method selected")');
    assert.equal(term.exit, null, 'the CLI keeps running and waits for a choice');

    await wm.invoke(win, 'terminal:stop', { id: term.id });
    const ended = await term.waitExit(30000);
    assert.equal(ended.id, term.id);
    ok(`terminal:stop ends the Gemini CLI (exit code ${ended.code})`);

    // the CLI's own config got the defaults that keep it from reaching hosts the app has not requested
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(cfg.privacy.usageStatisticsEnabled, false);
    assert.equal(cfg.general.enableAutoUpdateNotification, false);
    assert.equal(cfg.security, undefined, 'no sign-in method is chosen for the user while there is no key');
    ok('~/.gemini/settings.json (in /data) has usage statistics and update checks turned off');
    await sleep(500);
    assert.deepEqual(net, [], 'with no network grant the CLI opened no connection and nothing left the VM');
    ok('no network grant: no connection was even attempted through the proxy');
  }

  // ------------------------------------------------------------------------------------------------ shell
  async function shell() {
    fs.writeFileSync(path.join(ws, 'seeded-on-host.txt'), 'seed from the host\n');
    const r = await term.start('shell', 24, 160);
    assert.deepEqual({ profile: r.profile, cwd: r.cwd, inWorkspace: r.inWorkspace }, { profile: 'shell', cwd: '/host/f-workspace', inWorkspace: true });
    await term.waitFor(/vmapp:\/host\/f-workspace\$ $/, { what: 'the shell prompt' });
    ok('terminal:start shell -> bash with its prompt, in /host/f-workspace');

    // the commands of the brief ---------------------------------------------------------------------------
    assert.equal(await term.run('echo rc=$?'), 'rc=0', 'a fresh shell starts with status 0 (a plain `exit` is then exit code 0)');
    const hello = await term.run('echo hello; uname -s');
    assert.equal(hello, 'hello\nLinux');
    ok('"echo hello; uname -s" -> hello, Linux');
    assert.equal(await term.run('echo $((6*7)) && id -u && pwd'), '42\n1000\n/host/f-workspace');
    ok('arithmetic runs, the user is uid 1000, the directory is the granted workspace');

    // a real terminal: tty group and mode of the pty (devpts, SPEC section 4), the size we asked for, TERM ----------
    assert.match(await term.run('tty'), /^\/dev\/pts\/\d+$/);
    assert.equal(await term.run('stat -c "%G %a" $(tty)'), 'tty 620');
    ok('stdin is a pseudo-terminal in /dev/pts, group tty (5), mode 0620 (guest devpts mount)');
    assert.equal(await term.run('stty size'), '24 160');
    assert.equal(await term.run('echo $TERM'), 'xterm-256color');
    ok('the size from terminal:start (24x160) is the terminal size; TERM=xterm-256color');

    // resize -------------------------------------------------------------------------------------------------
    term.resize(30, 100);
    await sleep(300);
    assert.equal(await term.run('stty size'), '30 100');
    term.resize(40, 150);
    await sleep(300);
    assert.equal(await term.run('stty size'), '40 150');
    ok('terminal:resize is applied (stty size: 30 100, then 40 150)');

    // files: VM -> host, host -> VM ----------------------------------------------------------------------------
    assert.equal(await term.run('echo from-the-vm > made-in-vm.txt && mkdir -p sub && echo nested > sub/inner.txt && echo done'), 'done');
    assert.equal(fs.readFileSync(path.join(ws, 'made-in-vm.txt'), 'utf8'), 'from-the-vm\n');
    assert.equal(fs.readFileSync(path.join(ws, 'sub', 'inner.txt'), 'utf8'), 'nested\n');
    ok('files written in the shell appear in the granted host folder (made-in-vm.txt, sub/inner.txt)');
    assert.equal(await term.run('cat seeded-on-host.txt'), 'seed from the host');
    ok('a file the host put in the folder is readable in the shell');

    // nothing outside the workspace and /data is writable --------------------------------------------------------
    assert.match(await term.run('touch /etc/x 2>&1; touch /app/x 2>&1; echo end'), /Read-only file system[\s\S]*Read-only file system[\s\S]*end/);
    assert.equal(await term.run('ls -1 /host'), 'appdata\nf-workspace');
    ok('the system and /app are read-only, and /host holds only appdata and the granted workspace');

    // interactive details ----------------------------------------------------------------------------------------
    assert.equal(await term.run('printf "\\303\\251 \\342\\202\\254\\n"'), 'é €');
    ok('UTF-8 output arrives intact');
    const mark = term.out.length;
    term.type('sleep 30\n');
    await sleep(500);
    term.type('\x03'); // Ctrl+C reaches the foreground program through the line discipline
    await term.waitFor(/\nvmapp:[^\n]*\$ $/, { since: mark, timeoutMs: 10000, what: 'the prompt after Ctrl+C' });
    ok('Ctrl+C interrupts the foreground program (sleep 30)');

    // output flow control: without acks the core stops after about 1 MiB; with them everything arrives ------------
    term.ack = false;
    const before = term.bytes;
    term.type('seq 1 600000\n'); // about 4 MB
    await sleep(6000);
    const held = term.bytes - before;
    assert.ok(held > 500 * 1024, `output flowed while nothing was acked (${held} bytes)`);
    assert.ok(held < 2 * 1024 * 1024, `the core must stop sending when the window is ${held} bytes behind`);
    ok(`flow control: with no acks the core stopped after ${Math.round(held / 1024)} KiB of a ~4 MB output`);
    term.releaseAcks();
    await term.waitFor(/\n600000\nvmapp:[^\n]*\$ $/, { since: 0, timeoutMs: 90000, what: 'the end of the long output' });
    assert.ok(term.bytes - before > 3.5 * 1024 * 1024);
    ok(`after acking, the rest arrives (${((term.bytes - before) / 1048576).toFixed(1)} MiB in total, last line 600000)`);

    // the key: stored in /data/settings.json (0600), never echoed, not in any process or environment of this profile -----
    await assert.rejects(() => wm.invoke(win, 'terminal:secret-set', { env: 'GEMINI_API_KEY', value: 'short' }), (e) => {
      assert.match(e.message, /does not look like a key/);
      assert.ok(!e.message.includes('short'));
      return true;
    });
    await assert.rejects(() => wm.invoke(win, 'terminal:secret-set', { env: 'PATH', value: DUMMY_KEY }), /unknown setting/);
    await assert.rejects(() => wm.invoke(win, 'terminal:secret-set', { env: 'GEMINI_API_KEY', value: 'has spaces in it 1234' }), /does not look like a key/);
    assert.equal(fs.existsSync(settingsFile), false);
    ok('a malformed key and an unknown setting are refused, and nothing is written');

    assert.deepEqual(await wm.invoke(win, 'terminal:secret-set', { env: 'GEMINI_API_KEY', value: ` ${DUMMY_KEY} ` }), { set: true });
    const st = fs.statSync(settingsFile);
    assert.equal(st.mode & 0o777, 0o600, `settings.json mode ${(st.mode & 0o777).toString(8)}`);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).secrets.GEMINI_API_KEY, DUMMY_KEY);
    assert.deepEqual(fs.readdirSync(dataDir).filter((n) => n.startsWith('settings.json')), ['settings.json'], 'no temporary file is left');
    const after = await wm.invoke(win, 'terminal:init');
    assert.equal(after.profiles.find((p) => p.id === 'gemini').secret.set, true);
    assert.ok(!JSON.stringify(after).includes(DUMMY_KEY), 'the key never goes back to the window');
    ok('the key is stored in /data/settings.json with mode 0600 (trimmed); terminal:init says it is set but never returns it');

    // a new Shell session after saving the key: the key is not in its environment or in any process's arguments
    await wm.invoke(win, 'terminal:stop', { id: term.id });
    await term.waitExit();
    await term.start('shell', 24, 160);
    await term.waitFor(/vmapp:\/host\/f-workspace\$ $/, { what: 'the prompt of the second shell' });
    assert.equal(await term.run('echo "[${GEMINI_API_KEY:-unset}]"; env | grep -c GEMINI_ || true'), '[unset]\n0');
    assert.equal(await term.run('cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c "dummy-not-a-[r]eal" || true'), '0');
    assert.equal(await term.run('cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " " | grep -c "dummy-not-a-[r]eal" || true'), '0');
    ok('with a key saved, the Shell profile has no GEMINI_API_KEY, and no process in the VM has the key in its environment or arguments');

    // stopping: the foreground program of a stopped session does not outlive it ------------------------------------
    term.type('sleep 1000\n');
    await sleep(500);
    await wm.invoke(win, 'terminal:stop', { id: term.id });
    await term.waitExit(15000);
    await term.start('shell', 24, 160);
    await term.waitFor(/vmapp:\/host\/f-workspace\$ $/, { what: 'the prompt of the third shell' });
    assert.equal(await term.run('cat /proc/[0-9]*/comm | grep -c "^sleep$" || true'), '0');
    ok('terminal:stop hangs the program up: the sleep that was running is gone');

    // the network ------------------------------------------------------------------------------------------------
    fs.writeFileSync(
      path.join(ws, 'netprobe.js'),
      `const http = require('http');
const tag = process.argv[2];
const said = (s) => console.log(tag + ' ' + s);
fetch('https://${GOOGLE}/v1beta/models').then(
  (r) => said('FETCH ' + r.status),
  (e) => said('FETCH FAILED ' + e.message),
).then(() => {
  const req = http.request({ host: '127.0.0.1', port: 3128, method: 'CONNECT', path: '${GOOGLE}:443' });
  req.on('connect', (res, socket) => {
    if (res.statusCode === 200) { said('CONNECT 200'); socket.destroy(); return; }
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { body += d; });
    socket.on('close', () => said('CONNECT ' + res.statusCode + ' ' + JSON.stringify(body.trim())));
  });
  req.on('error', (e) => said('CONNECT ERROR ' + e.message));
  req.end();
});
`,
    );
    const probe = (tag) => term.run(`node netprobe.js ${tag}`, 60000);
    assert.equal(await term.run('echo $HTTPS_PROXY $NODE_USE_ENV_PROXY'), 'http://127.0.0.1:3128 1');

    if (ONLINE) {
      const granted = await probe('granted');
      const m = granted.match(/^granted FETCH (\d+)$/m);
      assert.ok(m && Number(m[1]) >= 400 && Number(m[1]) < 500, `Google answers a request without a key with HTTP 4xx: ${granted}`);
      assert.match(granted, /^granted CONNECT 200$/m);
      ok(`granted: node's fetch() from the shell reaches ${GOOGLE} through the proxy: HTTP ${m[1]} (no key); CONNECT answers 200`);
    }

    const rv = await session.netRevoke(GOOGLE);
    assert.equal(rv.rule, GOOGLE);
    const denied = await probe('revoked');
    assert.match(denied, /^revoked FETCH FAILED /m);
    assert.match(denied, /^revoked CONNECT 403 /m);
    ok(`grant revoked in the running app: fetch() fails (${denied.split('\n')[0].replace(/^revoked /, '')}) and the proxy answers CONNECT with 403`);
    const refused = await waitFor(() => net.find((e) => e.host === GOOGLE && e.allowed === false), { what: 'the refused connection in the traffic events' });
    assert.equal(refused.port, 443);
    ok(`Inspector event: DENIED ${GOOGLE}:443 (${refused.reason})`);

    if (ONLINE) {
      const synced = await session.syncNetwork();
      assert.deepEqual(synced, { allowed: [GOOGLE], revoked: [] });
      const again = await probe('again');
      assert.match(again, /^again FETCH 4\d\d$/m);
      assert.match(again, /^again CONNECT 200$/m);
      ok('syncNetwork() re-applies the grant: the shell reaches Google again');
      const allowed = await waitFor(() => net.find((e) => e.host === GOOGLE && e.allowed === true && e.bytesDown > 0), { what: 'the allowed connection in the traffic events' });
      ok(`Inspector event: allowed ${GOOGLE}:443, ${allowed.bytesUp} bytes up, ${allowed.bytesDown} down`);
    }
    // a host that is not in the manifest can never be reached, whatever the shell tries
    const other = await term.run(
      `node -e "fetch('https://example.com/').then(r=>console.log('OTHER',r.status),e=>console.log('OTHER FAILED'))"`,
      60000,
    );
    assert.equal(other, 'OTHER FAILED');
    ok('a host the app never asked for (example.com) is refused');

    // exit code and restart -----------------------------------------------------------------------------------------
    term.type('exit 3\n');
    const ended = await term.waitExit();
    assert.equal(ended.code, 3);
    const oldId = term.id;
    await term.start('shell', 24, 80);
    assert.notEqual(term.id, oldId);
    await term.waitFor(/vmapp:\/host\/f-workspace\$ $/, { what: 'the prompt after the restart' });
    assert.equal(await term.run('stty size'), '24 80');
    ok('"exit 3" is reported as exit code 3; starting again gives a new session');

    // an unknown profile / bad sizes are refused ---------------------------------------------------------------------
    await assert.rejects(() => wm.invoke(win, 'terminal:start', { profile: 'nope' }), /unknown profile/);
    await assert.rejects(() => wm.invoke(win, 'terminal:start', { profile: 'shell', rows: 0, cols: 80 }), /rows must be/);
    ok('an unknown profile and a nonsense size are refused');

    // the key never reached the terminal, the console log or the window ---------------------------------------------------
    for (const line of net) assert.ok(!JSON.stringify(line).includes(DUMMY_KEY));
    await checkNothingLeaked();
  }

  // ------------------------------------------------------------------------------------------------ key
  async function withKey() {
    assert.equal(gemini.secret.set, true, 'the shell phase saved the dummy key');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).secrets.GEMINI_API_KEY, DUMMY_KEY);
    await term.start('gemini', 40, 120);
    const t = await term.waitFor(/Authenticated with gemini-api-key/, { timeoutMs: 120000 });
    assert.ok(!/How would you like to authenticate/.test(t), 'the sign-in dialog is not shown: the key from the environment is used');
    assert.ok(!/Enter Gemini API Key/.test(t));
    assert.ok(!t.includes(DUMMY_KEY), 'the key is not drawn anywhere');
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(cfg.security.auth.selectedType, 'gemini-api-key');
    ok('with the key saved, the Gemini CLI starts "Authenticated with gemini-api-key" (key passed in its environment, no sign-in dialog)');

    if (ONLINE) {
      // the CLI only reads the keyboard once its prompt box is up (keys typed earlier are flushed when it switches the tty to raw mode)
      await term.waitFor(/Type your message or @path\/to\/file/, { timeoutMs: 60000 });
      await sleep(1500);
      const mark = term.out.length;
      term.type('hello');
      await sleep(1000);
      term.type('\r'); // typed separately, so it is an Enter and not part of a paste
      const answer = await term.waitFor(/API key not valid/, { since: mark, timeoutMs: 180000, what: "Google's API-key error" });
      assert.match(answer, /API_KEY_INVALID|INVALID_ARGUMENT|Bad Request/);
      assert.ok(!answer.includes(DUMMY_KEY));
      ok("a prompt reaches Google through the proxy and comes back with Google's \"API key not valid\" (HTTP 400): the key was sent as the API key");
    }

    await wm.invoke(win, 'terminal:stop', { id: term.id });
    await term.waitExit(30000);
    if (ONLINE) {
      const allowed = await waitFor(() => net.find((e) => e.host === GOOGLE && e.allowed && e.bytesUp > 0), { timeoutMs: 15000, what: 'the connection event' });
      ok(`Inspector event: allowed ${GOOGLE}:443, ${allowed.bytesUp} bytes up, ${allowed.bytesDown} down`);
    }
    const hosts = [...new Set(net.map((e) => e.host))];
    assert.deepEqual(hosts.filter((h) => h !== GOOGLE), [], `the Gemini CLI reached no other host: ${hosts.join(', ')}`);
    ok(`the Gemini CLI asked for no host but ${GOOGLE} (seen: ${hosts.join(', ') || 'none'})`);

    // removing the key
    assert.deepEqual(await wm.invoke(win, 'terminal:secret-clear', { env: 'GEMINI_API_KEY' }), { set: false });
    assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(DUMMY_KEY));
    assert.equal((fs.statSync(settingsFile).mode & 0o777), 0o600);
    assert.equal((await wm.invoke(win, 'terminal:init')).profiles.find((p) => p.id === 'gemini').secret.set, false);
    ok('terminal:secret-clear removes the key from settings.json');
    await checkNothingLeaked();
  }

  /** The dummy key is in settings.json and in one process's environment, nowhere else: not in the terminal, not in the core's log. */
  async function checkNothingLeaked() {
    assert.ok(!term.out.includes(DUMMY_KEY), 'the key never appeared in the terminal output');
    const logFile = path.join(process.env.VMAPP_HOME || '', 'logs', `${session.appId}.console.log`);
    if (process.env.VMAPP_HOME && fs.existsSync(logFile)) {
      assert.ok(!fs.readFileSync(logFile, 'utf8').includes(DUMMY_KEY), 'the key is not in the console log');
      ok('the key is nowhere in the terminal output or in the VM console log');
    } else {
      ok('the key never appeared in the terminal output (no console log to read)');
    }
  }
}
