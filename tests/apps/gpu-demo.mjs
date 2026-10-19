// Particles (dev.vmapp.particles, node22 runtime): the logic half of the graphics showcase, tested headless in a real VM. The
// pixels (WebGPU) are tested separately in a real window: apps/gpu-demo/test/webgpu-cdp.mjs.
// Three runs share one app data folder (run-all.sh sets GPU_DEMO_PHASE):
//   1: the core streams the scene at 30 Hz with a deterministic physics state, params are clamped, the mouse attractor, built-in
//      presets, saving presets to /data, name validation, the CPU benchmark runs in the VM
//   2: a SECOND run (a fresh VM) starts with the last saved preset, the same replay hash as run 1, presets are deleted
//   3: a corrupt presets.json is ignored (built-ins only), and the core repairs it on the next save
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitted, ok, sleep, waitFor } from './lib.mjs';

const BUILTIN = ['Orbit', 'Galaxy', 'Swarm', 'Fountain', 'Nebula'];

export default async function ({ session, wm, store }) {
  const phase = process.env.GPU_DEMO_PHASE || '1';
  const win = 1;
  const dataFile = path.join(store.dataDir(session.appId), 'presets.json');
  const carry = path.join(process.env.APPS_FIX || path.join(os.tmpdir(), 'vmapp-gpu-demo-test'), 'gpu-demo-carry.json');
  const onDisk = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const snaps = () => emitted(wm, win, 'scene:state').map((a) => a[0]);
  const newest = () => snaps().at(-1);
  const waitSnap = (pred, what, timeoutMs = 5000) => waitFor(() => snaps().find(pred), { what, timeoutMs, intervalMs: 20 });
  const waitNew = (pred, what, timeoutMs = 5000) => {
    const from = snaps().length;
    return waitFor(() => snaps().slice(from).find(pred), { what, timeoutMs, intervalMs: 20 });
  };

  await wm.waitForWindows(1, 30000);
  const created = wm.windows.get(win);
  assert.equal(created.params.entry, 'index.html');
  assert.equal(created.params.title, 'Particles');
  assert.ok(!created.params.devTools, 'the window asks for no DevTools');
  ok('window created: index.html, title "Particles", no DevTools');

  // ---- the core runs in the VM -----------------------------------------------------------------------------
  const info = await wm.invoke(win, 'core:info');
  assert.equal(info.platform, 'linux');
  assert.equal(info.arch, 'arm64');
  assert.match(info.node, /^v22\./);
  assert.ok(info.vcpus >= 1 && info.memoryMiB >= 64);
  assert.equal(info.app.name, 'Particles');
  ok(`core:info says it runs on ${info.platform}/${info.arch}, Node ${info.node}, ${info.vcpus} vCPU, ${info.memoryMiB} MiB (the VM, not the host)`);

  const ping = await wm.invoke(win, 'core:ping');
  assert.equal(typeof ping, 'number');

  if (phase === '1') {
    // ---- a fresh app starts with the first built-in preset -------------------------------------------------
    const scene0 = await wm.invoke(win, 'scene:get');
    assert.equal(scene0.name, 'Orbit');
    assert.equal(scene0.builtin, true);
    assert.equal(scene0.orbit.n, 3);
    assert.equal(scene0.hz, 30);
    assert.equal(scene0.paused, false);
    assert.equal(scene0.tickHz, 120);
    assert.deepEqual(Object.keys(scene0.params).sort(), ['G', 'drag', 'hue', 'noise', 'pointSize', 'pointer', 'speed', 'swirl']);
    assert.ok(!fs.existsSync(dataFile), 'nothing is written to /data until the user saves a preset');
    ok('first run: preset "Orbit" with 3 attractors, stream rate 30 Hz, nothing in /data yet');

    // ---- the stream: 30 Hz, a few hundred bytes each, ticks at 120 Hz ---------------------------------------
    await waitSnap(() => true, 'the first scene:state');
    const from = snaps().length;
    await sleep(2000);
    const got = snaps().slice(from);
    assert.ok(got.length >= 45 && got.length <= 75, `about 60 snapshots in 2 s, got ${got.length}`);
    for (let i = 1; i < got.length; i++) {
      assert.equal(got[i].seq, got[i - 1].seq + 1, 'no snapshot is lost or repeated');
      assert.ok(got[i].t > got[i - 1].t, 'the core clock only goes forward');
      assert.ok(got[i].tick >= got[i - 1].tick, 'ticks never go back');
    }
    const gaps = got.slice(1).map((s, i) => s.t - got[i].t).sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    assert.ok(medianGap > 28 && medianGap < 40, `median gap between snapshots is ~33 ms, got ${medianGap.toFixed(1)}`);
    const rate = ((got.length - 1) * 1000) / (got.at(-1).t - got[0].t);
    const ticksPerSec = ((got.at(-1).tick - got[0].tick) * 1000) / (got.at(-1).t - got[0].t);
    assert.ok(rate > 25 && rate < 36, `stream rate ${rate.toFixed(1)} Hz`);
    assert.ok(ticksPerSec > 100 && ticksPerSec < 140, `the physics runs at 120 ticks/s, got ${ticksPerSec.toFixed(1)}`);
    const bytes = JSON.stringify(got[0]).length;
    assert.ok(bytes < 1500, `a snapshot is small (${bytes} bytes)`);
    const s = got[0];
    assert.equal(s.a.length, 3);
    assert.ok(s.a.every((a) => a.length === 4 && a.every(Number.isFinite)));
    assert.match(s.hash, /^[0-9a-f]{8}$/);
    assert.equal(s.ptr, null);
    ok(`stream: ${rate.toFixed(1)} Hz (median gap ${medianGap.toFixed(1)} ms), ${ticksPerSec.toFixed(0)} physics ticks/s, ${bytes} bytes per snapshot, seq without gaps`);

    // ---- determinism: the live state equals a replay from tick 0 -----------------------------------------
    await wm.invoke(win, 'scene:pause', true);
    const frozen = await waitNew((x) => x.paused, 'a paused snapshot');
    await sleep(150);
    const again = newest();
    assert.equal(again.tick, frozen.tick, 'a paused scene does not advance');
    assert.equal(again.hash, frozen.hash);
    const replay = await wm.invoke(win, 'scene:replay', frozen.tick);
    assert.equal(replay.tick, frozen.tick);
    assert.equal(replay.hash, frozen.hash, 'replaying the orbit from tick 0 reproduces the live state bit for bit');
    assert.deepEqual(replay.attractors, frozen.a);
    assert.equal((await wm.invoke(win, 'scene:replay', frozen.tick)).hash, replay.hash);
    assert.notEqual((await wm.invoke(win, 'scene:replay', frozen.tick + 1)).hash, replay.hash);
    assert.notEqual((await wm.invoke(win, 'scene:replay', 0)).hash, replay.hash);
    ok(`determinism: the live state at tick ${frozen.tick} (hash ${frozen.hash}) equals a replay from tick 0; one more tick differs`);

    // ---- resume, restart ---------------------------------------------------------------------------------
    await wm.invoke(win, 'scene:pause', false);
    const moving = await waitNew((x) => !x.paused && x.tick > frozen.tick + 20, 'the scene moves again');
    assert.notEqual(moving.hash, frozen.hash);
    const epochBefore = newest().epoch;
    const resetInfo = await wm.invoke(win, 'scene:reset');
    assert.ok(resetInfo.epoch > epochBefore, 'a restart bumps the epoch so the window does not interpolate across the jump');
    assert.ok(resetInfo.tick < 50);
    const afterReset = await waitNew((x) => x.epoch === resetInfo.epoch, 'a snapshot of the new epoch');
    assert.ok(afterReset.tick < 200);
    ok('pause freezes the state, resume continues, restart bumps the epoch and goes back to tick 0');

    // ---- stream rate --------------------------------------------------------------------------------------
    assert.deepEqual(await wm.invoke(win, 'stream:set', 1000), { hz: 60 });
    assert.deepEqual(await wm.invoke(win, 'stream:set', 1), { hz: 5 });
    assert.deepEqual(await wm.invoke(win, 'stream:set', 'x'), { hz: 30 });
    await wm.invoke(win, 'stream:set', 60);
    const f60 = snaps().length;
    await sleep(1200);
    const n60 = snaps().length - f60;
    assert.ok(n60 >= 45 && n60 <= 90, `60 Hz gives about 72 snapshots in 1.2 s, got ${n60}`);
    await wm.invoke(win, 'stream:set', 30);
    ok('stream rate: 60 Hz delivers about twice the snapshots, 1000 is clamped to 60, 1 to 5');

    // ---- parameters are validated and clamped in the core ----------------------------------------------
    const set = await wm.invoke(win, 'scene:set', { G: 99, drag: -5, swirl: null, noise: 'x', bogus: 1, hue: 0.25 });
    assert.equal(set.params.G, 4);
    assert.equal(set.params.drag, 0);
    assert.equal(set.params.swirl, scene0.params.swirl, 'a non-number leaves the value alone');
    assert.equal(set.params.noise, scene0.params.noise);
    assert.equal(set.params.hue, 0.25);
    assert.ok(!('bogus' in set.params));
    const streamed = await waitNew((x) => x.params.G === 4 && x.params.hue === 0.25, 'the new parameters in the stream');
    assert.equal(streamed.params.drag, 0);
    await wm.invoke(win, 'scene:set', scene0.params);
    ok('scene:set clamps (G 99 to 4, drag -5 to 0), ignores non-numbers and unknown keys, and the stream carries the change');

    // ---- the mouse attractor: the window sends a position, the core owns the strength -------------------
    await wm.send(win, 'scene:pointer', { x: 0.5, y: 0.25, z: -0.5, mode: 1 });
    const withPtr = await waitNew((x) => x.ptr !== null, 'a snapshot with the mouse attractor');
    assert.deepEqual(withPtr.ptr.slice(0, 3), [0.5, 0.25, -0.5]);
    assert.equal(withPtr.ptr[3], scene0.params.pointer, 'attract: the strength is the core\'s "pointer" parameter');
    await wm.send(win, 'scene:pointer', { x: 100, y: -100, z: 0, mode: -1 });
    const repel = await waitNew((x) => x.ptr && x.ptr[3] < 0, 'a repelling mouse attractor');
    assert.deepEqual(repel.ptr.slice(0, 2), [4, -4], 'positions are clamped to +-4');
    assert.equal(repel.ptr[3], -scene0.params.pointer);
    await wm.send(win, 'scene:pointer', 'garbage');
    await wm.send(win, 'scene:pointer', { x: 1, y: 1, z: 1, mode: 7 });
    await waitNew((x) => x.ptr === null, 'the mouse attractor off (mode 7 is not a mode)');
    ok('mouse attractor: attract and repel come back as +-pointer strength, positions clamped, garbage ignored, off again');

    // ---- presets --------------------------------------------------------------------------------------------
    const list = await wm.invoke(win, 'preset:list');
    assert.deepEqual(list.presets.map((p) => p.name), BUILTIN);
    assert.ok(list.presets.every((p) => p.builtin));
    assert.equal(list.current, 'Orbit');
    const galaxy = await wm.invoke(win, 'preset:load', 'Galaxy');
    assert.equal(galaxy.name, 'Galaxy');
    assert.equal(galaxy.orbit.n, 2);
    assert.equal(galaxy.params.hue, 0.08);
    const gs = await waitNew((x) => x.name === 'Galaxy' && x.epoch === galaxy.epoch, 'the Galaxy scene in the stream');
    assert.equal(gs.a.length, 2);
    const swarm = await wm.invoke(win, 'preset:load', 'Swarm');
    assert.equal((await waitNew((x) => x.epoch === swarm.epoch, 'the Swarm scene')).a.length, 6);
    await assert.rejects(() => wm.invoke(win, 'preset:load', 'Nope'), /No preset named "Nope"/);
    assert.equal(onDisk().last, 'Swarm', 'loading a preset remembers it as the last one');
    ok('five built-in presets; loading changes the attractors and the parameters (Galaxy 2 bodies, Swarm 6); unknown name refused');

    // ---- save to /data ---------------------------------------------------------------------------------------
    await wm.invoke(win, 'scene:set', { G: 2.5, swirl: -1.2, hue: 0.9 });
    const saved = await wm.invoke(win, 'preset:save', '  Test Preset  ');
    assert.equal(saved.name, 'Test Preset');
    assert.equal(saved.builtin, false);
    let disk = onDisk();
    assert.equal(disk.version, 1);
    assert.equal(disk.last, 'Test Preset');
    assert.deepEqual(disk.presets.map((p) => p.name), ['Test Preset']);
    assert.equal(disk.presets[0].params.G, 2.5);
    assert.equal(disk.presets[0].params.swirl, -1.2);
    assert.equal(disk.presets[0].orbit.n, 6);
    assert.ok(!fs.existsSync(`${dataFile}.tmp`), 'the temporary file was renamed away');
    assert.deepEqual((await wm.invoke(win, 'preset:list')).presets.filter((p) => !p.builtin).map((p) => p.name), ['Test Preset']);

    const reseeded = await wm.invoke(win, 'scene:reseed', 42);
    assert.equal(reseeded.orbit.seed, 42);
    assert.ok(reseeded.epoch > saved.epoch);
    const seeded = await wm.invoke(win, 'preset:save', 'Seeded');
    assert.equal(seeded.name, 'Seeded');
    disk = onDisk();
    assert.deepEqual(disk.presets.map((p) => p.name), ['Test Preset', 'Seeded']);
    assert.equal(disk.last, 'Seeded');
    assert.equal(disk.presets[1].orbit.seed, 42);
    const h500 = (await wm.invoke(win, 'scene:replay', 500)).hash;
    fs.mkdirSync(path.dirname(carry), { recursive: true });
    fs.writeFileSync(carry, JSON.stringify({ seed: 42, ticks: 500, hash: h500 }));
    ok(`presets saved to /data/presets.json on the host (atomic write): "Test Preset" and "Seeded" (seed 42, replay hash at tick 500 = ${h500})`);

    // ---- name validation --------------------------------------------------------------------------------------
    await assert.rejects(() => wm.invoke(win, 'preset:save', 'Orbit'), /built-in/);
    await assert.rejects(() => wm.invoke(win, 'preset:save', ''), /Give the preset a name/);
    await assert.rejects(() => wm.invoke(win, 'preset:save', '   '), /Give the preset a name/);
    await assert.rejects(() => wm.invoke(win, 'preset:save', 'x'.repeat(41)), /at most 40/);
    await assert.rejects(() => wm.invoke(win, 'preset:save', 'bad\nname'), /control characters/);
    await assert.rejects(() => wm.invoke(win, 'preset:delete', 'Orbit'), /Built-in presets cannot be deleted/);
    await assert.rejects(() => wm.invoke(win, 'preset:delete', 'No such'), /No preset named/);
    const proto = await wm.invoke(win, 'preset:save', '__proto__');
    assert.equal(proto.name, '__proto__', 'odd names are plain data');
    await wm.invoke(win, 'preset:delete', '__proto__');
    for (let i = 0; i < 40; i++) {
      try {
        await wm.invoke(win, 'preset:save', `bulk ${i}`);
      } catch (e) {
        assert.match(e.message, /At most 32 presets/);
        break;
      }
    }
    assert.equal(onDisk().presets.length, 32, 'at most 32 saved presets');
    for (let i = 0; i < 40; i++) await wm.invoke(win, 'preset:delete', `bulk ${i}`).catch(() => {});
    assert.deepEqual(onDisk().presets.map((p) => p.name), ['Test Preset', 'Seeded']);
    await wm.invoke(win, 'preset:load', 'Seeded');
    ok('validation: built-in names, empty, 41 characters and control characters refused; at most 32 presets; built-ins cannot be deleted');

    // ---- the CPU benchmark runs in the VM, and the stream keeps going ---------------------------------------
    const beforeBench = snaps().length;
    // (long enough to span several 33 ms ticks of the 30 Hz stream: 2048 bodies x 10 steps is about 42 M interactions, some 70 ms)
    const [r1, r2] = await Promise.allSettled([wm.invoke(win, 'bench:nbody', { bodies: 2048, steps: 10 }), wm.invoke(win, 'bench:nbody', { bodies: 128, steps: 2 })]);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'one benchmark runs at a time');
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /already running/);
    const bench = fulfilled[0].value;
    assert.ok(bench.computeMs > 0 && bench.wallMs >= bench.computeMs);
    assert.ok(bench.minteractionsPerSec > 1 && Number.isFinite(bench.gflops) && Number.isFinite(bench.checksum));
    assert.equal(bench.interactions, bench.bodies * bench.bodies * bench.steps);
    assert.ok(snaps().length - beforeBench >= 1, 'the scene stream keeps running during the benchmark');
    const clamped = await wm.invoke(win, 'bench:nbody', { bodies: 1, steps: 1 });
    assert.equal(clamped.bodies, 64, 'bodies is clamped to 64..4096');
    const heavy = await wm.invoke(win, 'bench:nbody', { bodies: 1536, steps: 5 });
    ok(`CPU benchmark in the VM: ${heavy.bodies} bodies x ${heavy.steps} steps = ${heavy.minteractionsPerSec.toFixed(0)} M interactions/s (${heavy.gflops.toFixed(1)} GFLOP/s); one at a time; the stream continues`);
  } else if (phase === '2') {
    // ---- a second run: a fresh VM, the same /data ---------------------------------------------------------------
    const scene = await wm.invoke(win, 'scene:get');
    assert.equal(scene.name, 'Seeded', 'the app starts with the preset that was saved last');
    assert.equal(scene.builtin, false);
    assert.equal(scene.orbit.seed, 42);
    assert.equal(scene.orbit.n, 6);
    assert.equal(scene.params.G, 2.5);
    assert.equal(scene.params.swirl, -1.2);
    assert.equal(scene.params.hue, 0.9);
    const first = await waitSnap(() => true, 'the first scene:state');
    assert.equal(first.name, 'Seeded');
    assert.equal(first.a.length, 6);
    assert.equal(first.params.G, 2.5);
    const list = await wm.invoke(win, 'preset:list');
    assert.deepEqual(list.presets.map((p) => p.name), [...BUILTIN, 'Test Preset', 'Seeded']);
    assert.equal(list.current, 'Seeded');
    ok('second run: the app opens with the saved preset "Seeded" (6 attractors, seed 42, G 2.5), both saved presets are listed');

    const expected = JSON.parse(fs.readFileSync(carry, 'utf8'));
    const replay = await wm.invoke(win, 'scene:replay', expected.ticks);
    assert.equal(replay.hash, expected.hash, 'a fresh VM reproduces the first run\'s state at the same tick');
    ok(`determinism across runs: replay at tick ${expected.ticks} gives hash ${replay.hash}, the same as in the first run's VM`);

    const tp = await wm.invoke(win, 'preset:load', 'Test Preset');
    assert.equal(tp.orbit.seed, 5);
    assert.equal(tp.params.G, 2.5);
    assert.equal(onDisk().last, 'Test Preset');

    // deleting the preset that is loaded falls back to the first built-in one
    const after = await wm.invoke(win, 'preset:delete', 'Test Preset');
    assert.equal(after.name, 'Orbit');
    assert.deepEqual(onDisk().presets.map((p) => p.name), ['Seeded']);
    assert.equal(onDisk().last, 'Orbit');
    const gone = await wm.invoke(win, 'preset:delete', 'Seeded');
    assert.equal(gone.name, 'Orbit');
    assert.deepEqual(onDisk().presets, []);
    ok('delete: the saved presets are removed from /data/presets.json; deleting the loaded one falls back to "Orbit"');

    // leave a corrupt file behind for the third run
    fs.writeFileSync(dataFile, '{ this is not json');
  } else if (phase === '3') {
    // ---- a corrupt presets.json is ignored ----------------------------------------------------------------------
    assert.equal(fs.readFileSync(dataFile, 'utf8'), '{ this is not json', 'the corrupt file is still there when the core starts');
    const scene = await wm.invoke(win, 'scene:get');
    assert.equal(scene.name, 'Orbit');
    const list = await wm.invoke(win, 'preset:list');
    assert.deepEqual(list.presets.map((p) => p.name), BUILTIN);
    await waitSnap((x) => x.name === 'Orbit', 'the stream runs');
    ok('third run: a corrupt presets.json is ignored, the app starts with the built-in presets');

    await wm.invoke(win, 'preset:save', 'After corruption');
    assert.equal(onDisk().version, 1);
    assert.deepEqual(onDisk().presets.map((p) => p.name), ['After corruption']);
    await wm.invoke(win, 'preset:delete', 'After corruption');
    assert.deepEqual(onDisk().presets, []);
    ok('the next save repairs the file (valid JSON again)');
  } else {
    throw new Error(`unknown GPU_DEMO_PHASE ${phase}`);
  }

  wm.userClose(win);
}
