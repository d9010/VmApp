'use strict';
// Lexical helpers shared by the rules. No real parsers: each scanner returns two same-length copies of the source:
//   code  comments blanked, string contents kept   (to read literals)
//   skel  comments blanked, string/regex contents blanked (quotes kept)   (to match structure: brackets, commas,
//         keywords, calls, without being fooled by text inside strings or comments)
// Newlines are always preserved, so an index maps to the same line in all three texts.

function blk(arr, a, b) {
  for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' ';
}

const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);

/** JavaScript (also fine for JSON and for the JS-like parts of .mjs). */
function scanJs(src) {
  const n = src.length;
  const code = src.split('');
  const skel = src.split('');
  const both = (a, b) => {
    blk(code, a, b);
    blk(skel, a, b);
  };

  function template(i) {
    // src[i] === '`'; returns the index after the closing backtick
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') {
        j = region(j + 2, true) + 1;
        continue;
      }
      j++;
    }
    return n;
  }

  function region(i, inInterp) {
    let depth = 0;
    let last = ''; // last significant token class: a punctuation char, or 'w' for a word/number/value
    let lastWord = '';
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        both(i, j);
        i = j;
        continue;
      }
      if (c === '/' && d === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        both(i, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') {
          if (src[j] === '\\') j++;
          j++;
        }
        j = Math.min(j + 1, n);
        blk(skel, i + 1, j - 1);
        last = 'w';
        lastWord = '';
        i = j;
        continue;
      }
      if (c === '`') {
        const j = template(i);
        blk(skel, i + 1, j - 1);
        last = 'w';
        lastWord = '';
        i = j;
        continue;
      }
      if (c === '/') {
        const regexOk = last === '' || '(,=:[!&|?{};+-*%<>~^}'.includes(last) || (last === 'w' && REGEX_PREV_WORDS.has(lastWord));
        if (regexOk) {
          let j = i + 1;
          let inClass = false;
          let ok = false;
          while (j < n && src[j] !== '\n') {
            const e = src[j];
            if (e === '\\') {
              j += 2;
              continue;
            }
            if (e === '[') inClass = true;
            else if (e === ']') inClass = false;
            else if (e === '/' && !inClass) {
              ok = true;
              break;
            }
            j++;
          }
          if (ok) {
            blk(skel, i + 1, j);
            j++;
            while (j < n && /[a-z]/i.test(src[j])) j++;
            last = 'w';
            lastWord = '';
            i = j;
            continue;
          }
        }
      }
      if (inInterp) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) return i;
          depth--;
        }
      }
      if (/[\w$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j++;
        lastWord = src.slice(i, j);
        last = 'w';
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        last = c;
        lastWord = '';
      }
      i++;
    }
    return i;
  }

  region(0, false);
  return { text: src, code: code.join(''), skel: skel.join('') };
}

/** Rust. Raw strings, nested block comments, char literals vs lifetimes. */
function scanRust(src) {
  const n = src.length;
  const code = src.split('');
  const skel = src.split('');
  const both = (a, b) => {
    blk(code, a, b);
    blk(skel, a, b);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    const prevWord = i > 0 && /[\w]/.test(src[i - 1]);
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      both(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      both(i, j);
      i = j;
      continue;
    }
    if ((c === 'r' || (c === 'b' && d === 'r')) && !prevWord) {
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 40));
      if (m) {
        const open = i + m[0].length;
        const close = '"' + m[1];
        let j = src.indexOf(close, open);
        j = j < 0 ? n : j;
        blk(skel, open, j);
        i = Math.min(n, j + close.length);
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      blk(skel, i + 1, j - 1);
      i = j;
      continue;
    }
    if (c === "'") {
      const m = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^\\'\n])'/.exec(src.slice(i, i + 16));
      if (m) {
        blk(skel, i + 1, i + m[0].length - 1);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return { text: src, code: code.join(''), skel: skel.join('') };
}

/** C / Objective-C (the VZ shim): // and block comments, "..." and '...' literals. */
function scanC(src) {
  const n = src.length;
  const code = src.split('');
  const skel = src.split('');
  const both = (a, b) => {
    blk(code, a, b);
    blk(skel, a, b);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      both(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      both(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      blk(skel, i + 1, j - 1);
      i = j;
      continue;
    }
    i++;
  }
  return { text: src, code: code.join(''), skel: skel.join('') };
}

const OPEN = '([{';
const CLOSE = ')]}';

/** Index of the bracket matching the opener at `i` in `skel`, or -1. */
function matchBracket(skel, i) {
  const stack = [];
  for (let k = i; k < skel.length; k++) {
    const c = skel[k];
    if (OPEN.includes(c)) stack.push(c);
    else if (CLOSE.includes(c)) {
      stack.pop();
      if (stack.length === 0) return k;
    }
  }
  return -1;
}

/** Splits skel[a, b) at top-level commas: [{start, end}] (end exclusive), trimming whitespace. */
function splitTop(skel, a, b) {
  const out = [];
  let depth = 0;
  let s = a;
  const push = (e) => {
    let x = s;
    let y = e;
    while (x < y && /\s/.test(skel[x])) x++;
    while (y > x && /\s/.test(skel[y - 1])) y--;
    if (y > x) out.push({ start: x, end: y });
  };
  for (let k = a; k < b; k++) {
    const c = skel[k];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      push(k);
      s = k + 1;
    }
  }
  push(b);
  return out;
}

/**
 * Finds calls whose head matches `re` (which must end with the opening paren, flags g are added).
 * Matches are searched in `scan.skel`, so text in comments and strings never counts.
 * Returns [{index, open, close, args:[{start,end,text}]}].
 */
function findCalls(scan, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out = [];
  let m;
  while ((m = g.exec(scan.skel))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(scan.skel, open);
    if (close < 0) continue;
    const args = splitTop(scan.skel, open + 1, close).map((r) => ({ ...r, text: scan.code.slice(r.start, r.end) }));
    out.push({ index: m.index, head: m[0], open, close, args });
  }
  return out;
}

/** Parses the object literal that starts at `skel[open] === '{'`. Props: {key, value, valueStart, valueEnd, spread, computed, index}. */
function parseObject(scan, open) {
  const close = matchBracket(scan.skel, open);
  if (close < 0 || scan.skel[open] !== '{') return null;
  const props = [];
  for (const seg of splitTop(scan.skel, open + 1, close)) {
    const text = scan.code.slice(seg.start, seg.end);
    if (text.startsWith('...')) {
      props.push({ spread: true, index: seg.start, value: text.slice(3) });
      continue;
    }
    if (text.startsWith('[')) {
      props.push({ computed: true, index: seg.start, value: text });
      continue;
    }
    let m = /^(?:async\s+|get\s+|set\s+|\*\s*)?(['"])([^'"]*)\1\s*(:|\()?/.exec(text);
    let key;
    let sep;
    let consumed;
    if (m) {
      key = m[2];
      sep = m[3];
      consumed = m[0].length;
    } else {
      m = /^(?:async\s+|get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*(:|\()?/.exec(text);
      if (!m) {
        props.push({ computed: true, index: seg.start, value: text });
        continue;
      }
      key = m[1];
      sep = m[2];
      consumed = m[0].length;
    }
    if (sep === ':') {
      const vs = skipWs(scan.code, seg.start + consumed);
      props.push({ key, index: seg.start, valueStart: vs, valueEnd: seg.end, value: text.slice(consumed).trim() });
    } else if (sep === '(') {
      props.push({ key, index: seg.start, method: true, valueStart: seg.start + consumed - 1, valueEnd: seg.end, value: text.slice(consumed - 1) });
    } else {
      props.push({ key, index: seg.start, shorthand: true, valueStart: seg.start, valueEnd: seg.end, value: key });
    }
  }
  return { open, close, props };
}

/** Index of the first non-space character at or after `i` in text. */
function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Evaluates an expression made only of string literals joined with +; null if it is anything else. */
function evalStringExpr(expr) {
  const parts = [];
  const re = /\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*(\+|$)/y;
  let i = 0;
  const s = expr.trim();
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    parts.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    i = re.lastIndex;
    if (m[4] === '') break;
  }
  return parts.length ? parts.join('') : null;
}

/** Blanks every item guarded by #[cfg(test)] / #[test] in a scanned Rust file (both code and skel). */
function stripRustTests(scan) {
  const code = scan.code.split('');
  const skel = scan.skel.split('');
  const re = /#\[\s*(?:cfg\s*\(\s*test\s*\)|test)\s*\]/g;
  let m;
  while ((m = re.exec(scan.skel))) {
    let k = m.index + m[0].length;
    for (;;) {
      k = skipWs(scan.skel, k);
      if (scan.skel.startsWith('#[', k)) {
        const e = matchBracket(scan.skel, k + 1);
        if (e < 0) break;
        k = e + 1;
      } else break;
    }
    let end = -1;
    for (let q = k; q < scan.skel.length; q++) {
      const c = scan.skel[q];
      if (c === ';') {
        end = q + 1;
        break;
      }
      if (c === '{') {
        const e = matchBracket(scan.skel, q);
        end = e < 0 ? scan.skel.length : e + 1;
        break;
      }
    }
    if (end < 0) continue;
    blk(code, m.index, end);
    blk(skel, m.index, end);
    re.lastIndex = end;
  }
  return { text: scan.text, code: code.join(''), skel: skel.join('') };
}

/** Maps an index in a text to a 1-based line number. */
function makeLiner(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The source line (trimmed, cut to 200 chars) that contains idx. */
function lineText(text, idx) {
  const a = text.lastIndexOf('\n', idx - 1) + 1;
  let b = text.indexOf('\n', idx);
  if (b < 0) b = text.length;
  return text.slice(a, b).trim().slice(0, 200);
}

module.exports = {
  scanJs,
  scanRust,
  scanC,
  matchBracket,
  splitTop,
  findCalls,
  parseObject,
  skipWs,
  evalStringExpr,
  stripRustTests,
  makeLiner,
  lineText,
};
