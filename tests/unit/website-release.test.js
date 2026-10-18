'use strict';
// The release tooling of the website (website/release.js): reading the changelog, the release record, the update feed (which must be one
// the launcher itself accepts, SPEC 8.10) and the GitHub release notes. The parts that call git, gh and macOS are run by hand with
// `node publish.js --release --dry-run` (docs/PRODUCTION.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../../website/release');
const { cleanLauncherFeed } = require('../../hostlib/updates');

const LOG = `# Changelog

Intro text that is not an entry.

## [Unreleased]

### Added

- Something not released yet.

## [0.2.0] - 2026-11-01

Faster start and a fix.

### Added

- **Bigger windows.** Windows remember their size. A second sentence that the card does not need.
- A \`new\` menu entry with
  a wrapped line.

### Fixed

- The [Inspector](docs/INSPECTOR.md) no longer flickers.

## [0.1.0] - 2026-10-18

The first public release.

### Added

- The launcher.
`;

const SHA = 'a'.repeat(64);
const build = (over = {}) =>
  R.makeRelease({
    version: '0.2.0',
    commit: 'b'.repeat(40),
    entry: R.changelogEntry(LOG, '0.2.0'),
    file: 'D9010-VmApp-Launcher-0.2.0-mac-arm64.zip',
    size: 150 * 1024 * 1024,
    sha256: SHA,
    repoUrl: 'https://github.com/d9010/VmApp/',
    ...over,
  });

test('release: plain() strips Markdown from a line', () => {
  assert.equal(R.plain('**Bold** and `code` and [a link](x.md) and _it_'), 'Bold and code and a link and it');
  assert.equal(R.plain('a\n  b'), 'a b');
});

test('release: firstSentence() cuts at the first full stop, or at the limit with an ellipsis', () => {
  assert.equal(R.firstSentence('One. Two.'), 'One.');
  assert.equal(R.firstSentence('No full stop here'), 'No full stop here');
  const cut = R.firstSentence(`${'word '.repeat(80)}end`, 50);
  assert.ok(cut.length <= 50 && cut.endsWith('…'), cut);
});

test('release: parseChangelog() reads versions, dates, the intro line and the bullets; [Unreleased] is skipped', () => {
  const entries = R.parseChangelog(LOG);
  assert.deepEqual(entries.map((e) => e.version), ['0.2.0', '0.1.0']);
  const e = entries[0];
  assert.equal(e.date, '2026-11-01');
  assert.equal(e.notes, 'Faster start and a fix.');
  assert.equal(e.bullets.length, 3);
  assert.equal(e.bullets[1], 'A `new` menu entry with a wrapped line.');
  assert.match(e.markdown, /### Fixed/);
});

test('release: changelogEntry() demands a dated entry that lists something', () => {
  assert.equal(R.changelogEntry(LOG, '0.1.0').version, '0.1.0');
  assert.throws(() => R.changelogEntry(LOG, '9.9.9'), /no entry "## \[9\.9\.9\]/);
  assert.throws(() => R.changelogEntry('## [1.0.0]\n\n### Added\n\n- x\n', '1.0.0'), /no date/);
  assert.throws(() => R.changelogEntry('## [1.0.0] - 2026-01-01\n\nJust words.\n', '1.0.0'), /lists nothing/);
});

test('release: makeRelease() names the tag, the asset address and short plain change lines', () => {
  const r = build();
  assert.equal(r.tag, 'v0.2.0');
  assert.equal(r.url, 'https://github.com/d9010/VmApp/releases/download/v0.2.0/D9010-VmApp-Launcher-0.2.0-mac-arm64.zip');
  assert.equal(r.releaseUrl, 'https://github.com/d9010/VmApp/releases/tag/v0.2.0');
  assert.deepEqual(r.changes, ['Bigger windows.', 'A new menu entry with a wrapped line.', 'The Inspector no longer flickers.']);
  assert.equal(r.notes, 'Faster start and a fix.');
  assert.equal(r.date, '2026-11-01');
});

test('release: the update feed is one the launcher accepts, and carries what the card shows', () => {
  const feed = R.feedFrom(build(), 'https://vmapp.dev/');
  const clean = cleanLauncherFeed(feed);
  assert.equal(clean.version, '0.2.0');
  assert.equal(feed.changelogUrl, 'https://vmapp.dev/docs/changelog');
  assert.equal(feed.pageUrl, 'https://vmapp.dev/download');
  assert.equal(feed.pub_date, '2026-11-01T00:00:00Z');
  assert.equal(feed.sha256, SHA);
});

test('release: a release the launcher would refuse never gets a feed (address outside the allowed hosts)', () => {
  const r = build({ repoUrl: 'https://example.com/x/y' });
  assert.throws(() => cleanLauncherFeed(R.feedFrom(r, 'https://vmapp.dev')));
});

test('release: the GitHub notes carry the changelog, how to install, and exactly what it was built from', () => {
  const entry = R.changelogEntry(LOG, '0.2.0');
  const r = build();
  const notes = R.releaseNotes({ release: r, entry, repoUrl: 'https://github.com/d9010/VmApp', siteUrl: 'https://vmapp.dev' });
  assert.match(notes, /^# D9010 VmApp 0\.2\.0 for macOS/);
  assert.match(notes, /Faster start and a fix\./);
  assert.equal(notes.split('Faster start and a fix.').length, 2, 'the intro line appears once');
  assert.match(notes, /### Fixed/);
  assert.match(notes, /shasum -a 256 -c SHA256SUMS/);
  assert.match(notes, /Tag `v0\.2\.0`, commit \[`bbbbbbb`\]\(https:\/\/github\.com\/d9010\/VmApp\/commit\/b{40}\)/);
  assert.ok(notes.includes(SHA));
  assert.doesNotMatch(notes, /notariz|by Apple|Apple-approved|Apple approved/i, 'no claim that sounds like an endorsement');
});

test('release: the real CHANGELOG.md has a dated entry for the version the launcher declares', () => {
  const root = path.join(__dirname, '..', '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'loader', 'package.json'), 'utf8')).version;
  const e = R.changelogEntry(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  assert.ok(e.bullets.length > 0);
  const feed = R.feedFrom(R.makeRelease({ version, commit: 'c'.repeat(40), entry: e, file: `D9010-VmApp-Launcher-${version}-mac-arm64.zip`, size: 1000, sha256: SHA, repoUrl: 'https://github.com/d9010/VmApp' }), 'https://vmapp.dev');
  assert.doesNotThrow(() => cleanLauncherFeed(feed));
});
