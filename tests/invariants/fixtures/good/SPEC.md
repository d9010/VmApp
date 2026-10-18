# Fixture SPEC (only the parts the checker reads)

## 6. The bridge protocol (host <-> core)

### Request ops (core -> host)
| `op` | `params` | `reply.result` |
|---|---|---|
| `window.create` | `{entry:"index.html", width, height}` | `{win}` |
| `window.close` | `{win}` | `{}` |
| `dialog.open` | `{directory:bool}` | `{canceled:true}` or `{canceled:false, paths:[]}`. Needs `permissions.dialogs`. |
| `dialog.save` | `{defaultName}` | `{canceled:true}` or `{canceled:false, path}`. Needs `permissions.dialogs`. |
| `dialog.message` | `{message}` | `{response: index}` |
| `shell.openExternal` | `{url}` (`https:` only) | `{opened:bool}`. Needs `permissions.external`. |
| `app.quit` | `{}` | `{}` |

The host enforces every permission.

---

## 7. The renderer (host side)

- Every response carries this CSP header:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.

## 8. Lifecycle

## 8.2 Host capabilities

**Bridge request ops** (SPEC 6 additions):

| `op` | `params` | `result` |
|---|---|---|
| `host.screen.windows` | `{}` | `[{windowId}]`. Needs `permissions.host` (`screen`). |
| `host.tool.run` | `{id, args}` | `{exitCode}`. Needs `permissions.host` (`tool:<id>`). |
| `host.input.stop` | `{sessionId}` | `{}`. Needs `permissions.host` (`input`). |
