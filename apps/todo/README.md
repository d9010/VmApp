# Todo (`dev.vmapp.todo`, runtime `dotnet8`)

A small to-do list with a C# core (`Program.cs`, System.Text.Json) that speaks the bridge protocol of SPEC section 6
directly. It asks for no folders and no dialogs.

## What it shows

- **Framework-dependent .NET.** The package holds only `Todo.dll` and its two json files (about 20 KiB); the shared
  .NET 8 runtime comes from the `dotnet8` runtime image. `core.command` is `["dotnet", "Todo.dll"]`.
- **App data.** Tasks live in `/data/todos.json` (`VMAPP_DATA`), written atomically (temp file + rename), so they
  survive restarts and updates.
- **The invoke/emit pattern.** `todo:list`, `todo:add`, `todo:toggle`, `todo:delete`, `todo:clear-completed` return the
  new list and also emit `changed` with the whole list; the UI renders whatever `changed` carries.
- **Window title.** The core opens the window with the right count ("2 open tasks") and keeps it current with
  `request window.setTitle`.
- **Quitting.** On `window closed` the core sends `request app.quit` and exits.

## Build, pack, run

Needs Docker (the SDK image is pinned by digest in `build.sh`).

```
vmapp/apps/todo/build.sh        # dotnet publish -r linux-arm64 --self-contained false into core/
vmapp/tools/vmapp pack vmapp/apps/todo -o todo.vmapp
vmapp/tools/vmapp install todo.vmapp
TODO_PHASE=1 vmapp/tools/vmapp run dev.vmapp.todo --headless --script vmapp/tests/apps/todo.mjs
```
