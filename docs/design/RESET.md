# Design: app state layers and reset (plan, not built yet)

Status: plan agreed with the maintainer on 2026-10-16. Reset of everything exists today (Reset… on a card); this
document plans precise, undoable resets. Build order is at the end. The maintainer's decision: build it only when users
need it. What each app costs in disk and memory, and the storage edge cases, are in [STORAGE.md](STORAGE.md).

## Today

Each app runs in its own VM. Every launch starts from a clean, read-only system:

| In the VM | Comes from | Persistent? |
|---|---|---|
| `/` (OS + language runtime) | the shared runtime image, read-only | can't be changed |
| `/app` (the app's code) | the package, read-only | can't be changed |
| `/tmp`, `/run` | memory | lost at every stop |
| `/data` (also `$HOME`) | the app's own host folder `data/<id>/` | yes |
| `/host/...` | folders the user granted | yes (the user's folders) |

**The problem:** anything an app installs or caches (npm, pip, NuGet, toolchains, models) can only persist in `/data`,
because `HOME=/data`. Over time the user's real data and re-creatable installs are mixed together, so the only reset
available is all-or-nothing.

## Plan: three layers, each resettable on its own

| Layer | In the VM | Holds | Reset |
|---|---|---|---|
| **Data** | `/data` | what the user would be upset to lose: documents, chats, settings, accounts | "Reset everything" only |
| **Cache** | `/cache` (new host folder `cache/<id>/`) | anything re-creatable: package-manager caches, downloaded toolchains, build outputs, model files the app declares as cache | "Clear cache": always safe; the app re-downloads |
| **System changes** | a per-app writable overlay over the read-only runtime (new) | what an app installs "into the OS" (`apt install`, `npm -g`, system `pip`) | "Undo system changes": back to the pristine runtime; data and cache kept |

1. **Cache.** The guest sets the standard variables, so tools use `/cache` without app changes:
   - `XDG_CACHE_HOME=/cache`
   - `npm_config_cache=/cache/npm`
   - `PIP_CACHE_DIR=/cache/pip`
   - `NUGET_PACKAGES=/cache/nuget`
   - `CARGO_HOME=/cache/cargo`
   - `GOMODCACHE=/cache/go`
   - `OLLAMA_MODELS` (where it applies)

   The SDK adds `app.getPath('cache')`. The manifest can declare which `/data` subfolders are cache, for example
   `"storage": {"cache": ["models"]}`, mounted from the cache folder. This is a SPEC change: §4 guest contract and
   §2.2 manifest.
2. **System changes.**
   - **Mechanism:** overlayfs, with the read-only runtime as the lower layer and a per-app upper layer stored in a
     sparse disk-image file `system/<id>.img` (ext4) that is attached as a third disk.
   - **Reset:** "Undo system changes" deletes that file.
   - **Requirements:** kernel `CONFIG_OVERLAY_FS` and `CONFIG_EXT4_FS` (currently forbidden in the default flavour; a
     governed change), plus a guest mount step.
   - **Opt-in:** the layer is per-app (`"core": {"systemChanges": true}`). Most apps never need it and keep the purely
     read-only root.
3. **Restore points with APFS clones.**
   - **Automatic before every reset:** the loader takes an instant copy-on-write clone (`clonefile`) of the app's
     data, cache and system files, so "Undo reset" works for 14 days (configurable).
   - **Manual restore points:** "Save a restore point", with a list to roll back to.
   - **Cost:** clones use almost no space until files change.
4. **Card actions**, from safest to strongest: **Clear cache**, **Undo system changes**, **Reset everything**. Each
   offers **Undo** for its retention period. A **storage report** shows the Data, Cache and System sizes and the
   restore points.
5. **Versions:**
   - **Across app updates:** data and cache persist.
   - **Runtime updates:** the system layer is tied to the runtime version, so an update asks whether to keep the
     layer (on an unchanged ABI) or reset it, with a restore point first.

## Rejected alternatives

- **A full frozen VM disk per app:** heavy (a full disk per app), and it mixes data with the system again.
- **Tracking every file an app writes:** fragile and slow, and it misses what tools write outside known paths.

## Build order

1. **Cache layer** (soon, before users accumulate data, because it moves where things live). Includes a one-time
   migration that moves known cache paths out of `/data`.
2. Restore points (APFS clones) plus "Undo reset" for today's Reset.
3. Clear cache button and storage report.
4. System-changes overlay (kernel flavour change, opt-in manifest flag).
