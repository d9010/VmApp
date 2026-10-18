'use strict';
// A small in-memory fixed-window rate limiter keyed by a string (an IP hash). State is never persisted.

class RateLimiter {
  /**
   * @param {number} limit requests allowed per window
   * @param {number} windowMs window length
   * @param {() => number} now clock
   */
  constructor(limit, windowMs, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map();
    this.lastPrune = now();
  }

  /** Counts one request. Returns { ok, retryAfterSec }. */
  hit(key) {
    const t = this.now();
    if (t - this.lastPrune > this.windowMs || this.buckets.size > 100000) this.prune(t);
    let b = this.buckets.get(key);
    if (!b || t - b.start >= this.windowMs) {
      b = { start: t, count: 0 };
      this.buckets.set(key, b);
    }
    b.count++;
    if (this.limit > 0 && b.count > this.limit) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.start + this.windowMs - t) / 1000)) };
    }
    return { ok: true, retryAfterSec: 0 };
  }

  prune(t = this.now()) {
    this.lastPrune = t;
    for (const [k, b] of this.buckets) if (t - b.start >= this.windowMs) this.buckets.delete(k);
  }
}

module.exports = { RateLimiter };
