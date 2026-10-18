# Ollama (GPU, experimental) (`dev.vmapp.ollama.gpu`, runtime `node22-gpu`)

The [Ollama sample](../ollama/README.md) with Ollama's **Vulkan backend**, for the experimental GPU backend of the platform
(SPEC 8.7: a VM with a Venus Vulkan device, `vmapp-vm-krun`). It is the same program as the Ollama app: the real `ollama serve` in a VM,
the same chat window, the same two network hosts for pulling models, no folders. What it adds is the manifest permission
`{"cap": "gpu", "api": "vulkan"}` (which requires runtime `node22-gpu`), and `lib/ollama/vulkan/libggml-vulkan.so` in its package.

**This folder holds only the manifest.** `core/` and `ui/` are generated (git-ignored): `apps/ollama/build.sh --with-vulkan` (or
`apps/ollama/vulkan/build-vulkan.sh`) copies `apps/ollama/core` and `apps/ollama/ui` here and adds the Vulkan library it builds in
Docker. Edit the sources in `apps/ollama/`, never the copies. How the library is built and checked, how Ollama finds it, how to run the
GPU test (`bash tests/apps/ollama-gpu.sh`) and what has and has not been verified: [apps/ollama/README.md, "The GPU"](../ollama/README.md#the-gpu).

It runs on the GPU only when all three switches of SPEC 8.7 are on (the app asks, you allowed it for this app, the loader setting
"Experimental GPU (Vulkan)" is on); otherwise it runs on the normal backend, without a GPU, on the VM's CPUs. The GPU is an experimental,
non-production stack (SPEC 8.7: the Venus decoder is unaudited); the plain Ollama app is the one to use for everyday chat.
