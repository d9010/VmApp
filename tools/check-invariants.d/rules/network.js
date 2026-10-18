'use strict';
// INV-N1 (the only way out is the allowlist proxy: the guest opens no outbound socket) and INV-N3 (the host checks every
// address before it connects; the test switches never reach the loader). SPEC 8.3. INV-D1 (no network device) stays with
// rules/native.js.

const { prodJs, fail, at } = require('../lib/tree');

const RS = (tree, dir) => tree.list(dir, { exts: ['.rs'] });

/** Matches of `re` in the scanned text `sc[which]` as findings. */
function each(out, f, sc, re, msg, which = 'skel') {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(sc[which]))) out.push(at('fail', f, sc, m.index, typeof msg === 'function' ? msg(m) : msg));
}

// ------------------------------------------------------------------------------------------------ N1

// Port forwarding (SPEC 8.8, DEV-APPS C4): the one connect of the guest, in this file only, to the VM's own loopback on the port
// the host named. Exactly this shape: the address is the loopback constant, never a value from anywhere.
const PORTFWD = 'guest/src/portfwd.rs';
const PORTFWD_CONNECT = /let\s+target\s*=\s*SocketAddr::from\(\(\s*Ipv4Addr::LOCALHOST\s*,\s*port\s*\)\);\s*let\s+server\s*=\s*match\s+TcpStream::connect_timeout\(\s*&target\s*,\s*CONNECT_TIMEOUT\s*\)/;

function ruleN1(tree) {
  const out = [];
  for (const f of RS(tree, 'guest/src')) {
    const sc = tree.scan(f, 'rust-nontest');
    if (f === PORTFWD) {
      const n = [...sc.skel.matchAll(/\bTcpStream\s*::\s*connect\w*\s*\(/g)].length;
      if (n !== 1 || !PORTFWD_CONNECT.test(sc.code)) {
        out.push(fail(f, null, 'port forwarding may connect once, to SocketAddr::from((Ipv4Addr::LOCALHOST, port)) (the VM\'s own loopback), nothing else (INV-N1)'));
      }
    } else each(out, f, sc, /\bTcpStream\s*::\s*connect\w*\s*\(/, 'TcpStream::connect in the guest: vmapp-init never opens an outbound connection (INV-N1)');
    each(out, f, sc, /\bUdpSocket\b/, 'UdpSocket in the guest: the VM has no network, only the proxy (INV-N1)');
    each(out, f, sc, /(?<![\w$:])libc\s*::\s*(?:connect|sendto|sendmsg)\s*\(/, (m) => `libc::${m[0].replace(/libc\s*::\s*|\s*\(/g, '')} in the guest (INV-N1)`);
    // listeners: loopback and vsock only
    each(out, f, sc, /"(?:0\.0\.0\.0|\[::\])[^"]*"/, 'the guest must not listen on all interfaces (INV-N1: loopback and vsock only)', 'code');
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ N3

const DEV_SWITCHES = /dev-allow-loopback|dev-resolve|allowLoopback|allow_loopback|devNet/;

function ruleN3(tree) {
  const out = [];

  // The launcher: only host/src/net.rs connects to anything, and only after check_addresses.
  const NET = 'host/src/net.rs';
  for (const f of RS(tree, 'host/src')) {
    const sc = tree.scan(f, 'rust-nontest');
    // every listener of the launcher (the window endpoint, SPEC 8.3 "The app's windows") is on the IPv4 loopback address only
    each(out, f, sc, /\bTcpListener\s*::\s*bind\s*\((?!\s*SocketAddr::from\(\s*\(\s*Ipv4Addr::LOCALHOST\s*,)/, 'TcpListener::bind on something other than SocketAddr::from((Ipv4Addr::LOCALHOST, …)): the launcher listens on loopback only (INV-N1)');
    if (f !== NET) {
      each(out, f, sc, /\bTcpStream\s*::\s*connect\w*\s*\(|\bto_socket_addrs\b|\bUdpSocket\b/, `outbound sockets and name lookups belong in ${NET}, behind the address check (INV-N3)`);
      continue;
    }
    each(out, f, sc, /\bUdpSocket\b/, 'UdpSocket in the network proxy (INV-N1)');
    each(out, f, sc, /\bTcpStream\s*::\s*connect\s*\(/, 'TcpStream::connect without a timeout in the network proxy (use connect_timeout, after check_addresses)');
    const calls = (name) => [...sc.skel.matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\(`, 'g'))].filter((m) => !/\bfn\s+$/.test(sc.skel.slice(Math.max(0, m.index - 8), m.index)));
    const connects = calls('connect_timeout');
    const checks = calls('check_addresses');
    if (!/\bfn\s+is_forbidden_ip\b/.test(sc.skel)) out.push(fail(f, null, 'is_forbidden_ip is missing: the host must refuse non-public addresses (INV-N3)'));
    if (!/\bfn\s+check_addresses\b/.test(sc.skel)) out.push(fail(f, null, 'check_addresses is missing (INV-N3)'));
    if (!/\bis_forbidden_ip\s*\(/.test(sc.skel.replace(/\bfn\s+is_forbidden_ip\b/, ''))) out.push(fail(f, null, 'is_forbidden_ip is never called (INV-N3)'));
    for (const c of connects) {
      if (!checks.some((k) => k.index < c.index)) out.push(at('fail', f, sc, c.index, 'connect_timeout before any check_addresses call: every address must be checked first (INV-N3)'));
    }
    if (connects.length && !checks.length) out.push(fail(f, null, 'the proxy connects but never calls check_addresses (INV-N3)'));
  }

  // The test switches are not part of the loader, and in hostlib only AppSession passes them on (from its `devNet` option).
  for (const f of prodJs(tree, 'loader')) {
    const sc = tree.scan(f, 'js');
    each(out, f, sc, DEV_SWITCHES, (m) => `${m[0]} in loader/: the network test switches must never reach the loader (INV-N3)`, 'code');
  }
  for (const f of prodJs(tree, 'hostlib')) {
    if (f === 'hostlib/session.js') continue;
    const sc = tree.scan(f, 'js');
    each(out, f, sc, DEV_SWITCHES, (m) => `${m[0]} outside hostlib/session.js: the network test switches have one door (INV-N3)`, 'code');
  }
  return out;
}

module.exports = {
  rules: [
    { id: 'n1-no-guest-egress', inv: 'INV-N1', name: 'network: the guest opens no outbound socket (listens on loopback and vsock only)', run: ruleN1 },
    { id: 'n3-address-check', inv: 'INV-N3', name: 'network: the host checks addresses before every connect; test switches stay out of loader/ and hostlib/', run: ruleN3 },
  ],
};
