'use strict';
// tools/check-invariants: the automated part of contribution review (docs/REVIEWING.md steps 2-4).
// Static checks of the mechanical invariants in GOVERNANCE.md. Node built-ins only.
//
//   tools/check-invariants [--json] [--diff <git-range>] [--rule <id|INV-xx>]... [--root <dir>] [--list]
//
// Exit: 0 no violation (warnings allowed), 1 at least one FAIL, 2 internal error.

const path = require('path');
const { Tree, fail, warn } = require('./lib/tree');

const MODULES = ['renderer', 'bridge', 'hostcode', 'native', 'network', 'gpu'];

function allRules() {
  const rules = [];
  for (const m of MODULES) rules.push(...require(`./rules/${m}`).rules);
  return rules;
}

function statusOf(findings) {
  if (findings.some((f) => f.level === 'fail')) return 'FAIL';
  if (findings.some((f) => f.level === 'warn')) return 'WARN';
  return 'PASS';
}

/** Runs the static rules over a tree. */
function runRules(root, only) {
  const tree = new Tree(root);
  const results = [];
  for (const r of allRules()) {
    if (only && only.length && !only.some((o) => o === r.id || o.toUpperCase() === r.inv)) continue;
    try {
      const findings = r.run(tree);
      results.push({ id: r.id, inv: r.inv, name: r.name, status: statusOf(findings), findings });
    } catch (e) {
      results.push({ id: r.id, inv: r.inv, name: r.name, status: 'ERROR', findings: [], error: e && e.stack ? e.stack : String(e) });
    }
  }
  return results;
}

/** The diff-mode rules: G4, G1/G2 hints, red flags. */
function diffRules(d) {
  const rules = [];
  const g4 = d.outside.map((p) => fail(p, null, 'changed path is outside vmapp/ (changes stay inside this repository; nothing outside it may be modified)'));
  rules.push({ id: 'g4-stay-inside', inv: 'INV-G4', name: 'no changed paths outside this repository (vmapp/)', status: statusOf(g4), findings: g4 });

  const behaviour = d.files.filter((f) => f.protected && !f.invariants.includes('REVIEW') && f.rel !== 'SPEC.md' && f.rel !== 'GOVERNANCE.md');
  const g1 = [];
  if (behaviour.length && !d.specChanged) {
    g1.push(warn(null, null, `protected code changed (${behaviour.slice(0, 6).map((f) => f.rel).join(', ')}${behaviour.length > 6 ? ', ...' : ''}) but SPEC.md did not: confirm no observable behaviour changed`));
  }
  rules.push({ id: 'g1-spec-sync', inv: 'INV-G1', name: 'observable behaviour change comes with a SPEC.md change', status: statusOf(g1), findings: g1 });
  const g2 = [];
  if (behaviour.length && !d.testsTouched) {
    g2.push(warn(null, null, 'protected paths changed but no test file was added or changed: the denied path must stay covered (INV-G2)'));
  }
  rules.push({ id: 'g2-denied-path-tests', inv: 'INV-G2', name: 'protected-path change keeps/adds a denied-path test', status: statusOf(g2), findings: g2 });

  const rf = d.redFlags.map((h) => ({ level: 'warn', file: h.file, line: h.line, message: `[${h.category}] ${h.what}${h.invs && h.invs.length ? ` (${h.invs.join(', ')})` : ''}`, text: h.text }));
  rules.push({ id: 'red-flags', inv: 'REVIEWING-4', name: 'red-flag scan of added lines (each hit needs a verified justification)', status: statusOf(rf), findings: rf });
  return rules;
}

function formatText(report) {
  const L = [];
  L.push(`D9010 VmApp invariant check  (root ${report.root})`);
  for (const r of report.rules) {
    L.push(`${r.status.padEnd(5)} ${r.inv.padEnd(11)} ${r.name}  [${r.id}]`);
    if (r.status === 'PASS') continue;
    if (r.status === 'ERROR') {
      L.push(`      internal error: ${String(r.error).split('\n').slice(0, 6).join('\n      ')}`);
      continue;
    }
    for (const f of r.findings) {
      const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '(tree)';
      L.push(`      ${f.level === 'fail' ? 'FAIL' : 'warn'} ${loc}  ${f.message}`);
      if (f.text) L.push(`           > ${f.text}`);
    }
  }
  if (report.diff) {
    const d = report.diff;
    L.push('');
    L.push(`DIFF ${d.range}: ${d.files.length} file(s) changed, ${d.protectedCount} protected  ->  CLASS ${d.class}`);
    for (const f of d.files) {
      const tag = f.protected ? `PROTECTED ${f.invariants.join(',')}` : f.inside ? 'class B' : 'OUTSIDE vmapp/';
      const shown = f.inside && f.rel ? f.rel : f.path;
      L.push(`  ${f.status}  ${f.from ? f.from + ' -> ' : ''}${shown}   [${tag}]`);
    }
    L.push(`  added ${d.addedLines} line(s), removed ${d.removedLines}; red flags: ${d.redFlags.length ? d.redFlags.length : 'none'}`);
  }
  const s = report.summary;
  L.push('');
  L.push(`${report.rules.length} rules: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail${s.error ? `, ${s.error} error` : ''}${report.diff ? `; CLASS ${report.diff.class}` : ''}`);
  L.push(report.exit === 0 ? 'OK' : report.exit === 1 ? 'VIOLATIONS FOUND (exit 1)' : 'INTERNAL ERROR (exit 2)');
  return L.join('\n') + '\n';
}

/** @returns {{exit:number, rules:object[], summary:object, diff?:object, root:string}} */
function run(opts = {}) {
  const root = path.resolve(opts.root || path.join(__dirname, '..', '..'));
  const rules = runRules(root, opts.rules);
  let diff;
  if (opts.diff) {
    diff = require('./diff').analyse(root, opts.diff);
    rules.push(...diffRules(diff));
  }
  const count = (s) => rules.filter((r) => r.status === s).length;
  const summary = { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), error: count('ERROR') };
  const exit = summary.error ? 2 : summary.fail ? 1 : 0;
  return { tool: 'check-invariants', root, ok: exit === 0, exit, summary, rules, ...(diff ? { diff } : {}) };
}

const USAGE = `usage: tools/check-invariants [--json] [--diff <git-range>] [--rule <id|INV-xx>]... [--root <dir>] [--list]
  --json         machine-readable report (for the AI reviewer)
  --diff <range> also classify the changed files (Class A/B), check INV-G4 and scan ADDED lines for red flags
  --rule <x>     run only the rule with this id or invariant (repeatable)
  --list         list the rules
exit: 0 = no violation, 1 = violation, 2 = internal error`;

function main(argv, out = process.stdout, err = process.stderr) {
  const opts = { rules: [] };
  let json = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--json') json = true;
    else if (a === '--list') list = true;
    else if (a === '--diff') opts.diff = val();
    else if (a.startsWith('--diff=')) opts.diff = a.slice(7);
    else if (a === '--root') opts.root = val();
    else if (a === '--rule') opts.rules.push(val());
    else if (a === '-h' || a === '--help') {
      out.write(USAGE + '\n');
      return 0;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (list) {
    for (const r of allRules()) out.write(`${r.inv.padEnd(11)} ${r.id.padEnd(22)} ${r.name}\n`);
    return 0;
  }
  const report = run(opts);
  out.write(json ? JSON.stringify(report, null, 2) + '\n' : formatText(report));
  return report.exit;
}

module.exports = { run, main, allRules, runRules, formatText, USAGE };
