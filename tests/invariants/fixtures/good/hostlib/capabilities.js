'use strict';
// Fixture broker: every host.* op authorizes (manifest + grant) before it acts.
class HostCapabilities {
  _gate(ctx, cap) {
    const list = (ctx.manifest && ctx.manifest.permissions && ctx.manifest.permissions.host) || [];
    const grants = ctx.grants();
    if (!list.some((h) => h.cap === cap)) return { ok: false, reason: 'not requested' };
    if (!grants[cap]) return { ok: false, reason: 'not granted' };
    return { ok: true };
  }

  async _authorize(ctx, st, rec, cap) {
    const g = this._gate(ctx, cap);
    if (!g.ok) throw new Error(`permission denied: ${g.reason}`);
    rec.allowed = true;
  }

  async _ctlRequest(op) {
    return { op };
  }

  async _toolRun() {
    return { exitCode: 0 };
  }

  async _dispatch(op, p, ctx, st, rec) {
    switch (op) {
      case 'host.screen.windows': {
        await this._authorize(ctx, st, rec, 'screen');
        return this._ctlRequest('windows');
      }
      case 'host.tool.run': {
        await this._authorize(ctx, st, rec, `tool:${p.id}`);
        return this._toolRun(p);
      }
      case 'host.input.stop':
        await this._authorize(ctx, st, rec, 'input');
        return {};
      default:
        throw new Error(`unknown host op: ${op}`);
    }
  }

  requestOp(op, p, ctx) {
    return this._dispatch(op, p, ctx, {}, {});
  }
}

module.exports = { HostCapabilities };
