'use strict';
// A bare Node core for the network tests (tests/e2e.sh scenario 11; it runs in the node22 runtime, which this checks too).
// It has no window and no bridge: it fetches real HTTPS URLs through the proxy, once a second, and logs each outcome to
// the console as `NETTEST #<n> <host> status=<code> bytes=<n>` or `NETTEST #<n> <host> error=<reason>`. Nothing in
// the code mentions a proxy: Node 22.21+ sends fetch/http/https through $HTTPS_PROXY because the guest sets
// NODE_USE_ENV_PROXY=1 (SPEC 8.3).
//
//   NETTEST_URLS   comma separated URLs (default: the npm registry, which the test grants, and example.com, which it does not)

const urls = (process.env.NETTEST_URLS || 'https://registry.npmjs.org/left-pad,https://example.com/').split(',');
let round = 0;

async function fetchOne(n, url) {
  const host = new URL(url).hostname;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    const t = await r.text();
    console.log(`NETTEST #${n} ${host} status=${r.status} bytes=${t.length}`);
  } catch (e) {
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    console.log(`NETTEST #${n} ${host} error=${String(why).replace(/\s+/g, ' ')}`);
  }
}

console.log(`NETTEST node=${process.version} HTTPS_PROXY=${process.env.HTTPS_PROXY} NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY}`);
(async () => {
  for (;;) {
    round += 1;
    for (const u of urls) await fetchOne(round, u);
    await new Promise((r) => setTimeout(r, 1000));
  }
})();
