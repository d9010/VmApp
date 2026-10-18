'use strict';
// The WebGPU renderer: a compute shader integrates up to two million particles, an instanced-quad render pass draws them
// additively into a half-float accumulation texture (which gives the trails), and a last pass tone-maps that texture to the
// canvas. Everything runs on the host's GPU inside this sandboxed window; the core in the VM only sends a few hundred bytes of
// scene state 30 times a second. Classic script; exposes window.WebGpuRenderer.

(() => {
  const MAX = window.P3D.MAX_PARTICLES;
  const PARTICLE_BYTES = 32; // vec3 pos, f32 life, vec3 vel, f32 seed
  const UNIFORM_FLOATS = 68; // 272 bytes, see struct U

  const HEADER = /* wgsl */ `
struct U {
  viewProj : mat4x4<f32>,
  attr : array<vec4<f32>, 9>,
  dt : f32,
  time : f32,
  count : u32,
  nAttr : u32,
  G : f32,
  drag : f32,
  swirl : f32,
  noise : f32,
  pointSize : f32,
  hue : f32,
  frame : u32,
  fade : f32,
  res : vec2<f32>,
  exposure : f32,
  pad : f32,
};
struct Particle { pos : vec3<f32>, life : f32, vel : vec3<f32>, seed : f32 };
@group(0) @binding(0) var<uniform> u : U;
`;

  const COMPUTE = /* wgsl */ `
${HEADER}
@group(0) @binding(1) var<storage, read_write> P : array<Particle>;

fn pcg(v : u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(v : u32) -> f32 { return f32(pcg(v)) * (1.0 / 4294967296.0); }

fn spawn(i : u32, salt : u32) -> Particle {
  let k = i * 5u + salt * 2654435761u;
  let z = rnd(k) * 2.0 - 1.0;
  let phi = rnd(k + 1u) * 6.2831853;
  let rad = 0.15 + 0.85 * pow(rnd(k + 2u), 0.3333);
  let s = sqrt(max(0.0, 1.0 - z * z));
  var p : Particle;
  p.pos = vec3<f32>(s * cos(phi), z * 0.3, s * sin(phi)) * rad;
  p.vel = cross(vec3<f32>(0.0, 1.0, 0.0), p.pos) * 0.8;
  p.life = 3.0 + 9.0 * rnd(k + 3u);
  p.seed = rnd(k + 4u);
  return p;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) { return; }
  var p = P[i];
  if (p.life <= 0.0 || dot(p.pos, p.pos) > 36.0 || p.pos.x != p.pos.x) {
    P[i] = spawn(i, u.frame);
    return;
  }
  var a = vec3<f32>(0.0);
  for (var k = 0u; k < u.nAttr; k = k + 1u) {
    let A = u.attr[k];
    let d = A.xyz - p.pos;
    let r2 = dot(d, d) + 0.004;
    let inv = inverseSqrt(r2);
    let inv3 = inv * inv * inv;
    a += d * (A.w * u.G * inv3);
    a += cross(vec3<f32>(0.0, 1.0, 0.0), d) * (A.w * u.swirl * u.G * inv3);
  }
  let t = u.time;
  let q = p.pos * 2.3 + vec3<f32>(t * 0.31, t * 0.23, t * 0.17);
  a += vec3<f32>(sin(q.y + 1.7 * sin(q.z)), sin(q.z + 1.3 * sin(q.x)), sin(q.x + 1.1 * sin(q.y))) * (u.noise * 2.0);
  a = a - p.pos * vec3<f32>(0.4, 1.2, 0.4); // a soft, flattened well around the origin keeps the cloud in view and gives it a disc
  let am = length(a);
  if (am > 40.0) { a = a * (40.0 / am); }
  var v = (p.vel + a * u.dt) * exp(-u.drag * u.dt);
  let vm = length(v);
  if (vm > 4.0) { v = v * (4.0 / vm); }
  p.vel = v;
  p.pos = p.pos + v * u.dt;
  p.life = p.life - u.dt;
  P[i] = p;
}
`;

  const RENDER = /* wgsl */ `
${HEADER}
@group(0) @binding(1) var<storage, read> P : array<Particle>;

// a quad as a triangle strip: four vertices per particle instead of six
var<private> CORNERS : array<vec2<f32>, 4> = array<vec2<f32>, 4>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));

fn palette(h : f32) -> vec3<f32> {
  // hue wheel at 80% saturation (no dark gaps like a cosine palette has)
  let p = abs(fract(vec3<f32>(h) + vec3<f32>(1.0, 0.6666667, 0.3333333)) * 6.0 - vec3<f32>(3.0));
  return mix(vec3<f32>(1.0), clamp(p - vec3<f32>(1.0), vec3<f32>(0.0), vec3<f32>(1.0)), 0.8);
}

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) col : vec3<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let p = P[ii];
  let c = CORNERS[vi];
  let clip = u.viewProj * vec4<f32>(p.pos, 1.0);
  let want = u.pointSize;
  let size = max(want, 2.0);
  let area = (want / size) * (want / size);
  var o : VOut;
  o.pos = vec4<f32>(clip.xy + c * size / u.res * clip.w, clip.zw);
  o.uv = c;
  let t = clamp(length(p.vel) * 0.35, 0.0, 1.0);
  o.col = mix(palette(u.hue + 0.3 * p.seed + 0.35 * t), vec3<f32>(1.0), 0.15 + 0.35 * t) * (0.4 + 1.2 * t) * u.exposure * area;
  return o;
}

@fragment
fn fs(v : VOut) -> @location(0) vec4<f32> {
  let r = length(v.uv);
  let a = 1.0 - smoothstep(0.0, 1.0, r);
  return vec4<f32>(v.col * a, 1.0);
}
`;

  const FULLSCREEN = /* wgsl */ `
${HEADER}
@group(0) @binding(1) var accum : texture_2d<f32>;

var<private> TRI : array<vec2<f32>, 3> = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(TRI[vi], 0.0, 1.0);
}

// Multiplies what is already in the accumulation texture by (1 - fade): the trails.
@fragment
fn fadeFs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, u.fade);
}

// Tone-maps the accumulation texture onto a dark background with a soft vignette.
@fragment
fn blitFs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let c = textureLoad(accum, vec2<i32>(frag.xy), 0).rgb;
  let uv = frag.xy / u.res - vec2<f32>(0.5);
  let bg = vec3<f32>(0.010, 0.014, 0.032) * (1.0 - dot(uv, uv) * 1.2);
  let m = vec3<f32>(1.0) - exp(-c * 1.3);
  return vec4<f32>(clamp(bg + m * (vec3<f32>(1.0) - bg), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

  async function checkModule(device, code, label) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`${label}: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    return module;
  }

  class WebGpuRenderer {
    /** Returns a renderer, or throws an Error whose message says why WebGPU cannot be used. */
    static async create(canvas) {
      if (!('gpu' in navigator) || !navigator.gpu) throw new Error('navigator.gpu is not available in this window');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('requestAdapter() returned null: no WebGPU adapter');
      let ai = adapter.info;
      if (!ai && typeof adapter.requestAdapterInfo === 'function') ai = await adapter.requestAdapterInfo();
      ai = ai || {};
      const wantTimestamps = adapter.features.has('timestamp-query');
      const device = await adapter.requestDevice({ requiredFeatures: wantTimestamps ? ['timestamp-query'] : [] });
      const info = {
        api: 'webgpu',
        vendor: ai.vendor || '',
        architecture: ai.architecture || '',
        device: ai.device || '',
        description: ai.description || '',
        isFallback: !!adapter.isFallbackAdapter,
        features: [...adapter.features].sort(),
        limits: {
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        },
        timestamps: wantTimestamps,
      };
      const r = new WebGpuRenderer(canvas, adapter, device, info);
      try {
        await r.init();
      } catch (e) {
        device.destroy(); // do not leave a half-built device behind when the caller falls back to WebGL2
        throw e;
      }
      return r;
    }

    constructor(canvas, adapter, device, info) {
      this.canvas = canvas;
      this.adapter = adapter;
      this.device = device;
      this.info = info;
      this.api = 'webgpu';
      this.lostReason = null;
      this.error = null;
      this.gpuMs = null; // compute and render time of a recent frame, from timestamp queries (when the adapter has them)
      this.uniforms = new Float32Array(UNIFORM_FLOATS);
      this.uniformsU32 = new Uint32Array(this.uniforms.buffer);
      this.width = 0;
      this.height = 0;
      this.accum = null;
      this.tsPending = false;
      this.onLost = null;
    }

    async init() {
      const { device, canvas } = this;
      device.addEventListener('uncapturederror', (e) => {
        if (!this.error) this.error = e.error && e.error.message ? e.error.message : String(e.error);
      });
      device.lost.then((l) => {
        this.lostReason = `${l.reason || 'lost'}: ${l.message || ''}`.trim();
        if (this.onLost) this.onLost(this.lostReason);
      });
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx = canvas.getContext('webgpu');
      if (!this.ctx) throw new Error('canvas.getContext("webgpu") returned null');
      this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

      this.ubuf = device.createBuffer({ label: 'uniforms', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.pbuf = device.createBuffer({ label: 'particles', size: MAX * PARTICLE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

      const [cm, rm, fm] = await Promise.all([
        checkModule(device, COMPUTE, 'compute'),
        checkModule(device, RENDER, 'render'),
        checkModule(device, FULLSCREEN, 'fullscreen'),
      ]);
      const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
      const fadeBlend = { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      this.computePipe = device.createComputePipeline({ label: 'update', layout: 'auto', compute: { module: cm, entryPoint: 'main' } });
      this.drawPipe = device.createRenderPipeline({
        label: 'draw',
        layout: 'auto',
        vertex: { module: rm, entryPoint: 'vs' },
        fragment: { module: rm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: { color: additive, alpha: additive } }] },
        primitive: { topology: 'triangle-strip' },
      });
      this.fadePipe = device.createRenderPipeline({
        label: 'fade',
        layout: 'auto',
        vertex: { module: fm, entryPoint: 'vs' },
        fragment: { module: fm, entryPoint: 'fadeFs', targets: [{ format: 'rgba16float', blend: { color: fadeBlend, alpha: fadeBlend } }] },
        primitive: { topology: 'triangle-list' },
      });
      this.blitPipe = device.createRenderPipeline({
        label: 'blit',
        layout: 'auto',
        vertex: { module: fm, entryPoint: 'vs' },
        fragment: { module: fm, entryPoint: 'blitFs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      });
      const ub = { buffer: this.ubuf };
      const pb = { buffer: this.pbuf };
      this.computeBG = device.createBindGroup({ layout: this.computePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: ub }, { binding: 1, resource: pb }] });
      this.drawBG = device.createBindGroup({ layout: this.drawPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: ub }, { binding: 1, resource: pb }] });
      this.fadeBG = device.createBindGroup({ layout: this.fadePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: ub }] });

      if (this.info.timestamps) {
        this.qs = device.createQuerySet({ type: 'timestamp', count: 4 });
        this.qResolve = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        this.qRead = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      }
      this.frameNo = 0;
      this.resize(Math.max(1, canvas.width), Math.max(1, canvas.height));
      // a first, empty frame doubles as a check that the pipelines validate
      await device.queue.onSubmittedWorkDone();
      const err = await this._validate();
      if (err) throw new Error(`WebGPU validation error: ${err}`);
    }

    async _validate() {
      this.device.pushErrorScope('validation');
      this.frame(this._probeState());
      const e = await this.device.popErrorScope();
      await this.device.queue.onSubmittedWorkDone();
      return e ? e.message : null;
    }

    _probeState() {
      return { viewProj: new Float32Array(16), attr: new Float32Array(36), nAttr: 0, dt: 0.016, time: 0, count: 1000, G: 1, drag: 0.3, swirl: 0.3, noise: 0.1, pointSize: 2, hue: 0.5, fade: 0.1, exposure: 1 };
    }

    resize(w, h) {
      if (w === this.width && h === this.height && this.accum) return;
      this.width = w;
      this.height = h;
      if (this.accum) this.accum.destroy();
      this.accum = this.device.createTexture({
        label: 'accumulation',
        size: [w, h],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.accumView = this.accum.createView();
      this.blitBG = this.device.createBindGroup({
        layout: this.blitPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: this.accumView }],
      });
      this.clearNext = true;
    }

    _writeUniforms(s) {
      const f = this.uniforms;
      const u = this.uniformsU32;
      f.set(s.viewProj, 0);
      f.set(s.attr, 16);
      f[52] = s.dt;
      f[53] = s.time;
      u[54] = s.count;
      u[55] = s.nAttr;
      f[56] = s.G;
      f[57] = s.drag;
      f[58] = s.swirl;
      f[59] = s.noise;
      f[60] = s.pointSize;
      f[61] = s.hue;
      u[62] = this.frameNo >>> 0;
      f[63] = s.fade;
      f[64] = this.width;
      f[65] = this.height;
      f[66] = s.exposure;
      this.device.queue.writeBuffer(this.ubuf, 0, f);
    }

    /** Encodes and submits one frame: simulate, draw into the accumulation texture, tone-map to the canvas. */
    frame(s) {
      const { device } = this;
      this.frameNo++;
      this._writeUniforms(s);
      const enc = device.createCommandEncoder();
      const stamp = !!this.qs && !this.tsPending && this.frameNo % 20 === 0;

      const cp = enc.beginComputePass(stamp ? { timestampWrites: { querySet: this.qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : undefined);
      cp.setPipeline(this.computePipe);
      cp.setBindGroup(0, this.computeBG);
      cp.dispatchWorkgroups(Math.ceil(s.count / 256));
      cp.end();

      const clear = this.clearNext || s.fade >= 0.999;
      this.clearNext = false;
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: this.accumView, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        ...(stamp ? { timestampWrites: { querySet: this.qs, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {}),
      });
      if (!clear) {
        rp.setPipeline(this.fadePipe);
        rp.setBindGroup(0, this.fadeBG);
        rp.draw(3);
      }
      rp.setPipeline(this.drawPipe);
      rp.setBindGroup(0, this.drawBG);
      rp.draw(4, s.count);
      rp.end();

      const bp = enc.beginRenderPass({
        colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      bp.setPipeline(this.blitPipe);
      bp.setBindGroup(0, this.blitBG);
      bp.draw(3);
      bp.end();

      if (stamp) {
        enc.resolveQuerySet(this.qs, 0, 4, this.qResolve, 0);
        enc.copyBufferToBuffer(this.qResolve, 0, this.qRead, 0, 32);
      }
      device.queue.submit([enc.finish()]);
      if (stamp) this._readStamps();
    }

    _readStamps() {
      this.tsPending = true;
      this.qRead
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const t = new BigUint64Array(this.qRead.getMappedRange().slice(0));
          this.qRead.unmap();
          const compute = Number(t[1] - t[0]) / 1e6;
          const render = Number(t[3] - t[2]) / 1e6;
          if (compute >= 0 && render >= 0 && compute < 1000 && render < 1000) this.gpuMs = { compute, render };
        })
        .catch(() => {
          this.info.timestamps = false;
        })
        .finally(() => {
          this.tsPending = false;
        });
    }

    /** Runs `frames` frames back to back (not tied to the display's refresh) and reports how long the GPU took. */
    async benchmark(frames, makeState) {
      await this.device.queue.onSubmittedWorkDone();
      for (let i = 0; i < 8; i++) this.frame(makeState(i));
      await this.device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        this.frame(makeState(i));
        if (i % 8 === 7) await this.device.queue.onSubmittedWorkDone();
      }
      await this.device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    }

    destroy() {
      try {
        this.ctx.unconfigure();
      } catch {
        /* already gone */
      }
      try {
        this.device.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  window.WebGpuRenderer = WebGpuRenderer;
})();
