# Design: what each app costs (disk and memory) and the storage edge cases (planning)

Status: planning notes, 2026-10-16. Nothing here is built yet. The maintainer's decision: keep the current design, watch
how it is received, and act on the items below when they become real problems. The reset plan is in
[RESET.md](RESET.md).

## The layout (as built)

A "VM" here is **not** a disk image per app. The design is already "one fixed operating-system disk, shared, plus a
small space per app":

- **Shared, read-only, stored once per Mac:**
  - the kernel (7.6 MB) and init (0.5 MB);
  - the runtime images: `native` 0.2 MB, `node22` 116 MB, `dotnet8` 106 MB (`node22-gpu` 120 MB, experimental).

  Every app that uses `node22` boots from the same `node22.img` file, whether there is 1 app or 100.
- **Per app:**
  - its package (the app's own code: Notes 28 KB, Hasher 0.5 MB, Ollama 48 MB, Ollama desktop 111 MB);
  - its `data/<id>/` folder (whatever the app saves).
- **Per running app:** memory. Stopped apps use no memory and no CPU.

## Measured costs (M4 Max, October 2026)

| | 1 app | 20 Node apps |
|---|---|---|
| Disk, shared | `node22.img` 116 MB (once) | 116 MB (once) |
| Disk, per app | package + its data (Notes: 28 KB + data) | 20 × (package + data), see edge case 1 |
| Memory, while running | ~30 MB (minimal core) to ~140 MB (a Node core), `tools/bench boot` | about 20 × 140 MB if all 20 run at once |
| Memory, stopped | 0 | 0 |

The default memory ceiling is 256 MiB per VM (the manifest recommends it; the user chooses). macOS gives a VM real
memory only as it touches it, so the ceiling is not what it costs.

## Edge cases

| # | Case | What happens today | Matters when | Options |
|---|---|---|---|---|
| 1 | **App code stored twice, every version kept** | Install keeps the unpacked version (`apps/<id>/<version>/`) and the package file (`apps/<id>/pkg/<version>.vmapp`, kept for Publish). Each update adds both again; nothing prunes old versions. | Big apps updated often: Ollama desktop is about 220 MB per version. | Keep one form (the package, unpacked on launch, or the unpacked folder, repacked for Publish). Keep the current version plus one previous (for rollback) and prune the rest. |
| 2 | **App code lives in memory** | The guest unpacks the app's code into a tmpfs (`/rt/app`), so a 96 MB core uses about 96 MB of the VM's memory for the whole run. | Big apps (Ollama desktop, Terminal: about 100 MB each). | Ship the core as a read-only EROFS image like the runtimes, so pages load on demand and can be evicted. This changes the package and guest format, so it is a SPEC change. |
| 3 | **`/tmp` is in memory** | `TMPDIR=/tmp` is a tmpfs, so a 2 GB temp file needs 2 GB of the VM's memory. Installers (npm, pip) unpack there. | Apps that unpack large archives or build things. | Point `TMPDIR` at a disk-backed folder cleared at each start (part of the cache layer in RESET.md). |
| 4 | **Memory is not handed back** | A balloon device is attached (`host/src/shim/vz_shim.m`) but never driven. A VM that peaks at 2 GB keeps holding it until it stops. | Long-running apps with memory spikes. | Drive the balloon from the loader when a VM is idle, or under host memory pressure. |
| 5 | **No per-app disk limit** | `/data` is a plain host folder, and APFS has no per-folder quotas. A buggy or hostile app can fill the Mac's drive. | Any untrusted app: this is a denial-of-service hole, the one item to fix before a public release. | Soft limit: the loader watches the size, warns, then pauses the app at the limit (keeps plain, inspectable folders). Hard limit: a per-app sparse disk image with a maximum size (enforced by the filesystem; needs ext4 in the kernel, files no longer plain on the host). |
| 6 | **Disk full** | Writes fail inside the app (`ENOSPC`). The loader says nothing. | Any time the Mac is nearly full. | The loader warns on low space and shows which app is growing (the storage report in RESET.md). |
| 7 | **Same big file in two apps** | Two apps that download the same 4.7 GB model store it twice. Apps never share, by design. | Several AI apps. | Later: an opt-in, read-only, hash-addressed shared store (for example for models), verified by hash so no app learns what another stored. Ties to "app groups" (SPEC §2.2 Future). |
| 8 | **Runtime copies** | The loader puts runtimes in its data folder as instant APFS clones, which are free on the same drive. From another drive (as in development, running from ResearchTest) it is a real copy, about 220 MB. Old runtime versions are never removed. | Loader on an external drive; runtime updates. | Remove runtime images that no installed app uses. |
| 9 | **Logs grow without limit** | `logs/<id>.console.log` is appended to, with no rotation. | Chatty long-running apps. | Rotate at a size (for example 10 MB × 3). |
| 10 | **Time Machine backs up caches** | Everything in the loader's data folder is backed up, including model files and package caches. | Large models. | Exclude the cache layer from backups (`tmutil addexclusion`) once it exists (RESET.md). |
| 11 | **Downgrade after a data migration** | Rolling back with Versions may meet data written by the newer version. | Apps that change their data format. | A restore point (APFS clone of `/data`) before every update (RESET.md). |
| 12 | **Memory pages are not shared between VMs** | Each running VM reads the runtime into its own memory: the host caches the file once, but every guest holds its own copy of what it uses. This is most of the ~140 MB of a Node app. | Many apps running at once. | Accept it (it is the price of isolation), or look at shared-memory mappings later if the hypervisor allows it. |

## Rejected: all apps in one shared VM

One VM for every app would save the per-VM memory in edge case 12, but apps could then see and attack each other's files
and processes. That removes the main promise (each app reaches only what you granted it). The per-app VM costs memory
only while an app runs, and disk only for the app's own code and data, so it stays.

## Order when these become real

1. **Before a public release:** edge case 5 (disk limit), with 6 (disk-full warning).
2. **When big apps get updates:** edge case 1 (stored twice, version pruning).
3. **When users run several big apps:** edge cases 2, 3 and 4 (memory).
4. With the reset work: edge cases 10 and 11. Edge cases 7, 8, 9 and 12 when someone reports them.
