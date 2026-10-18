# Hosting the D9010 VmApp registry: an existing EC2 instance + Cloudflare

**For:** the person who runs the registry. You have an AWS EC2 instance and you want `https://api.<your domain>` for the
registry and `https://dl.<your domain>` for the downloads, with the packages in a Cloudflare R2 bucket. What the registry stores
and how: [../README.md](../README.md#storage). Cloudflare's dashboard changes its labels now and then; the concepts below do not.

```
 vmapp CLI / Loader / browser
   │
   │ https://api.<domain>   the API and the web pages
   ├────────────▶ Cloudflare ──(tunnel)──▶ EC2: cloudflared ─▶ 127.0.0.1:8790 ─▶ registry container
   │                                                                              │  reads and writes the bucket
   │ https://dl.<domain>/blobs/…   a download, after the registry's 302           │  (S3 API, credentials in .env)
   ├────────────▶ Cloudflare cache ──▶ R2 bucket ◀────────────────────────────────┘
   │
   │ PUT to a presigned address of the bucket   a publish: the package goes straight to R2
   └────────────▶ R2 bucket (<account>.r2.cloudflarestorage.com)
```

What this gives you: no open port on the EC2 instance, no package bytes through it (so no EC2 data-transfer-out bill and no 100 MB
Cloudflare upload cap for big packages), and one bucket that holds all of the registry's data.

You need: a Cloudflare account, an AWS EC2 instance you can ssh into (2 GB of RAM or more: the registry reads a whole package into memory
to verify it, up to 512 MiB; 10 GB of free disk), and about an hour.

---

## 1. The domain (Cloudflare Registrar)

1. Cloudflare dashboard → **Domain Registration** → **Register Domains**; search, buy. The DNS zone is created for you in the same
   account; there are no name servers to change. (A domain bought elsewhere works too: add it as a site and change its name servers
   to Cloudflare's.)
2. Turn on DNSSEC for the zone (DNS → Settings) if you like.

Below, `example.com` stands for your domain.

## 2. The R2 bucket and its API token

1. **R2 Object Storage** → **Create bucket**: name `vmapp-registry`, a location near your users, Standard storage class.
2. Note your **account id** (R2 overview page, or the dashboard's right-hand column). The S3 endpoint is
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
3. **R2 → Manage R2 API Tokens → Create API token**:
   - Permissions: **Object Read & Write**.
   - Specify bucket: **only** `vmapp-registry`.
   - Copy the **Access Key ID** and **Secret Access Key** now; the secret is shown once. They go into `.env` on the EC2 instance and
     nowhere else: not in a chat, a ticket, a shell command line or a git repository.

The registry never deletes from the bucket (only `admin.js gc --confirm` does), but "Object Read & Write" includes delete, so a leaked
token could. Treat it like a password and rotate it if in doubt (step 8).

## 3. `dl.example.com`: public reads of the packages, and only the packages

1. Bucket → **Settings → Custom Domains → Connect Domain** → `dl.example.com`. Cloudflare creates the DNS record; it is proxied.
   Leave **Public access via r2.dev** disabled.
2. **The registry's event log lives in the same bucket, and it contains publisher e-mail addresses.** Make the public address serve
   the packages only. Dashboard → `example.com` → **Security → WAF → Custom rules → Create rule**:
   - Name: `dl: blobs only`
   - Expression: `(http.host eq "dl.example.com" and not starts_with(http.request.uri.path, "/blobs/sha256/"))`
   - Action: **Block**.
3. **Cache** the packages (optional, saves R2 requests; the files never change): **Caching → Cache Rules → Create rule**:
   `(http.host eq "dl.example.com")` → Eligible for cache → Edge TTL 1 year.
4. **Lifecycle rule for `staging/`** (publishing step 1 leaves the uploaded object there; the registry never deletes it):
   bucket → **Settings → Object lifecycle rules → Add rule** → prefix `staging/` → delete objects **2 days** after upload.
   (Also keep the default rule that aborts incomplete multipart uploads.)
5. Check it, from your laptop, after the registry is up (step 4) and has published something:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://dl.example.com/lease/writer.json       # must be 403
curl -s -o /dev/null -w '%{http_code}\n' https://dl.example.com/events/                 # must be 403
```

The registry also checks `…/lease/writer.json` at start and logs `WARNING … publicly readable` if it can be fetched.

## 4. The registry on the EC2 instance

Install Docker Engine and the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)), then:

```sh
git clone <your repository> && cd <repository>/vmapp/registry         # or copy the vmapp/ folder here
cp .env.example .env && chmod 600 .env
$EDITOR .env
```

In `.env` set at least:

```
REGISTRY_PUBLIC_URL=https://api.example.com
REGISTRY_STORAGE=s3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=vmapp-registry
S3_ACCESS_KEY_ID=<from step 2>
S3_SECRET_ACCESS_KEY=<from step 2>
S3_PATH_STYLE=1
PUBLIC_DOWNLOAD_BASE=https://dl.example.com
REGISTRY_TRUST_PROXY=1
```

Then:

```sh
docker compose up -d --build
docker compose ps                                  # "healthy" after about 45 s
curl -s http://127.0.0.1:8790/api/stats            # {"apps":0,"versions":0,"downloads":0}
curl -s http://127.0.0.1:8790/api/info             # "publishModes":["direct","presigned"],"downloads":"redirect"
docker compose logs --tail 20                      # "storage: bucket vmapp-registry at …", "loaded N events"
docker compose run --rm registry node /app/registry/admin.js check-storage     # four PASS lines, see below
```

`check-storage` probes the bucket once: that a second PUT does not replace an object, that a copy refuses a changed source, and that
a presigned PUT accepts exactly the announced size. The registry's "nothing is ever replaced" guarantee rests on those three behaviours
of the object store (R2 and MinIO are expected to have them; this proves it for your bucket). It leaves three tiny `staging/probe-*`
objects, which the lifecycle rule of step 3 removes. If it prints `FAIL`, do not publish to this bucket; the message says what to do.

The container listens on `127.0.0.1:8790` only, runs as a non-root user with a read-only root file system, and restarts by itself
(`restart: unless-stopped`, including after a reboot). If it refuses to start, the log says why: a missing `S3_*` variable, bad
credentials (`SignatureDoesNotMatch`, `InvalidAccessKeyId`), a wrong bucket, or "another registry process is writing to this
bucket" (see Troubleshooting).

## 5. `api.example.com`: reaching the container from the internet

### A. Cloudflare Tunnel (recommended: no open port at all)

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → Cloudflared → name it `vmapp-registry`.
2. Copy the tunnel **token**. On the EC2 instance put it in a root-only file, not on a command line:

```sh
sudo install -d -m 700 /etc/vmapp
sudo bash -c 'umask 177; read -r -s -p "tunnel token: " T; echo; printf "TUNNEL_TOKEN=%s\n" "$T" > /etc/vmapp/cloudflared.env'
sudo docker run -d --name cloudflared --restart unless-stopped --network host \
  --env-file /etc/vmapp/cloudflared.env cloudflare/cloudflared:<a pinned version from Docker Hub> tunnel --no-autoupdate run
```

3. In the tunnel's **Public Hostname** tab add `api.example.com` → Service **HTTP** → `localhost:8790`. Cloudflare creates the
   proxied DNS record itself.
4. EC2 security group: **no inbound rules** are needed for the registry (keep SSH from your address, or use Session Manager).

### B. Proxied DNS record to the instance (if you do not want a tunnel)

DNS → add an **A** record `api` → the instance's Elastic IP, **proxied (orange cloud)**. SSL/TLS mode **Full (strict)** with a
Cloudflare Origin certificate on a reverse proxy on the instance (nginx or Caddy) that forwards to `127.0.0.1:8790`. Open port 443 in the
security group **to Cloudflare's address ranges only** ([cloudflare.com/ips](https://www.cloudflare.com/ips/)). The proxy must replace
the client address header, because the registry trusts the last `X-Forwarded-For` entry (`REGISTRY_TRUST_PROXY=1`):

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;   # replace, do not append
    proxy_set_header Host $host;
    client_max_body_size 520m;
    proxy_request_buffering off;
}
```

### Caching the web pages, and what must not be cached

The home page (`/`), the app pages (`/apps/<id>`), `/sitemap.xml` and `/robots.txt` are public and the same for every visitor; the
registry sends `Cache-Control: public, max-age=60` for them (and `no-cache` for everything else). Cloudflare does **not** cache HTML
by default, so every crawler and every visitor reaches the instance. To let the edge absorb them: **Caching → Cache Rules → Create rule**:

- Name: `registry: public pages`
- Expression: `(http.host eq "api.example.com" and (http.request.uri.path eq "/" or starts_with(http.request.uri.path, "/apps/") or http.request.uri.path in {"/sitemap.xml" "/robots.txt"}))`
- Cache eligibility: **Eligible for cache**; Edge TTL: **Use cache-control header if present** (the registry's 60 seconds); Browser TTL: respect origin.

Do **not** cache `/api/*` (the API answers `no-cache` and must stay current: a publish, a withdrawal and the owner endpoints), nor `/publish`, `/publisher`
or `/verify` (`/verify?code=…` carries a one-time code in the address). A "Cache Everything" rule for the whole host would cache those; scope it
as above. A new app, a withdrawal or a download count shows on the cached pages after at most a minute. The pages carry no cookie and nothing per visitor,
so a shared cache cannot leak anything between visitors.

### Search engines

The pages are server-rendered with titles, canonical links, Open Graph tags and structured data (README, "Web pages and search engines"), which
needs `REGISTRY_PUBLIC_URL` to be set (step 4): without it the registry leaves out every absolute URL, and `/sitemap.xml` answers 404.
After the registry is up and has apps:

1. Check: `curl -s https://api.example.com/robots.txt` names `https://api.example.com/sitemap.xml`, and `curl -s https://api.example.com/sitemap.xml` lists the home page and every app.
2. **Google Search Console** (search.google.com/search-console): add the property (the `api.example.com` host: a *Domain* property for `example.com` verified by a DNS TXT record
   covers it), then **Sitemaps → Add a new sitemap** → `sitemap.xml`. *URL inspection* on an app page shows what Google sees.
3. **Bing Webmaster Tools** (bing.com/webmasters): add the site (you can import it from Search Console), then **Sitemaps → Submit sitemap** → `https://api.example.com/sitemap.xml`.
   Bing's data also feeds DuckDuckGo and others.
4. Link previews need nothing: Slack, X and iMessage read the Open Graph tags of the app's address. (X caches a card for days; its Card Validator and Slack's
   "unfurl" cache can be refreshed from their own tools.)

Search and sort results (`/?q=…`, `/?sort=…`) are marked `noindex`; every app is in the sitemap. An app whose every version is withdrawn is
`noindex` and left out of the sitemap, and a hidden app (`admin.js hide`) is a 404. The website is served from the `api.` host in this guide;
if you would rather have the site on the bare domain, point that name at the same tunnel and set `REGISTRY_PUBLIC_URL` to it.

### Limits you will meet behind Cloudflare

- Cloudflare's proxy accepts request bodies of **100 MB** (Free and Pro plans). Packages that size and larger must not go through
  `POST /api/publish`: that is why `vmapp publish` and the Loader upload straight to R2 whenever `/api/info` lists `presigned` (the
  default with the s3 backend). The web page's *Publish* form uploads through the registry, so it is capped at 100 MB.
- A request that takes longer than about 100 s to answer is cut off by Cloudflare (HTTP 524). `POST /api/publish/complete` for a
  512 MiB package takes seconds (fetch from R2, hash, verify).

## 6. Try it

From your laptop (the CLI is `vmapp/tools/vmapp`):

```sh
export VMAPP_REGISTRY=https://api.example.com
tools/vmapp pack apps/notes -o /tmp/notes.vmapp
tools/vmapp publish /tmp/notes.vmapp --name "You" --email you@example.com        # save the owner token it prints
tools/vmapp search notes
tools/vmapp get dev.vmapp.notes -o /tmp/notes-got.vmapp                          # follows the 302 to dl.example.com and verifies
```

Then check `https://api.example.com/` in a browser, and that step 3's two `curl`s still answer 403. On the instance:
`docker compose run --rm registry node /app/registry/admin.js verify` re-hashes every package and replays the log.

## 7. Moving an existing registry over

If you already ran the registry with the old `db.json` and `packages/` folders, copy that directory to the instance (for example to
`/srv/vmapp-old`), stop the registry, and run the migration once. The old folder is only read:

```sh
docker compose stop registry
docker compose run --rm -v /srv/vmapp-old:/old:ro registry node /app/registry/admin.js migrate --from-db /old --dry-run
docker compose run --rm -v /srv/vmapp-old:/old:ro registry node /app/registry/admin.js migrate --from-db /old
docker compose up -d
```

It writes the packages and the event log into the bucket and checks the result against the old database; running it again does nothing.
Owner tokens keep working.

## 8. Running it

| Task | How |
|---|---|
| Logs | `docker compose logs -f --tail 100` |
| Update | `git pull && docker compose up -d --build` (the old container stops first, releasing the writer lease; downtime is seconds) |
| Check the data | `docker compose run --rm registry node /app/registry/admin.js verify` (safe while the server runs) |
| What it holds | `… admin.js status` |
| Take an app down | `docker compose stop registry`, `… admin.js hide <id> --reason "…"`, `docker compose up -d` (a tombstone; nothing is deleted; `unhide` lifts it) |
| Clean up garbage | `docker compose stop registry`, `… admin.js gc` (lists), `… admin.js gc --confirm`, `docker compose up -d` |
| Rotate the R2 token | create a new token (step 2), edit `.env`, `docker compose up -d`, then delete the old token in Cloudflare |
| Stop for good | `docker compose down` (the data is in the bucket) |
| New instance | install Docker, copy `.env`, `docker compose up -d --build`: it rebuilds everything from the bucket |

The writer commands (`hide`, `unhide`, `gc --confirm`, `migrate`) refuse to run while the server is up ("this command changes the log").

Monitor `https://api.example.com/api/stats` from an uptime service; the container also reports its own health.

### Troubleshooting

| You see | Meaning |
|---|---|
| `another registry process is writing to this bucket` | Another server (another machine, an old container, a forgotten test) holds the lease. Stop it. After a crash, wait up to 60 s: the lease expires and a restart takes it over by itself. |
| `FATAL: the event log cannot be written` and the container restarts | R2 refused or lost writes (outage, expired or deleted token, wrong clock). It rebuilds from the bucket when it comes back. Look at the line before. |
| `SignatureDoesNotMatch` / `RequestTimeTooSkewed` | Wrong secret, or the instance's clock is off by more than a few minutes (check `timedatectl`). |
| `WARNING … is publicly readable` | The public address serves more than `blobs/`. Fix the WAF rule in step 3. |
| `vmapp get` says "refusing: … SHA-256" | The bytes served from `dl.<domain>` are not the package the registry announced. Something altered or replaced the object, or a cache serves a stale one. The client throws the file away. Run `admin.js verify`. |
| `publish failed: the upload to the registry's storage … HTTP 403` | The upload address expired (15 minutes) or the file changed size; run the command again. |
| Start-up takes long | The server replays every event since the last snapshot. Run `admin.js snapshot`, or lower `REGISTRY_SNAPSHOT_EVERY`. |

## 9. Backups

**The bucket is the backup.** It holds the event log, the snapshots and every package, written once and never changed by the registry,
and R2 keeps its data redundantly. What it does not protect you from is losing access to the bucket (an account problem, a deleted bucket,
a leaked token used maliciously). For that, keep a second copy somewhere else:

```sh
# the log and snapshots as one file (small; includes publisher e-mail addresses: store it privately)
docker compose run --rm -v /srv/vmapp-backups:/backups registry \
  node /app/registry/admin.js export --out /backups/registry-$(date +%F).tar

# the packages: copy blobs/ to another provider or another R2/S3 bucket, never deleting there (blobs are immutable)
rclone copy r2:vmapp-registry/blobs other:vmapp-registry-copy/blobs --immutable      # configure the rclone remotes with their own credentials
```

Run the `export` from cron, say weekly, and copy the tar off the machine. To restore: create a bucket, put the tar's `events/` and
`snapshots/` files back under the same names (and `blobs/` from the second copy), point `.env` at the bucket, `docker compose up -d`,
then `admin.js verify`. Copy `blobs/` before `events/` if you copy while the registry runs, so that no event is copied without its package.

## 10. What it costs

Cloudflare R2 list prices at the time of writing (check [developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/)):

| Item | Price | Notes |
|---|---|---|
| R2 storage (Standard) | **$0.015 per GB-month** | first 10 GB-month free |
| R2 Class A operations (PUT, COPY, LIST) | $4.50 per million | first 1 million per month free. A publish costs about 10; a registry start costs a few LISTs. The writer lease renews every 15 s: about 173,000 PUTs a month, inside the free tier. |
| R2 Class B operations (GET, HEAD) | $0.36 per million | first 10 million per month free. Each download is one (fewer with the cache rule); a registry start reads one object per event since the last snapshot; lease checks add about 173,000 a month. |
| R2 egress (downloads, to Cloudflare, to EC2) | **$0** | this is why the packages are served from R2 |
| Cloudflare Tunnel, DNS, WAF custom rules, cache rules | $0 | Free plan |
| Domain | at cost, about $10 a year for a `.com` | Cloudflare Registrar |
| EC2 | your existing instance | |
| EC2 data transfer **out** | $0.09 per GB after the first 100 GB a month | **avoided**: downloads and big uploads never touch the instance, because downloads redirect to R2 and publishes go straight to R2 |

Examples:

| Registry | R2 per month | What serving the same downloads from the EC2 instance would have added |
|---|---|---|
| 50 apps, 5 GB stored, 2,000 downloads of ~50 MB (100 GB) | $0 (inside the free tiers) | about $0 (inside the free 100 GB) |
| 200 apps, 40 GB stored, 10,000 downloads of ~100 MB (1 TB) | about $0.45 (storage; the operations stay inside the free tiers) | about $81 |
| 1,000 apps, 300 GB stored, 100,000 downloads of ~100 MB (10 TB) | about $4.35 (storage; the operations stay inside the free tiers) | about $890 |

## 11. Checklist

- [ ] `.env` is mode 600, only on the instance, in no repository, no chat, no log.
- [ ] The R2 token is scoped to the one bucket.
- [ ] `dl.<domain>/lease/writer.json` answers 403.
- [ ] The `staging/` lifecycle rule (2 days) exists.
- [ ] No inbound port is open for the registry (tunnel), or only Cloudflare's ranges on 443.
- [ ] One registry container, nowhere else.
- [ ] A second copy exists (weekly `export`, `blobs/` copied elsewhere).
- [ ] The cache rule for the public pages exists and does not cover `/api/*`, `/publish`, `/publisher` or `/verify` (step 5); the sitemap is submitted to
      Google Search Console and Bing Webmaster Tools.
- [ ] `REGISTRY_PUBLIC_URL` is the `https://api.` address (it also makes the canonical links and the sitemap); the verification e-mails (the registry has no SMTP client: by default they are
      written to `/data/outbox` inside the container, see `REGISTRY_MAILER` in `.env.example`) are understood to need a real mailer module
      before publishers can verify their e-mail address.
