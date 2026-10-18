'use strict';
// The size of an app's VM (SPEC 2.2, SPEC 8): who decides, and how.
//
//   - The manifest RECOMMENDS: `core.cpus` (1-16) and `core.memoryMiB` (64-32768). A recommendation allows nothing and
//     decides nothing; it is what the developer measured the app needs to run well.
//   - The USER chooses, per app, in the loader (the permission sheet and the app's card) or with `vmapp resources`. The choice
//     is stored in grants/<id>.json as `resources: {cpus, memoryMiB}` and survives updates; Reset forgets it (INV-D3: a
//     choice comes only from the user).
//   - Defaults, when the user has not chosen: ONE vCPU, and the recommended memory. (An app that wants more CPUs says so in its
//     recommendation and the sheet offers "Use recommended"; a VM never takes more of the Mac than the user allowed.)
//   - Caps: vCPUs at most the Mac's logical cores, memory at most half of the Mac's RAM. They are applied when a VM starts
//     (a grants file copied to a smaller Mac still works) and when a choice is saved (so the UI and the CLI refuse more).
//
// No Electron, no I/O except reading the host's core count and RAM; the loader, the CLI and the tests share it.

const os = require('os');

const CPUS_MIN = 1;
const CPUS_MAX = 16; // what a manifest may recommend
const MEMORY_MIN_MIB = 64;
const MEMORY_MAX_MIB = 32768; // what a manifest may recommend
const DEFAULT_CPUS = 1;
const MEMORY_SHARE = 0.5; // of the host's RAM
// The stored choice is checked structurally against these (so a hand-edited file cannot hold nonsense); the real limits are
// the host's and are applied by resolveResources / checkResources.
const STORED_CPUS_MAX = 1024;
const STORED_MEMORY_MAX_MIB = 4 * 1024 * 1024;
const KEYS = ['cpus', 'memoryMiB'];

class ResourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResourceError';
  }
}

const isInt = (v) => Number.isInteger(v);

/**
 * What this Mac allows: {cpus, memoryMiB}. `opts` overrides the host for tests: {cpus, totalMemoryMiB}.
 * cpus = logical cores (at least 1); memoryMiB = half of the RAM (at least the smallest VM, 64).
 */
function hostLimits(opts = {}) {
  let cores = opts.cpus;
  if (!isInt(cores)) {
    try {
      cores = os.cpus().length;
    } catch {
      cores = 1;
    }
  }
  let totalMiB = opts.totalMemoryMiB;
  if (!Number.isFinite(totalMiB)) totalMiB = Math.floor(os.totalmem() / 1048576);
  return { cpus: Math.max(CPUS_MIN, cores), memoryMiB: Math.max(MEMORY_MIN_MIB, Math.floor(totalMiB * MEMORY_SHARE)) };
}

/** The manifest's recommendation: {cpus, memoryMiB} (the manifest is already validated; the defaults match manifest.js). */
function recommendedOf(manifest) {
  const core = (manifest && manifest.core) || {};
  return {
    cpus: isInt(core.cpus) && core.cpus >= CPUS_MIN ? core.cpus : DEFAULT_CPUS,
    memoryMiB: isInt(core.memoryMiB) && core.memoryMiB >= MEMORY_MIN_MIB ? core.memoryMiB : 256,
  };
}

/**
 * `grants.resources` as stored: {cpus?, memoryMiB?} (integers; a missing key means "the default"). Structural checks only;
 * the host's limits are applied when the VM starts. `fail(message)` makes the error to throw. Returns the normalised object,
 * or null when it holds no choice at all.
 */
function validateStoredResources(r, fail = (m) => new ResourceError(m)) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) throw fail('grants.resources must be an object {cpus, memoryMiB}');
  for (const k of Object.keys(r)) if (!KEYS.includes(k)) throw fail(`grants.resources.${k} is not a known key`);
  const out = {};
  if (r.cpus !== undefined) {
    if (!isInt(r.cpus) || r.cpus < CPUS_MIN || r.cpus > STORED_CPUS_MAX) throw fail(`grants.resources.cpus must be an integer from ${CPUS_MIN} to ${STORED_CPUS_MAX}`);
    out.cpus = r.cpus;
  }
  if (r.memoryMiB !== undefined) {
    if (!isInt(r.memoryMiB) || r.memoryMiB < MEMORY_MIN_MIB || r.memoryMiB > STORED_MEMORY_MAX_MIB) {
      throw fail(`grants.resources.memoryMiB must be an integer from ${MEMORY_MIN_MIB} to ${STORED_MEMORY_MAX_MIB}`);
    }
    out.memoryMiB = r.memoryMiB;
  }
  return Object.keys(out).length ? out : null;
}

/** The stored choice of `grants` (the whole grants object), or null. Anything malformed counts as no choice. */
function chosenOf(grants) {
  const r = grants && typeof grants === 'object' ? grants.resources : null;
  if (!r) return null;
  try {
    return validateStoredResources(r);
  } catch {
    return null;
  }
}

/**
 * The size the VM gets. `grants` is the whole grants object (or null). Returns
 *   { cpus, memoryMiB,                 what `vmapp-vm` is started with
 *     recommended: {cpus, memoryMiB},  the manifest's
 *     limits: {cpus, memoryMiB},       this Mac's
 *     chosen: {cpus?, memoryMiB?}|null the user's stored choice
 *     custom: boolean,                 the user has chosen something
 *     notes: [string] }                why a value was lowered to fit this Mac
 */
function resolveResources(manifest, grants, limits = hostLimits()) {
  const recommended = recommendedOf(manifest);
  const chosen = chosenOf(grants);
  const notes = [];
  let cpus = chosen && chosen.cpus !== undefined ? chosen.cpus : DEFAULT_CPUS;
  let memoryMiB = chosen && chosen.memoryMiB !== undefined ? chosen.memoryMiB : recommended.memoryMiB;
  if (cpus > limits.cpus) {
    notes.push(`vCPUs: ${cpus} is more than this Mac has (${limits.cpus} logical cores); using ${limits.cpus}`);
    cpus = limits.cpus;
  }
  if (memoryMiB > limits.memoryMiB) {
    notes.push(`memory: ${memoryMiB} MiB is more than half of this Mac's memory (${limits.memoryMiB} MiB); using ${limits.memoryMiB} MiB`);
    memoryMiB = limits.memoryMiB;
  }
  return { cpus, memoryMiB, recommended, limits, chosen, custom: !!chosen, notes };
}

/** The sizes the memory menu offers: the usual steps up to the cap, plus the recommendation and the current value. */
function memoryChoices(limits, recommended, current) {
  const steps = [64, 128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144];
  const all = new Set(steps.filter((m) => m >= MEMORY_MIN_MIB && m <= limits.memoryMiB));
  for (const m of [recommended && recommended.memoryMiB, current && current.memoryMiB]) if (isInt(m) && m >= MEMORY_MIN_MIB && m <= limits.memoryMiB) all.add(m);
  all.add(Math.min(limits.memoryMiB, MEMORY_MAX_MIB)); // the largest a manifest may ask, or the cap if that is smaller
  return [...all].sort((a, b) => a - b);
}

/**
 * What the sheet and the card show (the `Resources` row):
 *   { recommended, limits, current: {cpus, memoryMiB}, custom, chosen, memoryChoices: [MiB],
 *     below: {cpus: boolean, memoryMiB: boolean}   current is less than recommended,
 *     notes }
 */
function resourceSummary(manifest, grants, limits = hostLimits()) {
  const r = resolveResources(manifest, grants, limits);
  const current = { cpus: r.cpus, memoryMiB: r.memoryMiB };
  return {
    recommended: r.recommended,
    limits: r.limits,
    current,
    custom: r.custom,
    chosen: r.chosen,
    memoryChoices: memoryChoices(limits, r.recommended, current),
    below: { cpus: current.cpus < r.recommended.cpus, memoryMiB: current.memoryMiB < r.recommended.memoryMiB },
    notes: r.notes,
  };
}

/**
 * Checks a choice the user is about to save (the sheet, the card, `vmapp resources`) and returns it in stored form
 * {cpus?, memoryMiB?}. Refuses what the Mac cannot give: vCPUs above its logical cores, memory above half of its RAM, or
 * below 64 MiB. A value below the app's recommendation is allowed (the UI warns). `spec` keys that are undefined are left out.
 */
function checkResources(spec, limits = hostLimits()) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new ResourceError('the resources must be an object {cpus, memoryMiB}');
  for (const k of Object.keys(spec)) if (!KEYS.includes(k)) throw new ResourceError(`“${k}” is not something that can be set (only cpus and memoryMiB)`);
  const out = {};
  if (spec.cpus !== undefined) {
    if (!isInt(spec.cpus) || spec.cpus < CPUS_MIN) throw new ResourceError('vCPUs must be a whole number, at least 1');
    if (spec.cpus > limits.cpus) throw new ResourceError(`this Mac has ${limits.cpus} logical core${limits.cpus === 1 ? '' : 's'}; ${spec.cpus} vCPUs is more than it can give`);
    out.cpus = spec.cpus;
  }
  if (spec.memoryMiB !== undefined) {
    if (!isInt(spec.memoryMiB) || spec.memoryMiB < MEMORY_MIN_MIB) throw new ResourceError(`memory must be a whole number of MiB, at least ${MEMORY_MIN_MIB}`);
    if (spec.memoryMiB > limits.memoryMiB) {
      throw new ResourceError(`${spec.memoryMiB} MiB is more than half of this Mac's memory; the most an app can have here is ${limits.memoryMiB} MiB`);
    }
    out.memoryMiB = spec.memoryMiB;
  }
  return out;
}

/** The recommendation as a choice, lowered to what this Mac allows: what "Use recommended" saves. */
function recommendedChoice(manifest, limits = hostLimits()) {
  const r = recommendedOf(manifest);
  return { cpus: Math.min(r.cpus, limits.cpus), memoryMiB: Math.min(r.memoryMiB, limits.memoryMiB) };
}

/** "2 vCPUs, 512 MB" (the loader's words: MB here means MiB; logs and the CLI pass 'MiB'). */
function describeSize(s, unit = 'MB') {
  return `${s.cpus} vCPU${s.cpus === 1 ? '' : 's'}, ${s.memoryMiB} ${unit}`;
}

module.exports = {
  ResourceError,
  CPUS_MIN,
  CPUS_MAX,
  MEMORY_MIN_MIB,
  MEMORY_MAX_MIB,
  DEFAULT_CPUS,
  MEMORY_SHARE,
  hostLimits,
  recommendedOf,
  validateStoredResources,
  chosenOf,
  resolveResources,
  memoryChoices,
  resourceSummary,
  checkResources,
  recommendedChoice,
  describeSize,
};
