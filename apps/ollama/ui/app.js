// Ollama window. The page has no network and no Node: everything comes from the core (core/main.js lists the channels).
// The layout and the chat code are adapted from apps/local-llm/ui/app.js; the model handling is Ollama's (pull, delete, installed list).
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

  let st = null; // the core's ollama:init answer, kept up to date by events
  let pullEv = null; // the latest ollama:pull event
  let current = ''; // the model the chat uses
  let loadedNames = []; // the models Ollama has in memory (/api/ps)
  let compute = null; // where they run (CPU or GPU) and which devices Ollama found
  let conv = []; // [{role, content}] without the system prompt
  let live = null; // the reply being generated: {id, bubble, text, reasoning, tokens, firstAt, lastAt, ...}
  let lastSpeed = null; // {genTps, promptTps, tokens, where}
  let banner = null; // {text, kind, action}

  const serverState = () => (st && st.server && st.server.state) || 'stopped';
  const ready = () => serverState() === 'ready';
  const pullBusy = () => !!(pullEv && ['starting', 'download', 'verify'].includes(pullEv.phase));
  const isInstalled = (name) => !!(st && st.models.local.some((l) => l.name === name));
  const isLoaded = (name) => loadedNames.includes(name);

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

  function fitWarning(bytes) {
    if (!st) return '';
    const need = needMiB(bytes);
    if (need <= st.vm.memMiB * 0.9) return '';
    return `Needs about ${Math.round(need)} MB of memory and this VM has ${st.vm.memMiB} MB. Give it more memory on the app's card in the library.`;
  }

  async function select(name) {
    current = name;
    try {
      await vm.invoke('ollama:settings', { lastModel: name });
    } catch {
      /* only a preference */
    }
    renderAll();
    if (ready() && !live) $('input').focus();
  }

  async function doPull(name) {
    clearBanner();
    try {
      await vm.invoke('ollama:pull', { name });
    } catch (e) {
      showBanner(e.message);
    }
  }

  async function doDelete(name) {
    try {
      await vm.invoke('ollama:delete', { name });
      if (current === name) current = '';
    } catch (e) {
      showBanner(e.message);
    }
  }

  function progressBlock(t) {
    const pct = t.total ? Math.min(100, (t.received / t.total) * 100) : 0;
    let text;
    if (t.phase === 'verify') text = 'Verifying and saving…';
    else if (t.phase === 'starting' || !t.total) text = 'Contacting the registry…';
    else text = `${fmtBytes(t.received)} of ${fmtBytes(t.total)}${t.bps ? ` · ${fmtRate(t.bps)}` : ''} (${pct.toFixed(0)}%)`;
    return [
      h('progress', { max: 100, value: t.phase === 'verify' ? 100 : pct }),
      h('div', { class: 'progress-text', text }),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: 'Cancel', onclick: () => vm.invoke('ollama:cancel') })),
    ];
  }

  function modelRow({ name, title, meta, note, warn, installed }) {
    const pulling = pullEv && pullEv.name === name && pullBusy() ? pullEv : null;
    const selected = current === name && installed;
    const loadedHere = installed && isLoaded(name);
    let body;
    if (pulling) body = progressBlock(pulling);
    else if (installed) {
      body = h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: selected ? '' : 'primary', text: selected ? 'In use' : 'Use', disabled: selected || !!live, onclick: () => select(name) }),
        loadedHere ? h('button', { type: 'button', text: 'Unload', disabled: !!live, onclick: () => vm.invoke('ollama:unload', { name }).catch((e) => showBanner(e.message)) }) : null,
        h('button', { type: 'button', class: 'danger', text: 'Delete', disabled: !!live, onclick: () => doDelete(name) }),
      );
    } else {
      body = h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', text: 'Pull', disabled: pullBusy() || !ready(), onclick: () => doPull(name) }));
    }
    return h(
      'li',
      { class: `model ${selected ? 'selected' : ''}` },
      h('div', { class: 'name' }, title, loadedHere ? ' ' : '', loadedHere ? h('span', { class: 'badge ok', text: 'loaded' }) : null),
      h('div', { class: 'meta', text: meta }),
      note ? h('p', { class: 'note', text: note }) : null,
      warn ? h('p', { class: 'warn', text: warn }) : null,
      body,
    );
  }

  function renderModels() {
    if (!st) return;
    const m = st.models;
    const catalog = $('catalog');
    catalog.replaceChildren();
    for (const c of m.catalog) {
      const installed = m.local.find((l) => l.name === c.name);
      catalog.append(
        modelRow({
          name: c.name,
          title: c.title,
          meta: `${c.name} · ${c.quant} · ${fmtBytes(installed ? installed.bytes : c.bytes)} · ${c.license}`,
          note: c.note,
          warn: fitWarning(installed ? installed.bytes : c.bytes),
          installed: !!installed,
        }),
      );
    }
    const others = m.local.filter((l) => !m.catalog.some((c) => c.name === l.name));
    const pullingOther = pullEv && pullBusy() && !m.catalog.some((c) => c.name === pullEv.name) && !others.some((l) => l.name === pullEv.name) ? pullEv.name : '';
    $('other-head').hidden = !others.length && !pullingOther;
    const list = $('other');
    list.replaceChildren();
    if (pullingOther) list.append(modelRow({ name: pullingOther, title: pullingOther, meta: 'Downloading…', installed: false }));
    for (const l of others) {
      list.append(
        modelRow({
          name: l.name,
          title: l.name,
          meta: [l.params, l.quant, fmtBytes(l.bytes)].filter(Boolean).join(' · '),
          warn: fitWarning(l.bytes),
          installed: true,
        }),
      );
    }
    $('pull-btn').disabled = pullBusy() || !ready();
    $('pull-name').disabled = pullBusy() || !ready();
    $('space').textContent = m.freeBytes === null ? '' : `Models are stored in this app's private data (${fmtBytes(m.freeBytes)} free on that disk). Reset app in the loader deletes them.`;
    renderEmpty();
  }

  $('pull-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('pull-name').value.trim();
    if (!name) return;
    await doPull(name);
    if (!banner) $('pull-name').value = '';
  });

  // ---------------------------------------------------------------------------------------------- compute

  function renderCompute() {
    if (!st) return;
    const sup = st.gpu;
    const box = $('use-gpu');
    box.disabled = !sup.eligible || serverState() === 'starting' || !!live;
    box.checked = sup.eligible && st.settings.useGpu;
    $('gpu-label').className = `check ${sup.eligible ? '' : 'disabled'}`;
    const note = $('gpu-note');
    let text;
    if (sup.eligible) {
      text = "Runs the model on the Mac's GPU through Vulkan (experimental; the VM gets a paravirtual GPU). Switching it restarts Ollama and unloads the model.";
    } else if (!sup.device) {
      text = "Off: this VM has no GPU (no /dev/dri render node). The Mac's GPU for Ollama needs the experimental Vulkan backend of the platform, which this setup does not have. Everything runs on the VM's CPUs.";
    } else {
      text = "This VM has a GPU, but this build of Ollama has no Vulkan backend (the linux-arm64 release does not include one). Everything runs on the VM's CPUs.";
    }
    if (sup.rpcGranted) text += " The GPU permission that is granted gives llama.cpp's RPC; Ollama cannot use that.";
    note.textContent = text;
    $('vm-note').textContent = `This VM: ${st.vm.cpus} vCPU${st.vm.cpus === 1 ? '' : 's'}, ${st.vm.memMiB} MB memory. Change the size on the app's card in the library: more vCPUs make the CPU faster.`;
  }

  $('use-gpu').addEventListener('change', async () => {
    const on = $('use-gpu').checked;
    try {
      st.settings = await vm.invoke('ollama:settings', { useGpu: on });
    } catch (e) {
      $('use-gpu').checked = !on;
      showBanner(e.message);
    }
    renderAll();
  });

  // ---------------------------------------------------------------------------------------------- header, status, composer

  let tick = null;

  function devicesText() {
    const devs = (compute && compute.devices) || st.server.devices || [];
    if (!devs.length) return 'no compute device reported yet';
    return devs.map((d) => (d.library === 'cpu' ? 'CPU' : `${d.library}: ${d.name || d.description}`)).join(', ');
  }

  function renderStatus() {
    if (!st) return;
    const s = st.server;
    const stt = serverState();
    const left = $('status-left');
    left.className = '';
    if (stt === 'starting') {
      left.textContent = `${s.message || 'Starting Ollama…'} ${fmtSecs(Date.now() - (s.startedAt || Date.now()))}`;
      if (!tick) tick = setInterval(renderStatus, 1000);
      return;
    }
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
    if (stt === 'ready') {
      const cm = compute && compute.models.find((x) => x.name === current);
      if (cm) {
        if (cm.where === 'gpu') {
          const dev = compute.gpuDevices[0];
          left.className = 'on';
          left.textContent = `Mac GPU (${dev ? `${dev.library}, ${dev.name}` : 'Vulkan'}) · ${cm.percentGpu}% of the model in video memory (${fmtBytes(cm.vramBytes)})`;
        } else {
          const requested = st.settings.useGpu && st.gpu.eligible;
          left.textContent = `CPU · ${compute.threads || st.vm.cpus} threads · context ${cm.contextLength || st.settings.ctx}${requested ? ' · GPU requested, but Ollama kept the model on the CPU' : ''}`;
        }
      } else {
        left.textContent = `Ollama ${s.version} ready · ${st.vm.cpus} vCPU${st.vm.cpus === 1 ? '' : 's'}, ${st.vm.memMiB} MB · compute: ${devicesText()}`;
      }
    } else if (stt === 'error') {
      left.textContent = 'Ollama is not running';
    } else {
      left.textContent = 'Ollama is stopped';
    }
  }

  function renderServer() {
    if (!st) return;
    const stt = serverState();
    const s = st.server;
    $('model-title').textContent = current || 'No model selected';
    $('loaded-badge').hidden = !(current && isLoaded(current));
    $('unload').hidden = !loadedNames.length;
    if (stt === 'error') {
      showBanner(s.message || 'Ollama stopped.', 'error', { label: 'Restart Ollama', run: () => vm.invoke('ollama:restart').catch((e) => showBanner(e.message)) });
    }
    renderStatus();
    renderComposer();
    renderCompute();
    renderModels();
  }

  function renderAll() {
    renderServer();
    renderSpeed();
  }

  function canChat() {
    return ready() && !!current && isInstalled(current);
  }

  function renderComposer() {
    const can = canChat();
    $('input').disabled = !can || !!live;
    $('input').placeholder = can
      ? 'Message (Enter to send, Shift+Enter for a new line)'
      : serverState() === 'starting'
        ? 'Starting Ollama…'
        : 'Pull and select a model to start chatting';
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
        ? 'Starting Ollama…'
        : canChat()
          ? 'Say something. The first answer takes a moment while Ollama loads the model.'
          : 'Press Use next to a model on the left.'
      : 'Pull a model on the left (the smallest is under 400 MB). The download comes from Ollama\'s registry, the only place this app talks to.';
  }

  function renderSpeed() {
    const r = $('status-right');
    if (live && live.tokens > 1 && live.lastAt > live.firstAt) {
      r.textContent = `~${fmtTps(((live.tokens - 1) / (live.lastAt - live.firstAt)) * 1000)}`;
    } else if (live) {
      r.textContent = live.tokens ? '' : 'Loading the model, thinking…';
    } else if (lastSpeed) {
      r.textContent = [`Generation ${fmtTps(lastSpeed.genTps)}`, lastSpeed.promptTps ? `prompt ${fmtTps(lastSpeed.promptTps)}` : '', `${lastSpeed.tokens} tokens`].filter(Boolean).join(' · ');
    } else {
      r.textContent = '';
    }
  }

  $('unload').addEventListener('click', () => vm.invoke('ollama:unload', {}).catch((e) => showBanner(e.message)));

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
    if (!text || !canChat() || live) return;
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
      const r = await vm.invoke('ollama:chat', { model: current, messages, temperature: st.settings.temperature, maxTokens: st.settings.maxTokens });
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
      showBanner(tooLong ? `${error} Start a new chat, or pick a larger context size in Settings.` : error);
    } else {
      conv.push({ role: 'assistant', content: l.text });
      if (stats) {
        lastSpeed = { genTps: stats.genTps, promptTps: stats.promptTps, tokens: stats.genTokens ?? l.tokens, where: stats.where };
        const bits = [fmtTps(stats.genTps), `${stats.genTokens ?? l.tokens} tokens`, stats.where === 'gpu' ? 'Mac GPU' : 'CPU', stats.model];
        if (stats.loadMs > 1000) bits.push(`model loaded in ${fmtSecs(stats.loadMs)}`);
        if (stats.finish === 'stopped') bits.push('stopped');
        else if (stats.finish === 'length') bits.push('hit the length limit');
        l.wrap.append(h('div', { class: 'stats', text: bits.filter(Boolean).join(' · ') }));
      }
    }
    renderAll();
    renderEmpty();
    if (ready()) $('input').focus();
  }

  vm.on('ollama:token', (m) => {
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
  vm.on('ollama:done', (m) => {
    if (live && (live.id === null || live.id === m.id)) finishLive({ stats: m.stats });
  });
  vm.on('ollama:chat-error', (m) => {
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
  $('stop').addEventListener('click', () => vm.send('ollama:stop', live && live.id !== null ? { id: live.id } : {}));
  $('new-chat').addEventListener('click', () => {
    if (live) vm.send('ollama:stop', {});
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
      const r = await vm.invoke('ollama:logs');
      $('log-text').textContent = r.lines.length ? r.lines.join('\n') : '(nothing yet)';
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
    $('settings-note').textContent = "Settings are saved in this app's private data. A larger context uses more memory (the model is the bigger part). Changing it reloads the model at the next question.";
  }
  async function saveSetting(patch) {
    try {
      st.settings = await vm.invoke('ollama:settings', patch);
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
  $('ctx').addEventListener('change', () => saveSetting({ ctx: Number($('ctx').value) }));

  // ---------------------------------------------------------------------------------------------- events from the core

  vm.on('ollama:status', (s) => {
    if (!st) return;
    st.server = s;
    if (s.state === 'ready' && banner && banner.action && banner.action.label === 'Restart Ollama') clearBanner();
    renderServer();
  });
  vm.on('ollama:models', (m) => {
    if (!st) return;
    st.models = m;
    if (current && !m.local.some((l) => l.name === current)) current = '';
    renderAll();
  });
  vm.on('ollama:loaded', (m) => {
    loadedNames = m.models;
    compute = m.compute;
    renderAll();
  });
  vm.on('ollama:pull', (t) => {
    pullEv = t;
    if (t.phase === 'error') showBanner(t.error || 'The download failed.');
    if (t.phase === 'done' && !current) {
      current = t.name; // the first model you pull becomes the one in use
      vm.invoke('ollama:settings', { lastModel: current }).catch(() => {});
    }
    if (t.phase === 'done' || t.phase === 'cancelled' || t.phase === 'error') pullEv = null; // the core sends ollama:models right after
    renderModels();
    renderComposer();
  });

  setInterval(() => {
    if (ready() && !live) vm.invoke('ollama:ps').catch(() => {});
  }, 10000);

  // ---------------------------------------------------------------------------------------------- start

  (async () => {
    try {
      st = await vm.invoke('ollama:init');
    } catch (e) {
      showBanner(`Could not start: ${e.message}`);
      return;
    }
    compute = st.compute;
    loadedNames = st.compute.models.map((m) => m.name);
    if (st.models.pull) pullEv = { ...st.models.pull };
    const last = st.settings.lastModel;
    if (last && st.models.local.some((l) => l.name === last)) current = last;
    fillSettings();
    renderAll();
    renderBanner();
    if (!st.binary.present) showBanner('Ollama is not bundled in this build of the app (run apps/ollama/build.sh and pack again).');
  })();
})();
