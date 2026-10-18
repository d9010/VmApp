# Hasher (`dev.vmapp.hasher`, runtime `native`)

SHA-256 of every file in a folder you pick. The core is a static Rust binary (`src/main.rs`, std + `serde_json` +
`sha2`) that speaks the bridge protocol of SPEC section 6 directly, with no SDK.

## What it shows

- **A bridge server in ~100 lines.** It listens on `$VMAPP_SOCKET`, reads JSON lines, answers `init` with `ready`,
  asks the host for a window (`request window.create`) and serves `invoke`s. Requests block a worker thread until the
  matching `reply` arrives; the main thread keeps reading.
- **Dialogs without a folder grant.** "Choose a folder..." sends `request dialog.open {directory:true}` and gets back
  `/host/pick-N`. "Save report..." sends `request dialog.save {defaultName:"hashes.txt"}`, writes
  `hashes.txt.partial` at `/host/save-N/` and renames it; the host delivers it to the place the user chose.
- **Streaming to the UI.** `emit` events: `started`, `progress {done,total,current}`, `result {path,sha256,size}` per
  file, `done`. The walk skips symlinks and stops at 10,000 files.
- **Quitting.** On `window closed` the core sends `request app.quit` and exits.

The report has the format of `shasum -a 256`: `sha256` + two spaces + relative path.

## Build, pack, run

```
vmapp/apps/hasher/build.sh      # cargo build (aarch64-unknown-linux-musl), copies the binary to core/hasher
vmapp/tools/vmapp pack vmapp/apps/hasher -o hasher.vmapp
vmapp/tools/vmapp install hasher.vmapp
vmapp/tools/vmapp run dev.vmapp.hasher --headless --script vmapp/tests/apps/hasher.mjs --open DIR --save report.txt
```

`build.sh` uses your Rust toolchain (`RUSTUP_HOME`/`CARGO_HOME`, else `cargo` on `PATH`) and needs the target
`aarch64-unknown-linux-musl` (`rustup target add aarch64-unknown-linux-musl`); see the header of the script.
