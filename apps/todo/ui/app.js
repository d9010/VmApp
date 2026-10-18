'use strict';
// Todo UI: static script (CSP: script-src 'self'). Talks to the C# core through window.vmapp only.

(() => {
  const api = window.vmapp;
  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('form'), input: $('input'), list: $('list'), empty: $('empty'),
    summary: $('summary'), status: $('status'), clear: $('btn-clear'),
  };

  function setStatus(message, isError) {
    el.status.textContent = message || '';
    el.status.classList.toggle('error', !!isError);
  }

  async function call(channel, ...args) {
    try {
      render(await api.invoke(channel, ...args));
      setStatus('');
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  function render(items) {
    el.list.replaceChildren();
    for (const t of items) {
      const li = document.createElement('li');
      li.classList.toggle('done', t.done);

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = t.done;
      box.setAttribute('aria-label', 'Done');
      box.addEventListener('change', () => call('todo:toggle', t.id));

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = t.text;

      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete');
      del.addEventListener('click', () => call('todo:delete', t.id));

      li.append(box, text, del);
      el.list.appendChild(li);
    }
    const open = items.filter((t) => !t.done).length;
    const done = items.length - open;
    el.empty.hidden = items.length > 0;
    el.list.hidden = items.length === 0;
    el.clear.disabled = done === 0;
    el.summary.textContent = items.length ? `${open} open, ${done} done` : '';
  }

  el.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    await call('todo:add', text);
    el.input.focus();
  });

  el.clear.addEventListener('click', () => call('todo:clear-completed'));

  // The core emits the whole list after every change (also covers changes made from elsewhere).
  api.on('changed', render);

  call('todo:list');
  el.input.focus();
})();
