'use strict';
// Desk Helper UI: static script (the CSP allows script-src 'self' only). Everything goes through window.vmapp.invoke.
// Every call returns {ok:true, ...} or {ok:false, denied, cap, error}; `show` turns the second kind into a clear message.

(() => {
  const api = window.vmapp;
  const $ = (id) => document.getElementById(id);

  const HINT = {
    screen: 'Grant "screen" to Desk Helper (permission sheet, or: vmapp grant-host dev.vmapp.deskhelper screen). macOS also needs Screen Recording for the D9010 VmApp Launcher.',
    input: 'Grant "input" to Desk Helper. macOS also needs Accessibility for the D9010 VmApp Launcher.',
    tool: 'Register a tool (vmapp tool add ...) and grant it to Desk Helper under "tool:*".',
    mcp: 'Register an MCP server (vmapp mcp add ...) and grant it to Desk Helper under "mcp:*".',
  };

  /** Shows the outcome of a call in a status element. Returns true when the call worked. */
  function show(el, r, okText) {
    if (r && r.ok) {
      el.className = 'status good';
      el.textContent = okText || 'Done.';
      return true;
    }
    const cap = String((r && r.cap) || '').split(':')[0];
    if (r && r.denied) {
      el.className = 'status denied';
      el.textContent = `Not allowed (${r.cap}): ${r.error}. ${HINT[cap] || ''}`;
    } else {
      el.className = 'status error';
      el.textContent = `Failed: ${(r && r.error) || 'no answer'}`;
    }
    return false;
  }

  const busy = (btn, on) => { btn.disabled = on; };
  const pretty = (v) => JSON.stringify(v, null, 2);

  // ------------------------------------------------------------------------------------ 1. look
  let shotUrl = null;
  let shotSize = null; // {width, height} of the PNG, in points
  let shotBounds = null; // {x, y, w, h}: the captured area in GLOBAL points (from result.target.bounds), or null (older loader)
  let picked = null; // {x, y} in global points

  const ptWidth = $('pt-width');
  ptWidth.value = String(Math.round(window.screen.width) || 1440);

  /** In words: what the user shared (what the loader says it captured), and why it may differ from what we asked for. */
  function describeTarget(t) {
    if (!t) return 'your loader did not say what it captured.';
    const b = t.bounds ? ` (${Math.round(t.bounds.w)} × ${Math.round(t.bounds.h)} points at ${Math.round(t.bounds.x)}, ${Math.round(t.bounds.y)})` : '';
    const what =
      t.kind === 'window' ? `a window${t.windowId !== undefined ? ` (id ${t.windowId})` : ''}${b}` :
      t.kind === 'region' ? `a region of the screen${b}` :
      `display ${t.display !== undefined ? t.display : '(main)'}${b}`;
    const by =
      t.by === 'user' ? 'You chose this in the loader’s question.' :
      t.by === 'default' ? 'What we asked for no longer exists, so your main display was used.' :
      'You had already allowed screenshots for this run, so what we suggested was used.';
    return `${what}. ${by}`;
  }

  function b64ToBlobUrl(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  }

  function renderWindows(list) {
    const body = $('windows');
    body.replaceChildren();
    for (const w of list) {
      const tr = document.createElement('tr');
      const b = w.bounds || {};
      for (const text of [w.app, w.title || '(no title)', `${b.x}, ${b.y}  ${b.w}×${b.h}`]) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  $('btn-look').addEventListener('click', async () => {
    const btn = $('btn-look');
    busy(btn, true);
    $('st-look').className = 'status';
    $('st-look').textContent = 'Asking the host...';
    try {
      const r = await api.invoke('desk:look');
      if (!show($('st-look'), r, `Screenshot ${r.shot && r.shot.width}×${r.shot && r.shot.height}, ${r.windows && r.windows.length} windows.${r.windowsError ? ` (The window list was not allowed: ${r.windowsError})` : ''}`)) return;
      if (shotUrl) URL.revokeObjectURL(shotUrl);
      shotUrl = b64ToBlobUrl(r.shot.png);
      shotSize = { width: r.shot.width, height: r.shot.height };
      // What was captured decides how a click on the picture becomes a point: the user may have picked another display, a
      // window or a region, so the picture is not necessarily the main display. `bounds` are global points.
      shotBounds = r.target && r.target.bounds ? r.target.bounds : null;
      $('captured-what').textContent = describeTarget(r.target);
      if (shotBounds) ptWidth.value = String(Math.round(shotBounds.w));
      ptWidth.readOnly = !!shotBounds;
      $('shot').src = shotUrl;
      $('marker').hidden = true;
      picked = null;
      refreshPicked();
      renderWindows(r.windows);
      $('look-out').hidden = false;
    } catch (e) {
      show($('st-look'), { ok: false, error: e.message });
    } finally {
      busy(btn, false);
    }
  });

  // ------------------------------------------------------------------------------------ 2. point and click
  function refreshPicked() {
    $('picked').textContent = picked ? `(${picked.x}, ${picked.y}) points` : 'none yet (take a screenshot and click it)';
    $('btn-click').disabled = !picked || !$('ok-click').checked;
  }

  $('shot').addEventListener('click', (ev) => {
    const img = $('shot');
    const widthPts = Number(ptWidth.value);
    if (!shotSize || (!shotBounds && !(widthPts > 0)) || !img.clientWidth) return;
    // The picture is shown scaled; positions are fractions of it. Scale them back to the captured area's size in points and
    // add its origin: input coordinates are GLOBAL points (a second display to the left has negative x, a window sits
    // somewhere on the screen). Without bounds (an older loader) the picture is assumed to start at 0, 0.
    const fx = ev.offsetX / img.clientWidth;
    const fy = ev.offsetY / img.clientHeight;
    const area = shotBounds || { x: 0, y: 0, w: widthPts, h: widthPts * (shotSize.height / shotSize.width) };
    picked = { x: Math.round(area.x + fx * area.w), y: Math.round(area.y + fy * area.h) };
    const m = $('marker');
    m.style.left = `${ev.offsetX}px`;
    m.style.top = `${ev.offsetY}px`;
    m.hidden = false;
    refreshPicked();
  });
  ptWidth.addEventListener('change', () => {
    picked = null;
    $('marker').hidden = true;
    refreshPicked();
  });
  $('ok-click').addEventListener('change', refreshPicked);

  $('btn-click').addEventListener('click', async () => {
    if (!picked) return;
    const btn = $('btn-click');
    busy(btn, true);
    $('st-click').className = 'status';
    $('st-click').textContent = 'Asking the host... (look for the question, then the red badge)';
    try {
      const r = await api.invoke('desk:click', picked);
      show($('st-click'), r, `Moved to (${picked.x}, ${picked.y}) and clicked. Control ended.`);
    } catch (e) {
      show($('st-click'), { ok: false, error: e.message });
    } finally {
      refreshPicked();
    }
  });

  // ------------------------------------------------------------------------------------ 3. type
  $('btn-type').addEventListener('click', async () => {
    const btn = $('btn-type');
    const st = $('st-type');
    const text = $('type-text').value;
    if (!text) return;
    busy(btn, true);
    st.className = 'status';
    try {
      for (let n = 3; n > 0; n--) {
        st.textContent = `Typing in ${n}... click into the target app now.`;
        await new Promise((res) => setTimeout(res, 1000));
      }
      st.textContent = 'Asking the host...';
      const r = await api.invoke('desk:type', { text });
      show(st, r, `Typed ${r.typed} characters. Control ended.`);
    } catch (e) {
      show(st, { ok: false, error: e.message });
    } finally {
      busy(btn, false);
    }
  });

  // ------------------------------------------------------------------------------------ 4. tools
  let tools = [];

  function describeTool(t) {
    if (!t) return '';
    const specs = t.args.map((a) => `${a.optional ? '[' : ''}${a.pattern}${a.mapPath ? ' (host path)' : ''}${a.optional ? ']' : ''}`);
    return `${t.description ? t.description + ' - ' : ''}${t.kind === 'shell' ? 'SHELL tool: runs whatever you type. ' : ''}Arguments: ${specs.join('  ') || 'none'}${t.variadic ? ' (repeatable)' : ''}`;
  }

  $('tool-select').addEventListener('change', () => {
    $('tool-desc').textContent = describeTool(tools.find((t) => t.id === $('tool-select').value));
  });

  $('btn-tools').addEventListener('click', async () => {
    const btn = $('btn-tools');
    busy(btn, true);
    try {
      const r = await api.invoke('desk:tools');
      if (!show($('st-tools'), r, `${r.tools && r.tools.length} tool(s) granted to this app.`)) return;
      tools = r.tools;
      const sel = $('tool-select');
      sel.replaceChildren();
      for (const t of tools) sel.add(new Option(`${t.name} (${t.id})${t.kind === 'shell' ? ' [shell]' : ''}`, t.id));
      $('tool-desc').textContent = describeTool(tools[0]);
      $('tool-form').hidden = tools.length === 0;
      if (!tools.length) $('st-tools').textContent = 'No tools are granted to this app. Register one with "vmapp tool add" and grant it.';
    } catch (e) {
      show($('st-tools'), { ok: false, error: e.message });
    } finally {
      busy(btn, false);
    }
  });

  $('btn-tool-run').addEventListener('click', async () => {
    const btn = $('btn-tool-run');
    busy(btn, true);
    $('tool-out').hidden = true;
    $('st-tool').className = 'status';
    $('st-tool').textContent = 'Running...';
    try {
      const args = $('tool-args').value.split('\n').filter((l) => l.length > 0);
      const r = await api.invoke('desk:tool-run', { id: $('tool-select').value, args, stdin: $('tool-stdin').value });
      if (!show($('st-tool'), r, `Finished with exit code ${r.result && r.result.exitCode}.`)) return;
      const x = r.result;
      $('tool-out').textContent = `exit code ${x.exitCode}${x.timedOut ? ' (timed out)' : ''}${x.truncated ? ' (output truncated)' : ''}\n--- stdout ---\n${x.stdout}\n--- stderr ---\n${x.stderr}`;
      $('tool-out').hidden = false;
    } catch (e) {
      show($('st-tool'), { ok: false, error: e.message });
    } finally {
      busy(btn, false);
    }
  });

  // ------------------------------------------------------------------------------------ 5. MCP
  let servers = [];

  function fillMcpTools() {
    const s = servers.find((x) => x.id === $('mcp-server').value);
    const sel = $('mcp-tool');
    sel.replaceChildren();
    for (const t of (s && s.tools) || []) sel.add(new Option(t.name, t.name));
    fillMcpDesc();
  }
  function fillMcpDesc() {
    const s = servers.find((x) => x.id === $('mcp-server').value);
    const t = s && s.tools.find((x) => x.name === $('mcp-tool').value);
    $('mcp-desc').textContent = t ? `${t.description || ''}${t.inputSchema ? '  Input: ' + JSON.stringify(t.inputSchema) : ''}` : s && s.error ? `This server could not be used: ${s.error}` : '';
  }
  $('mcp-server').addEventListener('change', fillMcpTools);
  $('mcp-tool').addEventListener('change', fillMcpDesc);

  $('btn-mcp').addEventListener('click', async () => {
    const btn = $('btn-mcp');
    busy(btn, true);
    $('st-mcp-list').className = 'status';
    $('st-mcp-list').textContent = 'Asking the host (it starts each server)...';
    try {
      const r = await api.invoke('desk:mcp-list');
      if (!show($('st-mcp-list'), r, `${r.servers && r.servers.length} server(s) granted to this app.`)) return;
      servers = r.servers;
      const sel = $('mcp-server');
      sel.replaceChildren();
      for (const s of servers) sel.add(new Option(`${s.name} (${s.id})${s.error ? ' - unavailable' : ''}`, s.id));
      $('mcp-form').hidden = servers.length === 0;
      if (!servers.length) $('st-mcp-list').textContent = 'No MCP servers are granted to this app. Register one with "vmapp mcp add" and grant it.';
      fillMcpTools();
    } catch (e) {
      show($('st-mcp-list'), { ok: false, error: e.message });
    } finally {
      busy(btn, false);
    }
  });

  $('btn-mcp-call').addEventListener('click', async () => {
    const btn = $('btn-mcp-call');
    $('mcp-out').hidden = true;
    let args;
    try {
      args = JSON.parse($('mcp-args').value || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
    } catch {
      return show($('st-mcp'), { ok: false, error: 'The arguments must be a JSON object, for example {"text": "hi"}.' });
    }
    busy(btn, true);
    $('st-mcp').className = 'status';
    $('st-mcp').textContent = 'Calling...';
    try {
      const r = await api.invoke('desk:mcp-call', { server: $('mcp-server').value, tool: $('mcp-tool').value, args });
      if (!show($('st-mcp'), r, 'The server answered.')) return;
      $('mcp-out').textContent = pretty(r.result);
      $('mcp-out').hidden = false;
    } catch (e) {
      show($('st-mcp'), { ok: false, error: e.message });
    } finally {
      busy(btn, false);
    }
  });

  refreshPicked();
})();
