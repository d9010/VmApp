# Publishing an app (people, CLI, loader and AI agents)

**For:** anyone putting an app on a D9010 VmApp registry: by hand, from the loader, from a terminal, or from an AI agent or
CI pipeline. New to D9010 VmApp? Do levels 1–5 of [START-HERE.md](START-HERE.md) first; you don't need a registry to build,
test or share an app. For trust levels (verified publishers) and how downloads are counted, see
[DISTRIBUTING.md](DISTRIBUTING.md).

---

## 1. How ids, URLs, versions and tokens fit together

| Thing | Where it comes from | Changes? |
|---|---|---|
| **App id** (`com.you.myapp`) | `id` in your `vmapp.json`, chosen by you | **never**: it identifies your app everywhere (users' data, grants, the registry page) |
| **App page** | `<registry>/apps/<app id>` | never |
| **Version** (`1.4.2`) | `version` in your `vmapp.json` | bump it for every publish; it must be higher than any version already published |
| **Download URL** | `<registry>/api/apps/<app id>/<version>/download` (or `/latest/download`) | one per version, immutable |
| **Owner token** | returned **once** by your first publish | keep it secret; it's the only proof that later versions are yours |
| **Package id** | the hash of your manifest, printed by `vmapp inspect` | different for every build; it identifies exactly what you published |

**The first publish of an id claims it.** After that, the registry accepts new versions of that id only with its
owner token. One token can own several apps: send it with the first publish of another id, and that app joins your
publisher.

## 2. Build the artifact

```sh
tools/vmapp pack <project dir> -o dist/<name>-<version>.vmapp    # the one file you publish
tools/vmapp verify dist/<name>-<version>.vmapp                   # the same checks the registry runs
tools/vmapp inspect dist/<name>-<version>.vmapp                  # id, version, package id, sizes
```

## 3. Four ways to publish

### 3.1 From the loader (no terminal, no website)
Open the app's card and choose **Publish…** (it works on any installed app; the usual case is a developer build made
with **Run project folder…**, then **Rebuild & run** after each change):
1. Enter the registry address.
2. The first time, leave the owner token empty and enter your publisher details (all optional; see DISTRIBUTING.md,
   "What users see about you", for what is shown publicly).
3. Click **Publish**. You get the app page address and, on a first publish, your owner token once.

The loader uploads the package it installed, keeps your owner token in its own data folder
(`publish-tokens.json`, readable only by you, the same file `vmapp publish` uses) and fills it in for later versions of
the same app. Errors appear in the sheet with the plain-words meaning of §3.4's table. A plain `http://` registry
on another computer gets a warning (development only).

### 3.2 From the website
Open `<registry>/publish` and choose the file. The first time, copy the owner token the page shows; it's shown only
once. For later versions, paste the token into the token field.

### 3.3 From the CLI
```sh
export VMAPP_REGISTRY=https://registry.example.org      # or pass --registry
tools/vmapp publish dist/my-app-1.0.0.vmapp --name "Ada Lovelace" --email ada@example.com
#  → app page URL + owner token (shown once, and saved to $VMAPP_HOME/publish-tokens.json, mode 0600)
tools/vmapp publish dist/my-app-1.0.1.vmapp             # later versions: the saved token is used automatically
```
To use the token on another machine or in CI, set `VMAPP_PUBLISH_TOKEN`, or pass `--token`.

A registry that keeps its packages in cloud storage (`GET <registry>/api/info` lists `"presigned"` among `publishModes`) receives
the file there directly: the CLI and the loader ask `POST /api/publish/init {size, sha256}` for a 15-minute upload address, `PUT`
the package to it, and finish with `POST /api/publish/complete {uploadId}`, where the registry fetches the file and verifies it
exactly as for a direct upload. You notice nothing except that big packages work behind a proxy that limits uploads (Cloudflare:
100 MB). `vmapp publish --direct` sends the file through the registry instead.

### 3.4 From an AI agent or CI (the HTTP API)

**First publish** (it claims the id and creates your publisher):
```sh
curl -sS -X POST "$VMAPP_REGISTRY/api/publish" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Vmapp-Publisher: {"name":"Ada Lovelace","email":"ada@example.com","url":"https://example.com"}' \
  --data-binary @dist/my-app-1.0.0.vmapp
# 201 {"id":"com.you.myapp","version":"1.0.0","packageId":"…","url":"…/app/com.you.myapp","ownerToken":"…"}
```
Store `ownerToken` as a **secret**, for example `VMAPP_PUBLISH_TOKEN` in your CI secrets. Never commit it.

**Every later version:**
```sh
curl -sS -X POST "$VMAPP_REGISTRY/api/publish" \
  -H "Authorization: Bearer $VMAPP_PUBLISH_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @dist/my-app-1.0.1.vmapp
```

**What the responses mean:**

| Status | Meaning | What to do |
|---|---|---|
| 201 | published | report the `url` |
| 400 | the package is invalid (the message says why) | run `vmapp verify`, fix, re-pack |
| 401 | this id exists and you sent no token | use the token from the first publish |
| 403 | the token doesn't own this id | wrong token, or someone else claimed the id; pick another id only if it isn't yours |
| 409 | this version exists or isn't higher | bump `version` in `vmapp.json`, re-pack |
| 413 / 415 | too large / wrong content type | max 2047 MiB (SPEC §2; a registry may set less); send `application/octet-stream` |
| 429 | rate limited (10 publishes per hour per address by default) | wait, then retry |
| 502 / 503 | the registry's storage could not be written | nothing was published; retry later |

For a package larger than the registry's proxy accepts, use the presigned form: `GET $VMAPP_REGISTRY/api/info`; if `publishModes`
lists `presigned`, `POST /api/publish/init` with `{"size": <bytes>, "sha256": "<hex>"}` (same `Authorization` header), `PUT` the
file to the returned `url` (exactly `size` bytes, within 15 minutes), then `POST /api/publish/complete` with `{"uploadId": "…"}` and
the same headers a direct publish uses (`Authorization`, or `X-Vmapp-Publisher` on a first publish). The answers are the same 201
and error codes (plus `400 upload_missing` / `upload_mismatch`, `404 unknown_upload`, `409 upload_changed`).
If the answer to `init` has `"parts": {"size": S, "count": N}`, the package is too large for one request: send it in N parts
instead, part number K (1 to N) as `PUT <url>?part=K` with exactly S bytes (the last part has what is left), in any order and up to
an hour after `init`, then `complete` as above. `vmapp publish` and the launcher's *Publish…* do this for you.

**The agent's procedure** (copy into your agent's instructions):

> To publish the app in `<project dir>` to `$VMAPP_REGISTRY`:
> 1. Read `id` and `version` from `vmapp.json`. Check the app's existing versions:
>    `GET $VMAPP_REGISTRY/api/apps/<id>/versions`. A 404 means a first publish.
> 2. If the id exists, make sure `version` is higher than the highest listed. If it isn't, bump the patch number
>    (or as instructed) in `vmapp.json`.
> 3. `tools/vmapp pack <project dir> -o dist/<name>-<version>.vmapp`, then `tools/vmapp verify` it. Stop on
>    errors.
> 4. Publish with `tools/vmapp publish <file>` (it handles the token), or with the curl calls above using
>    `$VMAPP_PUBLISH_TOKEN`.
> 5. On a first publish, save the returned owner token **only** to the secret store you were given (never to the
>    repository or logs), and tell the human it exists.
> 6. Report the app page URL and the package id.
> 7. Never change the app id to get around a 403. Report it instead.

## 4. Updates, choices and withdrawing

- **Ship an update:** bump `version`, pack and publish. Users see it on the same page.
- **Version numbers mean something to users.** Their loader's *Latest compatible* choice never moves them across a
  major version, so put breaking changes in a new major (`2.0.0`).
- **A bad version:** withdraw it, with a reason users will see. It's never chosen automatically again, but users
  who pinned it can still get it.
  ```sh
  tools/vmapp withdraw com.you.myapp 1.0.1 --reason "Saving fails on large notes; use 1.0.2"
  tools/vmapp restore  com.you.myapp 1.0.1
  ```
  The API equivalents are `POST /api/apps/<id>/<version>/withdraw {"reason":"…"}` and `/restore`, each with the
  owner token.
- **New permissions in an update:** users are always asked before such an update installs, whatever their update
  choice. Explain the change in your description.

## 5. Losing your token

There's no account recovery in this version of the registry. A lost token means you can't publish new versions of
that id. Keep the token in a password manager or secret store. Account recovery comes with publisher accounts, later.
