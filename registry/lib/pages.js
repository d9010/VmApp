'use strict';
// The server-rendered pages: the home page (the app list), each app's page, /sitemap.xml and /robots.txt.
//
// Search engines and link previews read the HTML they are given and do not run page scripts, so these pages arrive
// complete. The chrome (header, intro, footer, script tags) stays in public/index.html and public/app.html, which carry
// placeholders (<!--@head-->, <!--@browse-->, <!--@stats-->, <!--@app-->); this module fills them. The scripts home.js and
// app.js take over from the server-rendered content: search, sorting and "Show more" on the home page.
//
// Nothing here adds a claim. What is shown comes from lib/present.js (the same records the JSON API serves), the publisher
// only as the display rule allows (README, "The display rule"), and every value is escaped (lib/html.js). Absolute URLs
// (canonical, og:url, JSON-LD urls, the sitemap) are built from the configured public URL only, never from the request,
// and are left out when none is configured.

const present = require('./present');
const versions = require('./versions');
const { queryApps } = require('./listing');
const { html, raw, jsonLd, snippet, httpsUrl } = require('./html');

const SITE_NAME = 'D9010 VmApp Registry';
const HOME_DESCRIPTION = 'Browse, search and download .vmapp apps. Every app runs in its own virtual machine, and the D9010 VmApp Launcher asks before an app touches your folders.';
const PAGE_SIZE = 20; // the same as PAGE in public/home.js, so that JavaScript continues where the server stopped
const SORT_TABS = [['popular', 'Popular'], ['new', 'New'], ['updated', 'Updated']];
const SITEMAP_MAX_URLS = 50000; // the sitemap protocol's limit for one file
// The manifest has no category, so the page says the most general one. If it ever gets one, read it here.
const APP_CATEGORY = 'UtilitiesApplication';

const FOLDER_VERBS = { read: 'read the files in', readwrite: 'read and change files in', writeonly: 'save new files into' }; // public/common.js: R.accessWords
const HOST_WORDS = { // public/common.js: R.hostWords
  screen: 'See your screen',
  input: 'Control your mouse and keyboard',
  'tool:*': 'Run tools from your own catalog',
  'mcp:*': 'Use MCP servers from your own catalog',
  gpu: "Run work on your Mac's GPU, through a sandboxed helper",
};

// The same formats as public/common.js (R.fmtBytes, R.fmtDate, R.plural): the two renderings must read alike
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The scheme and host of the configured public URL ("https://api.example.com"), or null: unset or not an http(s) URL. */
function originOf(publicUrl) {
  if (!publicUrl) return null;
  try {
    const u = new URL(publicUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The URL of a home page variant, relative: "/", "/?sort=new&q=notes&page=2". */
function homeHref({ sort, q, page }) {
  const p = new URLSearchParams();
  if (sort !== 'popular') p.set('sort', sort);
  if (q) p.set('q', q);
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `/?${qs}` : '/';
}

/** What the query string of "/" asks for, made safe: an unknown sort is "popular", a bad page is 1, q is trimmed and cut at 100. */
function homeParams(sp) {
  const s = sp.get('sort');
  const sort = SORT_TABS.some(([k]) => k === s) ? s : 'popular';
  const q = [...(sp.get('q') || '').trim()].slice(0, 100).join('').trim();
  const p = sp.get('page');
  const page = p && /^\d{1,6}$/.test(p) ? Math.max(1, Number(p)) : 1;
  return { sort, q, page };
}

const appHref = (id) => `/apps/${encodeURIComponent(id)}`;
const downloadHref = (id, version) => `/api/apps/${encodeURIComponent(id)}/${encodeURIComponent(version)}/download`;

/** A small badge for a publisher view {level, label}: public/common.js R.pubBadge. */
function pubBadge(pub) {
  const level = pub.level === 'domain' || pub.level === 'email' ? pub.level : 'unverified';
  const mark = level === 'domain' ? '✓ ' : level === 'email' ? '✉ ' : '';
  return html`<span class="pubbadge level-${level}">${mark + pub.label}</span>`;
}

/** One entry of the app list: public/home.js item(). */
function listEntry(a) {
  return html`<li>
<div class="title"><a href="${appHref(a.id)}">${a.name}</a><span class="ver">${'v' + a.latestVersion}</span></div>
<p class="meta">${pubBadge(a.publisher)}<span>${a.id}</span></p>
${a.description ? html`<p>${a.description}</p>` : ''}
<p class="meta"><span>${plural(a.downloads, 'download', 'downloads')}</span><span>${fmtBytes(a.sizeBytes)}</span><span>${a.runtime}</span><span>${'updated ' + fmtDate(a.updatedAt)}</span></p>
<p class="meta"><span>${'Asks for: ' + a.permissionsSummary}</span></p>
</li>`;
}

// ---------------------------------------------------------------------------------------------- the app page

function permissionsCard(p) {
  const items = [];
  for (const f of p.folders) {
    items.push(html`<li><strong>${'A folder called "' + f.name + '"'}</strong><span class="badge">${f.access}</span><span class="why">${'Lets the app ' + (FOLDER_VERBS[f.access] || f.access) + ' a folder you choose. Why: ' + (f.purpose || 'no reason given')}</span></li>`);
  }
  if (p.dialogs) {
    items.push(html`<li><strong>File open and save dialogs</strong><span class="why">Lets the app ask you to pick a file or a place to save one. It only sees what you pick.</span></li>`);
  }
  if (p.external) {
    items.push(html`<li><strong>Open web links in your browser</strong><span class="why">You are shown each address and confirm before it opens.</span></li>`);
  }
  for (const d of p.devices || []) {
    items.push(html`<li><strong>${'Your ' + d.device}</strong><span class="badge">listens</span><span class="why">${'Lets the app’s window hear your ' + d.device + ' while it runs, only if you allow it in the D9010 VmApp Launcher (the default is no). Why: ' + (d.purpose || 'no reason given')}</span></li>`);
  }
  // SPEC 8.2, INV-H6: control of the computer is labelled as such
  for (const h of p.host || []) {
    items.push(html`<li><strong>${HOST_WORDS[h.cap] || h.cap}</strong>${h.control ? html`<span class="badge danger">requests control of your computer</span>` : ''}<span class="why">${'Only if you allow it in the D9010 VmApp Launcher (the default is no). Why: ' + (h.purpose || 'no reason given')}</span></li>`);
  }
  // SPEC 8.3: the internet addresses it asks to reach; nothing is allowed by default
  for (const n of p.network || []) {
    const ports = (n.ports || [443]).map((x) => (x === 80 ? '80 (not encrypted)' : String(x))).join(', ');
    const what = n.wildcard ? `any address under ${n.host.slice(2)} (many servers)` : n.host;
    items.push(html`<li><strong>${'The internet: ' + n.host}</strong><span class="badge">${'port ' + ports}</span>${n.wildcard ? html`<span class="badge danger">wildcard</span>` : ''}${n.insecure ? html`<span class="badge danger">not encrypted</span>` : ''}<span class="why">${'Lets the app connect to ' + what + ', only if you allow it in the D9010 VmApp Launcher (the default is no). Why: ' + (n.purpose || 'no reason given')}</span></li>`);
  }
  const nothing = !p.folders.length && !p.dialogs && !p.external && !(p.devices || []).length && !(p.host || []).length && !(p.network || []).length;
  if (nothing) items.push(html`<li>Nothing. This app asks for no folders and no dialogs.</li>`);
  const warning = (p.network || []).length && p.folders.some((f) => f.access !== 'writeonly')
    ? html`<p class="warnbox">This app asks to read folders and to reach internet addresses, so it could send what it reads to those addresses if you allow both. The D9010 VmApp Launcher warns you again before you do.</p>`
    : '';
  return html`<section class="card perms" aria-labelledby="perm-h">
<h2 id="perm-h">This app will ask for:</h2>
<ul>${items}</ul>
${warning}
<p class="muted">You approve each folder, each internet address and each device in the D9010 VmApp Launcher, and can say no to any of them. Until you allow it, the app cannot reach anything but its own private data.</p>
</section>`;
}

/** Only verified facts (the display rule); a website is a link only if it is an https: URL, else plain text. */
function publisherBlock(pub) {
  let extra = '';
  if (pub.level === 'domain') {
    const link = pub.url ? httpsUrl(pub.url) : null;
    extra = html`${pub.company ? html` <strong>${pub.company}</strong>` : ''}${pub.url ? (link ? html` <a href="${link}" rel="noopener noreferrer nofollow">${pub.url}</a>` : html` <span>${pub.url}</span>`) : ''}`;
  } else if (pub.level === 'unverified') {
    extra = html` <span class="muted">Nobody has confirmed who made this app.</span>`;
  }
  return html`<p class="publisher">${pubBadge(pub)}${extra}</p>`;
}

function detailsList(a) {
  const rows = [
    ['App id', a.id, true],
    ['Package id', a.packageId, true],
    ['Runtime', a.runtime],
    ['Size', fmtBytes(a.sizeBytes)],
    ['Contents', `${plural(a.manifest.files.count, 'file', 'files')} (UI ${fmtBytes(a.manifest.files.uiBytes)}, core ${fmtBytes(a.manifest.files.coreBytes)})`],
    ['Recommended size', `${a.manifest.core.memoryMiB} MiB, ${plural(a.manifest.core.cpus, 'CPU', 'CPUs')} (you choose the real size in the D9010 VmApp Launcher)`],
    ['Downloads', `${a.downloads} (${a.downloads30d} in the last 30 days)`],
    ['First published', fmtDate(a.createdAt)],
    ['Last updated', fmtDate(a.updatedAt)],
  ];
  return html`<dl class="facts">${rows.map((r) => html`<dt>${r[0]}</dt><dd${r[2] ? raw(' class="mono"') : ''}>${r[1]}</dd>`)}</dl>`;
}

function versionsList(a) {
  return html`<ul class="versions">${a.versions.map((v) => html`<li>
<span class="v">${v.version}</span>
<span class="grow"><span class="meta">${fmtDate(v.publishedAt) + ' · ' + fmtBytes(v.size) + ' · ' + plural(v.downloads, 'download', 'downloads')}</span><br><span class="meta mono">${'sha256 ' + v.sha256.slice(0, 16) + '...'}</span>${v.withdrawn ? html`<br><span class="withdrawn">${'Withdrawn: ' + v.withdrawn.reason}</span>` : ''}</span>
<a class="button secondary" href="${downloadHref(a.id, v.version)}" rel="nofollow">Download</a>
</li>`)}</ul>`;
}

/** The content of #app: public/app.js render(). `a` is present.details(). */
function appContent(a) {
  return html`<h1>${a.name}<span class="muted">${'  v' + a.latestVersion}</span></h1>
${publisherBlock(a.publisher)}
${a.description ? html`<p>${a.description}</p>` : ''}
<p><a class="button" href="${downloadHref(a.id, a.latestVersion)}" rel="nofollow">${'Download v' + a.latestVersion + ' (' + fmtBytes(a.sizeBytes) + ')'}</a></p>
${permissionsCard(a.permissions)}
<section class="card">
<h2>How to install</h2>
<p>Download the file, then choose Install... in the D9010 VmApp Launcher and open it. The Loader shows the permissions above before anything is installed. Or, from a terminal:</p>
<pre class="cmd">${'vmapp get ' + a.id + ' --install'}</pre>
</section>
<section>
<h2>Details</h2>
${detailsList(a)}
</section>
<section>
<h2>Versions</h2>
<div class="card">
<p>Version numbers tell you how big a change is. A new major version (1.x to 2.0, or a new minor version while the app is still 0.x) is a breaking change; anything else should be safe to take.</p>
<p>After you install an app, the D9010 VmApp Launcher lets you choose how it updates: "Stay on this version" (never changes), "Latest compatible" (newer versions that are not breaking changes) or "Always latest". You can go back to an older version yourself at any time. If the app asks for new access, the Loader always asks you first.</p>
<p class="muted">A withdrawn version was pulled by its publisher, with the reason shown below. It is never offered as an update, but you can still download it by its exact version.</p>
</div>
${versionsList(a)}
</section>`;
}

// ---------------------------------------------------------------------------------------------- the module

/**
 * @param {{db: object, publicUrl?: string, stats: () => {apps: number, versions: number, downloads: number}, shells: {home: string, app: string}}} o
 *   `shells` are the texts of public/index.html and public/app.html with their placeholders
 */
function createPages({ db, publicUrl, stats, shells }) {
  const origin = originOf(publicUrl);
  const abs = (p) => (origin ? origin + p : null);

  const SLOTS = { home: ['head', 'browse', 'stats'], app: ['head', 'app'] };
  for (const [name, slots] of Object.entries(SLOTS)) {
    for (const s of slots) {
      if (typeof shells[name] !== 'string' || !shells[name].includes(`<!--@${s}-->`)) throw new Error(`the ${name} page shell must contain <!--@${s}-->`);
    }
  }
  /** Fills the placeholders of a shell in one pass (a value is never searched for placeholders itself). */
  const fill = (name, values) => shells[name].replace(/<!--@([a-z]+)-->/g, (m, k) => (SLOTS[name].includes(k) ? String(values[k]) : m));

  /** The <head> tags every page carries; `canonical` is absolute or null, `ld` a JSON-LD object or null. */
  function headTags({ title, description, canonical, robots, ld }) {
    return [
      html`<title>${title}</title>`,
      html`<meta name="description" content="${description}">`,
      robots && html`<meta name="robots" content="${robots}">`,
      canonical && html`<link rel="canonical" href="${canonical}">`,
      html`<meta property="og:site_name" content="${SITE_NAME}">`,
      html`<meta property="og:type" content="website">`,
      html`<meta property="og:title" content="${title}">`,
      html`<meta property="og:description" content="${description}">`,
      canonical && html`<meta property="og:url" content="${canonical}">`,
      html`<meta name="twitter:card" content="summary">`,
      html`<meta name="twitter:title" content="${title}">`,
      html`<meta name="twitter:description" content="${description}">`,
      // a data block, not a script: the page's CSP (script-src 'self') neither needs nor gets 'unsafe-inline' for it
      ld && raw(`<script type="application/ld+json">${jsonLd(ld)}</script>`),
    ].filter(Boolean).map(String).join('\n');
  }

  const footerStats = () => {
    const s = stats();
    return `${plural(s.apps, 'app', 'apps')}, ${plural(s.versions, 'version', 'versions')}, ${plural(s.downloads, 'download', 'downloads')}`;
  };

  // ---- GET / ----
  /** @param {URLSearchParams} sp */
  function home(sp) {
    const { sort, q, page } = homeParams(sp);
    const offset = (page - 1) * PAGE_SIZE;
    const { total, items } = queryApps(db, { sort, q: q.toLowerCase(), limit: PAGE_SIZE, offset });
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const outOfRange = page > lastPage;
    // only the plain list, in its default order, is for the index; searches, other orders and empty pages are not
    // (all of them still link to the apps, so a crawler loses nothing)
    const indexable = !q && sort === 'popular' && !outOfRange;

    let status;
    if (outOfRange) status = 'There are no apps on this page.';
    else if (total === 0) status = q ? `No apps match "${q}".` : 'No apps yet. Be the first to publish one.';
    else status = plural(total, 'app', 'apps') + (q ? ` match "${q}"` : '');

    const tabs = SORT_TABS.map(([k, label]) => html`<a href="${homeHref({ sort: k, q, page: 1 })}" data-sort="${k}" aria-current="${k === sort ? 'page' : 'false'}">${label}</a>`);
    const pager = lastPage > 1 || outOfRange
      ? html`<nav id="pager" class="pager" aria-label="Pages">${page > 1 ? html`<a rel="prev" href="${homeHref({ sort, q, page: Math.min(page - 1, lastPage) })}">&larr; Previous</a>` : ''}<span class="muted">${`Page ${Math.min(page, lastPage)} of ${lastPage}`}</span>${page < lastPage ? html`<a rel="next" href="${homeHref({ sort, q, page: page + 1 })}">Next &rarr;</a>` : ''}</nav>`
      : '';
    const browse = html`<form id="search" class="search" role="search" action="/" method="get" autocomplete="off">
<label class="sr" for="q">Search apps</label>
<input type="search" id="q" name="q" value="${q}" placeholder="Search by name, id or verified publisher" maxlength="100">
${sort !== 'popular' ? html`<input type="hidden" name="sort" value="${sort}">` : ''}
<button type="submit">Search</button>
</form>
<nav class="tabs" aria-label="Sort apps">${tabs}</nav>
<p id="status" class="muted" role="status" aria-live="polite">${status}</p>
<ul id="list" class="applist" data-total="${total}" data-offset="${offset}">${items.map(listEntry)}</ul>
${pager}
<p><button type="button" id="more" class="secondary" hidden>Show more</button></p>`;

    let title = `${SITE_NAME} - apps that run in their own sandbox`;
    if (q) title = `Search results for "${snippet(q, 60)}" - ${SITE_NAME}`;
    else if (page > 1) title = `Apps, page ${page} - ${SITE_NAME}`;
    const description = q ? snippet(`Apps on the ${SITE_NAME} that match "${q}".`, 200) : HOME_DESCRIPTION;
    const canonical = indexable ? abs(homeHref({ sort, q, page })) : null;
    const isStartPage = indexable && page === 1;
    const ld = isStartPage && origin
      ? {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        url: abs('/'),
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: abs('/?q={search_term_string}') },
          'query-input': 'required name=search_term_string',
        },
      }
      : null;
    const head = headTags({ title, description, canonical, robots: indexable ? null : 'noindex, follow', ld });
    return { status: 200, type: 'text/html; charset=utf-8', body: fill('home', { head, browse, stats: footerStats() }), cache: 'public' };
  }

  // ---- GET /apps/<id> ----
  function app(id) {
    const rec = db.getApp(id); // a hidden app is not found: the page says no more than the API does
    if (!rec) {
      const head = headTags({ title: `App not found - ${SITE_NAME}`, description: 'There is no app with this id on the D9010 VmApp Registry.', canonical: null, robots: 'noindex', ld: null });
      const content = html`<p id="status" class="muted" role="status" aria-live="polite">${`There is no app with the id "${id}".`}</p>
<div id="app" data-ssr="1"></div>`;
      return { status: 404, type: 'text/html; charset=utf-8', body: fill('app', { head, app: content }), cache: 'none' };
    }
    const a = present.details(db, rec);
    const available = versions.newestAvailable(rec) !== null; // every version withdrawn: the page answers, but is not for the index
    const shown = a.versions.find((v) => v.version === a.latestVersion);
    const description = snippet(a.description, 200)
      || `Download ${a.name} v${a.latestVersion} from the ${SITE_NAME}. It runs in its own sandbox; the page lists the permissions it asks for.`;
    const title = `${a.name} - ${SITE_NAME}`;
    const canonical = available ? abs(appHref(a.id)) : null;

    let ld = null;
    if (available) {
      ld = {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: a.name,
        softwareVersion: a.latestVersion,
        operatingSystem: 'macOS',
        applicationCategory: APP_CATEGORY,
        // the registry charges nothing for a download; it says nothing about the app's licence
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        datePublished: a.createdAt,
        dateModified: shown ? shown.publishedAt : a.updatedAt,
      };
      if (a.description) ld.description = snippet(a.description, 500);
      if (origin) {
        ld.url = abs(appHref(a.id));
        ld.downloadUrl = abs(downloadHref(a.id, a.latestVersion));
      }
      // only a verified domain is a publisher; an e-mail address on a domain says nothing about who made the app
      if (a.publisher.level === 'domain') {
        ld.publisher = { '@type': 'Organization', name: a.publisher.company || a.publisher.domain };
        const site = a.publisher.url ? httpsUrl(a.publisher.url) : null;
        if (site) ld.publisher.url = site;
      }
    }
    const head = headTags({ title, description, canonical, robots: available ? null : 'noindex, follow', ld });
    const content = html`<p id="status" class="muted" role="status" aria-live="polite"></p>
<div id="app" data-ssr="1">${appContent(a)}</div>`;
    return { status: 200, type: 'text/html; charset=utf-8', body: fill('app', { head, app: content }), cache: 'public' };
  }

  // ---- /sitemap.xml and /robots.txt ----
  /** The apps that belong in the sitemap: visible, with a version that is not withdrawn; `at` is that version's publish time (ms). */
  function indexedApps() {
    const out = [];
    for (const rec of db.apps()) {
      const v = versions.newestAvailable(rec);
      if (v !== null) out.push({ id: rec.id, at: rec.versions[v].publishedAt });
    }
    return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  const lastmod = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  function sitemap() {
    if (!origin) {
      // a sitemap holds absolute URLs; the host is not guessed from the request
      return { status: 404, type: 'text/plain; charset=utf-8', body: 'No sitemap: the registry does not know its public address (REGISTRY_PUBLIC_URL).\n', cache: 'none' };
    }
    const apps = indexedApps().slice(0, SITEMAP_MAX_URLS - 1);
    const newest = apps.reduce((m, x) => Math.max(m, x.at), 0);
    const url = (loc, at) => html`<url><loc>${loc}</loc>${at ? html`<lastmod>${lastmod(at)}</lastmod>` : ''}</url>`;
    const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      [url(abs('/'), newest), ...apps.map((x) => url(abs(appHref(x.id)), x.at))].join('\n') + '\n</urlset>\n';
    return { status: 200, type: 'application/xml; charset=utf-8', body, cache: 'public' };
  }

  function robots() {
    const lines = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /publish',
      'Disallow: /publisher',
      'Disallow: /verify',
    ];
    if (origin) lines.push('', `Sitemap: ${abs('/sitemap.xml')}`);
    return { status: 200, type: 'text/plain; charset=utf-8', body: lines.join('\n') + '\n', cache: 'public' };
  }

  return { home, app, sitemap, robots };
}

module.exports = { createPages, PAGE_SIZE };
