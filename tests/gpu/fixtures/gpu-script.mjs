// Script for `vmapp run dev.vmapp.gpu-test --headless --script gpu-script.mjs` (tests/gpu/vm-rpc.test.js): asks the app in the VM what
// its environment says and to talk RPC to the GPU server, and prints one line "RESULT {json}".
//   GPU_TEST_REVOKE=1   after the first probe, take the GPU grant away (as the sheet or the CLI would) and probe until it fails
export default async function ({ session, wm, store }) {
  await wm.waitForWindows(1, 30000);
  const out = {};
  out.env = await wm.invoke(1, 'env');
  out.first = await wm.invoke(1, 'probe', 300);
  if (process.env.GPU_TEST_REVOKE === '1') {
    const t0 = Date.now();
    store.setHostGrant(session.appId, 'gpu', null);
    out.stillOk = [];
    for (let i = 0; i < 100; i++) {
      const r = await wm.invoke(1, 'probe', 0);
      if (!r.ok) {
        out.afterRevoke = r;
        break;
      }
      out.stillOk.push(Date.now() - t0);
      await new Promise((res) => setTimeout(res, 100));
    }
    out.revokedAfterMs = Date.now() - t0;
    out.running = session.state;
    out.again = await wm.invoke(1, 'probe', 0);
  }
  console.log('RESULT ' + JSON.stringify(out));
}
