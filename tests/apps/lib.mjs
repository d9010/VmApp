// Shared helpers for the headless app tests (tests/apps/*.mjs). Used by scripts run with `vmapp run --headless --script`.
import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; returns that value. Throws with `what` on timeout. */
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Waits for a file to exist on the host (delivery of write-only shares is asynchronous) and returns its path. */
export function waitForFile(file, timeoutMs = 15000) {
  return waitFor(() => fs.existsSync(file) && file, { timeoutMs, what: `file ${file}` });
}

/** All argument lists the core emitted on `channel` to window `win`, in order. */
export function emitted(wm, win, channel) {
  return wm.windows.get(win).received.filter((r) => r.channel === channel).map((r) => r.args);
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`environment variable ${name} is not set (tests/apps/run-all.sh sets it)`);
  return v;
}

let checks = 0;
/** Logs a passed check so the transcript shows what was verified. */
export function ok(message) {
  checks++;
  console.log(`  ok ${checks}: ${message}`);
}
