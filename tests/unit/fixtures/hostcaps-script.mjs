// Script for `vmapp run dev.vmapp.hostcaps --headless --script hostcaps-script.mjs`: calls the app's 'run' and prints
// the result as one line "RESULT {json}" for the test to check.
export default async function ({ wm, capUi }) {
  await wm.waitForWindows(1, 30000);
  const r = await wm.invoke(1, 'run');
  console.log('RESULT ' + JSON.stringify({ r, confirms: capUi.calls.map((c) => c.cap), badges: capUi.badges.map((b) => `${b.badge}:${b.state}`) }));
}
