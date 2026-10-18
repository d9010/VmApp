'use strict';
// Renderer: talks to the main process only through window.api (see preload.js).

const $ = (id) => document.getElementById(id);

// ---- a tiny Markdown converter -----------------------------------------------------------------------------
// Supports: # headings, paragraphs, **bold**, *italic*, `code`, fenced code blocks, > quotes, - / * lists,
// 1. lists, --- rules and [text](http(s) url). The source is HTML-escaped first, so the output is safe.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul' | 'ol', items: [] }
  let quote = [];

  const flushPara = () => { if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>` + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + `</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => { if (quote.length) out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>'); quote = []; };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) { // fenced code block
      flushAll();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushAll();
      out.push(`<h${m[1].length}>` + inline(m[2]) + `</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      quote.push(m[1]);
    } else if ((m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line))) {
      flushPara(); flushQuote();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(m[2]);
    } else if (line.trim() === '') {
      flushAll();
    } else {
      flushList(); flushQuote();
      para.push(line.trim());
    }
  }
  flushAll();
  return out.join('\n');
}

// ---- UI ----------------------------------------------------------------------------------------------------

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text;
  el.className = isError ? 'error' : '';
}

async function refreshRecent() {
  const list = await window.api.recent();
  const ul = $('recent');
  ul.textContent = '';
  for (const entry of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = entry.name;
    btn.title = entry.path;
    btn.addEventListener('click', () => openFlow(entry.path));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

// Opens `filePath`, or shows the native open dialog when it is undefined.
async function openFlow(filePath) {
  try {
    const file = await window.api.openFile(filePath);
    if (!file) return; // dialog cancelled
    $('content').innerHTML = renderMarkdown(file.content);
    document.title = file.name + ' - Markdown Viewer';
    setStatus(file.path, false);
    await window.api.addRecent({ path: file.path, name: file.name });
    await refreshRecent();
  } catch (err) {
    setStatus('Could not open the file: ' + (err && err.message ? err.message : err), true);
  }
}

// Links in a rendered document must not navigate the app window.
$('content').addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('a')) e.preventDefault();
});

$('open').addEventListener('click', () => openFlow());
window.api.onMenuOpen(() => openFlow()); // File > Open… (Cmd/Ctrl+O)
refreshRecent().catch((err) => setStatus('Could not read the recent list: ' + err.message, true));
