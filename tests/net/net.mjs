// The network permission end to end (SPEC 8.3): a Node app on the node22 runtime, a real VM, the REAL internet, the whole
// hostlib path (manifest -> grants -> --net rules -> allowlist proxy -> traffic events). Run by tests/net/run.sh with
// `vmapp run --headless --script`; NET_PHASE selects what is expected:
//   granted  registry.npmjs.org is granted: fetch('https://registry.npmjs.org/left-pad') answers 200 with real JSON (TLS runs
//            end to end through the tunnel); example.com (not requested, so it cannot be granted) is refused by the proxy;
//            then the grant is revoked in the RUNNING app (session.netRevoke): the same fetch fails, and the Inspector
//            events show what happened (bytes for the first, the revoke, the refusal).
//   none     the grant does not exist: every fetch fails and nothing leaves the VM.
import assert from 'node:assert/strict';
import { ok, waitFor } from '../apps/lib.mjs';

const PHASE = process.env.NET_PHASE || 'granted';
const NPM = 'https://registry.npmjs.org/left-pad';

export default async function ({ session, wm }) {
  const win = 1;
  await wm.waitForWindows(1, 30000);
  const events = [];
  session.on('traffic', (ev) => ev.kind === 'net' && events.push(ev));
  const fetchIn = (url) => wm.invoke(win, 'net:fetch', url);

  const env = await wm.invoke(win, 'net:env');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.match(env.node, /^v22\.(2[1-9]|[3-9]\d)\./, `Node ${env.node} must be 22.21 or later for NODE_USE_ENV_PROXY`);
  ok(`the core sees the proxy environment (Node ${env.node}, HTTPS_PROXY ${env.HTTPS_PROXY})`);

  if (PHASE === 'granted') {
    const r = await fetchIn(NPM);
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.name, 'left-pad');
    assert.ok(r.bytes > 1000, `${r.bytes} bytes`);
    ok(`fetch(${NPM}) inside the VM: HTTP ${r.status}, "${r.name}", ${r.bytes} bytes (TLS end to end)`);

    const refused = await fetchIn('https://example.com/');
    assert.ok(refused.error, JSON.stringify(refused));
    ok(`a host that is not in the app's permissions is refused (${refused.error})`);

    // the refusal is visible at once; the allowed connection reports when it closes
    const denied = await waitFor(() => events.find((e) => e.host === 'example.com'), { what: 'the example.com event' });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /^network not granted$|^not allowed: example\.com:443/);
    assert.equal(denied.bytes, 0);
    ok(`Inspector event: DENIED example.com:443 (${denied.reason})`);

    // revoke in the running app: open connections close, new ones are refused
    const rv = await session.netRevoke('registry.npmjs.org');
    assert.equal(rv.rule, 'registry.npmjs.org');
    ok(`netRevoke: vmapp-vm closed ${rv.closed} open connection(s)`);
    const after = await fetchIn(NPM);
    assert.ok(after.error, `the same fetch must fail after the revoke: ${JSON.stringify(after)}`);
    ok(`after the revoke the same fetch fails (${after.error})`);

    const allowed = await waitFor(() => events.find((e) => e.host === 'registry.npmjs.org' && e.allowed), { what: 'the registry.npmjs.org event' });
    assert.ok(allowed.bytesDown > 1000 && allowed.bytesUp > 100, JSON.stringify(allowed));
    assert.ok(allowed.durationMs >= 0 && allowed.port === 443);
    ok(`Inspector event: allowed registry.npmjs.org:443, ${allowed.bytesUp} bytes up, ${allowed.bytesDown} down, ${allowed.durationMs} ms${allowed.reason ? ` (${allowed.reason})` : ''}`);
    const refusedAgain = events.filter((e) => e.host === 'registry.npmjs.org' && !e.allowed);
    assert.ok(refusedAgain.length >= 1);
    ok('Inspector event: the fetch after the revoke is DENIED');

    // the grant on disk is untouched by a live revoke; a sync with the stored grants brings the VM back in line
    const synced = await session.syncNetwork();
    assert.deepEqual(synced, { allowed: ['registry.npmjs.org'], revoked: [] });
    const again = await fetchIn(NPM);
    assert.equal(again.status, 200, JSON.stringify(again));
    ok('syncNetwork() re-applies the stored grant to the running VM: the fetch works again');
  } else {
    assert.equal(PHASE, 'none');
    const r = await fetchIn(NPM);
    assert.ok(r.error, `without a grant the fetch must fail: ${JSON.stringify(r)}`);
    ok(`no grant: fetch(${NPM}) fails (${r.error})`);
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(events, [], 'no network channel exists, so there is nothing to report and nothing left the VM');
    ok('no grant: no network channel was opened and no traffic event exists');
  }
}
