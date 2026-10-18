# D9010 VmApp app registry

**For:** people who run a registry. If you only want to publish or get an app, read
[../docs/DISTRIBUTING.md](../docs/DISTRIBUTING.md). To put a registry on a server (EC2 + Cloudflare), read
[deploy/HOSTING.md](deploy/HOSTING.md).

A small public server where people publish `.vmapp` packages and others browse, search and download them. Node 22, no
npm dependencies, CommonJS like `hostlib/`. The server checks every upload with `hostlib/package.js` (the same code the
Loader and the CLI use), so a package that gets in is well formed: every hash matches, the entry order is right and the
limits hold. Everything it stores is append-only: see [Storage](#storage).

## Run it

```sh
node vmapp/registry/server.js --port 8790 --data /path/to/data                  # local storage
REGISTRY_STORAGE=s3 S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  S3_ENDPOINT=... node vmapp/registry/server.js                                  # S3-compatible storage (credentials: environment only)
```

or as a container: [Container](#container).

| Option | Environment | Default | Meaning |
|---|---|---|---|
| `--port N` | `REGISTRY_PORT` | `8790` | `0` picks a free port (the chosen address is printed). |
| `--host ADDR` | `REGISTRY_HOST` | `127.0.0.1` | Bind address. Only use `0.0.0.0` / `::` behind a firewall or reverse proxy. |
| `--data DIR` | `REGISTRY_DATA` | `$VMAPP_WORK/registry-data` (`vmapp/out/work/registry-data`) | Scratch space (`tmp/` for uploads in flight, `outbox/`, `server.pid`) and, with local storage, the store itself in `DIR/store`. |
| `--storage local\|s3` | `REGISTRY_STORAGE` | `local` | See [Backends](#backends). |
| `--public-download-base URL` | `PUBLIC_DOWNLOAD_BASE` | none | Downloads redirect to `URL/blobs/sha256/<hh>/<sha256>.vmapp`. See [Downloads](#downloads-and-the-302). |
| `--trust-proxy` | `REGISTRY_TRUST_PROXY=1` | off | Take the client address from the **last** `X-Forwarded-For` entry. Set it only behind a proxy that sets that header itself; otherwise anyone can pick their own address and dodge the limits. |
| `--public-url URL` | `REGISTRY_PUBLIC_URL` | the listen address (emails only) | The address users reach the registry at. Used in verification emails, and for the canonical links, Open Graph URLs, structured data, `sitemap.xml` and `robots.txt` of the web pages (see [Web pages and search engines](#web-pages-and-search-engines)): only its scheme and host are used, and **when it is not set those absolute URLs are left out**. The `Host` header of a request is never used for them. |
| `--mailer FILE` | `REGISTRY_MAILER` | dev mailer | See [Email](#email). |
| `--max-package-mib N` | `REGISTRY_MAX_PACKAGE_MIB` | `512` | Largest package accepted (512 MiB is also the format's own limit). |
| `--publish-per-hour N` | `REGISTRY_PUBLISH_PER_HOUR` | `10` | Publish attempts per address per hour (a presigned `init` counts as one). |
| `--api-per-minute N` | `REGISTRY_API_PER_MINUTE` | `300` | API requests per address per minute. The server-rendered pages (`/`, `/apps/<id>`, `/sitemap.xml`) count too, because building them walks the app list; the publish/verify pages, static files and `robots.txt` are not counted. |
| `--snapshot-every N` | `REGISTRY_SNAPSHOT_EVERY` | `500` | A snapshot after this many events. |
| `--counter-flush-min N` | `REGISTRY_COUNTER_FLUSH_MIN` | `5` | Download counters are appended to the log at most this often. |
| `--dev-allow-http-verify` | | off | **Tests only.** See [Domain checks](#domain-checks). |
| `--quiet` | `REGISTRY_QUIET=1` | off | No request log. |

The storage settings that are not options (`S3_*`, `REGISTRY_LOCAL_DIR`, the lease times) are environment variables, listed in
[registry/.env.example](.env.example). **The S3 credentials exist only as environment variables**: there is no flag for them, so
they never appear in `ps`, in shell history or in a compose file. Nothing the server prints contains them.

Stop it with SIGINT or SIGTERM: it finishes the requests in flight, appends the download counters, writes a final snapshot and
releases the writer lease before exiting.

**One process only.** The server allocates the event sequence numbers and is the only writer of the log. A local store is
protected by a lock file (`DATA/server.pid`), a bucket by a lease object (see [One writer](#one-writer)). Do not run several
copies behind a load balancer, and do not edit anything in the store while the server runs.

## Storage

The registry keeps its data as **immutable files**. Nothing is ever rewritten in place, and nothing is ever deleted by the
server. A withdrawal or a take-down is a mark (an event), not a removal. The same layout is used on a local disk and in an
S3-compatible bucket.

```
<store>/
  blobs/sha256/<hh>/<sha256>.vmapp                       packages, named by their SHA-256 (hh = its first two hex digits)
  events/<yyyy>/<mm>/<dd>/<seq 12 digits>-<rand>.json    the event log: the source of truth
  snapshots/<seq 12 digits>.json                         the state as of that event, for a fast start
  staging/<uuid>.vmapp                                   s3 only: uploads waiting for POST /api/publish/complete
  lease/writer.json                                      s3 only: the single-writer lease
DATA/                                                    always on the server's own disk
  tmp/ outbox/ server.pid                                uploads in flight, dev-mailer messages, the process lock
```

`<store>` is `DATA/store` (or `REGISTRY_LOCAL_DIR`) for the `local` backend and the whole bucket for `s3`.

### 1. Blobs

A package is stored once, as `blobs/sha256/<hh>/<sha256>.vmapp`. It is **write-once**: if the object exists, publishing the same
bytes writes nothing. If an object with that name exists but has another size, the publish fails with 500 `storage_error` and the
operator must look (`admin.js verify`); a blob is never replaced. The order of a publish is: blob first, then events, so an interrupted publish
can leave a blob that no event refers to (garbage that `admin.js gc` lists), never an event that refers to a missing blob.

### 2. The event log

The log is the **source of truth**: one JSON file per event, never changed after it is written. The state the registry serves
is `replay(events)`, nothing else.

```json
{"seq": 17, "ts": "2026-10-16T09:00:00.000Z", "type": "version.withdrawn", "actor": "pub-0123456789abcdef", "data": {"id": "com.example.notes", "version": "1.0.3", "reason": "Corrupts notes"}}
```

- `seq`: 1, 2, 3, … without gaps. Allocated by the one server process.
- `ts`: ISO-8601 UTC, **never earlier than the event before it** (if the clock steps back, event time stands still). The folder
  `<yyyy>/<mm>/<dd>` in the name is its UTC date.
- `actor`: a publisher id (`pub-…`), `system` (the server itself) or `admin` (`admin.js`). **Never a token.**
- The file name is `<seq 12 digits>-<rand>.json` (`rand` = 12 hex digits). The random part means that a second writer cannot
  silently replace an event: two files with one `seq` are detected and the server refuses to start on them.

| `type` | `data` | Meaning |
|---|---|---|
| `publisher.created` | `{id, tokenHash, name, company, email, url}` | `tokenHash` is the SHA-256 of the owner token. The token itself is never stored. |
| `publisher.updated` | `{id, name, company, email, url}` | A changed email drops its verification. |
| `publisher.verified` | `{id, kind:"email", email}` or `{id, kind:"domain", name, method:"file"\|"dns"}` | |
| `app.published` | `{id, version, sha256, size, packageId, publisherId, meta:{manifest, files}}` | `meta.manifest` is the manifest without its `files` hash map (for the app page); `sha256` names the blob. |
| `version.withdrawn` | `{id, version, reason}` | A mark. The version stays published and downloadable by its exact number. A later `version.withdrawn` replaces the reason. |
| `version.restored` | `{id, version}` | Lifts the mark (writes nothing if the version is not withdrawn). |
| `app.hidden` | `{id, reason}` | **Tombstone** (administrator only, `admin.js hide`): the app disappears from every API and page, and its id cannot be published to. Its events and packages stay. |
| `app.unhidden` | `{id}` | Lifts the tombstone (`admin.js unhide`). |
| `counters.downloads` | `{items:[{id, version, hour:"2026-10-16T09", n}]}` | Download counts **aggregated per app, version and UTC hour**, appended by the server every `REGISTRY_COUNTER_FLUSH_MIN` minutes (default 5) and on shutdown, never one event per download. Counts are visible at once and are only lost, up to that interval, if the process is killed. |
| `admin.gc` | `{deleted:[key,…], minAgeHours, kinds}` | The audit record of `admin.js gc --confirm`: which objects it deleted. |

An event is checked against the current state **before** it is written (a contradicting event is refused, so the log can always
be replayed), and applied only after it is durably stored. Events written by `admin.js migrate` carry `data.migrated`.
The code that defines every event's effect is `lib/state.js`; the server and `admin.js verify` use the same code.

What is **not** in the log, on purpose: the pending email codes and domain-check tokens (15 minutes, memory only: a restart voids
them), the rate limits, the per-address download de-duplication table (random salt per process, never on disk), and the
presigned uploads that were announced but not completed (a restart voids them; the client starts again). No IP address is
ever stored.

### 3. Snapshots

`snapshots/<seq 12 digits>.json` holds the whole state as of event `seq`:
`{"format":1, "seq", "ts", "createdAt", "stateSha256", "state"}`. A new file is written every `REGISTRY_SNAPSHOT_EVERY`
events (default 500) and when the server stops cleanly; **an existing snapshot is never overwritten or deleted**, and all
are kept. A starting server loads the newest snapshot whose checksum is right (a damaged one is skipped, the next older is used,
down to none) and replays only the events after it. A snapshot is an optimisation: deleting every one of them changes nothing
but the start-up time (`admin.js verify` proves that each snapshot equals the replay up to its number).

### 4. Backends

| | `local` (default) | `s3` |
|---|---|---|
| Where | a directory: `DATA/store` | an S3-compatible bucket: AWS S3, Cloudflare R2, MinIO |
| Select | `REGISTRY_STORAGE=local` | `REGISTRY_STORAGE=s3` with `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and usually `S3_ENDPOINT`, `S3_REGION` |
| Path-style addressing | – | `S3_PATH_STYLE=1` (R2, MinIO; the default whenever `S3_ENDPOINT` is set) or `0` (AWS: `bucket.s3.<region>.amazonaws.com`) |
| Write-once | hard link of a finished temp file (fails if the name exists) | `PutObject` with `If-None-Match: *` (set `S3_CONDITIONAL_PUT=0` only for a store that rejects it; the client then checks first) |
| Local disk | holds the data | **only a cache and scratch space**: a server on an empty disk rebuilds everything from the bucket at start |
| Presigned uploads | no | yes |
| Single-writer guard | `DATA/server.pid` | `lease/writer.json` |

S3 requests are signed with AWS Signature Version 4 implemented in `lib/sigv4.js` (Node built-ins only) and tested against AWS's
published examples (`tests/registry/sigv4.test.js`) and against MinIO. The server's clock must be right to within a few minutes
(the object store checks request times).

### 5. Downloads and the 302

`GET /api/apps/:id/:version/download`:

- **With `PUBLIC_DOWNLOAD_BASE`** (for example `https://dl.example.com`, an R2 custom domain): `302` with
  `Location: <base>/blobs/sha256/<hh>/<sha256>.vmapp`, no body, and the headers a direct download has: `X-Vmapp-Sha256`,
  `X-Vmapp-Package-Id`, `X-Vmapp-Version`, `ETag`, and `X-Vmapp-Withdrawn` for a withdrawn version. The redirect is counted as the
  download. The package then travels from the object store's public address, not through this server.
- **Without it:** the registry streams the blob from its store (`200`, `Content-Type: application/x-vmapp`, `Content-Length`, the same
  headers).

**The bucket is never trusted.** `vmapp get` and the Loader (`hostlib/updates.js`) read the checksum and the package id from the
*registry's* response, follow exactly one redirect (never from https to http, never with credentials in the address, never a
second hop), and check what arrives: the SHA-256 against `X-Vmapp-Sha256`, the whole package with `hostlib/package.js`, the package
id against `X-Vmapp-Package-Id`, and that id and version are the ones asked for. A bucket that serves other bytes is refused.
A browser that follows the link from the web page gets the file named by its hash (`<sha256>.vmapp`) instead of
`<id>-<version>.vmapp`, because the object store, not the registry, sends the response.

**The public address must serve `blobs/` only.** The event log in the same bucket holds publisher e-mail addresses and token
hashes. HOSTING.md step 3 sets a Cloudflare rule for it; the server also fetches `<base>/lease/writer.json` once at start and logs
a `WARNING` if that works.

### 6. Publishing without passing through the server

`GET /api/info` says how a registry can be published to: `{"name","publishModes":["direct"] | ["direct","presigned"],"downloads":"direct"|"redirect","maxPackageBytes"}`.

With the `s3` backend (`presigned` is listed):

1. `POST /api/publish/init` `{size, sha256}`, optionally `Authorization: Bearer <owner token>` (a token that no publisher has is
   refused at once). Counts against the publish rate limit. Answer `200`
   `{uploadId, method:"PUT", url, headers:{"Content-Length":"<size>"}, expiresAt, size}`: a presigned URL for
   `staging/<uploadId>.vmapp`. It is valid for **15 minutes** and the signature includes `Content-Length`, so the object store
   accepts exactly `size` bytes and nothing else.
2. The client sends `PUT <url>` with the package. The bytes go straight to the object store.
3. `POST /api/publish/complete` `{uploadId}` with the same `Authorization` (or, for a first publish, `X-Vmapp-Publisher`) as a
   direct publish. The server checks the object's size, **streams the staged object to its own disk while hashing it**, compares
   size and SHA-256 with what `init` announced (`400 upload_mismatch`), runs the same strict `hostlib/package.js` verification as a
   direct upload (`400 invalid_package`), and then, one publish at a time, checks ownership and the version rules exactly as for a
   direct upload. The blob is made with a server-side `CopyObject` from `staging/` to `blobs/…`, **only if the staged object still has
   the ETag that was verified** (`409 upload_changed` otherwise: someone with the URL overwrote it after the check). Then
   `app.published` is appended. The answer is the same `201` as for a direct publish.
4. **Staging objects are never deleted by the server.** Add a lifecycle rule that expires `staging/` after 2 days (HOSTING.md,
   step 3); `admin.js gc --confirm` deletes them too.

Other answers: `501 not_supported` for the local backend, `404 unknown_upload` (unknown id, expired, finished, or the server was
restarted: start again with `init`), `400 upload_missing` (nothing was PUT yet), `413`/`400` for a bad `size`/`sha256`, `429`.

The direct `POST /api/publish` stays for the local backend, for small packages and for the web page. `vmapp publish` and the Loader's
*Publish…* ask `/api/info` and use init/complete when `presigned` is listed (`vmapp publish --direct` forces the direct upload).

### 7. One writer

The log has one writer: this process. It is the only one that allocates sequence numbers, which is what keeps them gap-free. It
follows that **a registry runs as one process, with one storage, at a time**. This is a deliberate simplification.

- **Local store:** `DATA/server.pid` (`<pid> <host name>`) refuses a second process on the same data directory, and a file left by a
  dead process (or, in a container, by the previous run) is recognised as stale.
- **Bucket:** the server holds a **lease**, `lease/writer.json` (`{id, host, pid, startedAt, renewedAt, ttlMs}`), the only object that is
  ever overwritten and one that holds no data. It renews it every 15 s (`REGISTRY_LEASE_RENEW_SEC`); it is valid for 60 s
  (`REGISTRY_LEASE_TTL_SEC`). A starting server that finds a lease being renewed **refuses to start** ("another registry process is
  writing to this bucket"); one that finds a lease nobody has renewed for its ttl (a crashed server) takes it over after waiting out
  the ttl; a clean shutdown marks the lease released, so a restart is immediate. A running server whose lease was taken, or that cannot
  renew it, stops writing.
- `admin.js hide`, `unhide`, `migrate` and `gc --confirm` write events or delete objects, so they take the same lock/lease first and
  refuse to run while the server is up.
- Two events with one `seq` (a race that slipped past the lease, a repeated write) are detected when the log is replayed: the server
  refuses to start on a log with a duplicate or a gap, and says which events.

The lease catches an accidental second server. It is not a fencing mechanism for a deliberate or partitioned one; if you need
failover, you need a different design.

### 8. When storage fails

If an event cannot be written after retrying, the server **stops writing for good** (`503 storage_unavailable` on every change,
reads keep working, the process exits so that a supervisor restarts it, which rebuilds from the log). Its memory may no longer match
the log and a restart is the only safe way to find out. Nothing is half-written: an event is one object, created whole.

### 9. What deletes anything

Only `admin.js gc --confirm`, and only `staging/` objects and blobs that no event refers to, each at least 24 hours old (`--min-age-hours`),
with an `admin.gc` event listing them. Events and snapshots can never be deleted through the storage code (it refuses). A hidden
app's, a withdrawn version's and an old version's packages are all referenced, so gc never touches them.

### 10. Migrating from the old format

Before this storage the registry kept `db.json` and `packages/<id>/<version>.vmapp`. Convert such a directory once:

```sh
node registry/admin.js migrate --from-db /path/to/old-data --dry-run     # what it would write
node registry/admin.js migrate --from-db /path/to/old-data               # with the server stopped
```

It verifies every old package (size, SHA-256, `hostlib` verification, package id) **before writing anything**; any problem aborts
with the list. Publishers (with their email/domain verifications), versions (with their original publication times), withdrawals and
download counters become events with their original times, and the packages become blobs. It checks the result against the old
database. The old directory is only read, never changed or deleted. Run it again and nothing happens; run it after an interruption
and it completes. Owner tokens keep working. It refuses a store that already holds other events.

### 11. Administration: `registry/admin.js`

It reads the same environment as the server (`REGISTRY_STORAGE`, `REGISTRY_DATA`, `S3_*`), so it works on either backend.

| Command | |
|---|---|
| `status` | Events, snapshots, apps, versions, publishers, blobs. |
| `snapshot` | Writes `snapshots/<seq>.json` for the current state. A new write-once file; safe while the server runs. |
| `check-storage` | Probes the bucket once (run it on a new one, for example R2): a second PUT must not replace an object, a server-side copy must refuse a changed source, a presigned PUT must be bound to its size. Leaves three tiny `staging/probe-*` objects. Exit 1 if the store misbehaves. |
| `verify [--no-blobs]` | Reads every event (valid, contiguous from 1, replays without contradiction), every snapshot (checksum, and equal to the replay up to its number), and **re-hashes every package an event refers to**. Exit 1 on any problem. Safe while the server runs. |
| `gc [--min-age-hours N] [--confirm]` | Lists staging objects and unreferenced blobs. **Without `--confirm` it deletes nothing and exits 2.** With it, deletes them (server stopped) and appends `admin.gc` events. |
| `export --out FILE.tar` | A tar of all events and snapshots (not the blobs) for an offline backup. Never overwrites a file. The archive holds publisher e-mail addresses: keep it private. |
| `migrate --from-db DIR [--dry-run]` | See above. |
| `hide <id> --reason TEXT` / `unhide <id>` | The tombstone (server stopped). |

### 12. Backup

With the `s3` backend **the bucket is the backup**: it holds the log, the snapshots and every package, and nothing in it is ever
rewritten or deleted by the server. For a second copy that survives the loss of the bucket or of its credentials, run
`admin.js export` somewhere on a schedule and copy `blobs/` with any S3 tool (HOSTING.md has an example). To restore: put the
archive's files back under the same keys, put `blobs/` back, start the server.
With the `local` backend, stop the server (or copy while it is idle) and copy `DATA/store`.
Because files never change, a plain recursive copy is always consistent as long as it copies `events/` last.

### 13. Known limits

- The per-day download table (`daily`) keeps one entry per app and day, forever (a few bytes a day); old snapshots hold their own copies.
- A server killed with `SIGKILL` (or a power cut) loses the download counts of the last `REGISTRY_COUNTER_FLUSH_MIN` minutes. Nothing else.
- All state is held in memory, rebuilt at start: startup time grows with the events since the last snapshot and the number of apps; search is a substring scan.
  The home page and the sitemap walk the app list per request (a CDN in front absorbs repeats for a minute).
- `sitemap.xml` is one file of at most 50,000 URLs (the protocol's limit); with more apps it lists the first 49,999 by id and the home page. A sitemap index would be the next step.
- Anyone can start a presigned upload, just as anyone can publish a first package: the per-address publish limit is the only throttle, and
  abandoned uploads sit in `staging/` until the lifecycle rule (or `gc`) removes them.
- One writer, no failover (see above). The web page's *Publish* form uploads through the server (its Content-Security-Policy allows no other address); big packages go straight to the bucket from `vmapp publish` and the Loader.

## Container

`registry/Dockerfile` builds the image (Node 22 on Debian bookworm, pinned by digest; no packages installed; non-root user `node`;
data only under `/data`, so the root file system can be read-only; `HEALTHCHECK` on `/api/stats`). Build context is `vmapp/`:

```sh
cd vmapp/registry
cp .env.example .env && chmod 600 .env && $EDITOR .env      # the storage credentials go here, nowhere else
docker compose up -d --build                                 # 127.0.0.1:8790, restart: unless-stopped, volume for /data
curl http://127.0.0.1:8790/api/stats
```

`compose.yaml` publishes the port on `127.0.0.1` only: a reverse proxy or a Cloudflare Tunnel on the same machine is what the
internet talks to. The step-by-step guide for an existing EC2 instance and Cloudflare (domain, DNS, tunnel, R2 bucket and custom
domain, lifecycle rule, costs, backups) is [deploy/HOSTING.md](deploy/HOSTING.md).

## API

Errors are `{"error": {"code", "message"}}` with a fitting status.

| Request | What |
|---|---|
| `GET /api/info` | `{name, publishModes, downloads, maxPackageBytes}`. See [Publishing without passing through the server](#6-publishing-without-passing-through-the-server). |
| `POST /api/publish` | Body: the raw `.vmapp` bytes, `Content-Type: application/octet-stream`, up to 512 MiB (streamed to `DATA/tmp`, then verified). `Authorization: Bearer <owner token>` for an id that exists, or to add a **new** id to your publisher. `X-Vmapp-Publisher: {"name","company","email","url"}` (JSON, ASCII, all optional) describes a **new** publisher. 201 `{id, version, packageId, sha256, size, created, url, publisher, ownerToken?}`. `ownerToken` appears only when this call created the publisher, and only once. 400 invalid package (hostlib's message), 401/403 token, 409 version exists or not newer or the app is hidden, 413, 415, 429, 502/503 storage. |
| `POST /api/publish/init`, `POST /api/publish/complete` | The presigned form of the above (s3 backend). |
| `GET /api/apps?sort=popular\|new\|updated\|name&q=&limit=&offset=` | `{total, limit, offset, sort, q, items[]}`. Item: `id, name, publisher{level,label,...}, description, latestVersion, runtime, downloads, downloads30d, createdAt, updatedAt, sizeBytes, permissionsSummary`. `popular` = total downloads, then last 30 days, then name. `limit` 1-100 (default 50). Hidden apps are not listed. |
| `GET /api/apps/:id` | The list item plus `packageId`, `manifest` (the latest manifest; the `files` hash map is replaced by `{count, uiBytes, coreBytes, hasIcon}`), `permissions` (`folders`, `dialogs`, `external`, `devices`, `host[{cap, purpose, control}]` for host capabilities, `network[{host, ports, purpose, wildcard, insecure}]` for the hosts it asks to reach: both shown on the app page and in `permissionsSummary`, and neither allows anything), `versions[{version, packageId, sha256, size, publishedAt, downloads, withdrawn}]`, and `claimedPublisher` (see [Publisher identity](#publisher-identity)). `latestVersion`, and the manifest and size shown, are those of the newest version that is **not withdrawn** (if every version is withdrawn: the highest). |
| `GET /api/apps/:id/:version/download` | The file, or a 302 to it (see [Downloads](#5-downloads-and-the-302)). `latest` is accepted and means the newest version that is not withdrawn (404 `all_withdrawn` if there is none); a withdrawn version is still served when asked for by its exact number, with `X-Vmapp-Withdrawn: <percent-encoded reason>`. Headers: `Content-Type: application/x-vmapp`, `Content-Disposition: attachment` (direct only), `X-Vmapp-Package-Id`, `X-Vmapp-Sha256` (of the file), `X-Vmapp-Version`, `ETag`. |
| `GET /api/apps/:id/versions` | `[{version, packageId, sha256, size, publishedAt, withdrawn}]`, highest first, every version. `withdrawn` is `{reason, at}` or `null`. |
| `GET /api/apps/:id/resolve?choice=compatible\|latest&from=<semver>` | `{version}` or `{version: null}`. See [Versions](#versions-and-update-choices). 400 for a bad `choice`/`from` (`from` is required for `compatible`). |
| `POST /api/apps/:id/:version/withdraw` `{reason}` | Mark one version as withdrawn (a `version.withdrawn` event). Owner token (`Authorization: Bearer`; 401 without a well-formed token, 403 for a token that does not own the app, as for publish). `reason`: plain text, 1-200 characters, one line (400 otherwise). 404 for an unknown app or version. Withdrawing again replaces the reason. 200 `{id, version, withdrawn:{reason, at}}`. |
| `POST /api/apps/:id/:version/restore` | Undo it. Same auth. Idempotent (restoring a version that is not withdrawn is a 200 no-op that writes nothing). 200 `{id, version, withdrawn: null}`. |
| `GET /api/stats` | `{apps, versions, downloads}`. |
| `/api/publisher/*` | Identity. See below. |

`:id` is checked against the manifest id pattern and `:version` against semver before any object is touched. Versions
are immutable and must increase (semver order; "not newer than the latest" is refused). The only change to a published
version is withdrawing or restoring it.

### Versions and update choices

The rules are SPEC §8.1; the Loader asks `resolve` and decides nothing itself about what is newer.

`resolve?choice=…&from=<semver>` returns the highest version that is:

- **not withdrawn**, and
- **not lower than `from`**: the answer is an *update*, never a downgrade, so it may equal `from` and it is `null`
  when nothing at or above `from` qualifies (for example when `from` itself was withdrawn and nothing newer exists), and
- for `compatible`: in the **same major** as `from`; while the major is `0`, in the **same minor** too (`0.2.x` may
  break `0.1.x`). `latest` takes any major (`from` is optional for it), and
- **not a prerelease** (`1.2.0-beta.1`), unless `from` is itself a prerelease of the same `x.y.z`: then the
  prereleases of that one line count as well (a beta tester follows the betas of `1.2.0` and ends on `1.2.0`). A
  stable user is never moved onto a prerelease. (Prerelease order is semver's: `beta.2` < `beta.10` < `rc.1` < release.)

`from` need not be a published version. Differences from the list/detail views, on purpose: `latestVersion` and the
`latest` download alias are the highest non-withdrawn version **including** prereleases (as before), because they
describe what the publisher last released; `resolve` is what decides what gets *installed automatically*.

**Withdrawn versions.** `withdrawn: {reason, at}` is derived from the `version.withdrawn` / `version.restored` events (`at` is the
event's time; the API shows ISO time). Publishing still requires a version higher than the highest ever published,
withdrawn or not. The app page shows each withdrawn version with `Withdrawn: <reason>`; the reason is public text from the
publisher and is only ever rendered as a text node. To take an app off the registry entirely, an operator hides it
(`admin.js hide`, a tombstone): nothing is deleted and it can be lifted.

### Downloads

A `GET` of a package counts once per (client address, version) per 24 hours (for a redirect: when the 302 is sent). The
de-duplication table lives in memory only, keyed by a hash of the address with a random per-process salt; it is never written to
disk and a restart forgets it (a client may then count once more). `HEAD` and `304` responses do not count. **Downloads are the only
ranking signal.** The registry has no way to see whether an app is launched (INV-G3: no telemetry), so nothing like that can
influence ranking. Counts appear in the API at once and reach the log as `counters.downloads` events.

## Web pages and search engines

The home page and every app's page are **rendered by the server**, so search engines and link previews (Slack, X, iMessage),
which do not run page scripts, get the whole page. The scripts take over from the server-rendered content: `home.js` for
search, sorting and "Show more", `app.js` only as a fallback for a page that arrives without content. The publish, publisher and
verify pages are unchanged.

| Address | What |
|---|---|
| `GET /` | The app list: the first 20 apps in the default order (name, publisher label, description, latest version, downloads, link), a search form, sort links and page links. Works without JavaScript: `?q=notes`, `?sort=new\|updated` and `?page=2` use the same search and order as `GET /api/apps`. An unknown `sort` or a bad `page` means the default; `q` is cut at 100 characters. |
| `GET /apps/<id>` | The app page: everything the script-built page shows (permissions, versions, withdrawn reasons, details, publisher label by the display rule). An unknown **or hidden** app is a 404 (an HTML page that only says there is no such app, `noindex`). |
| `GET /sitemap.xml` | The home page and every visible app page, `lastmod` = the publish time of the app's newest version that is not withdrawn. Left out: hidden apps and apps whose every version is withdrawn. One file, at most 50,000 URLs (see Known limits). **404 when `REGISTRY_PUBLIC_URL` is not set** (a sitemap needs absolute URLs). |
| `GET /robots.txt` | `Allow: /`; `Disallow: /api/`, `/publish`, `/publisher`, `/verify`; a `Sitemap:` line when `REGISTRY_PUBLIC_URL` is set. |

**What goes in the page.** `<title>`, `<meta name="description">` (the app's description cut at 200 characters on one line; a plain sentence
when it has none), Open Graph and Twitter card tags (`summary`; there are no images), and, **only when `REGISTRY_PUBLIC_URL` is set**,
`<link rel="canonical">` and `og:url`. JSON-LD (a `<script type="application/ld+json">` data block): a `WebSite` with a `SearchAction`
(`/?q={search_term_string}`) on the start page, and on an app page a `SoftwareApplication` with `name`, `softwareVersion` (the newest
version that is not withdrawn), `operatingSystem: "macOS"`, `applicationCategory: "UtilitiesApplication"` (the manifest has no category,
so the most general one), `offers` of price 0 (the registry charges nothing for a download; it says nothing about the app's licence),
`datePublished`, `dateModified`, `description`, and with the public URL `url` and `downloadUrl`. `publisher` (an `Organization`) appears
**only for a publisher with a verified domain** (its company, else the domain; its website only if it is `https:` and on that domain). An
e-mail-verified publisher is not put there: an address at a domain says nothing about who made the app. No rating, no review, nothing the
registry does not know.

**What is indexed.**

| Page | |
|---|---|
| `/` and `/?page=N` | Indexed, each with its own canonical address. |
| `/?q=…`, `/?sort=new\|updated`, a page past the end | `noindex, follow`, no canonical (they list the same apps in another order or another selection; all the apps are in the sitemap anyway). |
| `/apps/<id>` | Indexed, canonical, JSON-LD. |
| `/apps/<id>` with **every version withdrawn** | Answers, but `noindex, follow`; no canonical, no JSON-LD; not in the sitemap. |
| `/apps/<id>` of a hidden or unknown app | 404, `noindex`. |

**Security.** Every value that comes from a package or a publisher (names, descriptions, ids, versions, permission texts, withdrawal
reasons, company and website of a verified domain, a search term) is HTML-escaped in text and in attributes (`lib/html.js`: the only way
to put a value into the markup is the `html` template tag, which escapes it). JSON-LD is `JSON.stringify` with `<`, `>`, `&`, U+2028 and
U+2029 written as `\u` escapes, so `</script>` cannot occur in it. A data block is not executed, so the Content-Security-Policy is
unchanged (`script-src 'self'`, no `'unsafe-inline'`). A website becomes a link only if it is an `https:` URL without credentials; other
addresses are shown as plain text. Absolute URLs come from `REGISTRY_PUBLIC_URL` only. `tests/registry/seo.test.js` checks all of this
with hostile text, and `tests/registry/ui.test.js` checks that the server and the page scripts say the same words.

**Caching.** `/`, `/apps/<id>` (200), `/sitemap.xml` and `/robots.txt` are the same for every visitor (no cookie, no token, no `Host`
dependence) and carry `Cache-Control: public, max-age=60` and an `ETag`; Cloudflare in front may cache them (see
[deploy/HOSTING.md](deploy/HOSTING.md)). 404 pages, the API and every other page are `no-cache`. A new app or download count can
therefore take up to a minute to show on these pages; the API is always current.

## Publisher identity

There are no accounts. A publisher is created by its first publish and identified by its **owner token** (32 random
bytes, hex). The token is shown once; only its SHA-256 is stored (in the `publisher.created` event). One publisher can own several
app ids: send the token when you publish a new id and it joins the same publisher.

### The display rule

The registry shows **only verified facts**. What a publisher merely claims is stored but not shown.

| Level | How | What the API and web UI show |
|---|---|---|
| `unverified` (default) | nothing | "Unverified publisher". Not the claimed name, company, URL or email, and **not** the manifest's own `publisher` string. |
| `email` | the publisher confirms a one-time link sent to its email | "Verified email @example.com": the domain of the address only. Never the full address, never the free-text name. |
| `domain` | the publisher proves control of a domain | "Verified: example.com", plus the company name, plus the website **if its host is the verified domain or a subdomain of it**. Never the person's name. |

Consequences, all enforced by tests:

- The list and detail views carry `publisher: {level, label, ...}` with exactly the table above.
- The manifest's `publisher` string is exposed only as `claimedPublisher` in the detail view. The web UI does not
  render it, the detail's `manifest` copy has no `publisher` key, and lists never carry it.
- Search matches an app's id, name and description plus the **verified** facts (verified email domain, verified
  domain, and the company of a domain-verified publisher). It never matches an unverified claim.
- No public response contains a full email address. (The authenticated `GET /api/publisher/me` returns the owner's
  own details back to the owner.)

### Endpoints

All take `Authorization: Bearer <owner token>` (401 without, 403 for an unknown token) except `confirm-email`.

| Request | What |
|---|---|
| `GET /api/publisher/me` | Your profile, level, pending verifications, app ids. |
| `POST /api/publisher/profile` `{name?, company?, email?, url?}` | Replace your details (a `publisher.updated` event). Changing the email removes its verification. |
| `POST /api/publisher/verify-email` | Sends a one-time code (random, 15 minutes, single use; a new request voids the old one; 5 per hour). |
| `POST /api/publisher/confirm-email` `{code}` | No token needed: the code is the secret. Also done by opening `/verify?code=...` and pressing the button (the page does nothing on load, so mail scanners that fetch links cannot confirm). |
| `POST /api/publisher/verify-domain` `{domain}` | Returns the token and what to publish. |
| `POST /api/publisher/check-domain` | The server looks for the token. 200 on success, 422 with the reason otherwise. |

The web UI for all of this is `/publisher` (paste your token; it is kept in the page only).

### Email

`createRegistry({mailer})` takes any object with `async send({to, subject, text})`. The default **dev mailer** writes
each message to `DATA/outbox/<timestamp>-<rand>.eml` and logs the file name (not the code). There is no SMTP in this
version. To send real mail, write a module that exports `send` using your provider (SMTP library, SES, ...) and start
the server with `--mailer ./my-mailer.js` (`REGISTRY_MAILER`). The message contains a link built from `--public-url`; set it to the
public address, or the links will point at the listen address.

### Domain checks

The publisher proves control by either of these (the server tries the file, then DNS):

1. serving the exact line `vmapp-publisher=<token>` at `https://<domain>/.well-known/vmapp-publisher.txt`
   (surrounding whitespace is ignored; anything else in the file fails), or
2. a DNS TXT record `vmapp-publisher=<token>` on `_vmapp.<domain>`.

The check is deliberately strict: HTTPS only, port 443 only, no redirects at all, 5 seconds, at most 4 KB, and the
host must resolve to **public addresses only** (loopback, private, link-local and other special ranges are refused, so
the registry cannot be used to probe your network). A domain is held by one publisher at a time. Any domain the
publisher can prove is accepted, and that domain is what users see.

`--dev-allow-http-verify` switches to plain HTTP, allows `localhost`/IPv4 hosts with a port, and skips the
public-address rule. It exists so tests can run the check against a local server. Never set it on a real registry.

## Limits and abuse controls

| What | Default |
|---|---|
| Package size | 512 MiB, enforced on `Content-Length` and while streaming (and on the announced size of a presigned upload) |
| Publish attempts | 10 per address per hour |
| API requests | 300 per address per minute (the server-rendered pages `/`, `/apps/<id>` and `/sitemap.xml` count as well) |
| Header / whole-request / idle timeouts | 15 s / 15 min / 60 s |
| Verification emails | 5 per publisher per hour; code valid 15 minutes |
| Domain checks | 20 per publisher per hour |
| Presigned uploads waiting | 5000; each valid 15 minutes, each checked at most 5 times |

All counters are in memory and reset on restart. Uploads are verified with `hostlib`, which reads the package into
memory (up to 512 MiB) and blocks the event loop while hashing; a flood of maximum-size uploads is slow. Keep the publish
limit low, and consider smaller `--max-package-mib` for a public instance.

## Security notes

- **Put it behind TLS.** The server speaks plain HTTP and has no HTTPS option. Terminate TLS in a reverse proxy
  (nginx, Caddy, Cloudflare), bind the server to `127.0.0.1`, and pass `--trust-proxy` and `--public-url`.
  Without TLS, owner tokens and uploads travel in the clear.
- **Storage credentials** are environment variables only, are never logged or put in an error message, and should be a token scoped to
  the one bucket. The server never deletes from the bucket, but a leaked token could: keep `.env` at mode 600 and keep a second copy
  (Backup).
- **The event log is private.** The bucket's public address must serve `blobs/` only.
- The web UI is static files plus the server-rendered pages (see [Web pages and search engines](#web-pages-and-search-engines)), with
  `Content-Security-Policy: default-src 'self'` (no inline script, no inline style),
  `nosniff`, `X-Frame-Options: DENY` and no referrer. Page scripts build the DOM with `textContent` and
  `setAttribute` only; a test fails if `innerHTML` or similar appears. The server escapes every registry value it puts in a page.
- Paths and object keys: ids and versions are validated before use; every storage key is checked against a strict pattern; static
  files are looked up by name in a table read at start.
- Tokens are compared by SHA-256 lookup. A lost token cannot be recovered (there are no accounts).
- Everything uploaded is public, including `core.cpio`.
- Request logs have the method, path, status and time. They never contain addresses, query strings or tokens.

## What is missing (on purpose, for now)

- **Accounts and recovery.** The owner token is the identity; lose it and you cannot publish new versions.
- **Package signatures.** Nothing proves who built a file; the identity levels above prove who *controls an email or
  domain*, not that the package came from them. Signatures are a later format change.
- **Moderation.** No review, reporting or malware scanning. The VM sandbox and the permission sheet are what protect users. An operator
  takes an app down with `admin.js hide` (a tombstone).
- **SMTP, storage quotas, a clustered or failover mode, a search index** (search is a substring scan, fine for thousands of
  apps), icons and screenshots.

## Tests

```sh
node --test vmapp/tests/registry/       # API, identity, UI, server-rendered pages / sitemap / robots (seo.test.js), CLI, storage, S3 (against an in-process fake S3), SigV4 vectors
VMAPP_TEST_MINIO=1 node --test vmapp/tests/registry/s3.test.js   # the same S3 tests against a real MinIO in Docker (image pinned by digest, data under $VMAPP_WORK/minio-data)
bash vmapp/tests/registry/e2e.sh        # real VM: publish apps/notes, `vmapp get --install`, run it headless
```
