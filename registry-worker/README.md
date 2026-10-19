# The registry API on Cloudflare Workers (api.vmapp.dev)

The public registry API of D9010 VmApp: what the launcher and the `vmapp` CLI talk to for the list of apps, search, details, versions,
downloads and publishing. It is the same API as [../registry/](../registry/README.md) (the Node server), running as a Cloudflare Worker, so
there is **no server to run**: the free tier is meant to cover it.

```
 launcher / vmapp CLI / the website
        │  https://api.vmapp.dev/api/...
        ▼
   Worker (src/index.js) ───▶ Registry Durable Object (src/registry.js): the only writer
                                 │  the event log and the state: SQLite inside the object (src/events.js)
                                 │  every package: R2 bucket "vmapp-packages" (private; downloads stream through the Worker)
                                 └─ package check as a stream (src/verify.js)
```

## What is reused and what is new

The rules are not copied, they are the registry's own files, bundled: `registry/lib/state.js` (what each event does), `db.js`, `listing.js`
(search and sort), `versions.js` (update choices), `present.js` (how records are shown), `publisher.js`, `ratelimit.js`, and
`hostlib/manifest.js` (what a valid manifest is). New: where things are kept (SQLite and R2 instead of files in a bucket), the router
(`src/registry.js`, endpoint for endpoint the same as the Node registry), and the package check.

**The package check is a stream.** A Worker has 128 MB of memory and packages go up to 512 MiB, so `hostlib/package.js` (which reads a
whole package into memory) cannot run here. `src/verify.js` checks the same things one pass over the bytes. Where it checks less than
the Node verifier (the structure of the core image), its header comment says exactly what; the launcher verifies everything again at install.

## Endpoints

Same as the Node registry ([../registry/README.md](../registry/README.md#api)): `GET /api/info`, `/api/stats`, `/api/apps`,
`/api/apps/:id`, `/api/apps/:id/versions`, `/api/apps/:id/resolve`, `/api/apps/:id/:version/download`, `POST /api/publish`,
`/api/publish/init` and `/complete`, `POST /api/apps/:id/:version/withdraw` and `/restore`, `/api/publisher/me` and `/profile`.
Added: `PUT /api/uploads/:id` (where `init` tells the client to send the package), and the operator's
`POST /api/admin/apps/:id/hide` and `/unhide` (with the `ADMIN_TOKEN` secret).

**Large packages (over 95 MiB, up to `MAX_PACKAGE_MIB`, 512) go up in parts.** Cloudflare's proxy accepts at most 100 MB per request, so
for such a package `init` answers with `parts: {size, count}` (parts of 32 MiB, the last one shorter) and the client sends part N as
`PUT <url>?part=N` with exactly that many bytes (any order, a part can be sent again, up to 60 minutes after `init`). `complete` puts the
parts together in R2 with the Worker's own R2 binding (a multipart upload; no R2 API token and no presigned URL are needed), then checks the
package as for any other upload. The launcher's *Publish…* and `vmapp publish` do this by themselves. A client that does not know about
parts gets a `400` that says so. Packages up to 95 MiB are unchanged: one `PUT`.

Not yet: email and domain verification of publishers (they answer `501 not_supported`; they need a mailer and DNS lookups) and the web pages
(the website is the separate static site).

## Run it locally (no Cloudflare account needed)

```sh
npm run dev                 # wrangler dev: http://127.0.0.1:8787, a local Durable Object and a local R2
VMAPP_REGISTRY=http://127.0.0.1:8787 ../tools/vmapp publish ../out/examples/02-notes.vmapp
VMAPP_TEST_PACKAGES=../out/examples npm test     # the unit and end-to-end tests (they start their own Worker)
```

## Deploy

From `website/` (one command for the site and the API, with verification of both):

```sh
npx wrangler login --scopes account:read user:read pages:write workers:write workers_scripts:write workers_routes:write zone:read
npm run deploy              # or: node publish.js --api-only
```

One-time, in the Cloudflare dashboard: enable **R2** (R2 Object Storage, Get started). The deploy creates the bucket `vmapp-packages` and the
Worker, and attaches `api.vmapp.dev` (a custom domain on the `vmapp.dev` zone, set in `wrangler.jsonc`). Optional secret for taking apps down:
`npx wrangler secret put ADMIN_TOKEN`.

## Limits worth knowing

- One Durable Object serves everything, which is right for a registry of this size (the Node one is also a single process).
- Verifying a large package costs CPU time. The free Workers plan allows very little CPU per request, so large packages may need the paid
  plan ($5 a month); small ones do not.
- Downloads are streamed through the Worker, so the bucket stays private and download rules (for example "only from the launcher") can be
  enforced in one place.
