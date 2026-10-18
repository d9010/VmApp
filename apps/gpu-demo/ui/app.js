'use strict';
// Particles UI. Static script (the CSP allows script-src 'self' only, and no network).
//
// This window draws. The scene (attractors, physics parameters, presets) comes from the core in the VM through window.vmapp:
// a snapshot about 30 times a second, which the render loop interpolates so the picture runs at the display's rate. The
// pixels are made here, on the host GPU (WebGPU, with a WebGL2 fallback); no frame ever crosses the bridge.

(() => {
  const bridge = window.vmapp;
  const P3D = window.P3D;
  const MAX = P3D.MAX_PARTICLES;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

  /** [key, label, min, max, step]: the core owns these and clamps them again; the sliders only ask. */
  const PARAMS = [
    ['G', 'Gravity', 0, 4, 0.01],
    ['drag', 'Drag', 0, 3, 0.01],
    ['swirl', 'Swirl', -2, 2, 0.01],
    ['noise', 'Turbulence', 0, 1.5, 0.01],
    ['pointSize', 'Dot size', 0.5, 6, 0.1],
    ['hue', 'Colour', 0, 1, 0.01],
    ['speed', 'Speed', 0, 3, 0.01],
    ['pointer', 'Mouse pull', 0, 6, 0.1],
  ];
  const DEFAULT_PARAMS = { G: 1, drag: 0.35, swirl: 0.4, noise: 0.15, pointSize: 1.6, hue: 0.58, speed: 1, pointer: 2.5 };

  const S = {
    renderer: null,
    canvas: $('view'),
    choice: 'auto', // the API the user asked for: auto, webgpu or webgl2
    reason: '', // why WebGPU is not in use, when it is not
    failed: false,
    count: 1000000,
    persistence: 0.85,
    orbit: true,
    yaw: 0.6,
    pitch: 0.45,
    dist: 3.2,
    dpr: 1,
    time: 0,
    frame: 0,
    lastFrame: performance.now(),
    // scene stream from the core
    buf: [], // recent snapshots {snap}
    offsets: [],
    offset: 0,
    last: null,
    scene: null, // the core's answer to scene:get / preset:load
    snapshots: 0,
    interpolated: 0,
    rxTimes: [],
    streamHz: 0,
    rttMs: null,
    coreInfo: null,
    modified: false,
    paused: false,
    // measurements
    fps: 0,
    frameMs: 0,
    worstMs: 0,
    fpsFrames: 0,
    fpsStart: performance.now(),
    worstWindow: 0,
    benchmarking: false,
    gpuBench: null,
    cpuBench: null,
    errors: [],
    pointer: { nx: 0, ny: 0, mode: 0, inside: false, lastSent: 0 },
  };

  // ---------------------------------------------------------------------------------------------- small helpers

  function prefs(load) {
    try {
      if (load) return JSON.parse(localStorage.getItem('particles.prefs') || '{}');
      localStorage.setItem('particles.prefs', JSON.stringify({ count: S.count, persistence: S.persistence, orbit: S.orbit, choice: S.choice }));
    } catch {
      /* storage can be unavailable: the app works without it */
    }
    return {};
  }

  function logError(message) {
    S.errors.push(String(message));
    if (S.errors.length > 20) S.errors.shift();
    console.warn(message);
  }

  const sliderToCount = (s) => clamp(Math.round(Math.pow(10, 4 + (s / 100) * Math.log10(MAX / 10000)) / 1000) * 1000, 10000, MAX);
  const countToSlider = (c) => clamp(((Math.log10(c) - 4) / Math.log10(MAX / 10000)) * 100, 0, 100);

  /**
   * Each dot adds less when there are more of them, and less again when the trails are longer (a trail adds up about 1 / fade
   * frames of light), so the picture keeps a similar brightness whatever the count and the trails.
   */
  const exposureFor = (count, fade) => 1.2 * clamp(Math.sqrt(250000 / count), 0.12, 1.6) * Math.max(fade, 0.03);

  // ---------------------------------------------------------------------------------------------- renderer lifecycle

  function freshCanvas() {
    const stage = $('stage');
    const c = document.createElement('canvas');
    c.id = 'view';
    c.setAttribute('aria-label', 'Particle simulation, drawn on the GPU');
    stage.replaceChildren(c);
    S.canvas = c;
    return c;
  }

  function sizeCanvas() {
    const c = S.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.max(1, Math.round(c.clientWidth * dpr));
    let h = Math.max(1, Math.round(c.clientHeight * dpr));
    const maxPixels = 8.5e6; // about 4K: beyond that the extra pixels only cost fill rate
    if (w * h > maxPixels) {
      const k = Math.sqrt(maxPixels / (w * h));
      w = Math.max(1, Math.floor(w * k));
      h = Math.max(1, Math.floor(h * k));
    }
    S.dpr = w / Math.max(1, c.clientWidth);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    if (S.renderer) S.renderer.resize(w, h);
  }

  /** `temporary` is for an automatic fallback: it must not overwrite what the user chose (and what is remembered). */
  async function startRenderer(choice, temporary) {
    if (!temporary) {
      S.choice = choice;
      prefs(false);
    }
    S.failed = false;
    S.reason = '';
    if (S.renderer) {
      S.renderer.onLost = null;
      S.renderer.destroy();
      S.renderer = null;
    }
    freshCanvas();
    sizeCanvas();
    let r = null;
    if (choice !== 'webgl2') {
      try {
        r = await window.WebGpuRenderer.create(S.canvas);
      } catch (e) {
        S.reason = e && e.message ? e.message : String(e);
        logError(`WebGPU is not used: ${S.reason}`);
        r = null;
        freshCanvas(); // a canvas that has had a WebGPU context cannot get a WebGL one
        sizeCanvas();
      }
    } else {
      S.reason = 'WebGL2 was selected';
    }
    if (!r) {
      try {
        r = window.WebGl2Renderer.create(S.canvas);
      } catch (e) {
        S.failed = true;
        logError(`WebGL2 is not available either: ${e && e.message ? e.message : e}`);
      }
    }
    S.renderer = r;
    if (r) {
      r.onLost = (why) => {
        logError(`${r.api} lost: ${why}`);
        if (r.api === 'webgpu' && S.renderer === r) {
          startRenderer('webgl2', true).then(() => {
            S.reason = `WebGPU device lost (${why})`;
            renderHud();
          });
        }
      };
      sizeCanvas();
    }
    renderHud();
  }

  // ---------------------------------------------------------------------------------------------- the scene stream

  function onSnap(snap) {
    const rx = performance.now();
    S.snapshots++;
    S.last = snap;
    S.offsets.push(rx - snap.t);
    if (S.offsets.length > 120) S.offsets.shift();
    S.offset = Math.min(...S.offsets);
    S.buf.push({ snap });
    if (S.buf.length > 12) S.buf.shift();
    S.rxTimes.push(rx);
    while (S.rxTimes.length && rx - S.rxTimes[0] > 2000) S.rxTimes.shift();
    S.streamHz = S.rxTimes.length > 1 ? ((S.rxTimes.length - 1) * 1000) / (S.rxTimes[S.rxTimes.length - 1] - S.rxTimes[0]) : 0;
    S.paused = !!snap.paused;
  }

  const attrBuf = new Float32Array(36);
  const mixN = (a, b, w) => a + (b - a) * w;

  /** The scene at `now`: the snapshots on both sides of (now - clock offset - 1.5 periods), interpolated. */
  function sample(now) {
    const b = S.buf;
    if (!b.length) return null;
    const last = b[b.length - 1];
    const period = 1000 / (last.snap.hz || 30);
    const rt = now - S.offset - 1.5 * period;
    let ia = b.length - 1;
    while (ia > 0 && b[ia].snap.t > rt && b[ia - 1].snap.epoch === last.snap.epoch) ia--;
    const A = b[ia].snap;
    const Cb = ia + 1 < b.length && A.t <= rt ? b[ia + 1].snap : A;
    const w = Cb !== A ? clamp((rt - A.t) / (Cb.t - A.t), 0, 1) : 0;
    if (Cb !== A) S.interpolated++;
    attrBuf.fill(0);
    const n = Math.min(A.a.length, Cb.a.length, 8);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) attrBuf[4 * i + k] = mixN(A.a[i][k], Cb.a[i][k], w);
    // the mouse attractor takes the slot after the scene's bodies; its strength fades in and out between snapshots
    const pa = A.ptr;
    const pc = Cb.ptr;
    let nAttr = n;
    if (pa || pc) {
      const p0 = pa || pc;
      const p1 = pc || pa;
      for (let k = 0; k < 3; k++) attrBuf[4 * n + k] = mixN(p0[k], p1[k], w);
      attrBuf[4 * n + 3] = mixN(pa ? pa[3] : 0, pc ? pc[3] : 0, w);
      nAttr = n + 1;
    }
    const params = {};
    for (const k of Object.keys(Cb.params)) params[k] = mixN(typeof A.params[k] === 'number' ? A.params[k] : Cb.params[k], Cb.params[k], w);
    return { n: nAttr, attr: attrBuf, params };
  }

  function buildState(sc, dtSec) {
    const p = sc ? sc.params : DEFAULT_PARAMS;
    const aspect = S.canvas.width / Math.max(1, S.canvas.height);
    const fade = 1 - Math.pow(S.persistence, dtSec * 60);
    return {
      viewProj: P3D.viewProj(aspect, S.yaw, S.pitch, S.dist, S.renderer.api === 'webgpu'),
      attr: sc ? sc.attr : attrBuf.fill(0),
      nAttr: sc ? sc.n : 0,
      dt: dtSec * p.speed,
      time: S.time,
      count: S.count,
      G: p.G,
      drag: p.drag,
      swirl: p.swirl,
      noise: p.noise,
      pointSize: p.pointSize * S.dpr,
      hue: p.hue,
      fade,
      exposure: exposureFor(S.count, fade),
    };
  }

  // ---------------------------------------------------------------------------------------------- render loop

  function sendPointer(force) {
    if (!bridge) return;
    const now = performance.now();
    if (!force && now - S.pointer.lastSent < 33) return;
    S.pointer.lastSent = now;
    const aspect = S.canvas.width / Math.max(1, S.canvas.height);
    const [x, y, z] = P3D.pointerToWorld(S.pointer.nx, S.pointer.ny, aspect, S.yaw, S.pitch, S.dist);
    bridge.send('scene:pointer', { x, y, z, mode: S.pointer.mode });
  }

  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dtMs = now - S.lastFrame;
    S.lastFrame = now;
    S.frame++;
    S.fpsFrames++;
    S.worstWindow = Math.max(S.worstWindow, dtMs);
    if (now - S.fpsStart >= 500) {
      S.fps = (S.fpsFrames * 1000) / (now - S.fpsStart);
      S.frameMs = (now - S.fpsStart) / S.fpsFrames;
      S.worstMs = S.worstWindow;
      S.fpsFrames = 0;
      S.worstWindow = 0;
      S.fpsStart = now;
    }
    if (!S.renderer || S.benchmarking) return;
    const dtSec = clamp(dtMs / 1000, 1 / 240, 1 / 20);
    if (S.orbit) S.yaw += 0.08 * dtSec;
    if (S.pointer.mode !== 0) sendPointer(false);
    const sc = sample(now);
    S.time += dtSec * (sc ? sc.params.speed : 1);
    try {
      S.renderer.frame(buildState(sc, dtSec));
    } catch (e) {
      logError(`render error: ${e && e.message ? e.message : e}`);
    }
    if (S.renderer.error && !S.errors.includes(S.renderer.error)) logError(`${S.renderer.api}: ${S.renderer.error}`);
  }

  // ---------------------------------------------------------------------------------------------- HUD

  const el = {
    badge: $('api-badge'),
    fps: $('fps'),
    frameMs: $('frame-ms'),
    gpuWrap: $('gpu-ms-wrap'),
    gpuMs: $('gpu-ms'),
    rApi: $('r-api'),
    rAdapter: $('r-adapter'),
    rDetail: $('r-detail'),
    reason: $('fallback-reason'),
    count: $('count'),
    countOut: $('count-out'),
    trails: $('trails'),
    trailsOut: $('trails-out'),
    orbit: $('orbit'),
    apiSelect: $('api-select'),
    gpuBench: $('gpu-bench'),
    gpuBenchOut: $('gpu-bench-out'),
    cWhere: $('c-where'),
    cStream: $('c-stream'),
    cRtt: $('c-rtt'),
    cSim: $('c-sim'),
    preset: $('preset'),
    presetDelete: $('preset-delete'),
    presetName: $('preset-name'),
    presetSave: $('preset-save'),
    presetMsg: $('preset-msg'),
    modified: $('modified'),
    params: $('params'),
    pause: $('pause'),
    reset: $('reset'),
    reseed: $('reseed'),
    hz: $('hz'),
    cpuBench: $('cpu-bench'),
    cpuBenchOut: $('cpu-bench-out'),
  };

  const sliders = new Map(); // param key -> {input, out}

  function buildParamSliders() {
    for (const [key, label, min, max, step] of PARAMS) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const lab = document.createElement('label');
      lab.htmlFor = `p-${key}`;
      lab.textContent = label;
      const out = document.createElement('output');
      out.htmlFor = `p-${key}`;
      lab.appendChild(out);
      const input = document.createElement('input');
      input.type = 'range';
      input.id = `p-${key}`;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(DEFAULT_PARAMS[key]);
      out.textContent = Number(input.value).toFixed(2);
      input.addEventListener('input', () => {
        out.textContent = Number(input.value).toFixed(2);
        S.modified = true;
        queueParam(key, Number(input.value));
      });
      wrap.append(lab, input);
      el.params.appendChild(wrap);
      sliders.set(key, { input, out });
    }
  }

  let pendingParams = {};
  let paramTimer = null;
  function queueParam(key, value) {
    pendingParams[key] = value;
    if (paramTimer) return;
    paramTimer = setTimeout(async () => {
      const patch = pendingParams;
      pendingParams = {};
      paramTimer = null;
      try {
        await bridge.invoke('scene:set', patch);
      } catch (e) {
        logError(`scene:set failed: ${e.message}`);
      }
    }, 40);
  }

  function syncSliders(params) {
    for (const [key, { input, out }] of sliders) {
      if (typeof params[key] !== 'number') continue;
      if (document.activeElement !== input) input.value = String(params[key]);
      out.textContent = params[key].toFixed(2);
    }
  }

  function describe(r) {
    if (!r) return { api: 'none', adapter: '–', detail: '–' };
    const i = r.info;
    if (r.api === 'webgpu') {
      const gib = (n) => `${(n / 1073741824).toFixed(n >= 1073741824 ? 0 : 2)} GiB`;
      return {
        api: 'WebGPU · compute shader + instanced quads',
        adapter: [i.vendor, i.architecture].filter(Boolean).join(' · ') || 'unknown adapter',
        detail: [i.description || i.device, `max buffer ${gib(i.limits.maxBufferSize)}`, `${i.features.length} features`, i.isFallback ? 'software adapter' : 'hardware adapter'].filter(Boolean).join(' · '),
      };
    }
    return {
      api: 'WebGL2 (fallback) · transform feedback + points',
      adapter: i.renderer,
      detail: `${i.vendor} · ${i.version} · trails: ${i.trails}`,
    };
  }

  function renderHud() {
    const r = S.renderer;
    const d = describe(r);
    if (S.failed) {
      el.badge.className = 'badge fail';
      el.badge.textContent = 'no GPU API';
    } else if (!r) {
      el.badge.className = 'badge pending';
      el.badge.textContent = 'starting…';
    } else if (r.api === 'webgpu') {
      el.badge.className = 'badge gpu';
      el.badge.textContent = 'WebGPU';
    } else {
      el.badge.className = 'badge gl';
      el.badge.textContent = 'WebGL2 fallback';
    }
    el.rApi.textContent = d.api;
    el.rAdapter.textContent = d.adapter;
    el.rDetail.textContent = d.detail;
    const showReason = (S.failed || (r && r.api === 'webgl2')) && S.reason;
    el.reason.hidden = !showReason;
    if (showReason) el.reason.textContent = S.failed ? `No GPU API could start. ${S.reason}` : `WebGPU is not in use: ${S.reason}.`;
    el.apiSelect.value = S.choice;
  }

  function hudTick() {
    el.fps.textContent = S.fps ? S.fps.toFixed(S.fps >= 100 ? 0 : 1) : '–';
    el.frameMs.textContent = S.frameMs ? `${S.frameMs.toFixed(1)} (worst ${S.worstMs.toFixed(0)})` : '–';
    const g = S.renderer && S.renderer.gpuMs;
    el.gpuWrap.hidden = !g;
    if (g) el.gpuMs.textContent = `${(g.compute + g.render).toFixed(2)} (sim ${g.compute.toFixed(2)} + draw ${g.render.toFixed(2)})`;
    el.countOut.textContent = fmtInt(S.count);
    el.trailsOut.textContent = S.persistence.toFixed(2);
    const l = S.last;
    el.cStream.textContent = l ? `${S.streamHz.toFixed(1)} Hz received (core sends ${l.hz} Hz), ${fmtInt(S.snapshots)} snapshots` : 'waiting for the core…';
    el.cRtt.textContent = S.rttMs === null ? '–' : `${S.rttMs.toFixed(2)} ms (UI to core and back)`;
    el.cSim.textContent = l ? `tick ${fmtInt(l.tick)} · hash ${l.hash} · ${l.a.length} attractor${l.a.length === 1 ? '' : 's'}${l.paused ? ' · paused' : ''}` : '–';
    if (l) syncSliders(l.params);
    el.modified.hidden = !S.modified;
    el.pause.textContent = S.paused ? 'Resume' : 'Pause';
  }

  // ---------------------------------------------------------------------------------------------- the core

  function applyScene(info) {
    S.scene = info;
    S.modified = false;
    S.paused = info.paused;
    syncSliders(info.params);
    el.hz.value = String(info.hz);
    el.preset.value = info.name;
    el.presetDelete.disabled = info.builtin;
    el.presetName.value = '';
  }

  function presetMessage(text, bad) {
    el.presetMsg.hidden = !text;
    el.presetMsg.textContent = text || '';
    el.presetMsg.className = bad ? 'note bad' : 'note';
  }

  async function refreshPresets() {
    const list = await bridge.invoke('preset:list');
    el.preset.replaceChildren();
    for (const [title, builtin] of [['Built-in', true], ['Saved', false]]) {
      const items = list.presets.filter((p) => p.builtin === builtin);
      if (!items.length) continue;
      const g = document.createElement('optgroup');
      g.label = title;
      for (const p of items) {
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.name;
        g.appendChild(o);
      }
      el.preset.appendChild(g);
    }
    el.preset.value = list.current;
    el.presetDelete.disabled = !list.presets.some((p) => p.name === list.current && !p.builtin);
  }

  async function guarded(fn) {
    try {
      return await fn();
    } catch (e) {
      presetMessage(e && e.message ? e.message : String(e), true);
      logError(e && e.message ? e.message : e);
      return null;
    }
  }

  async function measureRtt() {
    const samples = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      await bridge.invoke('core:ping');
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    S.rttMs = samples[Math.floor(samples.length / 2)];
  }

  async function cpuBench() {
    el.cpuBench.disabled = true;
    el.cpuBenchOut.textContent = 'running in the VM…';
    try {
      const r = await bridge.invoke('bench:nbody', { bodies: 1536, steps: 20 });
      S.cpuBench = r;
      el.cpuBenchOut.textContent = `${r.bodies} bodies x ${r.steps} steps in ${r.computeMs.toFixed(0)} ms: ${r.minteractionsPerSec.toFixed(0)} M interactions/s (about ${r.gflops.toFixed(1)} GFLOP/s) on the VM's CPU`;
    } catch (e) {
      el.cpuBenchOut.textContent = e.message;
    } finally {
      el.cpuBench.disabled = false;
    }
    return S.cpuBench;
  }

  // ---------------------------------------------------------------------------------------------- GPU benchmark

  async function gpuBench() {
    if (S.benchmarking || !S.renderer) return S.gpuBench;
    S.benchmarking = true;
    el.gpuBench.disabled = true;
    el.gpuBenchOut.textContent = 'running…';
    await new Promise((r) => requestAnimationFrame(r));
    try {
      const r = S.renderer;
      const sc = sample(performance.now());
      const base = buildState(sc, 1 / 60);
      const frames = r.api === 'webgpu' ? 240 : 90;
      const count = S.count;
      const ms = await r.benchmark(frames, (i) => ({ ...base, dt: 1 / 60, time: S.time + i / 60, fade: 0.1, count }));
      const fps = (frames * 1000) / ms;
      S.gpuBench = { api: r.api, count, frames, ms, fps, mUpdatesPerSec: (count * frames) / ms / 1000 };
      el.gpuBenchOut.textContent = `${fmtInt(count)} particles: ${frames} frames in ${ms.toFixed(0)} ms = ${fps.toFixed(0)} fps without vsync (${S.gpuBench.mUpdatesPerSec.toFixed(0)} M particle updates/s)`;
    } catch (e) {
      el.gpuBenchOut.textContent = `benchmark failed: ${e.message}`;
      logError(`benchmark failed: ${e.message}`);
    } finally {
      S.benchmarking = false;
      el.gpuBench.disabled = false;
    }
    return S.gpuBench;
  }

  // ---------------------------------------------------------------------------------------------- wiring

  function setCount(n) {
    S.count = clamp(Math.round(n), 10000, MAX);
    el.count.value = String(countToSlider(S.count));
    el.countOut.textContent = fmtInt(S.count);
    prefs(false);
  }

  function setPersistence(v) {
    S.persistence = clamp(v, 0, 0.95); // longer trails would add less than a half-float can resolve per frame
    el.trails.value = String(S.persistence);
    prefs(false);
  }

  function wire() {
    el.count.addEventListener('input', () => setCount(sliderToCount(Number(el.count.value))));
    for (const b of document.querySelectorAll('[data-count]')) b.addEventListener('click', () => setCount(Number(b.dataset.count)));
    el.trails.addEventListener('input', () => setPersistence(Number(el.trails.value)));
    el.orbit.addEventListener('change', () => {
      S.orbit = el.orbit.checked;
      prefs(false);
    });
    el.apiSelect.addEventListener('change', () => startRenderer(el.apiSelect.value));
    el.gpuBench.addEventListener('click', gpuBench);
    el.cpuBench.addEventListener('click', cpuBench);
    $('toggle-panels').addEventListener('click', togglePanels);

    el.preset.addEventListener('change', () =>
      guarded(async () => {
        presetMessage('');
        applyScene(await bridge.invoke('preset:load', el.preset.value));
        await refreshPresets();
      }),
    );
    el.presetSave.addEventListener('click', () =>
      guarded(async () => {
        const name = el.presetName.value.trim() || (S.scene && !S.scene.builtin ? S.scene.name : '');
        const info = await bridge.invoke('preset:save', name);
        presetMessage(`Saved "${info.name}" in the VM's /data`);
        await refreshPresets();
        applyScene(info);
      }),
    );
    let deleteArmed = null;
    el.presetDelete.addEventListener('click', () => {
      if (!deleteArmed) {
        el.presetDelete.textContent = 'Sure?';
        deleteArmed = setTimeout(() => {
          deleteArmed = null;
          el.presetDelete.textContent = 'Delete';
        }, 3000);
        return;
      }
      clearTimeout(deleteArmed);
      deleteArmed = null;
      el.presetDelete.textContent = 'Delete';
      guarded(async () => {
        const info = await bridge.invoke('preset:delete', el.preset.value);
        presetMessage('Deleted');
        await refreshPresets();
        applyScene(info);
      });
    });
    el.pause.addEventListener('click', () => guarded(async () => applyScene(await bridge.invoke('scene:pause'))));
    el.reset.addEventListener('click', () => guarded(async () => applyScene(await bridge.invoke('scene:reset'))));
    el.reseed.addEventListener('click', () =>
      guarded(async () => {
        const info = await bridge.invoke('scene:reseed');
        applyScene(info);
        S.modified = true;
      }),
    );
    el.hz.addEventListener('change', () => guarded(async () => bridge.invoke('stream:set', Number(el.hz.value))));

    const stage = $('stage');
    const ndc = (ev) => {
      const r = S.canvas.getBoundingClientRect();
      S.pointer.nx = ((ev.clientX - r.left) / r.width) * 2 - 1;
      S.pointer.ny = 1 - ((ev.clientY - r.top) / r.height) * 2;
    };
    stage.addEventListener('pointerdown', (ev) => {
      ndc(ev);
      S.pointer.mode = ev.button === 2 || ev.shiftKey ? -1 : 1;
      stage.setPointerCapture(ev.pointerId);
      sendPointer(true);
    });
    stage.addEventListener('pointermove', (ev) => {
      ndc(ev);
      if (S.pointer.mode !== 0) sendPointer(false);
    });
    const release = () => {
      if (S.pointer.mode === 0) return;
      S.pointer.mode = 0;
      sendPointer(true);
    };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);
    stage.addEventListener('contextmenu', (ev) => ev.preventDefault());
    stage.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        S.dist = clamp(S.dist * Math.exp(ev.deltaY * 0.001), 1.5, 8);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' && t.type === 'text')) return;
      if (ev.code === 'Space' && !(t && (t.tagName === 'BUTTON' || t.tagName === 'SELECT'))) {
        ev.preventDefault();
        guarded(async () => applyScene(await bridge.invoke('scene:pause')));
      } else if (ev.key === 'h' || ev.key === 'H') togglePanels();
    });
    new ResizeObserver(() => sizeCanvas()).observe(stage);
  }

  function togglePanels() {
    const hide = document.body.classList.toggle('hide-panels');
    const b = $('toggle-panels');
    b.textContent = hide ? 'Show panels' : 'Hide panels';
    b.setAttribute('aria-expanded', String(!hide));
  }

  // ---------------------------------------------------------------------------------------------- start

  async function start() {
    buildParamSliders();
    wire();
    const p = prefs(true);
    if (typeof p.count === 'number') setCount(p.count);
    else setCount(S.count);
    if (typeof p.persistence === 'number') setPersistence(p.persistence);
    if (typeof p.orbit === 'boolean') {
      S.orbit = p.orbit;
      el.orbit.checked = p.orbit;
    }
    const choice = p.choice === 'webgpu' || p.choice === 'webgl2' ? p.choice : 'auto';
    requestAnimationFrame(loop);
    setInterval(hudTick, 250);
    if (!bridge) {
      el.cWhere.textContent = 'No D9010 VmApp bridge: open this app in the D9010 VmApp Launcher.';
      await startRenderer(choice);
      return;
    }
    bridge.on('scene:state', onSnap);
    await startRenderer(choice);
    try {
      const info = await bridge.invoke('core:info');
      S.coreInfo = info;
      el.cWhere.textContent = `${info.platform === 'linux' ? 'Linux' : info.platform} ${info.arch} VM · Node ${info.node} · ${info.vcpus} vCPU · ${info.memoryMiB} MiB`;
      await refreshPresets();
      applyScene(await bridge.invoke('scene:get'));
      await measureRtt();
      setInterval(() => measureRtt().catch(() => {}), 4000);
    } catch (e) {
      logError(`core: ${e.message}`);
      el.cWhere.textContent = `The core did not answer: ${e.message}`;
    }
  }

  // A read-only summary and a few actions for tests and for people who open the devtools; nothing here is a secret.
  window.__particles = {
    get state() {
      const r = S.renderer;
      return {
        api: r ? r.api : null,
        failed: S.failed,
        reason: S.reason,
        adapter: r ? r.info : null,
        count: S.count,
        fps: S.fps,
        frameMs: S.frameMs,
        worstMs: S.worstMs,
        gpuMs: r ? r.gpuMs : null,
        frames: S.frame,
        canvas: { width: S.canvas.width, height: S.canvas.height, dpr: S.dpr },
        snapshots: S.snapshots,
        interpolatedFrames: S.interpolated,
        streamHz: S.streamHz,
        rttMs: S.rttMs,
        last: S.last,
        coreInfo: S.coreInfo,
        gpuBench: S.gpuBench,
        cpuBench: S.cpuBench,
        errors: S.errors.slice(),
      };
    },
    setCount,
    setTrails: setPersistence,
    setApi: (choice) => startRenderer(choice),
    gpuBench,
    cpuBench,
  };

  start().catch((e) => {
    logError(`start failed: ${e && e.message ? e.message : e}`);
    el.cWhere.textContent = `Could not start: ${e && e.message ? e.message : e}`;
  });
})();
