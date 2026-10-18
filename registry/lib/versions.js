'use strict';
// Version selection for SPEC §8.1: withdrawn versions and the "compatible" / "latest" choices.
//
// A version record may carry `withdrawn: {reason, at}`. Records written before this feature have no such field and
// count as not withdrawn, so an existing db.json needs no migration.

const { SEMVER_RE, compareVersions } = require('../../hostlib/manifest');

const REASON_MAX = 200;
const CHOICES = ['compatible', 'latest'];

function parse(v) {
  const m = SEMVER_RE.exec(v);
  if (!m) throw new Error(`invalid version: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].slice(1) : null };
}

const isWithdrawn = (rec) => !!(rec && rec.withdrawn && typeof rec.withdrawn === 'object' && typeof rec.withdrawn.reason === 'string');

/** All version records, highest first. */
function sortedDesc(app) {
  return Object.values(app.versions).sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The version shown as "the latest" in lists and on the app page, and served for the `latest` download alias:
 * the highest version that is not withdrawn (prereleases count, as they always did). null if every version is
 * withdrawn.
 */
function newestAvailable(app) {
  const r = sortedDesc(app).find((x) => !isWithdrawn(x));
  return r ? r.version : null;
}

/** The version to show for the app: the newest available one, else (all withdrawn) the highest published. */
function displayVersion(app) {
  return newestAvailable(app) || app.latest;
}

/**
 * GET /resolve: the best version for `choice`, relative to `from`, or null.
 *
 * - Withdrawn versions are never picked.
 * - Never lower than `from` (the result may equal `from`): a resolve is an "update", never a downgrade.
 * - `compatible`: same major as `from`; for 0.x the same minor too (a 0.x minor may break).
 * - `latest`: any major.
 * - Prereleases (1.2.0-beta.1) are skipped, unless `from` is itself a prerelease: then the prereleases of the same
 *   x.y.z as `from` are candidates as well, so a beta tester follows the betas of that line and ends on its release.
 *
 * @param {object} app
 * @param {'compatible'|'latest'} choice
 * @param {string|null} from a valid semver; may be null for `latest`
 */
function resolve(app, choice, from) {
  if (!CHOICES.includes(choice)) throw new Error(`unknown choice: ${choice}`);
  const f = from ? parse(from) : null;
  if (choice === 'compatible' && !f) throw new Error('compatible needs a starting version');
  for (const rec of sortedDesc(app)) {
    if (isWithdrawn(rec)) continue;
    const c = parse(rec.version);
    if (c.pre) {
      const sameLine = f && f.pre && c.major === f.major && c.minor === f.minor && c.patch === f.patch;
      if (!sameLine) continue;
    }
    if (f && compareVersions(rec.version, from) < 0) return null; // sorted: everything after this is lower still
    if (choice === 'compatible' && (c.major !== f.major || (f.major === 0 && c.minor !== f.minor))) continue;
    return rec.version;
  }
  return null;
}

/** Validates a withdraw reason; returns it trimmed, or throws Error with a message fit for a 400 response. */
function checkReason(r) {
  if (typeof r !== 'string') throw new Error('reason is required: say in a sentence why this version is withdrawn');
  const s = r.trim();
  const n = [...s].length;
  if (n < 1) throw new Error('reason is required: say in a sentence why this version is withdrawn');
  if (n > REASON_MAX) throw new Error(`reason is too long (${REASON_MAX} characters at most)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('reason must be plain text on one line');
  return s;
}

module.exports = { REASON_MAX, CHOICES, isWithdrawn, sortedDesc, newestAvailable, displayVersion, resolve, checkReason };
