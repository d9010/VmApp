'use strict';
// Small statistics helpers shared by tools/bench and the scripts in bench/ (CommonJS, so both `require` and ESM `import` work).
//
// percentile() is the "nearest rank" percentile: the smallest sample that at least p of the samples are <= to. With 20 samples the
// p95 is therefore the 19th smallest, and with 5 samples it is the largest. median() is the middle sample (the mean of the two
// middle ones for an even count).

function sorted(a) {
  return Array.from(a).sort((x, y) => x - y);
}

function percentile(a, p) {
  const s = sorted(a);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

function median(a) {
  const s = sorted(a);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** {n, min, median, p95, p99, max, mean} of a list of numbers (null fields when the list is empty). */
function summarize(a) {
  const s = sorted(a);
  const n = s.length;
  return {
    n,
    min: n ? s[0] : null,
    median: median(s),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    max: n ? s[n - 1] : null,
    mean: n ? s.reduce((x, y) => x + y, 0) / n : null,
  };
}

/** Rounds to `digits` decimals (for JSON that people read). */
function round(x, digits = 3) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

module.exports = { percentile, median, summarize, round };
