#!/usr/bin/env node
'use strict';
// Publishes the website and the registry API to Cloudflare, and verifies what is live.
//
//   node publish.js                       the site and the API: build, scan, deploy, verify (the site against dist/, the API with smoke checks)
//   node publish.js --site-only           only the site (Cloudflare Pages)
//   node publish.js --api-only            only the API (the Worker in ../registry-worker)
//   node publish.js --with-tests          run the API's tests before deploying it
//   node publish.js --live                verify the site at siteUrl (the custom domain) instead of the Pages address
//   node publish.js --url URL             verify the site at URL;  --api-url URL  verify the API at URL
//   node publish.js --no-verify           deploy, skip the verification
//   node publish.js --dry-run             build and scan; print the commands that would run; call nothing else
//   node publish.js --verify-only         deploy nothing; compare the existing dist/ (and the API's behaviour) with what is live
//
// Node built-ins only. Exit code 0 on success, 1 on any failure. No token is ever read, printed or logged here: Wrangler keeps its own
// login, or reads CLOUDFLARE_API_TOKEN from the environment it inherits.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// The one place the Wrangler version is pinned (npx fetches exactly this version, so the deploy does not drift).
const WRANGLER = 'wrangler@4.151.1';
const LOGIN_HINT = 'Not logged in. Run: npx wrangler login --scopes account:read user:read pages:write';
// What deploying the API needs on top of the site's scopes (a Worker, its Durable Object, its R2 bucket, its custom domain).
const API_LOGIN_HINT = 'Run: npx wrangler login --scopes account:read user:read pages:write workers:write workers_scripts:write workers_routes:write zone:read';

// A published file must not contain any of these: local paths and personal markers, and wording that is internal. Edit the list here.
const LEAK_MARKERS = [
  { text: '/Volumes/', ignoreCase: false },
  { text: '/Users/', ignoreCase: false },
  { text: 'red-team', ignoreCase: true },
  { text: 'red team', ignoreCase: true },
];
// Private markers (a personal name) come from website/.leak-markers, one per line, a file that git ignores: the name itself must
// not appear in the public repository.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.leak-markers'), 'utf8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) LEAK_MARKERS.push({ text: t, ignoreCase: true });
  }
} catch {
  /* no private markers on this machine */
}

// Phrases that are allowed even though they contain a marker: generic example paths in the documentation (a Mac external drive named "Big").
const LEAK_ALLOWED = ['/Volumes/Big/'];

// Verification retries because a new deployment takes a moment to reach every edge: 5 attempts, these waits between them (60 s in all).
const RETRY_WAITS_MS = [10000, 15000, 15000, 20000];
const FETCH_TIMEOUT_MS = 30000;
const FETCH_PARALLEL = 6;
const UNKNOWN_PATH = '/no-such-page-xyz';

const USAGE = `Usage: node publish.js [options]

Rebuilds the site, scans it for leaks, deploys it (Cloudflare Pages) and the registry API (a Cloudflare Worker) with Wrangler, and
verifies that what is live is what was built.

Options:
  --site-only     only the site
  --api-only      only the API (the Worker in ../registry-worker)
  --with-tests    run the API's tests (npm test in ../registry-worker) before deploying it
  --dry-run       build and scan, print the commands that would run, call nothing else
  --verify-only   deploy nothing: compare dist/ with the live site, and check the live API
  --no-verify     do not verify after the deploy
  --url URL       verify the site at URL (for example http://127.0.0.1:8081)
  --live          verify the site at siteUrl from site.json (the public address) instead of the Pages address
  --api-url URL   verify the API at URL instead of the "api.url" of site.json
  --help          show this text

Without --url or --live, the address Wrangler prints for the new site deployment is used (https://<project>.pages.dev if it printed none).
One-time login for the site: npx wrangler login --scopes account:read user:read pages:write
For the API as well:         npx wrangler login --scopes account:read user:read pages:write workers:write workers_scripts:write workers_routes:write zone:read`;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, verifyOnly: false, noVerify: false, live: false, url: null, apiUrl: null, siteOnly: false, apiOnly: false, withTests: false, help: false };
  const value = (a, i, name, example) => {
    const v = a.startsWith(`${name}=`) ? a.slice(name.length + 1) : argv[i + 1];
    if (!v || v.startsWith('--')) throw new UsageError(`${name} needs an address, for example ${name} ${example}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verify-only') opts.verifyOnly = true;
    else if (a === '--no-verify') opts.noVerify = true;
    else if (a === '--live') opts.live = true;
    else if (a === '--site-only') opts.siteOnly = true;
    else if (a === '--api-only') opts.apiOnly = true;
    else if (a === '--with-tests') opts.withTests = true;
    else if (a === '--url' || a.startsWith('--url=')) {
      opts.url = value(a, i, '--url', 'http://127.0.0.1:8081');
      if (a === '--url') i++;
    } else if (a === '--api-url' || a.startsWith('--api-url=')) {
      opts.apiUrl = value(a, i, '--api-url', 'http://127.0.0.1:8787');
      if (a === '--api-url') i++;
    } else throw new UsageError(`unknown option: ${a}`);
  }
  if (opts.verifyOnly && opts.dryRun) throw new UsageError('--verify-only and --dry-run cannot be combined');
  if (opts.verifyOnly && opts.noVerify) throw new UsageError('--verify-only and --no-verify cannot be combined');
  if (opts.siteOnly && opts.apiOnly) throw new UsageError('--site-only and --api-only cannot be combined');
  return opts;
}

// ---- running other programs ---------------------------------------------------------------------------------------------------

// mode 'inherit': the child writes straight to the terminal. 'echo': output is shown and also returned. 'quiet': output is only returned.
function run(cmd, args, mode, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: mode === 'inherit' ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
    let out = '';
    if (mode !== 'inherit') {
      child.stdout.on('data', (d) => { out += d; if (mode === 'echo') process.stdout.write(d); });
      child.stderr.on('data', (d) => { out += d; if (mode === 'echo') process.stderr.write(d); });
    }
    child.on('error', (e) => resolve({ code: 1, out: `${out}\n${e.message}` }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, out: stripAnsi(out) }));
  });
}

const quote = (parts) => parts.map((p) => (/^[\w@./:=-]+$/.test(p) ? p : JSON.stringify(p))).join(' ');

// ---- the leak scan ------------------------------------------------------------------------------------------------------------

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// A file is binary when its first bytes hold a NUL.
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Returns [{file, marker, line}] for every marker found in a text file under dir (file is relative to dir).
function leakScan(dir, markers = LEAK_MARKERS) {
  const found = [];
  for (const file of filesIn(dir)) {
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) continue;
    // Allowed phrases are blanked out (same length, so line numbers stay right) before looking for markers.
    const text = LEAK_ALLOWED.reduce((t, a) => t.split(a).join('_'.repeat(a.length)), buf.toString('utf8'));
    const lower = text.toLowerCase();
    for (const m of markers) {
      const at = m.ignoreCase ? lower.indexOf(m.text.toLowerCase()) : text.indexOf(m.text);
      if (at >= 0) found.push({ file: path.relative(dir, file), marker: m.text, line: text.slice(0, at).split('\n').length });
    }
  }
  return found;
}

// ---- verifying the site -------------------------------------------------------------------------------------------------------

// The sitemap's absolute <loc> addresses, as paths.
function sitemapPaths() {
  const xml = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => new URL(m[1]).pathname);
}

// / -> index.html, /docs/ -> docs/index.html, /x -> x.html, /docs/x -> docs/x.html
function fileForPath(p) {
  if (p.endsWith('/')) return `${p.slice(1)}index.html`;
  return `${p.slice(1)}.html`;
}

async function get(base, p, init = {}) {
  const res = await fetch(new URL(p, base), { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'cache-control': 'no-cache' }, ...init });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

const why = (e) => (e.cause && e.cause.code ? e.cause.code : e.message);

// Runs fn over items, a few at a time, keeping the order of the results.
async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

// One pass over the whole site. Returns {problems: [string], same: number} where `same` counts the files that are identical.
async function verifyOnce(base) {
  const problems = [];
  const pages = sitemapPaths();
  // [path, file in dist]: every page of the sitemap, robots.txt, sitemap.xml, and the files in assets/.
  const checks = pages.map((p) => [p, fileForPath(p)]);
  checks.push(['/robots.txt', 'robots.txt'], ['/sitemap.xml', 'sitemap.xml']);
  for (const f of filesIn(path.join(DIST, 'assets'))) {
    const rel = path.relative(DIST, f).split(path.sep).join('/');
    checks.push([`/${rel}`, rel]);
  }
  let same = 0;
  await pool(checks, async ([p, rel]) => {
    const local = path.join(DIST, rel);
    if (!fs.existsSync(local)) { problems.push(`${p}: dist/${rel} does not exist, so there is nothing to compare`); return; }
    try {
      const r = await get(base, p);
      if (r.status !== 200) problems.push(`${p}: status ${r.status}, expected 200`);
      else if (sha256(r.body) !== sha256(fs.readFileSync(local))) problems.push(`${p}: differs from dist/${rel} (live ${r.body.length} bytes, sha256 ${sha256(r.body).slice(0, 12)}; built sha256 ${sha256(fs.readFileSync(local)).slice(0, 12)})`);
      else same++;
    } catch (e) {
      problems.push(`${p}: could not be fetched (${why(e)})`);
    }
  });

  try {
    const r = await get(base, UNKNOWN_PATH);
    if (r.status !== 404) problems.push(`${UNKNOWN_PATH}: status ${r.status}, expected 404`);
  } catch (e) {
    problems.push(`${UNKNOWN_PATH}: could not be fetched (${why(e)})`);
  }

  try {
    const r = await get(base, '/');
    if (!r.headers.get('content-security-policy')) problems.push('/: no Content-Security-Policy header');
    if (!/nosniff/i.test(r.headers.get('x-content-type-options') || '')) problems.push('/: no "x-content-type-options: nosniff" header');
  } catch (e) {
    problems.push(`/: headers could not be checked (${why(e)})`);
  }
  return { problems: problems.sort(), same, total: checks.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `once` (async () => {problems, summary}) until it has no problems, with the retry waits above. Returns true on success.
async function untilClean(label, once) {
  for (let attempt = 1; ; attempt++) {
    const { problems, summary } = await once();
    if (!problems.length) {
      console.log(summary);
      return true;
    }
    if (attempt > RETRY_WAITS_MS.length) {
      console.error(`error: ${label}: ${problems.length} check(s) still failing after ${attempt} attempts:`);
      for (const p of problems) console.error(`  ${p}`);
      return false;
    }
    const wait = RETRY_WAITS_MS[attempt - 1];
    console.log(`attempt ${attempt} of ${RETRY_WAITS_MS.length + 1}: ${problems.length} check(s) failing; trying again in ${wait / 1000} s`);
    await sleep(wait);
  }
}

async function verifySite(base) {
  console.log(`\nVerifying ${base} against dist/ ...`);
  return untilClean('the site', async () => {
    const { problems, same, total } = await verifyOnce(base);
    return {
      problems,
      summary: `Verified ${base}: ${same} of ${total} files identical to dist/ (pages, robots.txt, sitemap.xml, assets); ${UNKNOWN_PATH} gives 404; Content-Security-Policy and nosniff headers present.`,
    };
  });
}

// ---- verifying the API --------------------------------------------------------------------------------------------------------

// Smoke checks of a live registry API: it is what it claims to be, answers in the documented shapes, and its errors are JSON.
async function apiOnce(base) {
  const problems = [];
  const json = async (p, init) => {
    const r = await get(base, p, init);
    let body = null;
    try {
      body = JSON.parse(r.body.toString('utf8'));
    } catch {
      /* not JSON */
    }
    return { ...r, json: body };
  };
  const check = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${what}: ${e.message || why(e)}`);
    }
  };
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };

  await check('GET /api/info', async () => {
    const r = await json('/api/info');
    need(r.status === 200, `status ${r.status}, expected 200`);
    need(r.json && r.json.name === 'vmapp-registry', 'does not say it is "vmapp-registry"');
    need(Array.isArray(r.json.publishModes) && r.json.publishModes.length > 0, 'has no publishModes');
    need(Number.isSafeInteger(r.json.maxPackageBytes), 'has no maxPackageBytes');
    need(/nosniff/i.test(r.headers.get('x-content-type-options') || ''), 'no "x-content-type-options: nosniff" header');
  });
  await check('GET /api/stats', async () => {
    const r = await json('/api/stats');
    need(r.status === 200, `status ${r.status}, expected 200`);
    need(r.json && ['apps', 'versions', 'downloads'].every((k) => Number.isSafeInteger(r.json[k])), 'is not {apps, versions, downloads}');
  });
  await check('GET /api/apps', async () => {
    const r = await json('/api/apps?sort=popular&limit=5');
    need(r.status === 200, `status ${r.status}, expected 200`);
    need(r.json && Array.isArray(r.json.items) && Number.isSafeInteger(r.json.total) && r.json.sort === 'popular', 'is not {total, limit, offset, sort, q, items}');
    need(r.headers.get('access-control-allow-origin') === '*', 'public reads do not allow cross-origin access');
  });
  await check('GET /api/apps?sort=bogus', async () => {
    const r = await json('/api/apps?sort=bogus');
    need(r.status === 400 && r.json && r.json.error && r.json.error.code === 'bad_request', `status ${r.status}, expected a 400 bad_request`);
  });
  await check('GET /api/apps/<unknown>', async () => {
    const r = await json('/api/apps/com.example.no-such-app');
    need(r.status === 404 && r.json && r.json.error && r.json.error.code === 'not_found', `status ${r.status}, expected a JSON 404 not_found`);
  });
  await check('POST /api/publish without a body', async () => {
    const r = await json('/api/publish', { method: 'POST' });
    need(r.status >= 400 && r.status < 500 && r.json && r.json.error, `status ${r.status}, expected a JSON 4xx error`);
  });
  await check('GET /robots.txt', async () => {
    const r = await get(base, '/robots.txt');
    need(r.status === 200 && /Disallow:\s*\//.test(r.body.toString('utf8')), 'does not disallow crawling the API');
  });
  return problems.sort();
}

async function verifyApi(base) {
  console.log(`\nVerifying the API at ${base} ...`);
  return untilClean('the API', async () => {
    const problems = await apiOnce(base);
    return { problems, summary: `Verified ${base}: /api/info, /api/stats, /api/apps, the JSON error shapes, CORS and security headers, robots.txt.` };
  });
}

// ---- the steps ----------------------------------------------------------------------------------------------------------------

function fail(message) {
  console.error(`error: ${message}`);
  return 1;
}

// The address Wrangler prints for the new deployment: the address on its "Deployment complete" line, else the last one printed.
function deploymentUrl(output, suffix = 'pages\\.dev') {
  const pattern = new RegExp(`https://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${suffix}\\b`, 'gi');
  const all = [];
  for (const line of output.split('\n')) {
    const hits = line.match(pattern);
    if (hits && /deployment complete|take a peek|deployed|current version/i.test(line)) return hits[0];
    if (hits) all.push(...hits);
  }
  return all.length ? all[all.length - 1] : null;
}

// Is Wrangler logged in? With CLOUDFLARE_API_TOKEN set it uses the token from the environment and no login is needed.
async function authenticated(hint) {
  if (process.env.CLOUDFLARE_API_TOKEN) return true;
  const whoamiCmd = ['npx', '--yes', WRANGLER, 'whoami'];
  const who = await run(whoamiCmd[0], whoamiCmd.slice(1), 'quiet');
  if (who.code !== 0 && !/not authenticated|not logged in|wrangler login/i.test(who.out)) {
    console.error(`error: "${quote(whoamiCmd)}" failed:\n${who.out.trim()}`);
    return false;
  }
  if (who.code !== 0 || /not authenticated|not logged in|please run .?wrangler login/i.test(who.out)) {
    console.error(hint);
    return false;
  }
  return true;
}

async function siteStep(opts, site) {
  if (!site.cloudflareProject) return fail('site.json has no "cloudflareProject" (the name of the Cloudflare Pages project).');
  if (!opts.verifyOnly && !fs.existsSync(path.join(ROOT, 'node_modules', 'marked'))) return fail('node_modules/marked is missing. Run "npm ci" in website/ first.');

  const buildCmd = [process.execPath, 'build.js', '--production'];
  const whoamiCmd = ['npx', '--yes', WRANGLER, 'whoami'];
  const deployCmd = ['npx', '--yes', WRANGLER, 'pages', 'deploy', 'dist', '--project-name', site.cloudflareProject, '--branch', 'main'];
  const listCmd = ['npx', '--yes', WRANGLER, 'pages', 'project', 'list'];
  const createCmd = ['npx', '--yes', WRANGLER, 'pages', 'project', 'create', site.cloudflareProject, '--production-branch', 'main'];
  const fallbackBase = `https://${site.cloudflareProject}.pages.dev`;
  const chosenBase = opts.url || (opts.live ? site.siteUrl : null);

  console.log('\n=== The site ===');
  if (!opts.verifyOnly) {
    console.log('Building: node build.js --production');
    if ((await run(buildCmd[0], buildCmd.slice(1), 'inherit')).code !== 0) return fail('the build failed; nothing was deployed.');

    const leaks = leakScan(DIST);
    if (leaks.length) {
      for (const l of leaks) console.error(`error: dist/${l.file}:${l.line} contains "${l.marker}"`);
      return fail('the leak scan found local paths or internal wording in the output; nothing was deployed.');
    }
    console.log(`Leak scan: no file in dist/ contains ${LEAK_MARKERS.map((m) => `"${m.text}"`).join(', ')}.`);
  }

  if (opts.dryRun) {
    console.log('\nDry run: Wrangler is not called. The site commands that would run:');
    console.log(`  ${quote(whoamiCmd)}${process.env.CLOUDFLARE_API_TOKEN ? '   (skipped: CLOUDFLARE_API_TOKEN is set)' : ''}`);
    console.log(`  ${quote(listCmd)}   (then, only if the project is missing: ${quote(createCmd)})`);
    console.log(`  ${quote(deployCmd)}`);
    console.log(opts.noVerify ? '  (no verification: --no-verify)' : `  then verify dist/ against ${chosenBase || `the deployment address Wrangler prints (else ${fallbackBase})`}`);
    return 0;
  }

  let deployedUrl = null;
  if (!opts.verifyOnly) {
    if (!(await authenticated(LOGIN_HINT))) return 1;

    // The Pages project must exist. The first run creates it (production branch: main); later runs find it and move on.
    const listed = await run(listCmd[0], listCmd.slice(1), 'quiet');
    if (listed.code !== 0) return fail(`"${quote(listCmd)}" failed:\n${listed.out.trim()}`);
    if (!listed.out.includes(site.cloudflareProject)) {
      console.log(`\nThe Pages project "${site.cloudflareProject}" does not exist yet. Creating it: ${quote(createCmd)}`);
      if ((await run(createCmd[0], createCmd.slice(1), 'echo')).code !== 0) return fail('the Pages project could not be created.');
    }

    console.log(`\nDeploying: ${quote(deployCmd)}`);
    const dep = await run(deployCmd[0], deployCmd.slice(1), 'echo');
    if (dep.code !== 0) return fail(`the deploy failed (exit code ${dep.code}).`);
    deployedUrl = deploymentUrl(dep.out);
    console.log(deployedUrl ? `Deployed: ${deployedUrl}` : 'Deployed (Wrangler printed no *.pages.dev address).');
  }

  if (opts.noVerify) { console.log('Verification skipped (--no-verify).'); return 0; }
  if (!fs.existsSync(path.join(DIST, 'sitemap.xml'))) return fail('dist/sitemap.xml does not exist; build first (node build.js --production).');
  return (await verifySite(chosenBase || deployedUrl || fallbackBase)) ? 0 : 1;
}

async function apiStep(opts, site) {
  const api = site.api;
  if (!api || !api.dir || !api.bucket || !api.url) return fail('site.json has no "api" section ({dir, worker, bucket, url}).');
  const dir = path.resolve(ROOT, api.dir);
  if (!fs.existsSync(path.join(dir, 'wrangler.jsonc'))) return fail(`${dir} has no wrangler.jsonc (is "api.dir" in site.json right?).`);

  const testCmd = ['npm', 'test'];
  const bucketsCmd = ['npx', '--yes', WRANGLER, 'r2', 'bucket', 'list'];
  const bucketCreate = ['npx', '--yes', WRANGLER, 'r2', 'bucket', 'create', api.bucket];
  const deployCmd = ['npx', '--yes', WRANGLER, 'deploy'];
  const chosenBase = opts.apiUrl || api.url;

  console.log('\n=== The API ===');
  if (opts.dryRun) {
    console.log(`Dry run: Wrangler is not called. The API commands that would run, in ${path.relative(process.cwd(), dir) || dir}:`);
    if (opts.withTests) console.log(`  ${quote(testCmd)}`);
    console.log(`  ${quote(bucketsCmd)}   (then, only if the bucket "${api.bucket}" is missing: ${quote(bucketCreate)})`);
    console.log(`  ${quote(deployCmd)}`);
    console.log(opts.noVerify ? '  (no verification: --no-verify)' : `  then check the live API at ${chosenBase}`);
    return 0;
  }

  if (!opts.verifyOnly) {
    if (opts.withTests) {
      console.log(`Testing: ${quote(testCmd)}`);
      if ((await run(testCmd[0], testCmd.slice(1), 'inherit', dir)).code !== 0) return fail('the API tests failed; nothing was deployed.');
    }
    if (!(await authenticated(API_LOGIN_HINT))) return 1;

    // The package bucket must exist (R2 has to be enabled in the Cloudflare dashboard once). The first run creates the bucket.
    const listed = await run(bucketsCmd[0], bucketsCmd.slice(1), 'quiet', dir);
    if (listed.code !== 0) return fail(`"${quote(bucketsCmd)}" failed:\n${listed.out.trim()}\nR2 must be enabled once in the Cloudflare dashboard (R2 Object Storage, Get started); the login needs: ${API_LOGIN_HINT.replace('Run: ', '')}`);
    if (!new RegExp(`\\b${api.bucket}\\b`).test(listed.out)) {
      console.log(`\nThe R2 bucket "${api.bucket}" does not exist yet. Creating it: ${quote(bucketCreate)}`);
      if ((await run(bucketCreate[0], bucketCreate.slice(1), 'echo', dir)).code !== 0) return fail('the R2 bucket could not be created.');
    }

    console.log(`\nDeploying: ${quote(deployCmd)}`);
    const dep = await run(deployCmd[0], deployCmd.slice(1), 'echo', dir);
    if (dep.code !== 0) return fail(`the API deploy failed (exit code ${dep.code}).`);
    const workersUrl = deploymentUrl(dep.out, 'workers\\.dev');
    console.log(workersUrl ? `Deployed: ${workersUrl}` : 'Deployed.');
    if (!opts.apiUrl && !opts.noVerify && workersUrl) {
      // the custom domain may take a minute to get its certificate: the workers.dev address answers at once
      console.log(`The custom domain ${api.url} can take a minute to start answering; checking the Worker's own address first.`);
      if (!(await verifyApi(workersUrl))) return 1;
    }
  }

  if (opts.noVerify) { console.log('Verification skipped (--no-verify).'); return 0; }
  return (await verifyApi(chosenBase)) ? 0 : 1;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }

  if (Number(process.versions.node.split('.')[0]) < 22) return fail(`Node 22 or newer is needed (this is ${process.versions.node}).`);
  let site;
  try {
    site = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.json'), 'utf8'));
  } catch (e) {
    return fail(`site.json cannot be read: ${e.message}`);
  }
  for (const [flag, value] of [['--url', opts.url], ['--api-url', opts.apiUrl]]) {
    if (!value) continue;
    try {
      if (!/^https?:$/.test(new URL(value).protocol)) throw new Error('not http or https');
    } catch {
      return fail(`${flag} "${value}" is not an http or https address.`);
    }
  }

  if (!opts.apiOnly) {
    const code = await siteStep(opts, site);
    if (code !== 0) return code;
  }
  if (!opts.siteOnly) {
    const code = await apiStep(opts, site);
    if (code !== 0) return code;
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(`error: ${e.stack || e.message}`); process.exit(1); });
} else {
  module.exports = { leakScan, LEAK_MARKERS, fileForPath, deploymentUrl, apiOnce };
}
