# Contributing to D9010 VmApp

**For:** people and AI agents who change the D9010 VmApp platform itself: the loader, the host library, the launcher, the
guest, runtimes, SDKs and tools.
- Building an app on D9010 VmApp: [docs/BUILDING-APPS.md](docs/BUILDING-APPS.md).
- Converting one: [docs/CONVERTING.md](docs/CONVERTING.md).

Read these first, in this order:
1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together (15 minutes).
2. [GOVERNANCE.md](GOVERNANCE.md): **the invariants**. They can't be broken by a contribution.
3. [SPEC.md](SPEC.md): the contract, for the parts you touch.

---

## 1. What you need

You do not need all of it. Pick the part you work on (`launcher`, `kernel`, `vm`, `apps`, `gpu`) and run `bash tools/doctor <part>`: it checks
exactly what that part needs and prints the command for anything missing. The README's "Contributing: set up only the part you work on" has the
table. Most of the project (the launcher, the host library, the SDK, the registry, the docs and their tests) needs only Node.js 22. The table below
lists every tool for the whole project; [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) gives the tested versions, what is inside the build containers and how each is pinned.

| Tool | For | Notes |
|---|---|---|
| macOS 13+ on Apple silicon | the launcher and real-VM tests | Virtualization.framework |
| Xcode command-line tools | the Objective-C shim, `codesign` | `xcode-select --install` |
| Rust (1.90.0 is the tested version) + the `aarch64-unknown-linux-musl` target | `host/`, `guest/`, `tools/mkcpio`, the Rust sample | `rustup target add aarch64-unknown-linux-musl`; the guest links with `rust-lld`, which ships with rustup toolchains |
| Node.js 22 | `hostlib`, CLI, SDK tests, loader | no npm dependencies outside `loader/` devDependencies |
| Docker | the guest kernel (`kernel/build.sh`), the runtime images (`tools/mkruntime`) and the examples that compile Linux software (.NET, Ollama, local LLM, VS Code) | build time only; never needed at run time. Docker Desktop, or Lima if you want the engine's data on another disk ([docs/TOOLCHAIN.md](docs/TOOLCHAIN.md)) |
| git | `gpu/build.sh` clones the pinned llama.cpp source for the GPU server | build time only |
| cmake (optional) | the GPU server (`gpu/build.sh`, run by `tools/build.sh`) | `brew install cmake`; without it `tools/build.sh` skips the GPU server with a hint, and `--no-gpu` skips it on purpose |
| Network (first build) | the Linux source (checksum and signature checked), the llama.cpp source and the Docker base images; the loader's first `npm start` downloads the Electron binary | later builds use the caches in `out/work/`; `--offline` keeps cargo off the network |

**Everything is in this repository.** No sibling folder is needed (apart from the tools above), and the scripts write only to `out/` (products)
and `out/work/` (scratch files and caches: the cargo target folder, the kernel source download, test data), both
git-ignored. Set `VMAPP_WORK=/some/folder` to put the scratch space elsewhere; the build scripts, `tools/` and the
suites under `tests/` honour it.

**Rust toolchain detection** (`tools/lib/rust-env.sh`, used by `tools/build.sh` and `apps/hasher/build.sh`): if you set
`RUSTUP_HOME`/`CARGO_HOME`, those are used. Otherwise a sibling `../_toolchains/{rustup,cargo}` is used if it exists
(a convenient place to keep toolchains next to the checkout). Otherwise `cargo` and `rustc` come from `PATH`. The scripts check that the musl
target and the linker are present and print the command to install what is missing. `CARGO_TARGET_DIR` defaults to
`$VMAPP_WORK/target`; `CARGO_NET_OFFLINE=true` (or `tools/build.sh --offline`) keeps cargo from using the network.

## 2. Build and test

```sh
tools/build.sh                         # guest init, initramfs, mkcpio, vmapp-vm (signed ad hoc), kernel
tools/mkruntime runtimes/node22 out/runtimes/node22.img    # the runtime images (also native, dotnet8); rebuild when one changes
tools/vmapp runtime-install node22 out/runtimes/node22.img # to run apps from the command line (the loader installs the runtimes itself at start)
cd loader && npm ci && cd ..           # the loader's dev dependency (Electron)

tools/check-invariants                 # mechanical invariant checks: must pass
node --test tests/unit/                # host library, SDK, CLI
tests/e2e.sh                           # launcher + VM contract, real VMs (about 35 s measured on an M-series Mac once the build is done)
tests/apps/run-all.sh                  # sample apps, real VMs
tests/net/run.sh                       # the network permission end to end: a Node app, a real VM, the real npm registry (skips offline)
(cd host && cargo test)                # launcher unit tests, including the network proxy and the host-service tunnel (host/src/net.rs)
(cd tests/guest-net && cargo test)     # the guest's proxy and service listener (guest/src/netproxy.rs), natively (the guest itself only builds for Linux)
tests/gpu/run.sh                       # the GPU capability on this Mac: the sandboxed Metal server, a llama.cpp client from the pinned commit (builds it, downloads a 369 MiB model once)
node --test tests/gpu/vm-rpc.test.js   # an app in a real VM talks llama.cpp's RPC protocol to that server (needs out/gpu from gpu/build.sh)
tests/template/run.sh                  # the starter template, as a user would copy it
tests/convert/run.sh                   # the conversion examples
(cd loader && node test/loader-cdp.mjs)   # the loader: security settings, UI flow, lifecycle (real VMs)
```

Run the suites that cover what you changed, plus `check-invariants` and the unit tests always. A pull request lists
which suites it ran and their results.

**The guest kernel** is built from source by `kernel/build.sh` (called by `tools/build.sh`): the pinned Linux release is
downloaded once into `out/work/cache/kernel/`, verified against kernel.org's PGP-signed checksums, and built with a
trimmed `allnoconfig`-based config (`kernel/vmapp-guest.config`) in a digest-pinned Ubuntu container, then the final config
is checked against `kernel/kconfig-required.txt` and `kconfig-forbidden.txt`. The result, `out/Image`, is rebuilt only
when something in `kernel/` changes. Useful variants:

```sh
kernel/build.sh --config-only          # seconds: merge the config and run the required/forbidden check
tools/build.sh --kernel-from PATH      # use a prebuilt Image (no Docker), e.g. from a release
VMAPP_KERNEL=/path/to/Image tests/e2e.sh    # boot another kernel in the tests (also tests/apps/run-all.sh and the CLI)
```

A kernel change (`kernel/`) needs the same suites as a guest change: `tests/e2e.sh` and `tests/apps/run-all.sh` (they run
Node.js and .NET cores on it), and the PR lists the new `Image` size and sha256.

## 3. Where to change what

| You want to… | Change | Protected? (GOVERNANCE §2) |
|---|---|---|
| speed up boot or delivery in the launcher | `host/src/lib.rs` | yes: keep the contract, add tests |
| change guest mounts or start-up | `guest/src/*` | yes |
| add a field to the manifest | `SPEC.md` first (proposal), then `hostlib/manifest.js` | yes |
| add a bridge request op | `SPEC.md` first, then `hostlib/session.js` + the SDK + a denied-path test | yes |
| improve the loader's UI (library, inspector) | `loader/ui/*`, `loader/src/library.js`, `inspector.js` | no, except consent screens (B5) |
| change app-window security, the protocol handler or CSP | `loader/src/window-manager.js`, `protocols.js`, `preload-app.js` | **yes** |
| add an SDK convenience (no protocol change) | `sdk/node/vmapp.js` | no |
| add an SDK for another language | `sdk/<lang>/` | no |
| update a runtime (for example a Node patch release) | `runtimes/<name>/Dockerfile` (new digest) | yes |
| change what the GPU server may do, or move to another llama.cpp commit | `gpu/rpc-server.sb` (and the `h7-gpu-service` rule, which lists every allowed rule), `gpu/pins.env` (tag, commit, protocol; check the RPC protocol version and tell app developers: their clients are built from the same commit) | **yes** (INV-H7) |
| change the guest kernel (version, config, required/forbidden lists) | `kernel/` (`pins.env`, `vmapp-guest.config`, `kconfig-*.txt`) | not listed in GOVERNANCE §2 yet; treat it like `guest/`: a kernel option is attack surface, so say why in the pull request |
| CLI commands and tools | `tools/vmapp`, `tools/*` | no (except `check-invariants`) |
| docs, samples, templates | `docs/`, `apps/`, `templates/`, `examples/` | no (except GOVERNANCE and REVIEWING) |

## 4. Rules for every change

1. **Invariants first.** If a change needs an invariant to bend, stop: open a spec proposal (GOVERNANCE §4)
   instead.
2. **Spec and code move together** (INV-G1). An observable behaviour change updates `SPEC.md` in the same pull
   request.
3. **Prove the denied path** (INV-G2). Security-relevant code gets a test that the forbidden thing still fails.
4. **No new dependencies** in `hostlib/`, `sdk/`, `host/`, `guest/` or `tools/` without a strong reason in the pull
   request. The loader's runtime dependencies stay empty. Its dev dependencies are Electron plus the packaging tools
   (`@electron/packager`, `@electron/fuses`), all pinned exactly.
5. **Never panic in the launcher or init** (INV-E2): no `println!`/`eprintln!` in `host/`, and no
   `unwrap`/`expect` in `guest/` outside tests.
6. **Pin and reproduce:** base images are pinned by digest, builds are deterministic, and tests check
   reproducibility where they already do.
7. **Copied code** from other projects carries a header naming its source and licence.
8. **Licence of contributions.** The project is under the [MIT licence](LICENSE); a contribution is accepted under it. Code under another licence belongs in
   [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), not in an MIT file.
8. **No secrets** anywhere: not in code, tests, logs or command lines.

## 5. Pull requests

- **One topic per pull request.** Spec proposals are separate from implementations.
- **The description states:**
  - what changed;
  - why;
  - which invariants are touched (IDs);
  - which suites were run, with results;
  - for protected paths, the threat reasoning ("a malicious app could … but …").
- **Review:** every pull request is reviewed against [docs/REVIEWING.md](docs/REVIEWING.md), often by an AI agent
  first. Protected-path changes always need the maintainer's approval.
- **Commits:** imperative subject lines. Mention invariant IDs when relevant (`host: reuse slots round-robin
  (INV-D5)`).

## 6. Good first contributions

- **Round-robin slot allocation in `host/`:** it reduces the chance of a lingering mount on slot re-use, which is a
  known open issue.
- **An SDK for Python or Go** (`sdk/<lang>/`), implementing [docs/PROTOCOL.md §7](docs/PROTOCOL.md).
- **Inspector improvements:** export traffic as a file, search across apps.
- **More conversion examples:** a Python Flask app, once a Python runtime exists; a Tauri app.
- **Windows or Linux launchers:** see [docs/PLATFORMS.md](docs/PLATFORMS.md). Larger; talk to the maintainer first.
