# The toolchain: what you need, what is in it, and how to set it up

**For:** contributors who want to know exactly what gets installed on their Mac and what runs in the build containers. Nothing here is opaque:
every tool is a normal download with a published checksum, and every container is described by a file in this repository.
To check your machine for the part you work on, run `bash tools/doctor <part>` ([README](../README.md), "Contributing: set up only the part you work on").
Words you may not know (buildx, digest, bind mount, EROFS, …) are explained at the end.

## The tools on your Mac

| Tool | For | Version we tested | How it is pinned | Install |
|---|---|---|---|---|
| macOS 13+ on Apple silicon | the VM launcher and the real-VM tests | macOS 15.7 | n/a | n/a |
| Xcode command-line tools | the Objective-C shim, `codesign`, `clang` | the current ones | n/a | `xcode-select --install` |
| Rust + the `aarch64-unknown-linux-musl` target | `host/`, `guest/`, `tools/mkcpio`, the Rust sample | **1.90.0** | **not pinned by the repository**: only 1.90.0 is tested, newer versions are untested | see below |
| Node.js 22 | `hostlib`, the CLI, the SDK, the registry, the launcher, the tests | 22.15.0 | `loader/package-lock.json` pins the launcher's one dependency (Electron 44.4.5); everything else uses only Node's built-ins | `brew install node@22` |
| Docker (an engine, the `docker` command, and buildx) | the guest kernel, the runtime images, and the examples that compile Linux software (list in the next section) | Docker 28.3.3 | every base image is pinned by digest (below) | Docker Desktop, or Lima (below) |
| git, cmake (optional) | the GPU server (`gpu/build.sh`) | git 2.50.1, cmake 4.3.1 | `gpu/pins.env` pins the llama.cpp source it fetches | `brew install cmake` |

**Installing Rust, with the download checked.** The short way is `curl ... | sh` (see the README); if you would rather verify what you run:

```sh
curl -fsSLO https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init
curl -fsSL https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init.sha256 | awk '{print $1 "  rustup-init"}' | shasum -a 256 -c -
chmod +x rustup-init && ./rustup-init -y --profile minimal --default-toolchain 1.90.0 && . "$HOME/.cargo/env" && rustup target add aarch64-unknown-linux-musl
```

The build scripts find the toolchain through `tools/lib/rust-env.sh`: the `RUSTUP_HOME`/`CARGO_HOME` you set, else a `../_toolchains/{rustup,cargo}` folder
next to the repository if you have one, else `cargo` on your `PATH`. To keep Rust out of your home folder, install it into any folder you like
(`RUSTUP_HOME=<folder>/rustup CARGO_HOME=<folder>/cargo ./rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.90.0`) and export the same two variables before building.

## Docker: which engine, and how to tell

Docker is a **build-time** tool here. It builds the parts that need Linux: the guest kernel, the runtime images, the registry image, the EROFS image tool, and the examples that compile
Linux software (.NET, Ollama, Ollama Desktop, the local LLM, VS Code, the experimental GPU backend). It is never needed to run the launcher or an app.

You need three things on your Mac: a Docker **engine** (the part that runs containers), the `docker` **command**, and its **buildx** plugin. The engine must be arm64: on another
architecture the kernel build warns that it will run under emulation, which can take hours. The project's VM parts are tested only on a Mac with Apple silicon.
There are two common ways to get them:

| Engine | Choose it when | Set up |
|---|---|---|
| **Docker Desktop** | you have room for its disk image on your Mac (it keeps it under your home folder unless you move it in its settings). It includes the command and buildx. | `brew install --cask docker`, then start it |
| **Lima** (an engine in its own small VM) | you want the engine's data on another disk, or its own CPU, memory and disk limits | the section "Docker on another disk with Lima" below |

Which engine is `docker` talking to?

```sh
docker info --format '{{.Name}}'    # docker-desktop = Docker Desktop;  lima-vd = the Lima engine described below
echo "$DOCKER_HOST"                 # empty = Docker's default (its current "context", see `docker context ls`); set = the socket it points at, and it overrides the context
```

`bash tools/doctor kernel` prints the same engine name.

**No Docker at all, and no room for it?** The launcher, the host library, the SDK, the registry, the docs and their tests need only Node.js (`bash tools/doctor launcher`).
Anything that starts a VM needs a kernel and runtime images, which today are built with Docker. Without Docker you need ones someone else built: the build accepts a prebuilt kernel
(`tools/build.sh --kernel-from /path/to/Image`) and an image file can be installed with `tools/vmapp runtime-install <name> <image>`. Nothing is distributed prebuilt yet.

## What is inside the build containers

Docker runs the parts that need Linux. Each is a Dockerfile in this repository, and **every `FROM` names its base image by digest**, so the image you get
is the image we tested. `tools/check-invariants` enforces it (rule INV-F2: "every Dockerfile FROM is pinned by @sha256 digest").

| Container | Base image (digest) | Builds |
|---|---|---|
| `kernel/Dockerfile` | Ubuntu 24.04 `sha256:534baea6…` | the guest Linux kernel |
| `runtimes/node22/Dockerfile`, `registry/Dockerfile` | Node 22 (bookworm-slim) `sha256:c3de60bf…` | the Node runtime image; the registry image |
| `runtimes/native/Dockerfile`, `tools/mkerofs.Dockerfile`, `apps/local-llm/llama.Dockerfile` | Debian `sha256:7c7b2c96…` | the native runtime image; the EROFS image tool; llama.cpp for the local LLM sample |
| `runtimes/dotnet8/Dockerfile` | .NET 8 runtime `sha256:60d11c2b…` | the .NET runtime image |
| `runtimes/node22-gpu`, `apps/ollama/vulkan`, `tests/gpu-vulkan` | Node `sha256:154ba2f4…` | the experimental GPU runtime and backend |
| `apps/ollama-desktop/build/Dockerfile` | Go `sha256:978084e7…` | Ollama's desktop app |

Inside them, nothing floats: the Linux source is a tarball with a pinned SHA-256 and signature check (`kernel/pins.env`), and packages come from a dated
snapshot of the Debian or Ubuntu archive (`UBUNTU_SNAPSHOT`, `APT_SNAPSHOT` in the `pins.env` files). The guest kernel is built from unmodified upstream
source with our configuration; the experimental GPU flavour adds one patch ([kernel/SOURCE-OFFER.md](../kernel/SOURCE-OFFER.md)).

## How much space it takes

A clean build from nothing, measured in a copy of the public repository: **808 MB** in `out/`. Of that, the build scratch (the kernel build, the Rust target folder and the llama.cpp
source) is 661 MB, the runtime images 128 MB, and the kernel, init and tools the rest. The Rust toolchain is about 0.6 GB (a minimal install). Docker keeps the base images it pulls and its build cache, so
its size depends on what else you use it for. Nothing here needs a browser source tree or anything outside this repository. VS Code is the one large sample: it needs about 25 GB free.
The kernel builds in 1 to 4 minutes, depending on how many CPUs the engine has.

## Docker on another disk with Lima

### What Lima is, and when you want it

[Lima](https://lima-vm.io) is a small open-source tool that runs Linux virtual machines on a Mac. Here it runs one Ubuntu VM with Docker inside it, and the `docker` command on your Mac talks to
that Docker through a socket. It does the job of Docker Desktop's hidden VM, but the VM's disk lives in a folder you choose, and you choose its CPUs, memory and disk limit.

It is useful when the Mac's internal disk is small and the big builds belong on an external drive. **You do not need it if Docker Desktop works for you.**

### Set up (once)

`<workspace>` is an absolute folder, with **no spaces in its path**, on the disk where the engine's data should live. **Replace `<workspace>` everywhere below, including inside the yaml.**
Your checkout of this repository must be **inside** it (for example the workspace is `/Volumes/Big/work` and the checkout is `/Volumes/Big/work/vmapp`): the engine can only see folders under it
(see "Things to know"). These steps are for a Mac with Apple silicon.

**1. The `docker` command and buildx on your Mac** (skip this if you already have Docker Desktop's: it brings both). The engine runs inside the VM, but your Mac still needs the command:

```sh
brew install docker docker-buildx
```

Then let the command find the plugin, as Homebrew's own note says: put this in `~/.docker/config.json` (create the file with just this if you have none, otherwise add the key):

```json
{ "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
```

Check with `docker buildx version`. *(This install route was not run end to end here: the test machine already had Docker Desktop's command.)*

**2. Lima itself, with the download checked** (we used v2.2.1):

```sh
mkdir -p <workspace>/_toolchains/lima-dl <workspace>/_toolchains/lima && cd <workspace>/_toolchains/lima-dl
curl -sSLO https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz
curl -sSLO https://github.com/lima-vm/lima/releases/download/v2.2.1/SHA256SUMS
grep lima-2.2.1-Darwin-arm64.tar.gz SHA256SUMS | shasum -a 256 -c - && tar -xzf lima-2.2.1-Darwin-arm64.tar.gz -C ../lima
```

**3. The engine's configuration.** Save this as `<workspace>/_toolchains/lima-vd.yaml`. Each line is explained in the comment beside it:

```yaml
base:
- template:docker-rootful   # Lima's own template: an Ubuntu VM with Docker, running as root inside the VM
vmType: vz                  # use Apple's Virtualization.framework (the same one this project's own VMs use)
mountType: virtiofs         # fast shared folders between the Mac and the VM
cpus: 10                    # see "Sizing" below
memory: 32GiB
disk: 300GiB                # a limit, not an allocation: the disk file grows as images are stored (6.7 GB, images and layers, on the reference Mac)
mounts:
- location: <workspace>     # the Mac folders the engine can see, at the same path; the builds bind-mount your checkout from here
  writable: true            # the builds write their output (the checkout's out/ folder) through this mount
provision:                  # scripts Lima runs inside the VM at every start
- mode: system              # run as root
  script: |
    #!/bin/sh
    set -eu
    # a VS Code build walks a few hundred thousand files; evict the guest's inode cache so macOS's file table does not fill up
    sysctl -w vm.vfs_cache_pressure=10000
    # every 5 seconds, drop the guest's cached directory entries and inodes (not the page cache of open files)
    systemctl is-active --quiet virtiofs-trim || systemd-run --unit=virtiofs-trim --property=Restart=always \
      /bin/sh -c 'while sleep 5; do echo 2 > /proc/sys/vm/drop_caches; done'
```

**4. Create and start the engine, named `vd`, then point `docker` at it:**

```sh
export LIMA_HOME=<workspace>/_toolchains/lima-home PATH="<workspace>/_toolchains/lima/bin:$PATH"
limactl start --name=vd <workspace>/_toolchains/lima-vd.yaml
export DOCKER_HOST="unix://$LIMA_HOME/vd/sock/docker.sock" VMAPP_DOCKER_DATA="$LIMA_HOME"
docker info --format '{{.Name}}'      # must print: lima-vd
```

The first start downloads an Ubuntu image (hundreds of MB) and takes a few minutes; later starts take seconds.

### Using it day to day

Every new terminal needs the exports again (they are per terminal; put them in a small script or your shell profile):

```sh
export LIMA_HOME=<workspace>/_toolchains/lima-home PATH="<workspace>/_toolchains/lima/bin:$PATH"
export DOCKER_HOST="unix://$LIMA_HOME/vd/sock/docker.sock" VMAPP_DOCKER_DATA="$LIMA_HOME"
```

| Variable | What it does |
|---|---|
| `LIMA_HOME` | the folder where Lima keeps its instances: the VM and its disk. Setting it is what puts them under `<workspace>`. |
| `DOCKER_HOST` | the socket the `docker` command talks to. When it is set it overrides Docker's own "context" (`docker context ls` shows the default one). |
| `VMAPP_DOCKER_DATA` | tells the free-space checks of the large app builds (VS Code, Ollama Desktop) where the engine's data is. The kernel build does not read it. |

| You want to | Command |
|---|---|
| see whether it runs, and its size | `limactl list` |
| start it (after a restart of your Mac, or after a stop; no yaml needed) | `limactl start vd` (about 10 s) |
| stop it, to free its CPU and memory | `limactl stop vd` |
| know that `docker` uses it | `docker info --format '{{.Name}}'` prints `lima-vd` |
| remove it and free its disk | `limactl stop vd && limactl delete vd` (the yaml recreates it; images are pulled again) |

### Sizing

- **The kernel only:** 2 CPUs, 4 GiB and 30 GiB were enough (tested: the kernel built in 3.5 minutes; about 70 seconds on a bigger engine).
- **VS Code and the other large builds** (.NET, Ollama, Ollama Desktop, the local LLM, the GPU backend): the values in the yaml (10 CPUs, 32 GiB, 300 GiB) are what these builds were run with.
  Smaller values are untested for them; if in doubt, use the large ones.

### Things to know

- **The checkout must be inside `<workspace>`.** A folder outside the mounted location is **not an error**: it appears **empty** inside the engine, so a build sees nothing. Put your checkout under
  `<workspace>`, or delete the engine and recreate it with another `- location:` entry under `mounts:`.
- **The Ubuntu image is cached on your internal disk.** Lima keeps the image it downloads under `~/Library/Caches/lima`, even though the engine's disk is under `<workspace>` (about 3 GB).
- **The Ubuntu version is Lima's choice.** The template pulls its current Ubuntu (26.04 when tested). Builds do not depend on it, because every build container is pinned by digest.
- **`limactl start` prints a tip about `docker context create`.** You do not need it: the `DOCKER_HOST` export above is enough.

### If something goes wrong

| You see | What to do |
|---|---|
| `Cannot connect to the Docker daemon`, or `bash tools/doctor kernel` says Docker is not running | **Lima:** run `limactl list`; if `vd` is `Stopped`, run `limactl start vd`, and check that `DOCKER_HOST` is exported in **this** terminal. **Docker Desktop:** run `open -a Docker` and wait until it says it is running. *(Not reproduced here.)* |
| A build sees an empty folder | The checkout is outside `<workspace>` (see above). |
| The disk is full | `docker system df` shows what is using it; `docker system prune -a` removes unused images (they are pulled again when needed). On Lima you can also delete and recreate the engine. *(Not reproduced here.)* |
| `too many open files` during a big build (Lima) | The `provision:` block above is what prevents it. An existing engine keeps its own copy of the yaml, so add the block to your yaml and recreate the engine: `limactl stop vd && limactl delete vd`, then step 4 again. |

## What you do not need

A custom Chromium build, with its source checkout and build tools, is very large. None of that is part of this repository:
building, testing and changing D9010 VmApp needs none of it.

## Terms

- **Engine / buildx:** Docker's engine runs containers; `buildx` is the `docker` plugin that builds images (the kernel build needs it).
- **Digest:** `sha256:…`, a fingerprint of an exact container image. Naming an image by digest means you get those exact bytes, not whatever the tag points to today.
- **Bind mount:** a folder of your Mac made visible inside a container (`docker run -v /Mac/path:/in/container`); the builds use it to read your checkout and write `out/`.
- **EROFS:** a read-only filesystem format; the shared runtime images are EROFS images.
- **Context:** a saved `docker` connection to an engine (`docker context ls`); `DOCKER_HOST` overrides the current one.
- **VM launcher:** `vmapp-vm`, the small program that starts one app's VM (`host/`). **Real-VM tests:** tests that boot actual VMs (`tests/e2e.sh`), as opposed to the unit tests, which use a fake.

## Licence

D9010 VmApp is [MIT](../LICENSE). The software it builds and ships keeps its own licence: [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
