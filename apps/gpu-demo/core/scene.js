'use strict';
/*
 * The scene: the part of "Particles" that lives in the VM.
 *
 * Pure logic, no I/O, no clocks, so it can be tested and replayed exactly:
 *
 *   - a small set of ATTRACTOR bodies (1 to 8) that pull on each other with softened gravity and are held near the
 *     origin by a spring. They move on a fixed 120 Hz time step, so after N ticks the state is a function of
 *     (orbit configuration, N) and nothing else. Only + - * / and sqrt are used: those are exactly rounded by IEEE 754,
 *     so the same configuration gives bit-identical positions on any machine (Math.sin and friends are avoided on purpose).
 *   - a PARAMETER set for the particles (gravity, drag, swirl, turbulence, dot size, colour, speed). The window's GPU
 *     shader reads these; the core owns them. They do not feed back into the attractors, so the attractor path
 *     depends on the orbit configuration alone.
 *
 * main.js turns wall-clock time into a number of ticks and streams snapshots to the window; the window draws a million
 * particles around the streamed attractors on the GPU.
 */

const TICK_HZ = 120;
const MAX_BODIES = 8;
const SOFT2 = 0.04; // softening (squared) of the attractor-attractor force

/** Particle parameters: [min, max, default]. The window sends patches; every value is clamped here. */
const PARAM_SPEC = {
  G: [0, 4, 1], // pull of every attractor on a particle
  drag: [0, 3, 0.35], // velocity damping per second
  swirl: [-2, 2, 0.4], // sideways force around the attractors (the sign is the direction)
  noise: [0, 1.5, 0.15], // turbulence
  pointSize: [0.5, 6, 1.6], // dot size in pixels
  hue: [0, 1, 0.58], // colour
  speed: [0, 3, 1], // simulation speed of the particles
  pointer: [0, 6, 2.5], // strength of the mouse attractor
};

const ORBIT_LIMITS = {
  seed: [0, 2147483647],
  bodyG: [0, 3],
  spring: [0, 4],
  radius: [0, 1.5],
  speed: [0, 2],
  strength: [-3, 3],
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : dflt);

/** Returns the full parameter object: defaults, overridden by `base`, overridden by `patch`; unknown keys are dropped. */
function sanitizeParams(patch, base) {
  const out = {};
  for (const [k, [lo, hi, dflt]] of Object.entries(PARAM_SPEC)) {
    const b = base && typeof base[k] === 'number' ? clamp(base[k], lo, hi) : dflt;
    out[k] = patch && typeof patch === 'object' ? num(patch[k], lo, hi, b) : b;
  }
  return out;
}

/** Returns a complete, valid orbit configuration. */
function sanitizeOrbit(o) {
  const src = o && typeof o === 'object' ? o : {};
  const n = Number.isInteger(src.n) ? clamp(src.n, 1, MAX_BODIES) : 3;
  const strengths = [];
  for (let i = 0; i < n; i++) strengths.push(num(Array.isArray(src.strengths) ? src.strengths[i] : undefined, ...ORBIT_LIMITS.strength, 1));
  return {
    seed: Number.isInteger(src.seed) ? clamp(src.seed, ...ORBIT_LIMITS.seed) : 1,
    n,
    strengths,
    bodyG: num(src.bodyG, ...ORBIT_LIMITS.bodyG, 0.8),
    spring: num(src.spring, ...ORBIT_LIMITS.spring, 1),
    radius: num(src.radius, ...ORBIT_LIMITS.radius, 0.6),
    speed: num(src.speed, ...ORBIT_LIMITS.speed, 0.6),
  };
}

/** Small, fast 32-bit PRNG (mulberry32); integer maths only, so it is identical everywhere. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Scene {
  /** @param {object} orbit an orbit configuration (sanitised here) */
  constructor(orbit) {
    this.reset(orbit);
  }

  reset(orbit) {
    this.orbit = sanitizeOrbit(orbit);
    const { n, seed, radius, speed } = this.orbit;
    const rng = makeRng(seed);
    this.n = n;
    this.pos = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.accel = new Float64Array(3 * n);
    this.tick = 0;
    for (let i = 0; i < n; i++) {
      // a point in the unit ball by rejection (the loop is bounded in practice; the cap keeps it total)
      let x = 0;
      let y = 0;
      let z = 0;
      let r2 = 0;
      for (let tries = 0; tries < 64; tries++) {
        x = 2 * rng() - 1;
        y = 2 * rng() - 1;
        z = 2 * rng() - 1;
        r2 = x * x + y * y + z * z;
        if (r2 <= 1 && r2 >= 0.05) break;
        r2 = 0;
      }
      if (r2 === 0) {
        x = 1;
        y = 0;
        z = 0;
        r2 = 1;
      }
      const k = (radius * (0.6 + 0.4 * rng())) / Math.sqrt(r2);
      const px = x * k;
      const py = y * k;
      const pz = z * k;
      this.pos[3 * i] = px;
      this.pos[3 * i + 1] = py;
      this.pos[3 * i + 2] = pz;
      // a tangential velocity around the y axis (around the x axis when the body sits on the y axis)
      let tx = pz; // cross((0,1,0), p) = (pz, 0, -px)
      let tz = -px;
      let tl = Math.sqrt(tx * tx + tz * tz);
      let ty = 0;
      if (tl < 1e-9) {
        tx = 0; // cross((1,0,0), p) = (0, -pz, py)
        ty = -pz;
        tz = py;
        tl = Math.sqrt(ty * ty + tz * tz);
      }
      const s = tl > 0 ? speed / tl : 0;
      const jitter = 0.15 * speed;
      this.vel[3 * i] = tx * s + jitter * (rng() - 0.5);
      this.vel[3 * i + 1] = ty * s + jitter * (rng() - 0.5);
      this.vel[3 * i + 2] = tz * s + jitter * (rng() - 0.5);
    }
    this._accelerate();
  }

  /** a(p) for every body: softened attraction between bodies (the strengths are the masses) and a spring to the origin. */
  _accelerate() {
    const { n, pos, accel } = this;
    const { strengths, bodyG, spring } = this.orbit;
    for (let i = 0; i < n; i++) {
      let ax = -spring * pos[3 * i];
      let ay = -spring * pos[3 * i + 1];
      let az = -spring * pos[3 * i + 2];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = pos[3 * j] - pos[3 * i];
        const dy = pos[3 * j + 1] - pos[3 * i + 1];
        const dz = pos[3 * j + 2] - pos[3 * i + 2];
        const r2 = dx * dx + dy * dy + dz * dz + SOFT2;
        const f = (bodyG * strengths[j]) / (r2 * Math.sqrt(r2));
        ax += dx * f;
        ay += dy * f;
        az += dz * f;
      }
      accel[3 * i] = ax;
      accel[3 * i + 1] = ay;
      accel[3 * i + 2] = az;
    }
  }

  /** Advances `ticks` fixed steps (velocity Verlet at 120 Hz). */
  step(ticks) {
    const dt = 1 / TICK_HZ;
    const h = 0.5 * dt;
    const { n, pos, vel, accel } = this;
    for (let t = 0; t < ticks; t++) {
      for (let k = 0; k < 3 * n; k++) {
        vel[k] += h * accel[k];
        pos[k] += dt * vel[k];
      }
      this._accelerate();
      for (let k = 0; k < 3 * n; k++) vel[k] += h * accel[k];
    }
    this.tick += ticks;
  }

  /** The attractors as [x, y, z, strength]. */
  attractors() {
    const out = [];
    for (let i = 0; i < this.n; i++) out.push([this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2], this.orbit.strengths[i]]);
    return out;
  }

  /** FNV-1a over the exact bits of every position and velocity: equal hashes mean identical states. */
  hash() {
    const f = new Float64Array(this.pos.length + this.vel.length);
    f.set(this.pos);
    f.set(this.vel, this.pos.length);
    const u = new Uint32Array(f.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) {
      h ^= u[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
}

/** The built-in presets (cannot be overwritten or deleted). */
const BUILTIN = [
  {
    name: 'Orbit',
    orbit: { seed: 7, n: 3, strengths: [1, 0.7, 0.7], bodyG: 0.8, spring: 1.2, radius: 0.6, speed: 0.6 },
    params: { G: 1.2, drag: 0.6, swirl: 0.5, noise: 0.05, pointSize: 1.6, hue: 0.58, speed: 1, pointer: 2.5 },
  },
  {
    name: 'Galaxy',
    orbit: { seed: 21, n: 2, strengths: [2.2, 0.6], bodyG: 1.2, spring: 0.3, radius: 0.5, speed: 0.9 },
    params: { G: 1.6, drag: 0.3, swirl: 1.0, noise: 0.02, pointSize: 1.4, hue: 0.08, speed: 1, pointer: 2.5 },
  },
  {
    name: 'Swarm',
    orbit: { seed: 5, n: 6, strengths: [0.9, 0.8, 0.8, 0.7, 0.7, 0.6], bodyG: 1.6, spring: 1.0, radius: 0.9, speed: 0.8 },
    params: { G: 0.7, drag: 0.5, swirl: 0.5, noise: 0.25, pointSize: 1.6, hue: 0.33, speed: 1.2, pointer: 2.5 },
  },
  {
    name: 'Fountain',
    orbit: { seed: 3, n: 2, strengths: [1.8, -1.0], bodyG: 0.6, spring: 0.8, radius: 0.5, speed: 0.5 },
    params: { G: 1.1, drag: 0.7, swirl: 0.7, noise: 0.1, pointSize: 1.8, hue: 0.85, speed: 1, pointer: 2.5 },
  },
  {
    name: 'Nebula',
    orbit: { seed: 11, n: 1, strengths: [1], bodyG: 0, spring: 0, radius: 0.05, speed: 0 },
    params: { G: 0.7, drag: 0.4, swirl: 0.9, noise: 0.4, pointSize: 1.4, hue: 0.7, speed: 0.8, pointer: 2.5 },
  },
];

module.exports = { Scene, TICK_HZ, MAX_BODIES, PARAM_SPEC, BUILTIN, sanitizeParams, sanitizeOrbit, makeRng };
