'use strict';
// GOVERNANCE.md section 2, as data: protected paths (Class A) and the invariants each one carries.
// Paths are relative to vmapp/. Globs: `**` = any path, `*` = within one segment; a trailing `/` = a whole folder.
// The first matching entry wins, so specific entries come before catch-alls. If you change GOVERNANCE section 2,
// change this table in the same pull request (it is itself a protected path).

const ALL = [
  'A1', 'A2', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'D1', 'D2', 'D3', 'D4', 'D5',
  'E1', 'E2', 'E3', 'F1', 'F2', 'G1', 'G2', 'G3', 'G4', 'N1', 'N2', 'N3', 'N4', 'U1',
].map((x) => `INV-${x}`);
const inv = (...ids) => ids.map((x) => `INV-${x}`);

const PROTECTED = [
  { glob: 'SPEC.md', invs: ALL, note: 'the normative spec' },
  { glob: 'GOVERNANCE.md', invs: ALL, note: 'the invariants' },

  // loader/: not tests, not docs
  { glob: 'loader/test/**', invs: null },
  { glob: 'loader/**/*.md', invs: null },
  { glob: 'loader/preload-app.js', invs: inv('A1', 'B1', 'B2', 'B3', 'B4', 'B5'), note: 'the only API of app renderers' },
  { glob: 'loader/main.js', invs: inv('A1', 'B1', 'B2', 'B3', 'B4', 'B5'), note: 'navigation guards, IPC routing, loader windows' },
  { glob: 'loader/src/window-manager.js', invs: inv('A1', 'B1', 'B3', 'B5'), note: 'window creation, webPreferences, permission handlers' },
  { glob: 'loader/src/protocols.js', invs: inv('B3', 'B4'), note: 'vmapp-ui handler and CSP' },
  { glob: 'loader/src/runner.js', invs: inv('A1', 'B1', 'B3', 'C1'), note: 'wires sessions, partitions and windows' },
  { glob: 'loader/src/dialogs.js', invs: inv('B5', 'D3'), note: 'native dialogs and wording' },
  { glob: 'loader/src/devices.js', invs: inv('B3', 'D3'), note: 'the microphone gate: the only code that may answer true to an app window permission request' },
  { glob: 'loader/src/library.js', invs: inv('B5', 'D3'), note: 'permission sheet, install review, reset/uninstall' },
  { glob: 'loader/src/updater.js', invs: inv('A1', 'G3', 'U1'), note: "the launcher's own updates: the only code that names Electron's updater" },
  { glob: 'loader/ui/update.js', invs: inv('B5', 'U1'), note: 'the update card: it can only press buttons' },
  { glob: 'loader/ui/**', invs: inv('B5', 'D3'), note: 'loader-owned UI (permission sheet, install review)' },
  { glob: 'loader/**', invs: inv('A1', 'B1', 'B2', 'B3', 'B4', 'B5', 'D3'), note: 'loader code: assumed to contain protected parts (window creation, handlers, dialogs); package.json carries A1' },

  // hostlib/
  { glob: 'hostlib/session.js', invs: inv('A1', 'C1', 'C2', 'C3', 'D2', 'D3'), note: 'request ops, permission checks, grants, dialogs' },
  { glob: 'hostlib/bridge.js', invs: inv('A1', 'C1', 'C2', 'C3', 'D2', 'D3'), note: 'the bridge' },
  { glob: 'hostlib/capabilities.js', invs: inv('A1', 'C2', 'C3', 'H1', 'H2', 'H3', 'H4', 'H5'), note: 'host-capability broker: grants, tool arguments, input sessions, MCP' },
  { glob: 'hostlib/hostproc.js', invs: inv('A1', 'H3', 'H4', 'H7'), note: 'the only host processes besides vmapp-vm: hostctl, tools, MCP servers, the sandboxed GPU server' },
  { glob: 'hostlib/gpu.js', invs: inv('A1', 'H1', 'H2', 'H3', 'H7'), note: 'the GPU capability: the decision, the endpoint contract and the broker of the sandboxed servers' },
  { glob: 'hostlib/package.js', invs: inv('F1', 'D3') },
  { glob: 'hostlib/manifest.js', invs: inv('F1', 'D3') },
  { glob: 'hostlib/tar.js', invs: inv('F1', 'D3') },
  { glob: 'hostlib/cpio.js', invs: inv('F1', 'D3') },
  { glob: 'hostlib/store.js', invs: inv('F1', 'D3'), note: 'verification, install, grants storage' },

  { glob: 'hostlib/updates.js', invs: inv('A1', 'G3', 'U1'), note: "the one network module: registry requests and the launcher's own update check" },
  { glob: 'hostlib/network.js', invs: inv('D3', 'N2', 'N4'), note: 'network validation, rules for the launcher, grants, risk summary' },
  { glob: 'host/**', invs: inv('D1', 'D2', 'D5', 'E1', 'E2', 'E3', 'N1', 'N3', 'N4', 'H7', 'H8'), note: 'launcher: shim device config, shares, slots, parent watch, stdin ops, entitlements, the network proxy and the service tunnel, the command line (cli.rs), the experimental libkrun backend (krun.rs)' },
  { glob: 'guest/**', invs: inv('D4', 'D5', 'E2', 'N1', 'H7'), note: 'vmapp-init: mounts, extraction, privilege drop, control ops, the proxy and the service listener' },
  // the GPU capability (SPEC 8.6): the sandbox profile and the pinned llama.cpp commit are what the server may do and is; the spike is separate work
  { glob: 'gpu/venus-spike/**', invs: null },
  { glob: 'gpu/*.md', invs: null },
  { glob: 'gpu/**', invs: inv('H7', 'H8', 'A1'), note: 'the GPU server: sandbox profile, pinned llama.cpp commit and its build; the experimental Vulkan backend (gpu/krun): the VMM sandbox profile, pinned host libraries and patches' },
  { glob: 'kernel/**', invs: inv('D1', 'D4', 'F2'), note: "the guest's kernel: no network device or drivers, no namespaces or modules, pinned and reproducible build" },
  { glob: 'runtimes/**', invs: inv('F2') },
  { glob: 'tools/mkruntime', invs: inv('F2') },
  { glob: 'tools/mkerofs.Dockerfile', invs: inv('F2') },

  // the review system itself
  { glob: 'tools/check-invariants', invs: ['REVIEW'], note: 'the review system itself' },
  { glob: 'tools/check-invariants.d/**', invs: ['REVIEW'], note: 'the review system itself (rule modules)' },
  { glob: 'tests/invariants/**', invs: ['REVIEW'], note: 'tests of the review system' },
  { glob: 'docs/REVIEWING.md', invs: ['REVIEW'], note: 'the review system itself' },
];

function globToRegex(glob) {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      s += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') s += '[^/]*';
    else s += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}
const COMPILED = PROTECTED.map((e) => ({ ...e, re: globToRegex(e.glob) }));

/** @param {string} rel path relative to vmapp/ (posix) -> {protected, invs, glob, note} */
function classify(rel) {
  for (const e of COMPILED) {
    if (e.re.test(rel)) {
      if (e.invs === null) return { protected: false, invs: [], glob: e.glob, note: null };
      return { protected: true, invs: e.invs, glob: e.glob, note: e.note || null };
    }
  }
  return { protected: false, invs: [], glob: null, note: null };
}

module.exports = { PROTECTED, classify, globToRegex, ALL };
