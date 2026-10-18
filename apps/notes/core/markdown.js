'use strict';
// A tiny Markdown -> HTML converter: headings, paragraphs, **bold**, *italic*, `code`, lists and fenced code.
// Every piece of user text is HTML-escaped before any markup is added, so the output is safe to open in a browser.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text) {
  let s = escapeHtml(text.replace(/\u0000/g, ''));
  const codes = [];
  // protect `code` spans first so their contents are not touched by bold/italic
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let code = null; // lines of a fenced block

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flushPara();
      closeList();
      code = [];
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flushPara();
      closeList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushPara();
  closeList();
  return out.join('\n');
}

function toHtmlDocument(title, markdown) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 42rem; margin: 2.5rem auto; padding: 0 1rem; color: #1d1d1f; }
code { background: #f2f2f4; padding: .1em .3em; border-radius: 4px; font-family: ui-monospace, Menlo, monospace; }
pre { background: #f2f2f4; padding: .8rem 1rem; border-radius: 8px; overflow: auto; }
pre code { background: none; padding: 0; }
</style>
</head>
<body>
${render(markdown)}
</body>
</html>
`;
}

module.exports = { render, toHtmlDocument, escapeHtml };
