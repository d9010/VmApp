'use strict';
// Helpers for the server-rendered pages (lib/pages.js). Everything that comes from the registry (names, descriptions,
// publisher fields, ids, versions, permission text) is attacker-controlled, so the only way to put a value into markup
// here is to have it escaped: the `html` template tag escapes every interpolated value unless it is marked `raw` (which
// only the results of `html` itself are).
//
//   html`<a href="${href}">${name}</a>`      -> both values escaped (quote every attribute with "")
//   jsonLd(obj)                              -> JSON for a <script type="application/ld+json"> that cannot be broken out of
//   httpsUrl(s)                              -> the normalised URL if it is a plain https: URL, else null (the only kind that may become a link)

class Raw {
  constructor(s) {
    this.s = s;
  }

  toString() {
    return this.s;
  }
}

/** Marks markup that is already safe. Only for the output of `html` and for fixed strings in this code base. */
const raw = (s) => new Raw(String(s));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// C0 controls other than tab, newline and carriage return are not allowed in HTML at all (a NUL would become U+FFFD)
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// the two characters that end a line in JavaScript (U+2028, U+2029) are built, not typed, so that no editor or tool
// can turn them into a real line break inside this file
const LD_UNSAFE = new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

/** Escapes a value for use as text or as a double- or single-quoted attribute value. */
function esc(v) {
  return String(v).replace(CONTROLS, '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function part(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

/** Template tag: static text is trusted, every interpolated value is escaped (arrays are joined; `html` results and `raw` pass). */
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

/**
 * JSON for the body of <script type="application/ld+json">. JSON.stringify, then `<`, `>`, `&` and the two JS line
 * separators are written as \u escapes: the result is still the same JSON value, but it can contain neither "</script>"
 * nor "<!--", whatever the strings in it say.
 */
function jsonLd(obj) {
  return JSON.stringify(obj).replace(LD_UNSAFE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** One line of at most `max` characters (code points), for <meta description> and previews: whitespace collapsed, "..." when cut. */
function snippet(s, max) {
  const t = String(s).replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  const cps = [...t];
  return cps.length > max ? cps.slice(0, max - 1).join('').trimEnd() + '…' : t;
}

/** The normalised URL if `s` is an https: URL without credentials; else null. Nothing else may become a link. */
function httpsUrl(s) {
  if (typeof s !== 'string') return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.href;
}

module.exports = { Raw, raw, esc, html, jsonLd, snippet, httpsUrl };
