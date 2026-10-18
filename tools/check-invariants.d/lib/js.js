'use strict';
// Small JavaScript structure helpers on top of scan.js: function ranges, local function lookup, call expansion.

const { matchBracket, splitTop, skipWs } = require('./scan');

function paramNames(paramText) {
  const names = [];
  let depth = 0;
  let cur = '';
  const flush = () => {
    const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(cur);
    names.push(m ? m[1] : '');
    cur = '';
  };
  for (const c of paramText) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) flush();
    else cur += c;
  }
  if (cur.trim()) flush();
  return names;
}

/** Parses a function expression/arrow starting in [start,end): {params, bodyStart, bodyEnd, block} or null. */
function parseFunction(sc, start, end) {
  const sk = sc.skel;
  let i = skipWs(sk, start);
  if (sk.startsWith('async', i) && /[\s(]/.test(sk[i + 5] || '')) i = skipWs(sk, i + 5);
  if (sk.startsWith('function', i)) {
    i = skipWs(sk, i + 8);
    if (sk[i] === '*') i = skipWs(sk, i + 1);
    while (/[\w$]/.test(sk[i] || '')) i++;
    i = skipWs(sk, i);
    if (sk[i] !== '(') return null;
    const close = matchBracket(sk, i);
    if (close < 0) return null;
    const params = paramNames(sc.code.slice(i + 1, close));
    const b = skipWs(sk, close + 1);
    if (sk[b] !== '{') return null;
    const e = matchBracket(sk, b);
    return { params, bodyStart: b, bodyEnd: e < 0 ? sk.length : e + 1, block: true };
  }
  let params;
  let j;
  if (sk[i] === '(') {
    const close = matchBracket(sk, i);
    if (close < 0) return null;
    params = paramNames(sc.code.slice(i + 1, close));
    j = skipWs(sk, close + 1);
  } else {
    const m = /^[A-Za-z_$][\w$]*/.exec(sk.slice(i, i + 80));
    if (!m) return null;
    params = [m[0]];
    j = skipWs(sk, i + m[0].length);
  }
  if (!sk.startsWith('=>', j)) return null;
  j = skipWs(sk, j + 2);
  if (sk[j] === '{') {
    const e = matchBracket(sk, j);
    return { params, bodyStart: j, bodyEnd: e < 0 ? sk.length : e + 1, block: true };
  }
  return { params, bodyStart: j, bodyEnd: end, block: false };
}

/** Function bodies defined with a name in this file: declarations, `const f = ...`, and class/object methods. */
function findFunctions(sc, name) {
  const out = [];
  const esc = name.replace(/[$]/g, '\\$');
  const sk = sc.skel;
  let m;
  const decl = new RegExp(`\\bfunction\\s*\\*?\\s*${esc}\\s*\\(`, 'g');
  while ((m = decl.exec(sk))) {
    const f = parseFunction(sc, m.index, sk.length);
    if (f) out.push({ ...f, index: m.index });
  }
  const assign = new RegExp(`(?:\\b(?:const|let|var)\\s+|[.\\s])${esc}\\s*=\\s*(?!=)`, 'g');
  while ((m = assign.exec(sk))) {
    const start = m.index + m[0].length;
    // the end of the expression: the next ';' at depth 0 or end of line group; parseFunction only needs an upper bound
    const f = parseFunction(sc, start, exprEnd(sk, start));
    if (f) out.push({ ...f, index: m.index });
  }
  const meth = new RegExp(`(?:^|[\\n;{}])[ \\t]*(?:static\\s+|async\\s+|get\\s+|set\\s+)*${esc}\\s*\\(`, 'g');
  while ((m = meth.exec(sk))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(sk, open);
    if (close < 0) continue;
    const b = skipWs(sk, close + 1);
    if (sk[b] !== '{') continue;
    const e = matchBracket(sk, b);
    out.push({ params: paramNames(sc.code.slice(open + 1, close)), bodyStart: b, bodyEnd: e < 0 ? sk.length : e + 1, block: true, index: m.index });
  }
  return out;
}

function exprEnd(sk, start) {
  let depth = 0;
  for (let k = start; k < sk.length; k++) {
    const c = sk[k];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return k;
      depth--;
    } else if ((c === ';' || c === ',') && depth === 0) return k;
  }
  return sk.length;
}

/** Resolves an argument (arrow/function expression, or an identifier naming a local function) to a parsed function. */
function resolveCallable(sc, arg) {
  const f = parseFunction(sc, arg.start, arg.end);
  if (f) return f;
  const t = arg.text.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const fs = findFunctions(sc, t);
    if (fs.length) return fs[0];
  }
  return null;
}

/**
 * Text of a function body plus, transitively (depth levels), the bodies of local functions or methods
 * it calls (`foo(`, `this.foo(`). Used to follow permission checks into helpers.
 */
function expandedBody(sc, fn, depth = 3, seen = new Set()) {
  let text = sc.code.slice(fn.bodyStart, fn.bodyEnd);
  if (depth <= 0) return text;
  const skText = sc.skel.slice(fn.bodyStart, fn.bodyEnd);
  const re = /(?:\bthis\.|(?<![.\w$]))([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(skText))) {
    const name = m[1];
    if (seen.has(name) || /^(if|for|while|switch|catch|function|return|typeof|await|new|super)$/.test(name)) continue;
    seen.add(name);
    for (const f of findFunctions(sc, name)) text += '\n' + expandedBody(sc, f, depth - 1, seen);
  }
  return text;
}

/** [{start,end}] of the argument list of a call-like head already matched; convenience re-export. */
module.exports = { parseFunction, findFunctions, resolveCallable, expandedBody, paramNames, splitTop };
