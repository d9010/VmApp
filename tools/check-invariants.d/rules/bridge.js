'use strict';
// INV-C2: the request ops handled by hostlib/session.js are exactly SPEC 6's table plus the host.* ops of SPEC 8.2,
// permission-checked, with an error reply for unknown ops. The host.* ops are answered by the broker
// (hostlib/capabilities.js), where every op must call _authorize() before it does anything.

const { findCalls, parseObject, evalStringExpr, matchBracket, skipWs } = require('../lib/scan');
const { expandedBody, findFunctions } = require('../lib/js');
const { fail, warn, at } = require('../lib/tree');

const SESSION = 'hostlib/session.js';
const BRIDGE = 'hostlib/bridge.js';
const BROKER = 'hostlib/capabilities.js';

// Minimum permission requirements, independent of how the SPEC table is worded (GOVERNANCE INV-C2 / REVIEWING C2).
// The SPEC's own "Needs `permissions.x`" rows are added to this.
const BASE_PERMS = {
  'dialog.open': 'dialogs',
  'dialog.save': 'dialogs',
  'shell.openExternal': 'external',
};

/** Op rows (`| `a.b` | ... |`) of a markdown section: Map op -> required permission key or null. */
function opRows(sec, into) {
  for (const line of sec.split('\n')) {
    const m = /^\|\s*`([A-Za-z][\w]*(?:\.[\w]+)+)`\s*\|/.exec(line);
    if (!m) continue;
    const need = /Needs\s+`permissions\.(\w+)`/.exec(line);
    into.set(m[1], need ? need[1] : null);
  }
}

/** Ops (and their required permission) from SPEC 6's "Request ops" table and SPEC 8.2's "Bridge request ops" table. */
function specOps(tree) {
  if (!tree.exists('SPEC.md')) return null;
  const text = tree.read('SPEC.md');
  const i = text.search(/^###\s+Request ops/m);
  if (i < 0) return null;
  const rest = text.slice(i);
  const end = rest.slice(5).search(/^(#{1,3}\s|---\s*$)/m);
  const sec = end < 0 ? rest : rest.slice(0, end + 5);
  const ops = new Map();
  opRows(sec, ops);
  // SPEC 8.2: the host capability ops (a section "## 8.2 ..." up to the next heading)
  const j = text.search(/^##\s+8\.2\b/m);
  if (j >= 0) {
    const r2 = text.slice(j);
    const e2 = r2.slice(5).search(/^(#{1,2}\s|---\s*$)/m);
    opRows(e2 < 0 ? r2 : r2.slice(0, e2 + 5), ops);
  }
  return ops.size ? ops : null;
}

/** Case labels of a switch statement: [{label, start, end}] where start..end is the clause body. */
function switchClauses(sc, switchCall) {
  const sk = sc.skel;
  let b = skipWs(sk, switchCall.close + 1);
  if (sk[b] !== '{') return [];
  const e = matchBracket(sk, b);
  if (e < 0) return [];
  const marks = [];
  let depth = 0;
  for (let k = b + 1; k < e; k++) {
    const c = sk[k];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /[cd]/.test(c) && !/[\w$.]/.test(sk[k - 1] || ' ')) {
      let m = /^case\s+/.exec(sk.slice(k, k + 8));
      if (m) {
        // label up to the ':' that ends it (labels here are simple literals)
        let q = k + m[0].length;
        let d2 = 0;
        for (; q < e; q++) {
          const ch = sk[q];
          if ('([{'.includes(ch)) d2++;
          else if (')]}'.includes(ch)) d2--;
          else if (ch === ':' && d2 === 0) break;
        }
        marks.push({ label: sc.code.slice(k + m[0].length, q).trim(), start: q + 1, at: k });
        k = q;
      } else if (/^default\s*:/.test(sk.slice(k, k + 12))) {
        marks.push({ label: null, isDefault: true, start: sk.indexOf(':', k) + 1, at: k });
      }
    }
  }
  return marks.map((m, i) => ({ ...m, end: i + 1 < marks.length ? marks[i + 1].at : e }));
}

/**
 * Finds the op dispatch in a scanned file: a switch whose labels are spec ops, or a map keyed by spec op names.
 * Returns { sawSwitch, handled: Map op -> {idx,start,end}, defaultOk (null = no default clause) }.
 */
function findDispatch(sc, ops, file, out) {
  const handled = new Map();
  let sawSwitch = false;
  let defaultOk = null;
  for (const sw of findCalls(sc, /\bswitch\s*\(/)) {
    const clauses = switchClauses(sc, sw);
    const labels = clauses.filter((c) => c.label !== null).map((c) => evalStringExpr(c.label));
    if (labels.filter((l) => l && ops.has(l)).length < 2) continue;
    sawSwitch = true;
    for (const c of clauses) {
      if (c.isDefault) {
        const body = sc.code.slice(c.start, c.end);
        defaultOk = /\bthrow\b|\berror\b|\breply\b/.test(body) && !/\bbreak\s*;?\s*$/.test(body.trim());
        defaultOk = defaultOk && !!body.trim();
        continue;
      }
      const op = evalStringExpr(c.label);
      if (op === null) {
        out.push(at('fail', file, sc, c.at, `request switch has a non-literal case label '${c.label.slice(0, 40)}'`));
        continue;
      }
      // fallthrough labels (empty body) share the next clause's body
      let end = c.end;
      let k = clauses.indexOf(c);
      while (!sc.code.slice(clauses[k].start, clauses[k].end).trim() && k + 1 < clauses.length) {
        k++;
        end = clauses[k].end;
      }
      handled.set(op, { idx: c.at, start: c.start, end });
    }
  }

  // object/map style: { 'window.create': ..., ... }
  const re = /(?:[=(:,[]|\breturn)\s*\{/g;
  let m;
  while ((m = re.exec(sc.skel))) {
    const open = m.index + m[0].length - 1;
    const o = parseObject(sc, open);
    if (!o) continue;
    const keys = o.props.filter((p) => p.key && /\./.test(p.key));
    if (keys.filter((p) => ops.has(p.key)).length < 2) continue;
    for (const p of keys) {
      if (!handled.has(p.key)) handled.set(p.key, { idx: p.index, start: p.valueStart, end: p.valueEnd });
    }
    sawSwitch = true;
  }
  return { sawSwitch, handled, defaultOk };
}

function ruleC2(tree) {
  const out = [];
  if (!tree.exists(SESSION)) return [fail(SESSION, null, 'hostlib/session.js is missing')];
  const ops = specOps(tree);
  if (!ops) return [fail('SPEC.md', null, 'cannot extract the "Request ops" table from SPEC 6')];
  const sc = tree.scan(SESSION, 'js');
  const { sawSwitch, handled, defaultOk } = findDispatch(sc, ops, SESSION, out);

  if (!sawSwitch) return [fail(SESSION, null, 'cannot find the request-op dispatch (a switch or a map keyed by SPEC op names) in session.js')];

  for (const op of ops.keys()) if (!handled.has(op)) out.push(fail(SESSION, null, `SPEC op '${op}' (SPEC 6 / 8.2) is not handled in session.js`));
  for (const [op, h] of handled) if (!ops.has(op)) out.push(at('fail', SESSION, sc, h.idx, `op '${op}' is handled in session.js but is not in SPEC 6's or 8.2's table`));

  // unknown ops: an error reply
  if (defaultOk === null) out.push(fail(SESSION, null, 'the request switch has no default clause (unknown ops must get an error reply)'));
  else if (!defaultOk) out.push(fail(SESSION, null, 'the default clause of the request switch does not throw / return an error for unknown ops'));
  if (tree.exists(BRIDGE)) {
    const b = tree.scan(BRIDGE, 'js').code;
    if (!/t\s*:\s*['"]reply['"][^}]*error\s*:\s*\{\s*message/.test(b)) out.push(warn(BRIDGE, null, 'bridge.js: cannot see a { t: "reply", error: { message } } path for failed requests'));
  } else out.push(fail(BRIDGE, null, 'hostlib/bridge.js is missing'));

  // permission checks
  const need = new Map(Object.entries(BASE_PERMS));
  for (const [op, p] of ops) if (p) need.set(op, p);
  for (const [op, perm] of need) {
    const h = handled.get(op);
    if (!h) continue; // already reported as missing
    const fn = { bodyStart: h.start, bodyEnd: h.end };
    const body = expandedBody(sc, fn, 4);
    const re2 = new RegExp(`permissions\\s*(?:\\.\\s*${perm}\\b|\\[\\s*['"]${perm}['"]\\s*\\])`);
    const mm = re2.exec(body);
    if (!mm) {
      out.push(at('fail', SESSION, sc, h.idx, `op '${op}' has no permissions.${perm} check on its path`));
      continue;
    }
    const around = body.slice(Math.max(0, mm.index - 80), mm.index + mm[0].length + 160);
    if (!/\bthrow\b|\bdeny|\bdenied\b|\breturn\b/.test(around)) out.push(at('fail', SESSION, sc, h.idx, `op '${op}': permissions.${perm} is read but nothing denies on it`));
  }

  // the host.* ops: the broker authorizes every one of them first
  const hostOps = new Map([...ops].filter(([op]) => op.startsWith('host.')));
  if (hostOps.size) out.push(...brokerChecks(tree, hostOps));
  return out;
}

function brokerChecks(tree, hostOps) {
  const out = [];
  if (!tree.exists(BROKER)) return [fail(BROKER, null, `SPEC 8.2 ops exist but ${BROKER} (the host-capability broker) is missing`)];
  const sc = tree.scan(BROKER, 'js');
  const { sawSwitch, handled, defaultOk } = findDispatch(sc, hostOps, BROKER, out);
  if (!sawSwitch) return [...out, fail(BROKER, null, `cannot find the host.* op dispatch (a switch on SPEC 8.2's op names) in ${BROKER}`)];
  for (const op of hostOps.keys()) if (!handled.has(op)) out.push(fail(BROKER, null, `SPEC 8.2 op '${op}' is not handled in ${BROKER}`));
  for (const [op, h] of handled) if (!hostOps.has(op)) out.push(at('fail', BROKER, sc, h.idx, `op '${op}' is handled in the broker but is not in SPEC 8.2's table`));
  if (defaultOk === null) out.push(fail(BROKER, null, 'the broker dispatch has no default clause (unknown host ops must be an error)'));
  else if (!defaultOk) out.push(fail(BROKER, null, 'the default clause of the broker dispatch does not throw for unknown host ops'));
  // INV-H2: nothing happens before _authorize()
  for (const [op, h] of handled) {
    if (!hostOps.has(op)) continue;
    const body = sc.code.slice(h.start, h.end);
    const m = /\b_authorize\s*\(/.exec(body);
    if (!m) out.push(at('fail', BROKER, sc, h.idx, `host op '${op}' never calls _authorize() (manifest + grant check)`));
    else {
      // nothing that acts on the host may come before the authorization
      const before = body.slice(0, m.index);
      if (/\b(?:_ctlRequest|_inputStart|_toolRun|_mcpServer|_mcpTools|_capture|_inputRequest|startProcess)\s*\(/.test(before)) out.push(at('fail', BROKER, sc, h.idx, `host op '${op}' acts on the host before _authorize()`));
    }
  }
  // the authorization itself must read permissions.host and be able to deny
  const fns = findFunctions(sc, '_authorize');
  const gates = findFunctions(sc, '_gate');
  const authBody = [...fns, ...gates].map((f) => sc.code.slice(f.bodyStart, f.bodyEnd)).join('\n');
  if (!fns.length) out.push(fail(BROKER, null, 'the broker has no _authorize() function'));
  else if (!/permissions\s*\.\s*host\b/.test(authBody) || !/\bthrow\b/.test(authBody)) out.push(fail(BROKER, null, '_authorize()/_gate() must read the manifest\'s permissions.host and throw when it is missing'));
  else if (!/\bgrants\s*\(/.test(authBody)) out.push(fail(BROKER, null, '_authorize()/_gate() must check the user\'s grant (ctx.grants())'));
  return out;
}

module.exports = {
  rules: [{ id: 'c2-request-ops', inv: 'INV-C2', name: 'request ops == SPEC 6 + 8.2 tables; permission-checked; unknown ops get an error', run: ruleC2 }],
  specOps,
};
