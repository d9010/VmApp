#!/usr/bin/env node
'use strict';
// Builds the static website: src/ + the repository's Markdown documents -> dist/.
//
//   node website/build.js                build into website/dist
//   node website/build.js --serve [PORT] build, then serve dist/ on 127.0.0.1 (default 8080) with the real headers
//   node website/build.js --production   build, and fail on any problem (a placeholder in site.json counts)
//
// Hand-written pages: src/pages/<slug>.html, a few `key: value` lines (title, description), a line with `---`, then the HTML.
//   Tokens replaced in them: {{site}} {{repo}} {{name}} {{company}} {{companyUrl}} {{year}}
//   `<!--APPS-->` on the apps page becomes the app list built from src/apps.json.
// Documentation pages: every file listed in src/docs.json is rendered from the repository's Markdown (the one dependency, marked,
// does that). Links between documents are rewritten to the site's own pages; a link to any other file of the repository goes to
// GitHub; a link to something that is not in the repository is left as plain text and reported.
// The output has no script and no inline style, which is what the Content-Security-Policy in src/_headers allows.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Marked } = require('marked');

const ROOT = __dirname;
const REPO = path.resolve(ROOT, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.json'), 'utf8'));
const docsConfig = JSON.parse(fs.readFileSync(path.join(SRC, 'docs.json'), 'utf8'));
const args = process.argv.slice(2);
const production = args.includes('--production');
const serveAt = args.indexOf('--serve');
const repoUrl = site.repoUrl.replace(/\/$/, '');
const warnings = [];

// Paths that exist in this checkout but that the public export leaves out: a link to one is shown as plain text, not as a dead link.
// (The marker at the end of the line is what tools/export-github removes; the list is simply empty in the public copy.)
const NOT_PUBLIC = [
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function tokens(text) {
  return text
    .replace(/\{\{site\}\}/g, site.siteUrl)
    .replace(/\{\{repo\}\}/g, repoUrl)
    .replace(/\{\{name\}\}/g, site.name)
    .replace(/\{\{company\}\}/g, site.company)
    .replace(/\{\{companyUrl\}\}/g, site.companyUrl)
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
}

// ---- the documents -------------------------------------------------------------------------------------------------------

const docEntries = docsConfig.sections.flatMap((s) => s.items.map((i) => ({ ...i, section: s.title })));
const docByRepoPath = new Map(docEntries.map((d) => [d.src, d]));
const docUrl = (d) => `/docs/${d.slug}`;

// GitHub's rule for heading anchors, so that links written for GitHub keep working: lower case, drop punctuation, spaces to hyphens.
const slugify = (t) => t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

// Returns {url, doc} (doc is set when the target is one of the rendered documents), or null for a link to something that is not in the repository.
function resolveHref(href, srcPath) {
  if (/^(https?:|mailto:)/i.test(href) || href.startsWith('#')) return { url: href, doc: null };
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(srcPath), hashAt >= 0 ? href.slice(0, hashAt) : href)).replace(/\/$/, '');
  if (docByRepoPath.has(rel)) return { url: docUrl(docByRepoPath.get(rel)) + hash, doc: docByRepoPath.get(rel) };
  const excluded = NOT_PUBLIC.some((p) => rel === p || rel.startsWith(`${p}/`));
  const onDisk = path.join(REPO, rel);
  if (excluded || rel.startsWith('..') || !fs.existsSync(onDisk)) {
    warnings.push(`${srcPath}: "${href}" is not in the repository; shown as plain text`);
    return null;
  }
  return { url: `${repoUrl}/${fs.statSync(onDisk).isDirectory() ? 'tree' : 'blob'}/${site.branch}/${rel}${hash}`, doc: null };
}

// In the repository a link to another document is labelled with its file name; on the site it reads as the document's title.
const FILE_NAME = /(?:\.\.\/|\.\/)*(?:[\w-]+\/)*[\w-]+\.md/g;
function docLabel(html, doc) {
  const plain = html.replace(/<\/?code>/g, '');
  const out = plain.replace(FILE_NAME, doc.title);
  return out === plain ? html : out;
}

function renderDoc(entry) {
  const raw = fs.readFileSync(path.join(REPO, entry.src), 'utf8');
  const toc = [];
  const seen = new Map();
  let h1 = null;
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens: inline, depth }) {
        const html = this.parser.parseInline(inline);
        const text = decode(html.replace(/<[^>]+>/g, ''));
        if (depth === 1 && h1 === null) { h1 = text; return ''; }
        const base = slugify(text);
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (depth === 2 || depth === 3) toc.push({ depth, id, text });
        return `<h${depth} id="${id}">${html}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      link({ href, title, tokens: inline }) {
        const html = this.parser.parseInline(inline);
        const target = resolveHref(href, entry.src);
        if (target === null) return html;
        const t = title ? ` title="${esc(title)}"` : '';
        return `<a href="${esc(target.url)}"${t}>${target.doc ? docLabel(html, target.doc) : html}</a>`;
      },
    },
  });
  const body = marked.parse(raw).replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, '</table></div>');
  return { body, toc, h1: h1 || entry.title };
}

function sidebar(activeSlug) {
  return docsConfig.sections
    .map((s) => {
      const links = s.items.map((i) => `<a href="${docUrl(i)}"${i.slug === activeSlug ? ' aria-current="page"' : ''}>${esc(i.title)}</a>`).join('\n');
      return `<h4>${esc(s.title)}</h4>\n${links}`;
    })
    .join('\n');
}

function docsShell({ crumb, article, toc, editPath, prev, next, activeSlug }) {
  const tocHtml = toc.length
    ? `<h4>On this page</h4>\n${toc.map((t) => `<a class="d${t.depth}" href="#${t.id}">${esc(t.text)}</a>`).join('\n')}\n`
    : '';
  const edit = editPath ? `<a class="edit" href="${repoUrl}/edit/${site.branch}/${editPath}">Edit this page on GitHub</a>` : '';
  const pn = prev || next
    ? `<div class="pn">${prev ? `<a href="${docUrl(prev)}">&larr; ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a href="${docUrl(next)}">${esc(next.title)} &rarr;</a>` : '<span></span>'}</div>`
    : '';
  return `<div class="docs">
<details class="docs-menu"><summary>Documentation menu</summary><nav aria-label="Documentation">${sidebar(activeSlug)}</nav></details>
<aside class="side"><nav aria-label="Documentation">
${sidebar(activeSlug)}
</nav></aside>
<article>
<div class="crumb">${crumb}</div>
${article}
${pn}
</article>
<nav class="toc" aria-label="On this page">
${tocHtml}${edit}
</nav>
</div>`;
}

function docsIndex() {
  const sections = docsConfig.sections
    .map((s) => `<h2>${esc(s.title)}</h2>\n<dl class="doclist">\n${s.items.map((i) => `<dt><a href="${docUrl(i)}">${esc(i.title)}</a></dt><dd>${esc(i.summary)}</dd>`).join('\n')}\n</dl>`)
    .join('\n');
  return `<h1>Documentation</h1>
<p class="lead">Everything about D9010 VmApp: how to use it, how it works, and how to build for it. New here? Start with <a href="/docs/start-here">Start here</a>, or read <a href="/how-it-works">How it works</a> in plain words.</p>
${sections}`;
}

// ---- pages -------------------------------------------------------------------------------------------------------------------

function parsePage(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const cut = raw.indexOf('\n---\n');
  if (cut < 0) throw new Error(`${file}: no "---" line after the page's header`);
  const meta = {};
  for (const line of raw.slice(0, cut).split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  if (!meta.title || !meta.description) throw new Error(`${file}: needs title and description`);
  return { meta, body: raw.slice(cut + 5) };
}

function appCards() {
  const apps = JSON.parse(fs.readFileSync(path.join(SRC, 'apps.json'), 'utf8'));
  return apps
    .map((a) => `<article class="card">
  <h3>${esc(a.name)}</h3>
  <p class="meta">${esc(a.language)} &middot; <span class="id">${esc(a.id)}</span></p>
  <p>${esc(a.summary)}</p>
  <p class="label">It asks for</p>
  <ul>${a.asks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</article>`)
    .join('\n');
}

// ---- the latest release ------------------------------------------------------------------------------------------------------
// src/release.json is written by `node publish.js --release` (website/release.js) when a release is made: version, tag, commit, date,
// the zip's address, size and SHA-256, and the changes. The download page, the home page's button and the update feed
// (dist/updates/mac-arm64/latest.json, which the launcher asks, SPEC 8.10) are all made from it. With no release yet there is no feed
// and the download page says so.
const releaseFile = path.join(SRC, 'release.json');
const release = fs.existsSync(releaseFile) ? JSON.parse(fs.readFileSync(releaseFile, 'utf8')) : null;

const megabytes = (n) => `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`;
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** The home page's main button: only once there is something to download. */
function downloadButton() {
  return release ? '<a class="btn primary" href="/download">Download for Mac</a>' : '';
}

/** The body of the download page. */
function downloadSection() {
  if (!release) {
    return `<div class="note"><p><strong>The first release is being prepared.</strong> Until it is out, you can read how it works, browse the documentation, or build it from the <a href="${repoUrl}">source</a>.</p></div>`;
  }
  const r = release;
  const commitUrl = `${repoUrl}/commit/${r.commit}`;
  return `<section class="release" aria-label="Latest version">
  <p class="kicker">Latest version</p>
  <h2>D9010 VmApp ${esc(r.version)} for macOS</h2>
  <p>Released ${esc(longDate(r.date))}. ${esc(megabytes(r.size))}. Needs macOS ${esc(r.minimumOS)} or later, on a Mac with Apple silicon.</p>
  <p><a class="btn primary" href="${esc(r.url)}">Download for Mac</a><a class="btn ghost" href="${esc(r.releaseUrl)}">Release notes on GitHub</a></p>
  <div class="tablewrap">
  <table>
    <tbody>
      <tr><th>Version</th><td>${esc(r.version)}</td></tr>
      <tr><th>Built from</th><td>tag <a href="${repoUrl}/tree/${esc(r.tag)}"><code>${esc(r.tag)}</code></a>, commit <a href="${esc(commitUrl)}"><code>${esc(r.commit.slice(0, 7))}</code></a></td></tr>
      <tr><th>File</th><td><code>${esc(r.file)}</code></td></tr>
      <tr><th>SHA-256</th><td><code class="hash">${esc(r.sha256)}</code></td></tr>
    </tbody>
  </table>
  </div>
</section>

<h2>What's new in ${esc(r.version)}</h2>
<ul>
${r.changes.map((c) => `  <li>${esc(c)}</li>`).join('\n')}
</ul>
<p><a href="/docs/changelog">Read the full changelog</a>, which lists every version.</p>

<h2>Install</h2>
<ol class="steps">
  <li><strong>Download the zip.</strong>Use the button above. It is the same file that is attached to the GitHub release.</li>
  <li><strong>Check it (optional).</strong>In the folder with the download, run <code>shasum -a 256 ${esc(r.file)}</code>. The answer must be the SHA-256 shown above.</li>
  <li><strong>Move it into Applications.</strong>Unzip it, drag <code>D9010VmAppLauncher.app</code> into <code>/Applications</code> and open it. The first time, macOS asks you to confirm that you downloaded it from the internet: choose <em>Open</em>.</li>
  <li><strong>Try an app.</strong>Click <em>Load examples</em>, tick the sample apps you want and choose <em>Install selected</em>. Installing allows nothing: each app asks for what it needs the first time you launch it.</li>
</ol>

<h2>Updates</h2>
<p>Once installed, the launcher tells you when a newer version is available: a card appears at the top of its window with what changed, and you choose <em>Update now</em>, <em>Later</em> or <em>Skip this version</em>. Nothing is downloaded or restarted without your click. The check asks one address on this site for a small file and sends nothing about you: no identifier, no list of your apps, not even the version you run. You can turn it off in Host Capabilities, and ask yourself any time with <em>Check for Updates…</em> in the launcher's menu.</p>
<p>Older versions stay on the <a href="${repoUrl}/releases">releases page</a>. The source of this version is the tag above.</p>`;
}

/** The update feed, from the release record; throws if the launcher itself would refuse it. */
function updateFeed() {
  const feed = require('./release').feedFrom(release, site.siteUrl);
  // the launcher's own validation: a feed it would reject must never be published
  require('../hostlib/updates').cleanLauncherFeed(feed);
  return feed;
}

// Cloudflare's "Email Address Obfuscation" (on by default for a domain) rewrites anything that looks like an address, such as the
// example `you@example.com` in the docs, and injects a script that our Content-Security-Policy blocks. Writing the @ as an entity
// shows and copies exactly the same, and gives the rewriter nothing to find. Version numbers like `tool@4.1.0` do not match.
const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const hideEmails = (html) => html.replace(EMAIL, '$1&#64;$2');

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(DIST, 'docs'), { recursive: true });

  // The stylesheet gets a content hash in its name, so it can be cached for a year and still update at once.
  const css = fs.readFileSync(path.join(SRC, 'assets', 'style.css'));
  const cssName = `style.${crypto.createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`;
  fs.writeFileSync(path.join(DIST, 'assets', cssName), css);
  for (const f of ['favicon.svg', 'logo.svg']) fs.copyFileSync(path.join(SRC, 'assets', f), path.join(DIST, 'assets', f));

  const layout = fs.readFileSync(path.join(SRC, 'layout.html'), 'utf8');
  const urls = [];

  function emit(file, url, { title, description, content, mainClass = '' }) {
    const nav = site.nav
      .map(([label, href]) => {
        const on = href === url || (href === '/docs/' && url.startsWith('/docs/'));
        return `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
      })
      .join('\n      ');
    const html = tokens(layout)
      .replace(/\{\{title\}\}/g, () => esc(url === '/' ? `${site.name}: ${site.tagline}` : `${title} | ${site.name}`))
      .replace(/\{\{description\}\}/g, () => esc(tokens(description)))
      .replace(/\{\{canonical\}\}/g, `${site.siteUrl}${url}`)
      .replace(/\{\{css\}\}/g, `/assets/${cssName}`)
      .replace(/\{\{nav\}\}/g, () => nav)
      .replace(/\{\{mainClass\}\}/g, mainClass)
      .replace(/\{\{content\}\}/g, () => hideEmails(content));
    fs.mkdirSync(path.dirname(path.join(DIST, file)), { recursive: true });
    fs.writeFileSync(path.join(DIST, file), html);
    if (file !== '404.html') urls.push(url);
  }

  const pagesDir = path.join(SRC, 'pages');
  for (const f of fs.readdirSync(pagesDir).filter((n) => n.endsWith('.html')).sort()) {
    const slug = f.replace(/\.html$/, '');
    const { meta, body } = parsePage(path.join(pagesDir, f));
    emit(slug === 'index' ? 'index.html' : `${slug}.html`, slug === 'index' ? '/' : `/${slug}`, {
      title: meta.title,
      description: meta.description,
      content: tokens(body).replace('<!--APPS-->', appCards()).replace('<!--DOWNLOAD-->', downloadSection()).replace('<!--DOWNLOAD-BUTTON-->', downloadButton()),
    });
  }

  emit('docs/index.html', '/docs/', {
    title: 'Documentation',
    description: 'Every D9010 VmApp document: how to use it, how it works, and how to build apps for it.',
    mainClass: 'is-docs',
    content: docsShell({ crumb: '<span>Docs</span>', article: docsIndex(), toc: [], editPath: '', prev: null, next: null, activeSlug: '' }),
  });

  docEntries.forEach((entry, i) => {
    const { body, toc, h1 } = renderDoc(entry);
    const article = `<h1>${esc(h1)}</h1>\n${body}`;
    emit(`docs/${entry.slug}.html`, docUrl(entry), {
      title: entry.title,
      description: entry.summary,
      mainClass: 'is-docs',
      content: docsShell({
        crumb: `<a href="/docs/">Docs</a> &rsaquo; <span>${esc(entry.section)}</span> &rsaquo; <span>${esc(entry.title)}</span>`,
        article,
        toc,
        editPath: entry.src,
        prev: docEntries[i - 1] || null,
        next: docEntries[i + 1] || null,
        activeSlug: entry.slug,
      }),
    });
  });

  const list = urls.map((u) => `  <url><loc>${site.siteUrl}${u}</loc></url>`).join('\n');
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${list}\n</urlset>\n`);
  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.siteUrl}/sitemap.xml\n`);
  fs.writeFileSync(path.join(DIST, '_headers'), fs.readFileSync(path.join(SRC, '_headers'), 'utf8').replace('{{css}}', cssName));
  if (release) {
    fs.mkdirSync(path.join(DIST, 'updates', 'mac-arm64'), { recursive: true });
    fs.writeFileSync(path.join(DIST, 'updates', 'mac-arm64', 'latest.json'), `${JSON.stringify(updateFeed(), null, 2)}\n`);
  }
  return urls;
}

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? htmlFiles(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : []));
}

// Every internal link and asset must exist, and no page may carry a script or inline style (the CSP would block them).
function check() {
  const problems = [];
  const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
  const exists = (href) => {
    const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
    if (clean === '/') return true;
    const rel = clean.replace(/^\//, '').replace(/\/$/, '');
    return [rel, `${rel}.html`, path.join(rel, 'index.html')].some((c) => isFile(path.join(DIST, c)));
  };
  for (const file of htmlFiles(DIST)) {
    const name = path.relative(DIST, file);
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="(\/[^"/][^"]*)"/g)) if (!exists(m[1])) problems.push(`${name}: broken link ${m[1]}`);
    if (/<script[\s>]/i.test(html)) problems.push(`${name}: contains a script`);
    if (/\sstyle="/i.test(html) || /<style[\s>]/i.test(html)) problems.push(`${name}: contains inline style`);
    if (!name.startsWith('docs/') && /\{\{(site|repo|name|company|companyUrl|year|title|description|canonical|css|nav|mainClass|content)\}\}/.test(html)) problems.push(`${name}: an unreplaced {{token}}`);
  }
  if (/OWNER|REPLACE/.test(site.repoUrl)) problems.push(`site.json: repoUrl is still a placeholder (${site.repoUrl})`);
  if (production) problems.push(...warnings);
  return problems;
}

function serve(port) {
  const headers = {};
  for (const block of fs.readFileSync(path.join(DIST, '_headers'), 'utf8').split(/\n(?=\S)/)) {
    const [pattern, ...rest] = block.split('\n');
    if (pattern.trim() !== '/*') continue;
    for (const l of rest) {
      const i = l.indexOf(':');
      if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };
  http
    .createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(DIST, path.normalize(p));
      if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      else if (!fs.existsSync(file)) file += '.html';
      const found = fs.existsSync(file);
      if (!found) file = path.join(DIST, '404.html');
      res.writeHead(found ? 200 : 404, { ...headers, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    })
    .listen(port, '127.0.0.1', () => console.log(`serving ${DIST} on http://127.0.0.1:${port}/ (with the headers of src/_headers)`));
}

const urls = build();
const problems = check();
console.log(`built ${urls.length} pages (${docEntries.length} rendered from Markdown) into ${path.relative(process.cwd(), DIST) || DIST}`);
if (!production) for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
if (serveAt >= 0) serve(Number(args[serveAt + 1]) || 8080);
