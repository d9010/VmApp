// Local LLM window. The page has no network and no Node: everything comes from the core (core/main.js lists the channels).
(() => {
  'use strict';
  const vm = window.vmapp;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------------------------- helpers

  function h(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }

  const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);
  const fmtRate = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
  const fmtTps = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} tok/s` : '');
  const fmtSecs = (ms) => `${Math.max(0, Math.round(ms / 1000))} s`;

  // ---------------------------------------------------------------------------------------------- state

  let st = null; // the core's llm:init answer, kept up to date by events
  let transfer = null; // the latest llm:transfer event
  let conv = []; // [{role, content}] without the system prompt
  let live = null; // the reply being generated: {id, bubble, text, reasoning, tokens, firstAt, lastAt, stopped}
  let lastSpeed = null; // {genTps, promptTps, tokens, gpu}
  let banner = null; // {text, kind, action}

  const serverState = () => (st && st.server && st.server.state) || 'stopped';
  const ready = () => serverState() === 'ready';
  const gpuGranted = () => !!(st && st.gpu.granted);
  const wantGpu = () => gpuGranted() && $('use-gpu').checked;
  const transferBusy = () => !!(transfer && ['starting', 'resuming', 'download', 'verify', 'copy'].includes(transfer.phase));

  // ---------------------------------------------------------------------------------------------- banner

  function showBanner(text, kind = 'error', action = null) {
    banner = { text, kind, action };
    renderBanner();
  }
  function clearBanner() {
    banner = null;
    renderBanner();
  }
  function renderBanner() {
    $('banner').hidden = !banner;
    if (!banner) return;
    $('banner').className = `banner ${banner.kind === 'info' ? 'info' : ''}`;
    $('banner-text').textContent = banner.text;
    const a = $('banner-action');
    a.hidden = !banner.action;
    if (banner.action) a.textContent = banner.action.label;
  }
  $('banner-close').addEventListener('click', clearBanner);
  $('banner-action').addEventListener('click', () => {
    const a = banner && banner.action;
    clearBanner();
    if (a) a.run();
  });

  // ---------------------------------------------------------------------------------------------- models

  function needMiB(bytes) {
    return Math.ceil((bytes * 1.15) / 1048576) + 300; // weights + KV cache and buffers, roughly
  }

  function loadedFile() {
    const s = st && st.server;
    return s && (s.state === 'starting' || s.state === 'ready') ? s.model : '';
  }

  async function doLoad(file) {
    clearBanner();
    try {
      await vm.invoke('llm:load', { name: file, useGpu: wantGpu(), ctx: st.settings.ctx });
    } catch (e) {
      showBanner(e.message);
    }
  }

  async function doDownload(id) {
    clearBanner();
    try {
      await vm.invoke('llm:download', { id });
    } catch (e) {
      showBanner(e.message);
    }
  }

  async function doDelete(file) {
    try {
      await vm.invoke('llm:delete', { name: file });
    } catch (e) {
      showBanner(e.message);
    }
  }

  function progressBlock(t) {
    const pct = t.total ? Math.min(100, (t.received / t.total) * 100) : 0;
    const text =
      t.phase === 'verify'
        ? 'Checking the SHA-256…'
        : t.phase === 'resuming'
          ? 'Checking what was downloaded before…'
          : t.phase === 'starting'
            ? 'Starting…'
            : `${fmtBytes(t.received)} of ${fmtBytes(t.total)}${t.bps ? ` · ${fmtRate(t.bps)}` : ''} (${pct.toFixed(0)}%)`;
    return [
      h('progress', { max: 100, value: t.phase === 'verify' ? 100 : pct }),
      h('div', { class: 'progress-text', text }),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: 'Cancel', onclick: () => vm.invoke('llm:cancel') })),
    ];
  }

  function modelRow({ title, meta, note, warn, loaded, body }) {
    return h(
      'li',
      { class: `model ${loaded ? 'loaded' : ''}` },
      h('div', { class: 'name' }, title, loaded ? ' ' : '', loaded ? h('span', { class: 'badge ok', text: 'loaded' }) : null),
      h('div', { class: 'meta', text: meta }),
      note ? h('p', { class: 'note', text: note }) : null,
      warn ? h('p', { class: 'warn', text: warn }) : null,
      body,
    );
  }

  function fitWarning(bytes) {
    if (!st) return '';
    const need = needMiB(bytes);
    if (wantGpu() || need <= st.vm.memMiB * 0.9) return '';
    return `Needs about ${Math.round(need)} MB of memory and this VM has ${st.vm.memMiB} MB. Give it more memory on the app's card in the library${gpuGranted() ? ", or use the Mac's GPU (the weights then live on the Mac)" : ''}.`;
  }

  function renderModels() {
    if (!st) return;
    const m = st.models;
    const cur = loadedFile();
    const catalog = $('catalog');
    catalog.replaceChildren();
    for (const c of m.catalog) {
      const t = transfer && transfer.kind === 'download' && transfer.id === c.id && transferBusy() ? transfer : null;
      let body;
      if (t) body = progressBlock(t);
      else if (c.downloaded) {
        const isCur = cur === c.file;
        body = h(
          'div',
          { class: 'actions' },
          isCur
            ? h('button', { type: 'button', text: 'Unload', onclick: () => vm.invoke('llm:unload') })
            : h('button', { type: 'button', class: 'primary', text: 'Load', disabled: serverState() === 'starting' || !!live, onclick: () => doLoad(c.file) }),
          h('button', { type: 'button', class: 'danger', text: 'Delete', disabled: isCur, onclick: () => doDelete(c.file) }),
        );
      } else {
        const resume = c.partialBytes > 0 ? ` (resume ${Math.round((c.partialBytes / c.bytes) * 100)}%)` : '';
        body = h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', text: `Download${resume}`, disabled: transferBusy(), onclick: () => doDownload(c.id) }),
          c.partialBytes > 0 ? h('button', { type: 'button', class: 'danger', text: 'Discard', title: 'Delete the partly downloaded file', disabled: transferBusy(), onclick: () => doDelete(c.file) }) : null,
        );
      }
      catalog.append(
        modelRow({
          title: c.name,
          meta: `${c.quant} · ${fmtBytes(c.bytes)} · ${c.license}`,
          note: c.note,
          warn: c.downloaded || t ? fitWarning(c.bytes) : '',
          loaded: cur === c.file,
          body,
        }),
      );
    }

    const imported = m.local.filter((l) => !l.catalogId);
    const importing = transfer && transfer.kind === 'import' && transferBusy() ? transfer : null;
    $('imported-head').hidden = !imported.length && !importing;
    const list = $('imported');
    list.replaceChildren();
    if (importing) list.append(modelRow({ title: importing.name, meta: 'Importing…', body: progressBlock(importing) }));
    for (const l of imported) {
      const isCur = cur === l.name;
      list.append(
        modelRow({
          title: l.name,
          meta: fmtBytes(l.bytes),
          warn: fitWarning(l.bytes),
          loaded: isCur,
          body: h(
            'div',
            { class: 'actions' },
            isCur
              ? h('button', { type: 'button', text: 'Unload', onclick: () => vm.invoke('llm:unload') })
              : h('button', { type: 'button', class: 'primary', text: 'Load', disabled: serverState() === 'starting' || !!live, onclick: () => doLoad(l.name) }),
            h('button', { type: 'button', class: 'danger', text: 'Delete', disabled: isCur, onclick: () => doDelete(l.name) }),
          ),
        }),
      );
    }
    $('import-btn').disabled = transferBusy();
    $('space').textContent = m.freeBytes === null ? '' : `Models are stored in this app's private data (${fmtBytes(m.freeBytes)} free on that disk).`;
    renderEmpty();
  }

  $('import-btn').addEventListener('click', async () => {
    clearBanner();
    try {
      await vm.invoke('llm:import');
    } catch (e) {
      showBanner(e.message);
    }
  });

  // ---------------------------------------------------------------------------------------------- compute

  function renderCompute() {
    if (!st) return;
    const box = $('use-gpu');
    const granted = gpuGranted();
    box.disabled = !granted || !!live;
    $('gpu-label').className = `check ${granted ? '' : 'disabled'}`;
    const note = $('gpu-note');
    if (!granted) {
      box.checked = false;
      note.textContent =
        "Off: this app does not have the GPU permission. Choose \"Allow while the app runs\" for the GPU in the app's Permissions in the library, and start the app again, to run the model on the Mac's GPU. Until then everything runs on the VM's CPU.";
    } else {
      note.textContent =
        "Offloads the model's layers to the Mac's GPU through llama.cpp's RPC backend. The VM still has no GPU of its own: it sends tensors to a small host server that you allowed. Reloads the model.";
    }
    $('vm-note').textContent = `This VM: ${st.vm.cpus} vCPU${st.vm.cpus === 1 ? '' : 's'}, ${st.vm.memMiB} MB memory (${st.binary.label}). Change the size on the app's card in the library: more vCPUs make the CPU faster.`;
  }

  $('use-gpu').addEventListener('change', async () => {
    const on = $('use-gpu').checked;
    try {
      await vm.invoke('llm:settings', { useGpu: on });
    } catch {
      /* the setting is only a preference */
    }
    st.settings.useGpu = on;
    const cur = loadedFile();
    if (cur) doLoad(cur); // reload with the new choice
    renderModels();
  });

  // ---------------------------------------------------------------------------------------------- header, status, composer

  let tick = null;
  function renderServer() {
    if (!st) return;
    const s = st.server;
    const stt = serverState();
    $('model-title').textContent = stt === 'ready' || stt === 'starting' ? s.model : 'No model loaded';
    $('unload').hidden = stt === 'stopped';
    const left = $('status-left');
    left.className = '';
    if (stt === 'starting') {
      left.textContent = `${s.message || 'Loading…'} ${fmtSecs(Date.now() - (s.startedAt || Date.now()))}`;
      if (!tick) tick = setInterval(renderServer, 1000);
    } else {
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
      if (stt === 'ready') {
        const g = s.gpu || {};
        let where;
        if (g.active) {
          where = `Mac GPU via RPC${g.layers !== undefined ? ` (${g.layers}/${g.totalLayers} layers)` : ''}`;
          left.className = 'on';
        } else if (g.requested) where = "GPU requested, but the log does not show it in use";
        else where = `CPU, ${s.threads} thread${s.threads === 1 ? '' : 's'}`;
        left.textContent = `${where} · context ${s.ctx}`;
      } else if (stt === 'error') {
        left.textContent = 'Not loaded';
      } else {
        left.textContent = `No model loaded · ${st.vm.cpus} vCPU${st.vm.cpus === 1 ? '' : 's'}, ${st.vm.memMiB} MB`;
      }
    }
    if (stt === 'error' && s.message) {
      const gpuFailed = s.gpu && s.gpu.requested;
      showBanner(
        s.message,
        'error',
        gpuFailed
          ? {
              label: 'Use the CPU instead',
              run: () => {
                $('use-gpu').checked = false;
                st.settings.useGpu = false;
                vm.invoke('llm:settings', { useGpu: false }).catch(() => {});
                doLoad(s.model);
              },
            }
          : null,
      );
    }
    renderComposer();
    renderCompute();
    renderModels();
  }

  function renderComposer() {
    const can = ready();
    $('input').disabled = !can || !!live;
    $('input').placeholder = can ? 'Message (Enter to send, Shift+Enter for a new line)' : serverState() === 'starting' ? 'Loading the model…' : 'Load a model to start chatting';
    $('send').disabled = !can || !!live;
    $('send').hidden = !!live;
    $('stop').hidden = !live;
  }

  function renderEmpty() {
    const has = conv.length > 0 || !!live;
    $('empty').hidden = has;
    if (has || !st) return;
    const n = st.models.local.length;
    $('empty-hint').textContent = n
      ? serverState() === 'starting'
        ? 'Loading the model…'
        : ready()
          ? 'Say something.'
          : 'Press Load next to a model on the left.'
      : 'Download a model on the left (the smallest is under 500 MB), or import a .gguf file you already have. Then press Load.';
  }

  function renderSpeed() {
    const r = $('status-right');
    if (live && live.tokens > 1 && live.lastAt > live.firstAt) {
      r.textContent = `~${fmtTps(((live.tokens - 1) / (live.lastAt - live.firstAt)) * 1000)}`;
    } else if (live) {
      r.textContent = 'Thinking…';
    } else if (lastSpeed) {
      r.textContent = [`Generation ${fmtTps(lastSpeed.genTps)}`, lastSpeed.promptTps ? `prompt ${fmtTps(lastSpeed.promptTps)}` : '', `${lastSpeed.tokens} tokens`].filter(Boolean).join(' · ');
    } else {
      r.textContent = '';
    }
  }

  $('unload').addEventListener('click', () => vm.invoke('llm:unload').catch((e) => showBanner(e.message)));

  // ---------------------------------------------------------------------------------------------- messages

  function renderInline(parent, text) {
    for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(h('code', { text: part.slice(1, -1) }));
      else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(h('strong', { text: part.slice(2, -2) }));
      else parent.append(document.createTextNode(part));
    }
  }

  /** Text with ``` fences and `code` / **bold**, built from DOM nodes (never innerHTML). */
  function renderText(container, text) {
    container.replaceChildren();
    text.split('```').forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const body = nl >= 0 && /^[\w+#.-]*$/.test(part.slice(0, nl).trim()) ? part.slice(nl + 1) : part;
        container.append(h('pre', {}, h('code', { text: body.replace(/\n$/, '') })));
      } else {
        for (const para of part.split(/\n{2,}/)) {
          if (!para.trim()) continue;
          const p = h('p');
          renderInline(p, para.replace(/^\n+|\n+$/g, ''));
          container.append(p);
        }
      }
    });
  }

  function addMessage(role, text, extra) {
    const bubble = h('div', { class: 'bubble' });
    const wrap = h('div', { class: `msg ${role}${extra && extra.error ? ' error' : ''}` }, bubble);
    if (text) renderText(bubble, text);
    $('messages').append(wrap);
    renderEmpty();
    scrollDown(true);
    return { wrap, bubble };
  }

  function scrollDown(force) {
    const m = $('messages');
    if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 80) m.scrollTop = m.scrollHeight;
  }

  let paintQueued = false;
  function paintLive() {
    if (paintQueued || !live) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (!live) return;
      const b = live.bubble;
      b.replaceChildren();
      if (live.reasoning) b.append(h('div', { class: 'reasoning', text: live.reasoning }));
      const body = h('div');
      renderText(body, live.text);
      b.append(body);
      if (live.running) b.classList.add('cursor');
      scrollDown(false);
      renderSpeed();
    });
  }

  async function send() {
    const text = $('input').value.trim();
    if (!text || !ready() || live) return;
    clearBanner();
    $('input').value = '';
    conv.push({ role: 'user', content: text });
    addMessage('user', text);
    const { wrap, bubble } = addMessage('assistant', '');
    live = { id: null, wrap, bubble, text: '', reasoning: '', tokens: 0, firstAt: 0, lastAt: 0, running: true, userText: text };
    renderComposer();
    renderModels();
    renderCompute();
    renderSpeed();
    bubble.classList.add('cursor');
    const sys = st.settings.systemPrompt.trim();
    const messages = (sys ? [{ role: 'system', content: sys }] : []).concat(conv);
    try {
      const r = await vm.invoke('llm:chat', { messages, temperature: st.settings.temperature, maxTokens: st.settings.maxTokens });
      if (live) live.id = r.id;
    } catch (e) {
      finishLive({ error: e.message });
    }
  }

  function finishLive({ stats, error }) {
    if (!live) return;
    const l = live;
    live = null;
    l.bubble.classList.remove('cursor');
    renderText(l.bubble, l.text || '');
    if (l.reasoning) l.bubble.prepend(h('div', { class: 'reasoning', text: l.reasoning }));
    if (error) {
      if (!l.text) {
        // nothing was generated: take the question back so it can be sent again
        l.wrap.remove();
        const last = $('messages').lastElementChild;
        if (last && last.classList.contains('user')) last.remove();
        conv.pop();
        $('input').value = l.userText;
      } else {
        conv.push({ role: 'assistant', content: l.text });
      }
      const tooLong = /context|too long|exceed/i.test(error);
      showBanner(tooLong ? `${error} Start a new chat, or pick a larger context size in Settings and reload the model.` : error);
    } else {
      conv.push({ role: 'assistant', content: l.text });
      if (stats) {
        lastSpeed = { genTps: stats.genTps, promptTps: stats.promptTps, tokens: stats.genTokens ?? l.tokens, gpu: stats.gpu };
        const bits = [fmtTps(stats.genTps), `${stats.genTokens ?? l.tokens} tokens`, stats.gpu ? "Mac GPU" : 'CPU'];
        if (stats.finish === 'stopped') bits.push('stopped');
        l.wrap.append(h('div', { class: 'stats', text: bits.filter(Boolean).join(' · ') }));
      }
    }
    renderComposer();
    renderModels();
    renderCompute();
    renderSpeed();
    renderEmpty();
    if (ready()) $('input').focus();
  }

  vm.on('llm:token', (m) => {
    if (!live || (live.id !== null && m.id !== live.id)) return;
    if (live.id === null) live.id = m.id;
    const now = performance.now();
    if (!live.firstAt) live.firstAt = now;
    live.lastAt = now;
    live.tokens += m.n || 1;
    if (m.kind === 'reasoning') live.reasoning += m.text;
    else live.text += m.text;
    paintLive();
  });
  vm.on('llm:done', (m) => {
    if (live && (live.id === null || live.id === m.id)) finishLive({ stats: m.stats });
  });
  vm.on('llm:chat-error', (m) => {
    if (live && (live.id === null || live.id === m.id)) finishLive({ error: m.error });
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $('stop').addEventListener('click', () => vm.send('llm:stop', live && live.id !== null ? { id: live.id } : {}));
  $('new-chat').addEventListener('click', () => {
    if (live) vm.send('llm:stop', {});
    conv = [];
    for (const e of [...$('messages').querySelectorAll('.msg')]) e.remove();
    lastSpeed = null;
    renderSpeed();
    renderEmpty();
    if (ready()) $('input').focus();
  });

  // ---------------------------------------------------------------------------------------------- settings and log

  function togglePanel(which, show) {
    for (const [name, btn] of [['settings', 'settings-btn'], ['log', 'log-btn']]) {
      const on = name === which && show;
      $(name).hidden = !on;
      $(btn).setAttribute('aria-expanded', String(on));
    }
  }
  $('settings-btn').addEventListener('click', () => togglePanel('settings', $('settings').hidden));
  $('settings-close').addEventListener('click', () => togglePanel('settings', false));
  $('log-btn').addEventListener('click', async () => {
    const show = $('log').hidden;
    togglePanel('log', show);
    if (show) refreshLog();
  });
  $('log-close').addEventListener('click', () => togglePanel('log', false));
  $('log-refresh').addEventListener('click', refreshLog);
  async function refreshLog() {
    try {
      const r = await vm.invoke('llm:logs');
      $('log-text').textContent = r.lines.length ? r.lines.join('\n') : '(nothing yet: load a model)';
    } catch (e) {
      $('log-text').textContent = e.message;
    }
  }

  function fillSettings() {
    const s = st.settings;
    $('system-prompt').value = s.systemPrompt;
    $('temperature').value = String(s.temperature);
    $('temp-out').textContent = s.temperature.toFixed(2);
    $('max-tokens').value = String(s.maxTokens);
    const sel = $('ctx');
    sel.replaceChildren(...st.ctxChoices.map((c) => h('option', { value: c, text: `${c} tokens`, selected: c === s.ctx })));
    $('settings-note').textContent = `Settings are saved in this app's private data. A larger context uses more memory (the model is the bigger part).`;
  }
  async function saveSetting(patch) {
    try {
      st.settings = await vm.invoke('llm:settings', patch);
    } catch (e) {
      showBanner(e.message);
    }
  }
  $('system-prompt').addEventListener('change', () => saveSetting({ systemPrompt: $('system-prompt').value }));
  $('temperature').addEventListener('input', () => {
    $('temp-out').textContent = Number($('temperature').value).toFixed(2);
  });
  $('temperature').addEventListener('change', () => saveSetting({ temperature: Number($('temperature').value) }));
  $('max-tokens').addEventListener('change', () => saveSetting({ maxTokens: Number($('max-tokens').value) }));
  $('ctx').addEventListener('change', async () => {
    await saveSetting({ ctx: Number($('ctx').value) });
    const cur = loadedFile();
    if (cur) showBanner('The new context size applies when the model is loaded.', 'info', { label: 'Reload now', run: () => doLoad(cur) });
  });

  // ---------------------------------------------------------------------------------------------- events from the core

  vm.on('llm:status', (s) => {
    if (!st) return;
    st.server = s;
    renderServer();
  });
  vm.on('llm:models', (m) => {
    if (!st) return;
    st.models = m;
    renderModels();
  });
  vm.on('llm:transfer', (t) => {
    transfer = t;
    if (t.phase === 'error') showBanner(t.error || 'The transfer failed.');
    if (t.phase === 'done' || t.phase === 'cancelled' || t.phase === 'error') {
      // the core sends llm:models right after; keep the last event so the row does not flicker
      transfer = null;
    }
    renderModels();
  });

  // ---------------------------------------------------------------------------------------------- start

  (async () => {
    try {
      st = await vm.invoke('llm:init');
    } catch (e) {
      showBanner(`Could not start: ${e.message}`);
      return;
    }
    $('use-gpu').checked = st.settings.useGpu && st.gpu.granted;
    fillSettings();
    if (st.models.transfer) transfer = st.models.transfer;
    renderServer();
    renderBanner();
    if (!st.binary.present) showBanner('llama-server is not bundled in this build of the app (run apps/local-llm/build.sh and pack again).');
    else if (!st.binary.supported) showBanner(`This CPU lacks instructions that llama-server needs (${st.binary.missing.join(', ')}).`);
  })();
})();
