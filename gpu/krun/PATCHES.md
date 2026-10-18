# Patches to the pinned sources

`build-libs.sh` applies `patches/*.patch` with `git apply`, in file-name order, on a fresh shallow clone of the pinned
**virglrenderer fork** (slp, tag `0.10.4e-krunkit`, commit `bfec2d27c3953ee0530c459c2f5d042c2b619fa1`) after it has
checked that HEAD is that commit. A patch that does not apply stops the build. A patch for another component goes into
`patches/libkrun/`, `patches/libepoxy/` or `patches/moltenvk/` (same rules); none exists today, so libkrun, libepoxy and
MoltenVK are built exactly as upstream tagged them.

Every patch starts with a commit-message style header (what, why, upstream status) before its `diff --git`.

| # | Patch | What | Why | Upstream |
|---|---|---|---|---|
| 0001 | `venus-retire-fence-ignore-vanished-context` | `venus_state_cb_retire_fence()` returns when the context is gone instead of `assert(ctx)` | A Vulkan queue thread can retire a fence after the guest context was torn down; the assert aborts the whole VMM (spike REPORT B3, crash type 1) | Not applicable: `src/venus_context.c` exists only in the macOS fork |
| 0002 | `meson-moltenvk-include-dir-option` | Replaces `add_project_arguments('-I/opt/homebrew/opt/molten-vk/libexec/include')` by a string option `moltenvk-include-dir` (default: add nothing) | The Venus headers include `vk_video/*.h`, which the fork does not ship; the fork found them only in the Homebrew `molten-vk` layout of its author's machine. Deleting the line is not enough: the compile then fails with `vk_video/vulkan_video_codec_h264std.h` not found, unless some other include path happens to provide it. The spike worked around it with `CFLAGS`, which leaves the Homebrew path in the compile line. Now `build-libs.sh` passes the headers of the MoltenVK it just built and the build never looks at `/opt/homebrew` | Not applicable (fork build logic) |
| 0003 | `vkr-handle-ring-fatal-error-more-robustly` | Backport of upstream `e933cd5a`, `4e521ea4`, `2b36f184`: stop waiting when the context is fatal | Spike REPORT B4: see below | Merged upstream (virglrenderer >= 1.1.0) |

## 0003, the fatal-wait fix (REPORT B4)

**Backported and built. Exercised once (2026-10-15, by the launcher's author): a compute shader that needs 64-bit floats, which Apple GPUs and
MoltenVK cannot translate ("`double` is not supported in Metal"), makes the host's `SUBMIT_3D` fail (`virtio_gpu_dequeue_ctrl_func: response
0x1200 (command 0x207)` in the guest) and the VM stays alive and responsive (the GPU liveness probe keeps answering, the app's next dispatch
runs). The spike's build hung on a failed pipeline; this one does not. That is one reproducer, not the conformance run.**

Where the hang is: a guest `vkWaitRingSeqnoMESA` makes the Venus renderer block in `vkr_context_wait_ring_seqno()` on a
condition variable until the ring thread has consumed the ring up to a sequence number. If the ring thread dies first
(malformed command, a command that fails and that the guest then waits on) or the guest asks to wait for a sequence number
the ring can never reach, nobody signals the condition variable. In the upstream design that thread is a render-server
worker; in this fork Venus runs in-process, so it is **libkrun's virtio-gpu control-queue worker**: the VM's whole GPU
stops, and the guest sees a hung device (the spike measured exactly that, REPORT §6 B3/B4).

What upstream changed (June 2024, by Yiwei Zhang, in three commits that belong together):

1. `e933cd5a` "handle ring fatal error more robustly": the wait loop also ends when the context is fatal; a ring thread
   that exits with an error marks the context fatal and signals the waiter (`vkr_context_on_ring_fatal`); an idle ring
   thread checks whether the ring can still satisfy the sequence number somebody waits for and fails if it cannot;
   `vkWaitRingSeqnoMESA` kicks the ring first so that check runs on fresh state.
2. `4e521ea4` "log more on ring fatal": two `vkr_log()` lines on the failure paths.
3. `2b36f184` "fix a prior ring wait seqno validation": the check in (1) read the two values in the wrong order and could
   fail a healthy ring (a false "fatal"); the fix reads the waited-for seqno first, then the ring tail. **Taking only
   `e933cd5a` would be wrong**: it contains that bug. The patch is therefore the squash of all three, which is the state
   of upstream 1.3.0.

Feasibility: the fork's `vkr_context.c`, `vkr_ring.c`, `vkr_transport.c` and `vkr_context.h` equal upstream's at the parent
of `e933cd5a` except for line offsets (the fork is upstream 0.10.4 plus its macOS commits; those commits do not touch
the ring code), so the three upstream diffs apply without a textual change. `vkr_seqno_ge()` moves from `vkr_context.c` to
`vkr_common.h`, as in upstream. Verified: `git apply --check` on the pinned commit, a full build of libvirglrenderer, and
the end-to-end spike run described in `README.md` (guest enumerates the Venus device, offscreen render passes).

What it does **not** do:

- It does not fix the cause of a failed pipeline creation (MoltenVK or the translated shader), it only stops the hang
  afterwards. The guest still gets a failed or lost device; REPORT §6 B2 ("device loss is never reported to the guest")
  is a different, unfixed problem, as is B3 (timeline semaphores).
- The failing-pipeline hang itself was not re-created here: the spike has no small reproducer for it (its hangs came out
  of CTS groups), and writing one was out of scope. The check that remains for a GPU conformance gate is: run the CTS
  `api.*` and `synchronization.*` groups (REPORT §4) before and after, and watch the VM stay responsive.
- A hostile guest can still keep the worker busy with valid work (REPORT B7, no GPU time limit): the launcher needs the
  watchdog described there.

## 0001 is a symptom fix

`venus_lookup_context()` returning NULL means the context was already destroyed; dropping the retirement is correct for
that fence. It does not remove the race itself (the queue thread can also run while the context is being destroyed). The
proper fix is the planned rebase of the macOS delta onto current upstream (REPORT B6).

## Updating or adding a patch

1. Clone the fork at the pinned tag, change it, `git diff` / `git format-patch`.
2. Put the result in `patches/` with a header (what / why / upstream status) and the next number; keep the diff
   `git apply`-able on the pinned commit (`git apply --check`).
3. `gpu/krun/build-libs.sh` rebuilds virglrenderer and libkrun on the next run (the patches are part of the inputs).
