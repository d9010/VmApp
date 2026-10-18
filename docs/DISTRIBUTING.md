# Distributing D9010 VmApp apps

**For:** app publishers (how to share an app) and users (how to get one). Running a registry server:
[../registry/README.md](../registry/README.md). Building the app first: [BUILDING-APPS.md](BUILDING-APPS.md).

---

## 1. Sharing an app: the short version

An app is one file, `my-app-1.0.0.vmapp`. Make it with `vmapp pack`. Then pick **either**:

- **Any file host.** Put the file on a website, a GitHub release, a file share, an email. Users download it and choose
  *Install from file…* in the D9010 VmApp Launcher. Nothing else is needed; the file checks itself.
- **The registry.** Publish it once and people can find it, search it and get it with one command.

Either way the user sees the same permission sheet before anything is installed, and the same sandbox runs the app.

## 2. Publishing to a registry

```sh
vmapp pack . -o my-app-1.0.0.vmapp
vmapp publish my-app-1.0.0.vmapp --registry https://registry.example.org \
    --name "Your Name" --company "Your Company" --email you@example.com --url https://example.com
```

(`--registry` defaults to `$VMAPP_REGISTRY`, then `http://127.0.0.1:8790`. You can also use the *Publish* page on the
registry's website.)

The server checks the package with the same code the Loader uses: every hash, the entry order, the size limits. A bad
package is rejected with the exact reason, so run `vmapp verify` first if you want to see it locally.

### Your owner token

The first time you publish an app id, the registry creates a **publisher** for you and prints an **owner token**:

```
owner token: 9f2c...e1
SAVE IT NOW: the registry shows it once and keeps only a hash, so it cannot recover it.
```

- `vmapp publish` saves it in `$VMAPP_HOME/publish-tokens.json` (readable by you only) and uses it for later versions.
- On another machine, pass it with `--token`, or put it in `$VMAPP_PUBLISH_TOKEN` (the command line shows up in `ps`
  and shell history; the environment variable and the saved file do not).
- There are no accounts and no password reset. **If you lose the token you cannot publish new versions of that app.**
  Anyone who has it can publish as you, so keep it private.
- To publish a *second* app under the same identity, pass the same token: `vmapp publish other.vmapp --token ...`.

### Versions

- Versions are **immutable**. You cannot replace `1.0.0`; fix mistakes by publishing `1.0.1`.
- A new version must be **higher** than the latest one (semver: `1.2.0` > `1.1.9`; `1.0.0` > `1.0.0-beta.1`).
  Publishing an older version is refused.
- The app page lists every version (date, size, downloads); users can download any of them
  (`vmapp get my.app --version 1.0.0`).
- Everything in the package is public, including your core's code.

**What your version numbers mean to users.** Users choose in the D9010 VmApp Launcher how each app updates, and the choice
reads your version number:

| Users pick | They get |
|---|---|
| **Stay on this version** | nothing, until they choose a version themselves |
| **Latest compatible** | the highest version with the **same major** as theirs (while you are `0.x`: the same *minor*) |
| **Always latest** | the highest version, whatever it is |

So **bump the major version for a breaking change** (`1.4.2` to `2.0.0`): a change to how your app reads or writes its
data that old versions cannot handle, a feature removed, a folder it asks for that changes meaning. Users on *Latest
compatible* are never moved across it. Use minor for new features and patch for fixes; both stay inside the same major.
While you are `0.x`, a new minor (`0.2.0`) counts as the breaking step, so use `0.1.x` for fixes only.

Things that hold whatever the user chose:

- An update that asks for **more access** (a new folder, a folder changed from read to read-write, dialogs, web links)
  always stops and asks the user first.
- Your app's data folder is shared by all versions. If you change its format, read the old format too, or migrate it:
  users can go back to an older version, and that is at their own risk.
- A **prerelease** (`1.3.0-beta.1`) is never picked by *Latest compatible* or *Always latest* for a user on a stable
  version. A user already on a prerelease follows the prereleases of that same `x.y.z` and ends on its release.
  Publish prereleases to let people opt in by choosing the version by hand.

### Withdrawing a version

If a version turns out to be bad (it loses data, it crashes at start), you cannot replace it, but you can withdraw it:

```sh
vmapp withdraw my.app 1.4.0 --reason "Corrupts the notes file; use 1.4.1"
vmapp restore  my.app 1.4.0                  # undo it
```

It needs your owner token (saved by `vmapp publish`, or `--token`, or `$VMAPP_PUBLISH_TOKEN`). The reason is required,
plain text, up to 200 characters, and it is **public**. A withdrawn version:

- is never picked by *Latest compatible* or *Always latest*, and is not what `latest` downloads or the app page
  offers as the newest version;
- is still downloadable by its exact number (people who already depend on it, or want to look, can still get it), and
  the app page and the Loader show it as *Withdrawn* with your reason;
- does not free its number: you still publish the fix as a higher version (`1.4.1`).

Withdrawing does not remove it from machines that already installed it. Publish the fixed version too, so that
*Latest compatible* has somewhere to go.

### What users see about you

Users see **only what is verified**. What you type is not shown until it is backed by proof.

| You have done | Users see |
|---|---|
| nothing (the default) | **Unverified publisher**. Not your name, company, website or email, and not the `publisher` text in your manifest. |
| confirmed your email | **Verified email @example.com**: the part after the `@`, nothing else. |
| proven you control a domain | **Verified: example.com**, plus your **company name**, plus your **website** if it is on that domain (or a subdomain). |

Your personal name is never shown. Searching also only looks at verified facts, so an unverified claim cannot make an
app appear for a name it does not own.

**Verify your email.** Open the registry's `/publisher` page, paste your owner token, check your details, and press
*Send verification email*. Open the link in the message within 15 minutes and press the button. (The code works once.)

**Verify a domain.** On the same page enter your domain and press *Get my token*. Then do **one** of:

1. serve a file at `https://example.com/.well-known/vmapp-publisher.txt` whose content is exactly the line
   `vmapp-publisher=<your token>`, or
2. add a DNS `TXT` record on `_vmapp.example.com` with the value `vmapp-publisher=<your token>`.

Press *Check now*. The registry fetches the file over HTTPS (no redirects) or looks up the record. A domain can be
verified by one publisher at a time.

Signatures (proof that *this file* came from you) and real accounts come later. Today the levels prove that you control
an email address or a domain; they do not prove who wrote the code.

### How downloads are counted

The app page shows total downloads, with the last 30 days kept separately. A download counts once per client address
and version per day, and the registry keeps no addresses. Downloads are the only popularity signal: the Loader never
reports launches or usage, so nothing about how people use your app is known to anyone.

## 3. Getting an app (users)

- **From a website or a friend:** download the `.vmapp` file, open the D9010 VmApp Launcher, choose *Install from file…*, pick it. The
  Loader shows the app's name and the **permissions it asks for** before it installs.
- **From the registry, in the Loader:** *Browse registry…* (⇧⌘B) lists the launcher's registry, newest apps first, with a search box and a
  choice of order; *Install* on one shows the usual review and permission sheet before anything is installed.
- **From a registry's website:** browse it (Popular, New, Updated, or search), open the app page, read *This app will
  ask for:*, and press *Download*. Or from a terminal:

```sh
vmapp search notes                         # find apps; --sort new|updated
vmapp get dev.vmapp.notes                  # download the latest to ./dev.vmapp.notes-1.0.0.vmapp
vmapp get dev.vmapp.notes --install        # download and install it into your D9010 VmApp Launcher
vmapp get dev.vmapp.notes --version 1.0.0 -o notes.vmapp
vmapp get dev.vmapp.notes --choice compatible --from 1.0.0   # what "Latest compatible" would pick for 1.0.0
vmapp get dev.vmapp.notes --choice latest                     # the highest version that is not withdrawn
```

`--choice` asks the registry which version to take and then downloads exactly that one (`--from` defaults to the
installed version). It never picks a withdrawn version and never goes lower than `--from`. Asking for a withdrawn
version by its exact number still works, and prints the publisher's reason as a warning.

**Updates.** After you install an app, the Loader lets you pick how it updates: *Stay on this version*, *Latest
compatible* or *Always latest* (see §2, Versions). The app page lists every version, and a withdrawn one shows
*Withdrawn* and the publisher's reason. A new **major** version (or a new minor while the app is `0.x`) is a breaking
change, which *Latest compatible* does not cross.

`vmapp get` does not trust the server. It checks that the file's SHA-256 is the one the registry announced, verifies
the whole package (every file hash), recomputes the package id from the file and compares it with the id the registry
sent, and confirms the file is the app and version you asked for. If anything differs it refuses and leaves no file.
This also covers a registry that keeps its packages in cloud storage: it answers with a redirect to the file, `vmapp get` follows
that one redirect, and the checks above (against what the *registry* announced) are what make the storage untrusted.
Only the registry commands (`publish`, `search`, `get`, `withdraw`, `restore`) use the network, and only when you run
them; the Loader contacts a registry only for an app installed from one whose update choice is not *Stay on this
version*, or when you press *Check for updates* (SPEC §8.1).

## 4. The trust model

Be clear about what each layer promises:

- **The registry checks that a package is well formed. It does not vouch for the publisher.** It does not review code,
  scan for malware, or check that an app does what its description says. There is no moderation yet.
- **The identity levels say who controls an email address or a domain**, nothing more. "Unverified publisher" is the
  honest default, and the web pages say so.
- **You are protected whichever way you got the file**, because of how apps run:
  - the app's code runs in its own VM and sees only folders you grant, with the access you choose;
  - it has no network;
  - the UI is a sandboxed window with no Node and no file access;
  - the permission sheet shows what it asks for and why, and "no" is always possible.

  See [SECURITY.md](SECURITY.md) for the full model and what it does not cover.
- **A malicious app can still misuse access you gave it** (a folder you made read-write can be changed). Grant the
  least you can, prefer *read* or dialog picks, and be more careful with apps from unverified publishers.
- **Package signatures are not in format 1.** Until they are, the package id (the hash of the manifest) identifies
  exactly what you reviewed, but not who made it.

## 5. Running your own registry

`node vmapp/registry/server.js --port 8790 --data /path/to/data`. Put it behind TLS before exposing it. Details,
limits, backup and the API: [../registry/README.md](../registry/README.md).

The registry keeps its data as an append-only event log plus content-addressed packages, in a folder or in an S3-compatible
bucket (Cloudflare R2, AWS S3, MinIO): nothing it stores is ever rewritten, and a withdrawal or a take-down is a mark, not a
deletion ([the Storage section](../registry/README.md#storage)). It runs as a container (`registry/Dockerfile`,
`registry/compose.yaml`); the step-by-step guide for an EC2 instance with Cloudflare, with the costs, is
[../registry/deploy/HOSTING.md](../registry/deploy/HOSTING.md). If you already ran an older registry, `registry/admin.js migrate`
converts its `db.json` and `packages/` folder.

The website's home page and app pages are rendered by the server, so search engines and link previews (Slack, X, iMessage) can read
them. Set `REGISTRY_PUBLIC_URL` to the registry's public address (it makes the canonical links and `/sitemap.xml`), then submit the
sitemap to Google Search Console and Bing Webmaster Tools ([HOSTING.md, "Search engines"](../registry/deploy/HOSTING.md#search-engines)).
A public app page shows the same things as the website always did: the app's name and description, its permissions, and only the
publisher facts that are verified.
