'use strict';
// Release tooling for the D9010 VmApp Launcher: one command, `node publish.js --release` (see website/README.md and docs/PRODUCTION.md).
// From a signed build and the changelog it makes: a git tag, a GitHub release (the zip, its checksum and the release notes), and the
// two files the website needs, `src/release.json` (the download page) and the update feed `updates/mac-arm64/latest.json` that the
// launcher asks (SPEC 8.10). The site is deployed last, so the feed never points at a release that is not there yet.
//
// Everything that decides what is true is checked before anything is made: the zip is signed with a Developer ID, accepted by macOS's
// Gatekeeper and has the version of loader/package.json; the changelog has a dated entry for that version; the repository the tag goes
// on is clean, pushed, and has the same version; the tag and the release do not exist yet. Node built-ins only; the pure functions
// at the top are what tests/unit/website-release.test.js tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ---- the changelog ------------------------------------------------------------------------------------------------------------

/** Markdown to plain text, for one line of a card: no emphasis, code ticks or link syntax. */
function plain(md) {
  return String(md)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first sentence of a line, cut at `max` characters at the latest. */
function firstSentence(text, max = 200) {
  const m = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const s = m ? m[1] : text;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1).replace(/\s+\S*$/, '');
  return `${cut}…`;
}

/**
 * The entries of a changelog (Keep a Changelog style): `## [1.2.3] - 2026-10-18`, an optional paragraph, then `### Added` etc. with `- `
 * bullets. Returns [{version, date, notes, bullets, markdown}] newest first as written; `[Unreleased]` is skipped.
 */
function parseChangelog(text) {
  const out = [];
  const parts = String(text).split(/^(?=## )/m);
  for (const part of parts) {
    const head = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/m.exec(part.split('\n')[0] || '');
    if (!head) continue;
    const lines = part.split('\n').slice(1);
    const notes = [];
    const bullets = [];
    let inBullets = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^### /.test(line)) {
        inBullets = true;
        continue;
      }
      const b = /^[-*] (.*)$/.exec(line);
      if (b) {
        let item = b[1];
        while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) item += ` ${lines[++i].trim()}`; // a wrapped bullet
        bullets.push(item);
        inBullets = true;
      } else if (!inBullets && line.trim()) {
        notes.push(line.trim());
      }
    }
    out.push({ version: head[1], date: head[2] || '', notes: plain(notes.join(' ')), bullets, markdown: lines.join('\n').trim() });
  }
  return out;
}

/** The dated entry for `version`, or throws. */
function changelogEntry(text, version) {
  const e = parseChangelog(text).find((x) => x.version === version);
  if (!e) throw new Error(`CHANGELOG.md has no entry "## [${version}] - YYYY-MM-DD". Write what changed in this version first.`);
  if (!e.date) throw new Error(`The CHANGELOG.md entry for ${version} has no date ("## [${version}] - YYYY-MM-DD").`);
  if (!e.bullets.length) throw new Error(`The CHANGELOG.md entry for ${version} lists nothing (add "- ..." lines under "### Added", "### Changed" or "### Fixed").`);
  return e;
}

// ---- what the release is -------------------------------------------------------------------------------------------------------

const mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

/** The record kept in website/src/release.json: what the download page and the update feed are made from. */
function makeRelease({ version, commit, entry, file, size, sha256, repoUrl, minimumOS = '13.0' }) {
  const tag = `v${version}`;
  const base = repoUrl.replace(/\/$/, '');
  return {
    version,
    tag,
    commit,
    date: entry.date,
    file,
    size,
    sha256,
    url: `${base}/releases/download/${tag}/${file}`,
    releaseUrl: `${base}/releases/tag/${tag}`,
    notes: entry.notes,
    changes: entry.bullets.map((b) => firstSentence(plain(b))).filter(Boolean).slice(0, 12),
    minimumOS,
  };
}

/** The update feed (SPEC 8.10): Squirrel's fields plus the ones the launcher reads. */
function feedFrom(release, siteUrl) {
  const site = siteUrl.replace(/\/$/, '');
  return {
    version: release.version,
    url: release.url,
    sha256: release.sha256,
    size: release.size,
    name: `D9010 VmApp ${release.version}`,
    notes: release.notes || release.changes.join(' '),
    changes: release.changes,
    pub_date: `${release.date}T00:00:00Z`,
    tag: release.tag,
    commit: release.commit,
    changelogUrl: `${site}/docs/changelog`,
    pageUrl: `${site}/download`,
    minimumOS: release.minimumOS,
  };
}

/** The GitHub release notes: the changelog entry, how to install, and exactly what it was built from. */
function releaseNotes({ release, entry, repoUrl, siteUrl }) {
  const repo = repoUrl.replace(/\/$/, '');
  const site = siteUrl.replace(/\/$/, '');
  return `# D9010 VmApp ${release.version} for macOS (Apple silicon)

${entry.markdown}

## Download and install

Needs macOS ${release.minimumOS} or later on a Mac with Apple silicon.

1. Download \`${release.file}\` (${mb(release.size)}) from the assets below.
2. Optional: download \`SHA256SUMS\` into the same folder and run \`shasum -a 256 -c SHA256SUMS\`. It must say \`OK\`.
3. Unzip it, move \`D9010VmAppLauncher.app\` into \`/Applications\` and open it. The first time, macOS asks you to confirm that you downloaded it from the internet: choose **Open**.
4. Click **Load examples**, tick the sample apps you want and choose **Install selected**. Installing allows nothing: each app asks for what it needs the first time you launch it.

Once installed, the launcher tells you when a newer version is available (a card appears with what changed). Nothing is downloaded or restarted without your click, and the check sends nothing about you; you can turn it off in Host Capabilities.

## Built from

- Tag \`${release.tag}\`, commit [\`${release.commit.slice(0, 7)}\`](${repo}/commit/${release.commit})
- SHA-256 of \`${release.file}\`: \`${release.sha256}\`

Full changelog: ${site}/docs/changelog. Documentation: ${site}/docs/. D9010 VmApp is open source under the MIT licence; report a security problem privately through the repository's Security tab.
`;
}

// ---- running other programs ------------------------------------------------------------------------------------------------------

function sh(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ code: 1, out: `${out}\n${e.message}` }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, out: out.trim() }));
  });
}

const fail = (m) => {
  const e = new Error(m);
  e.releaseFailure = true;
  throw e;
};

async function must(cmd, args, what, opts) {
  const r = await sh(cmd, args, opts);
  if (r.code !== 0) fail(`${what} failed (${cmd} ${args.slice(0, 3).join(' ')}…):\n${r.out}`);
  return r.out;
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', resolve);
  });
  return h.digest('hex');
}

// ---- the checks ---------------------------------------------------------------------------------------------------------------------

/**
 * Starts the unpacked app for a few seconds in a throwaway data folder (VMAPP_HOME) and fails if it dies. A build can be signed, notarized
 * and accepted by Gatekeeper and still crash at start (0.1.0's first build: "Unable to find helper app"); only running it shows that.
 */
async function smokeTest(app, ms = 8000) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-release-home-'));
  try {
    const child = spawn(path.join(app, 'Contents', 'MacOS', 'D9010VmAppLauncher'), [], { env: { ...process.env, VMAPP_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const died = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const early = await Promise.race([died, new Promise((r) => setTimeout(() => r(null), ms))]);
    if (early) fail(`The app quit by itself within ${ms / 1000} seconds (exit ${early.code === null ? early.signal : early.code}):\n${out.trim().split('\n').slice(-8).join('\n')}`);
    child.kill('SIGTERM');
    await Promise.race([died, new Promise((r) => setTimeout(r, 5000))]);
    child.kill('SIGKILL');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Unzips the build into its own new folder and proves it is what a user's Mac will accept. Returns what it found. */
async function verifyZip(zip, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-release-check-'));
  try {
    // No "._" (AppleDouble) entries: an extractor that cannot apply them to the frameworks' symlinks writes them out as real files, which
    // breaks the seal and macOS says "could not verify ... free of malware". And unpack with plain `unzip`, the least forgiving extractor.
    const listing = await must('unzip', ['-Z1', zip], 'listing the zip');
    const stray = listing.split('\n').filter((n) => /(^|\/)\._/.test(n));
    if (stray.length) fail(`${path.basename(zip)} contains ${stray.length} "._" entries (extended attributes stored as files), for example ${stray[0]}. Zip with: ditto -c -k --norsrc --noextattr --keepParent (tools/package-mac.sh and tools/notarize-mac do).`);
    await must('unzip', ['-q', zip, '-d', dir], 'unzipping the build');
    const app = path.join(dir, 'D9010VmAppLauncher.app');
    if (!fs.existsSync(app)) fail(`${path.basename(zip)} does not contain D9010VmAppLauncher.app.`);
    const plist = path.join(app, 'Contents', 'Info.plist');
    const built = await must('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], 'reading the version');
    if (built !== version) fail(`The build says version ${built}, but loader/package.json says ${version}. Build again after changing the version.`);
    await must('codesign', ['--verify', '--deep', '--strict', app], 'verifying the signature');
    const info = (await sh('codesign', ['-dv', '--verbose=2', app])).out;
    if (/Signature=adhoc/.test(info) || !/Authority=Developer ID Application/.test(info)) fail('The build is not signed with a Developer ID (it is ad hoc or signed otherwise). Build with SIGN_IDENTITY set (docs/PRODUCTION.md).');
    const gate = await sh('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    if (gate.code !== 0 || !/source=Notarized Developer ID/.test(gate.out)) fail(`macOS would not open this build without a warning:\n${gate.out}\nRun the notarization step (docs/PRODUCTION.md).`);
    const staple = await sh('xcrun', ['stapler', 'validate', app]);
    if (staple.code !== 0) fail(`The ticket is not attached to the app (offline Macs would warn):\n${staple.out}`);
    await smokeTest(app);
    return { team: (/TeamIdentifier=(\S+)/.exec(info) || [])[1] || '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The repository the tag goes on: clean, pushed, at the version, and carrying the changelog. */
async function checkRepo(repo, { version, repoUrl }) {
  const git = (...a) => must('git', ['-C', repo, ...a], `git ${a[0]}`);
  if ((await sh('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'])).code !== 0) fail(`${repo} is not a git repository.`);
  if (await git('status', '--porcelain')) fail(`${repo} has uncommitted changes. Commit and push them first.`);
  const origin = await git('remote', 'get-url', 'origin');
  const want = repoUrl.replace(/\/$/, '').replace(/^https:\/\//, '');
  if (!origin.replace(/\.git$/, '').includes(want)) fail(`${repo}'s origin is ${origin}, not ${repoUrl}.`);
  await git('fetch', 'origin', '--tags', '--quiet');
  const head = await git('rev-parse', 'HEAD');
  const remote = await git('rev-parse', 'origin/main');
  if (head !== remote) fail(`${repo} is not at origin/main (it is ${head.slice(0, 7)}, origin/main is ${remote.slice(0, 7)}). Push, or pull, first: the tag must be on the public commit.`);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'loader', 'package.json'), 'utf8'));
  if (pkg.version !== version) fail(`${repo}/loader/package.json says ${pkg.version}, not ${version}: refresh the export from the source and push it first.`);
  const log = path.join(repo, 'CHANGELOG.md');
  if (!fs.existsSync(log)) fail(`${repo} has no CHANGELOG.md: refresh the export and push it first.`);
  changelogEntry(fs.readFileSync(log, 'utf8'), version);
  const remoteTag = await git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`);
  if (remoteTag) fail(`The tag v${version} already exists on GitHub. A version is released once: raise the version in loader/package.json and add a changelog entry.`);
  return head;
}

// ---- the workflow ---------------------------------------------------------------------------------------------------------------------

function ownerRepo(repoUrl) {
  const m = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (!m) fail(`site.json repoUrl (${repoUrl}) is not a GitHub repository address.`);
  return m[1];
}

/**
 * Where the public repository (github.com/d9010/VmApp) is checked out: the release tags that checkout, never this source tree.
 * VMAPP_EXPORT_REPO, then "exportRepo" in website/.release.local.json (git-ignored), else the workspace's fixed place:
 * <workspace>/public/github, next to this source folder (<workspace>/vmapp). See the workspace's CLAUDE.md.
 */
function localConfig(root) {
  const file = path.join(root, '.release.local.json');
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none */
  }
  const standard = path.resolve(root, '..', '..', 'public', 'github');
  const repo = process.env.VMAPP_EXPORT_REPO || j.exportRepo || (fs.existsSync(path.join(standard, '.git')) ? standard : '');
  if (!repo) fail(`Where is the public repository checked out? It is not at ${standard}. Set VMAPP_EXPORT_REPO, or put {"exportRepo": "<folder>"} in website/.release.local.json (a git-ignored file).`);
  return { exportRepo: path.resolve(repo) };
}

/**
 * Makes a release. `dryRun`: run every check and show what would be made; make nothing. Returns 0, or throws an Error with a plain message.
 * @param {{dryRun?: boolean, zip?: string}} opts   @param {object} site  site.json   @param {string} root  the website folder
 */
async function runRelease(opts, site, root) {
  const say = (m) => console.log(m);
  const vmapp = path.resolve(root, '..');
  const version = JSON.parse(fs.readFileSync(path.join(vmapp, 'loader', 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const file = `D9010-VmApp-Launcher-${version}-mac-arm64.zip`;
  const zip = path.resolve(opts.zip || path.join(vmapp, 'out', 'dist', file));
  const slug = ownerRepo(site.repoUrl);
  const { exportRepo } = localConfig(root);

  say(`\n=== Release ${version} ===`);
  if (!fs.existsSync(zip)) fail(`${zip} does not exist. Build it first: SIGN_IDENTITY=... tools/package-mac.sh --with-examples --examples-dir=<folder>, then tools/notarize-mac <profile> (docs/PRODUCTION.md).`);
  if (path.basename(zip) !== file) fail(`The zip must be named ${file} (it is ${path.basename(zip)}).`);
  const entry = changelogEntry(fs.readFileSync(path.join(vmapp, 'CHANGELOG.md'), 'utf8'), version);
  say(`Changelog: ${entry.bullets.length} change(s) dated ${entry.date}.`);

  say('Checking the build (signature, what macOS will do with it, the version) ...');
  const signed = await verifyZip(zip, version);
  say(`Build: signed with a Developer ID (team ${signed.team}), accepted by macOS, version ${version}.`);
  const size = fs.statSync(zip).size;
  const sha256 = await sha256File(zip);
  say(`Zip: ${mb(size)}, SHA-256 ${sha256.slice(0, 16)}…`);

  say(`Checking the repository ${exportRepo} ...`);
  const commit = await checkRepo(exportRepo, { version, repoUrl: site.repoUrl });
  say(`Repository: clean, pushed, at ${commit.slice(0, 7)}, version ${version}; ${tag} is free.`);
  if ((await sh('gh', ['release', 'view', tag, '--repo', slug])).code === 0) fail(`A GitHub release ${tag} already exists.`);
  if ((await sh('gh', ['auth', 'status'])).code !== 0) fail('The GitHub CLI is not logged in (gh auth login).');

  const release = makeRelease({ version, commit, entry, file, size, sha256, repoUrl: site.repoUrl });
  const notes = releaseNotes({ release, entry, repoUrl: site.repoUrl, siteUrl: site.siteUrl });
  const feed = feedFrom(release, site.siteUrl);
  // the feed must be one that the launcher itself accepts: the same validation, now, before anything is published
  const { cleanLauncherFeed } = require('../hostlib/updates');
  cleanLauncherFeed(feed);
  say(`Update feed for ${version}: valid for the launcher (${release.changes.length} change line(s)).`);

  if (opts.dryRun) {
    say(`\nDry run: nothing was made. A real run would now:\n  1. tag ${commit.slice(0, 7)} as ${tag} and push the tag\n  2. create the GitHub release ${tag} on ${slug} with ${file}, SHA256SUMS and these notes (${notes.split('\n').length} lines), as the latest release\n  3. check the release's assets and checksum on GitHub\n  4. write website/src/release.json, then build and deploy the site (download page, changelog, update feed) and check it live`);
    return 0;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-release-'));
  try {
    fs.writeFileSync(path.join(work, 'SHA256SUMS'), `${sha256}  ${file}\n`);
    fs.writeFileSync(path.join(work, 'notes.md'), notes);
    say(`\nTagging ${tag} at ${commit.slice(0, 7)} ...`);
    await must('git', ['-C', exportRepo, 'tag', '-a', tag, '-m', `D9010 VmApp ${version}`, commit], 'tagging');
    await must('git', ['-C', exportRepo, 'push', 'origin', tag], 'pushing the tag');
    say(`Creating the GitHub release (uploading ${mb(size)}) ...`);
    await must('gh', ['release', 'create', tag, zip, path.join(work, 'SHA256SUMS'), '--repo', slug, '--title', `D9010 VmApp ${version}`, '--notes-file', path.join(work, 'notes.md'), '--verify-tag', '--latest'], 'creating the release');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  say('Checking the release on GitHub ...');
  const api = JSON.parse(await must('gh', ['api', `repos/${slug}/releases/tags/${tag}`], 'reading the release back'));
  const asset = (api.assets || []).find((a) => a.name === file);
  if (!asset) fail(`GitHub has no asset ${file} on ${tag}.`);
  if (asset.size !== size) fail(`GitHub holds ${asset.size} bytes for ${file}, not ${size}. The upload is damaged: delete the release and the tag and run again.`);
  if (asset.state && asset.state !== 'uploaded') fail(`The asset is "${asset.state}", not "uploaded".`);
  if (!(api.assets || []).some((a) => a.name === 'SHA256SUMS')) fail('GitHub has no SHA256SUMS asset.');
  if (asset.digest) {
    if (asset.digest !== `sha256:${sha256}`) fail(`GitHub's checksum of ${file} is ${asset.digest}, expected sha256:${sha256}.`);
    say('GitHub reports the same SHA-256 for the uploaded zip.');
  } else {
    say('GitHub gave no checksum; downloading the zip back to compare ...');
    const res = await fetch(asset.browser_download_url, { redirect: 'follow' });
    const h = crypto.createHash('sha256');
    for await (const c of res.body) h.update(c);
    if (h.digest('hex') !== sha256) fail('The zip on GitHub is not the one that was uploaded.');
  }
  const latest = JSON.parse(await must('gh', ['api', `repos/${slug}/releases/latest`], 'asking which release is the latest'));
  if (latest.tag_name !== tag) fail(`GitHub's latest release is ${latest.tag_name}, not ${tag}.`);
  say(`Release ${tag} is live: ${release.releaseUrl}`);

  fs.writeFileSync(path.join(root, 'src', 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  say('Wrote website/src/release.json (the download page and the update feed are made from it).');
  return 0;
}

module.exports = { plain, firstSentence, parseChangelog, changelogEntry, makeRelease, feedFrom, releaseNotes, runRelease, verifyZip, mb };
