# Particles (`dev.vmapp.particles`, runtime `node22`)

A graphics showcase for D9010 VmApp: up to **two million particles** drawn with **WebGPU** at the Mac's full GPU speed in the app's
sandboxed window, while the scene they move around (attractors, physics, presets) lives in the core **inside the VM**.

It is the working demonstration of **layer 1** of the GPU story ([docs/VISION.md §4](../../docs/VISION.md)).

## The three layers of GPU, and where this app sits

| Layer | What | Status |
|---|---|---|
| **1. GPU in the UI window** | WebGPU and WebGL2 in the host Chromium renderer, hardware accelerated; the logic stays in the core | **This app.** Works today, with no loader change and no permission |
| **2. Vulkan inside the VM** | virtio-gpu + Mesa Venus, replayed by virglrenderer through MoltenVK to Metal, on a second VM backend (libkrun) | Experimental backend in progress (`gpu/venus-spike/`) |
| **3. VM-rendered frames in the window** | shared memory (blob resources) shows what the VM drew | Planned |

A **VM-rendered (Vulkan) variant of this showcase will follow on the experimental backend**: the same scene, but the particles
drawn by a Vulkan program in the VM instead of by the window. This version is the baseline to compare it with.

```
 sandboxed window (host, GPU)                          core (in the VM, CPU)
 ┌──────────────────────────────┐   scene:state 30 Hz  ┌─────────────────────────────────────┐
 │ WebGPU: compute shader moves │ ◄─────────────────── │ attractor bodies, 120 Hz fixed step │
 │ 1-2 M particles, quads draw  │   (about 0.5 KB)     │ physics parameters (clamped here)   │
 │ them, trails, tone map       │                      │ presets, saved in /data             │
 │ interpolates the snapshots   │ ───────────────────► │ CPU benchmark (n-body)              │
 │ UI, FPS, adapter info        │  invoke / send       └─────────────────────────────────────┘
 └──────────────────────────────┘
        no pixel crosses the bridge
```

## What it shows

- **The window draws.** A WebGPU compute shader integrates up to 2,000,000 particles (position, velocity, life; 32 bytes each, in
  one storage buffer); an instanced-quad pass draws them additively into a half-float texture (that gives the trails); a last
  pass tone-maps it to the canvas. The window shows the **FPS**, the **GPU time** per frame (timestamp queries, when the adapter has
  them) and the **adapter** (`GPUAdapterInfo`: vendor, architecture, description, limits).
- **A WebGL2 fallback.** Without `navigator.gpu`, or with no adapter, or if WebGPU fails, the same physics runs as a WebGL2
  vertex shader with transform feedback and the same drawing. The badge says which API is active (**WebGPU** or **WebGL2
  fallback**) and why WebGPU is not in use. The *API* menu forces either one.
- **The core owns the scene.** Attractor bodies (1 to 8) pull on each other and on the particles; the core steps them on a fixed
  120 Hz time step, so the state after N ticks is a function of the orbit configuration and N alone (only `+ - * / sqrt`, exactly
  rounded by IEEE 754, so it is bit-identical on any machine). The sliders (gravity, drag, swirl, turbulence, dot size, colour,
  speed, mouse pull) are **requests**: the core clamps them and streams the result back, and the shader uses what comes back.
- **A stream, not frames.** The core sends `scene:state` at 30 Hz (5 to 60 Hz selectable); the window keeps the last few snapshots and
  renders at the display's rate between them (the render time is one and a half stream periods in the past, against the core's
  own clock). A restart or a preset change bumps an `epoch`, so the window never blends across a jump.
- **The mouse is an attractor in the VM.** Press to attract, Shift or right-press to repel: the window sends a world position, the
  core owns the strength and streams the attractor back. The round trip UI to core and back is shown (about 0.2 to 0.7 ms).
- **Presets and persistence in the VM.** Five built-in presets (Orbit, Galaxy, Swarm, Fountain, Nebula) and your own, saved to
  `/data/presets.json` (atomic write, at most 32, validated on load: a corrupt file is ignored). The app opens with the preset you used last.
- **The VM's CPU too.** "CPU benchmark (VM)" runs an O(n²) n-body kernel in the core (1536 bodies × 20 steps) and shows
  million interactions per second, so the two halves are easy to tell apart: the VM does logic and maths on its CPU, the window's GPU draws.

Controls: drag = attract, Shift or right-drag = repel, wheel = zoom, Space = pause (in the VM), H = hide the panels.

## Files

```
vmapp.json            id dev.vmapp.particles, runtime node22, no permissions (no folder, no network, no dialogs)
core/main.js          the core: stream loop, IPC handlers, presets in /data
core/scene.js         the deterministic scene, parameter ranges, built-in presets (pure: no I/O, no clock)
core/nbody.js         the CPU benchmark
ui/index.html, style.css, app.js     the window: HUD, stream interpolation, render loop
ui/webgpu.js          WebGPU renderer (WGSL: compute, particles, trails, tone map)
ui/webgl2.js          WebGL2 fallback renderer (GLSL ES 3.00, transform feedback)
ui/math.js            camera and matrices
test/webgpu-cdp.mjs   the real-window check over the Chrome DevTools Protocol (below)
../../tests/apps/gpu-demo.mjs     the headless test of the core in a real VM
```

Everything is first-party code; nothing is downloaded or vendored (the CSP allows no remote assets anyway).

### The bridge

| Channel | Direction | What |
|---|---|---|
| `scene:state` | core → window, 5 to 60 Hz | `{seq, t, epoch, tick, hash, paused, name, hz, a: [[x,y,z,strength]…], ptr: [x,y,z,strength] or null, params}` |
| `scene:get`, `scene:set(patch)`, `scene:pause([bool])`, `scene:reset`, `scene:reseed([seed])` | window → core | read the scene, change parameters (clamped), pause, restart, new orbit |
| `scene:replay(ticks)` | window → core | the orbit replayed from tick 0 on a fresh scene: `{tick, hash, attractors}` (determinism check) |
| `scene:pointer` | window → core (`send`) | `{x, y, z, mode: 1, -1 or 0}` |
| `preset:list`, `preset:load(name)`, `preset:save(name)`, `preset:delete(name)` | window → core | presets |
| `stream:set(hz)` | window → core | stream rate |
| `core:info`, `core:ping`, `bench:nbody({bodies, steps})` | window → core | where the core runs, a round trip, the CPU benchmark |

## Run it

```sh
cd vmapp
tools/vmapp pack apps/gpu-demo -o particles.vmapp
tools/vmapp install particles.vmapp          # then Launch it in the D9010 VmApp Launcher (no permission sheet: it asks for nothing)
# or, as a developer: cd loader && npm start, then "Run project folder…" and pick apps/gpu-demo
```

## Tests

**1. The core, headless in a real VM** (`tests/apps/gpu-demo.mjs`, three runs sharing one app data folder; part of
`tests/apps/run-all.sh` as `gpu-demo-run1..3`):

```sh
tools/vmapp run dev.vmapp.particles --headless --script tests/apps/gpu-demo.mjs        # with GPU_DEMO_PHASE=1, then 2, then 3
```

It checks: the core runs on Linux/arm64 in the VM; the stream is about 30 Hz, small, gap-free, with 120 physics ticks per second; the live
state equals a replay from tick 0 (bit for bit), also in a **fresh VM** of the next run; pause, restart and `epoch`; parameters are
clamped and unknown keys dropped; the mouse attractor (attract, repel, clamping, garbage ignored); the built-in presets; saving to
`/data/presets.json` and **reading it back in the next run**; name validation and the 32-preset limit; a corrupt file is ignored
and repaired by the next save; the CPU benchmark runs in the VM, one at a time, while the stream continues.

**2. The window's GPU half, in the loader, over CDP** (`apps/gpu-demo/test/webgpu-cdp.mjs`). It opens real windows for about a minute
(and brings them to the front: a covered window would not render):

```sh
cd vmapp
VMAPP_WORK=/absolute/scratch/dir CDP_PORT=9301 node apps/gpu-demo/test/webgpu-cdp.mjs
```

Needs `out/` (built by `tools/build.sh`: `vmapp-vm`, `Image`, `initramfs.cpio`, `runtimes/node22.img`) and `loader/node_modules`
(Electron 44). It starts the loader **from source** with its own fresh `VMAPP_HOME`, answers "Run project folder…" with this app (a
developer build) and then, in the app window:

1. checks the sandbox is intact (no Node, `fetch` blocked by the CSP);
2. checks `navigator.gpu` exists, an adapter and a device were obtained, and prints the `GPUAdapterInfo`; **fails if the app is not on WebGPU**;
3. checks the stream from the VM arrives (about 30 snapshots/s, interpolated) and that a parameter change round-trips through the VM;
4. sends real mouse events (`Input.dispatchMouseEvent`) and checks they come back from the VM as an attractor;
5. measures the frame rate with **its own `requestAnimationFrame` counter over 5 s** at 1,000,000 and 2,000,000 particles, plus the app's
   uncapped GPU benchmark; takes the screenshot `$VMAPP_WORK/shots/particles.png`;
6. forces WebGL2, measures it and takes `particles-webgl2.png`; then **hides `navigator.gpu`** before the page runs and checks the app
   starts on WebGL2 by itself and says why; checks the page logged no warning, error, exception or CSP violation;
7. runs the CPU benchmark in the VM; stops the loader it started and checks its VM is gone; writes `$VMAPP_WORK/particles-cdp/report.json`.

Environment: `VMAPP_WORK` (scratch, default `out/work`), `CDP_PORT` (default 9301), `COUNTS` (default `1000000,2000000`), `FPS_SECONDS` (5),
`REQUIRE_WEBGPU=0` (do not fail when only WebGL2 exists), `PRESET_SHOTS=1` (also one screenshot per built-in preset, panels hidden).
The script passes `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` to the dev loader so that a window another
window covers keeps rendering; a packaged loader refuses debugging switches, so this is a test-only convenience.

## Measured (2026-10-15)

On an Apple M4 Max, macOS, loader from source (Electron 44.4.5), 1280×772 window. WebGPU adapter: vendor `apple`, architecture
`metal-3` (23 features, a hardware adapter, 4 GiB max buffer). Screenshot: `$VMAPP_WORK/shots/particles.png` (this recording:
`vmapp/out/work-p1/shots/particles.png`; the WebGL2 one is next to it).

| | Particles | rAF over 5 s | frame time (p50 / p95) | GPU time per frame | Uncapped (no vsync) |
|---|---|---|---|---|---|
| **WebGPU** | 1,000,000 | **100.0 fps** (99.8 to 100.0 over 4 runs) | 10.0 / 10.9 ms | 2.6 ms (sim 0.07 + draw 2.56) | 358 to 383 fps = about 370 M particle updates/s |
| **WebGPU** | 2,000,000 | **100.0 fps** (99.9 to 100.0) | 10.0 / 10.9 ms | 5.2 ms (sim 0.20 + draw 4.98) | 175 to 183 fps = about 360 M updates/s |
| WebGL2 (fallback) | 1,000,000 | 99.8 to 100.0 fps | 10.0 / 10.9 ms | n/a | 641 to 750 fps |

- **How to read it.** `requestAnimationFrame` is capped by the display: 10.0 ms per frame, steadily, is the display's refresh on this
  machine, so 1 to 2 million particles run at the cap with room to spare. The *uncapped* column is the app's own benchmark: 240 frames
  submitted back to back (simulate + draw + tone map) and timed until the GPU finishes, so it shows what the GPU can do beyond the cap.
  The GPU time is from timestamp queries (the browser quantises them). WebGL2 draws one `GL_POINTS` vertex per particle where the
  WebGPU version draws a four-vertex quad, which is why WebGL2 benchmarks faster here: this is not a claim that WebGL2 beats WebGPU.
- **The core (VM, 1 vCPU, 256 MiB, Linux arm64, Node 22):** the scene streams at **30.0 Hz** (30.0 snapshots/s received, measured in the
  window); a round trip from the window to the core and back takes **0.2 to 0.7 ms** (median of 9 pings). The n-body benchmark does
  **444 to 585 million interactions/s** (9 to 12 GFLOP/s at 20 flops per interaction) on that one vCPU.
- All of this ran with the stock loader: **WebGPU is available in the sandboxed app window with the strict CSP, no flag and no loader
  change** (`navigator.gpu` present, adapter obtained, `webgpu` context on a canvas, compute and render pipelines, timestamp queries).

## The honest limits

- **Measured on one machine.** The numbers depend on the GPU and the display; the script prints the same table for yours.
- **The GPU belongs to the window, not to the VM.** Nothing in the VM can use it: the core has no GPU (that is layer 2). The core only
  sends state; if your logic must run *on* the GPU in the VM, this approach does not apply.
- **Latency of the VM path.** Anything the user does that must change the picture goes UI → bridge → VM → bridge → UI. The measured round
  trip is well under a millisecond, but the stream is 30 Hz and interpolated 1.5 periods late, so the mouse attractor lags by about 50 ms.
- **WebGPU limits.** The default adapter limits are used (the 64 MB particle buffer fits within the 128 MiB storage-buffer limit; that is why
  the count stops at 2 million). Trails use a half-float texture, so they stop at 0.95 persistence.
- **DevTools are off** (`webPreferences.devTools` only with `PARTICLES_DEBUG=1` in the core's environment). `window.__particles` (a read-only
  state summary and a few actions) exists for tests and for people who open DevTools; it exposes nothing the page does not already have.
