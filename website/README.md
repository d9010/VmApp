# The D9010 VmApp website

A static site: plain HTML and CSS, no framework, no script, no cookies. A few hand-written pages explain the platform to people who are
not technical, and the repository's own Markdown documents are rendered as HTML pages (sidebar, "On this page", previous and next).
It has **no server** and **no download buttons for apps** (apps are installed from the launcher, so the permission sheet always comes first).

```
website/
  site.json          name, site URL, repository URL, navigation
  build.js           the generator
  publish.js         build, scan, deploy to Cloudflare Pages, verify (see Publishing)
  package.json       one dependency, marked (renders the Markdown); pinned, with a lock file
  src/layout.html    header and footer
  src/pages/*.html   hand-written pages: a few "key: value" lines, "---", then the HTML of the page
  src/docs.json      which Markdown documents become pages, their order, titles and one-line summaries
  src/apps.json      the sample-app list on /apps
  src/assets/        style.css (hashed at build time), logo.svg, favicon.svg
  src/_headers       Cloudflare Pages headers: a strict Content-Security-Policy, caching
  dist/              the output (git-ignored)
```

## Build and preview

```sh
cd website && npm ci                  # once: installs the one dependency, from the lock file
node build.js                         # builds dist/, checks every link, refuses script and inline style
node build.js --serve 8080            # builds, then serves dist/ on http://127.0.0.1:8080 with the real headers
node build.js --production            # as the first, but any warning (a link to a file not in the repository) is an error
```

## How the Markdown becomes pages

- `src/docs.json` lists the documents. A document not listed there is not on the site (add it there to publish it).
- A link from one document to another becomes a link to its page, and its label (the file name in the repository) becomes the page's title.
- A link to any other file or folder of the repository goes to GitHub. A link to something that is not in the repository, or that
  `NOT_PUBLIC` in `build.js` lists (what the public export leaves out), is shown as plain text and reported as a warning.
- Heading anchors follow GitHub's rule, so links written for GitHub still land on the right section.
- The page's "Edit this page on GitHub" link points at the Markdown file. Edit that file, not the HTML.

## Publishing (Cloudflare Pages, free)

```sh
npx wrangler login --scopes account:read user:read pages:write    # once; opens the browser, no key is typed or pasted anywhere
npm run deploy                                                    # rebuild from the Markdown, deploy, verify
```

`npm run deploy` (`node publish.js`) does, in order, and stops at the first failure:

1. Checks Node 22 or newer, `node_modules/marked`, and `cloudflareProject` in `site.json`.
2. Builds with `node build.js --production`.
3. Scans `dist/` for local paths and internal wording (`/Volumes/`, `/Users/`, `red-team`, `red team`; the list is at the top of `publish.js`), and for any
   private words you list in `website/.leak-markers` (one per line; that file is git-ignored on purpose).
4. Checks the Wrangler login (skipped when `CLOUDFLARE_API_TOKEN` is set), creates the Pages project if it does not exist yet (the first run only),
   then runs `wrangler pages deploy dist` on the pinned Wrangler version.
5. Verifies the live site against `dist/`: every page in `sitemap.xml`, `robots.txt`, `sitemap.xml` and the assets must return 200 with the same
   SHA-256 as the built file; an unknown path must return 404; the home page must carry a Content-Security-Policy and `nosniff`. It retries for
   about a minute while the deployment propagates. The address checked is the one Wrangler prints; `--live` uses `siteUrl` from `site.json`, `--url URL` any address.

```sh
npm run deploy:dry-run                       # build and scan, print the commands, call nothing (no Wrangler, no network)
node publish.js --verify-only --live         # build and deploy nothing; compare the existing dist/ with the public site
node publish.js --no-verify                  # deploy without the verification
```

Cloudflare Pages can alternatively build from the GitHub repository on every push (Connect to Git; root directory `website`, build command
`npm ci && node build.js --production`, output directory `dist`); this script is then the manual, verified path.

For the custom domain: Pages project, Custom domains, add the host (for example `vmapp.d9010.com`). If the domain's DNS is not on Cloudflare,
add the CNAME record Cloudflare shows at the DNS provider. Set `siteUrl` in `site.json` to the same address and rebuild: it feeds the
canonical links and `sitemap.xml`.

## Editing the hand-written pages

- Wording: edit the page in `src/pages/`. Tokens: `{{repo}}`, `{{name}}`, `{{site}}`. Link to a document with `/docs/<slug>`.
- The apps page is built from `src/apps.json`. Keep each "asks for" list equal to the app's `vmapp.json` permissions.
- Colors and spacing are tokens at the top of `src/assets/style.css`: silver and green on white, corners 2 px at most, no shadows.
- Do not add inline `<script>` or `style=` attributes: the Content-Security-Policy in `src/_headers` blocks them, and `build.js` fails on them.
