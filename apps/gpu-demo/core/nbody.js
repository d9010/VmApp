'use strict';
/*
 * A CPU benchmark that runs in the core, i.e. on the VM's vCPU: O(n^2) gravitational n-body steps (the classic
 * "interactions per second" figure). The window shows it next to the GPU numbers, so the two halves of the app are easy to tell
 * apart: the VM does logic and maths on the CPU, the window's GPU draws the pixels.
 *
 * Only the compute time is measured (the loop yields to the event loop between steps so the scene stream keeps running on a
 * one-vCPU VM; the time spent in those yields is reported separately as wallMs).
 */

const { makeRng } = require('./scene');

const FLOPS_PER_INTERACTION = 20; // the conventional count for a softened gravity interaction

const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

async function nbody(options) {
  const o = options && typeof options === 'object' ? options : {};
  const n = clampInt(o.bodies, 64, 4096, 1536);
  const steps = clampInt(o.steps, 1, 100, 20);
  const rng = makeRng(12345);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const vz = new Float64Array(n);
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = rng() * 2 - 1;
    y[i] = rng() * 2 - 1;
    z[i] = rng() * 2 - 1;
    m[i] = 0.5 + rng();
  }
  const dt = 1 / 240;
  const eps = 1e-3;
  let computeNs = 0n;
  const wall0 = process.hrtime.bigint();
  for (let s = 0; s < steps; s++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let j = 0; j < n; j++) {
        const dx = x[j] - xi;
        const dy = y[j] - yi;
        const dz = z[j] - zi;
        const r2 = dx * dx + dy * dy + dz * dz + eps;
        const inv = 1 / Math.sqrt(r2);
        const f = m[j] * inv * inv * inv;
        ax += dx * f;
        ay += dy * f;
        az += dz * f;
      }
      vx[i] += ax * dt;
      vy[i] += ay * dt;
      vz[i] += az * dt;
    }
    for (let i = 0; i < n; i++) {
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      z[i] += vz[i] * dt;
    }
    computeNs += process.hrtime.bigint() - t0;
    await yieldToLoop();
  }
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  const computeMs = Number(computeNs) / 1e6;
  const interactions = n * n * steps; // the j === i term is included (it adds only the softening); it is the same loop body
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i] + y[i] + z[i];
  return {
    bodies: n,
    steps,
    computeMs,
    wallMs,
    interactions,
    minteractionsPerSec: interactions / computeMs / 1000,
    gflops: (interactions * FLOPS_PER_INTERACTION) / computeMs / 1e6,
    checksum: sum,
  };
}

module.exports = { nbody };
