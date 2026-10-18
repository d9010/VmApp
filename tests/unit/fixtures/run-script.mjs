// Script for `vmapp run <id> --headless --script run-script.mjs`
import assert from 'node:assert/strict';

export default async function ({ session, wm }) {
  await wm.waitForWindows(1, 5000);
  const r = await wm.invoke(1, 'echo', 'from-script', 42);
  assert.deepEqual(r, ['from-script', 42]);
  const hello = await wm.waitForEmit('hello', { timeoutMs: 5000 });
  assert.equal(hello[0].name, 'Notes');
  console.log('SCRIPT-OK ' + session.appId);
}
