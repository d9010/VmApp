# Third-party notices

The D9010 VmApp code in this repository is released under the [MIT licence](LICENSE). This file lists what is **not** covered by it: files in this
repository that carry another licence, and software this project builds, downloads or ships, which keeps its own licence. Where a file has its own
licence header, the header wins.

## Files in this repository under another licence

| Files | Licence | Why |
|---|---|---|
| `kernel/flavours/gpu/patches/0001-drm-virtio-blob-alignment-for-hosts-with-larger-pages.patch`, `gpu/venus-spike/kernel/patches/0001-…` (the same patch) | the licence of each Linux file a hunk changes (GPL-2.0-only for the kernel; see the header of the patch) | They modify the Linux kernel. A kernel built with them is GPL-2.0-only as a whole: [kernel/SOURCE-OFFER.md](kernel/SOURCE-OFFER.md). |
| `gpu/venus-spike/launcher/spike-vm.c`, `gpu/venus-spike/guest/tools/vsock-test.c`, `vk-spin.c`, `vk-offscreen-tri.c` | Apache-2.0 | The spike's own tools, marked Apache-2.0 in their headers (the launcher uses libkrun's Apache-2.0 C API). |
| Patches against upstream software (`apps/vscode/patches/`, `apps/ollama-desktop/patches/`, `gpu/krun/patches/`, `gpu/venus-spike/guest/patches/`) | the added lines are MIT; the code they change keeps the licence of the project it belongs to (MIT for VS Code, Ollama and Mesa; see the tables below for the libkrun stack) | A patch is part of the file it changes. |

## Code adapted from earlier projects of the same author

Some files were adapted from two earlier projects by the same author (D9010 Inc.), which are not part of this repository. They are covered by the MIT licence above, and each file's
header names its source:

- **`agent-vm`:** the guest init (`guest/src/`), the host VM launcher (`host/src/`, including the Virtualization.framework wrapper), and the runtime and image tools (`tools/mkruntime`,
  `tools/mkerofs.Dockerfile`).
- **`d9010-native`:** the Virtualization.framework helper that `agent-vm` itself was adapted from (including the live folder-sharing call `set_shares`), and the guest kernel build and its
  hardening policy (`kernel/`).

Nothing in this repository depends on those projects being present.

## Software this project builds, downloads or ships

None of it is copied into this repository (the build fetches it at a pinned version), but the images, packages and the launcher that you build carry it, and its
licence text travels with it.

| Software | Licence | Where it appears |
|---|---|---|
| Linux kernel | GPL-2.0-only | the guest kernel (`out/Image`); source offer and licence texts in `kernel/SOURCE-OFFER.md` and `out/kernel-info/` |
| Node.js | MIT | the `node22` runtime image |
| .NET runtime | MIT | the `dotnet8` runtime image |
| Debian and Ubuntu packages | their own licences, per package | the runtime images and the build containers ([docs/PRODUCTION.md](docs/PRODUCTION.md) §3) |
| Electron (with Chromium) | MIT, with Chromium's licences in its bundle | the D9010 VmApp Launcher |
| VS Code (Code - OSS) | MIT (Microsoft Corporation); git is GPL-2.0 | the VS Code example (`ui/LICENSE.vscode.txt`, `ui/ThirdPartyNotices.vscode.txt`, `core/vscode/LICENSE`) |
| Ollama | MIT | the Ollama examples (`core/bin/LICENSE.ollama`) |
| llama.cpp (ggml) | MIT | the GPU server and the local LLM example (`out/gpu/LICENSE-llama.cpp.txt`) |
| Gemini CLI, xterm.js | Apache-2.0 and MIT, as published by their projects | the terminal example (`apps/terminal/`) |

The experimental GPU backend builds more. `tools/build.sh --with-krun` builds libkrun (Apache-2.0), virglrenderer (MIT), libepoxy (MIT) and MoltenVK (Apache-2.0) with libkrun's
Rust crates, and writes their licence texts to `out/krun/licenses/`. The research spike in `gpu/venus-spike/` also uses Mesa (MIT), the Vulkan headers, loader and tools
(Apache-2.0), shaderc (Apache-2.0), krunkit (Apache-2.0), vkpeak (MIT), the Vulkan CTS (Apache-2.0) and, for the stock libkrun kernel used only as a baseline, libkrunfw
(GPL-2.0 and LGPL-2.1). The exact versions and commits are in [gpu/venus-spike/BUILD.md](gpu/venus-spike/BUILD.md) and `gpu/krun/pins.env`.

If you find a component that is missing here or listed with the wrong licence, please open an issue.
