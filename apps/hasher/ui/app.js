'use strict';
// Hasher UI: static script (CSP: script-src 'self'). Talks to the Rust core through window.vmapp only.

(() => {
  const api = window.vmapp;
  const $ = (id) => document.getElementById(id);
  const el = {
    choose: $('btn-choose'), cancel: $('btn-cancel'), save: $('btn-save'),
    area: $('progress-area'), fill: $('bar-fill'), count: $('progress-count'), current: $('progress-current'),
    placeholder: $('placeholder'), table: $('table'), rows: $('rows'), status: $('status'),
  };
  const MAX_ROWS_SHOWN = 2000; // the report always holds every file; the table only shows the first ones

  let shown = 0;
  let received = 0;

  function setStatus(message, isError) {
    el.status.textContent = message || '';
    el.status.classList.toggle('error', !!isError);
  }
  // A handler's error reaches the page as Electron words it: "Error invoking remote method '<channel>': Error: <message>". Show the message.
  const reason = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }

  function addRow(r) {
    received++;
    if (shown >= MAX_ROWS_SHOWN) return;
    shown++;
    const tr = document.createElement('tr');
    const path = document.createElement('td');
    path.textContent = r.path;
    path.title = r.path;
    const size = document.createElement('td');
    const hash = document.createElement('td');
    if (r.error) {
      size.textContent = '';
      hash.textContent = r.error;
      hash.className = 'err';
    } else {
      size.textContent = formatSize(r.size);
      hash.textContent = r.sha256;
      hash.className = 'hash';
      hash.title = r.sha256;
    }
    tr.append(path, size, hash);
    el.rows.appendChild(tr);
  }

  function setBusy(busy) {
    el.choose.disabled = busy;
    el.cancel.hidden = !busy;
    if (busy) el.save.disabled = true;
  }

  api.on('started', (info) => {
    el.rows.replaceChildren();
    shown = 0;
    received = 0;
    el.placeholder.hidden = true;
    el.table.hidden = false;
    el.area.hidden = false;
    el.fill.style.width = '0%';
    el.count.textContent = `0 / ${info.total}`;
    el.current.textContent = '';
    setBusy(true);
    setStatus(info.truncated ? 'Only the first 10,000 files are hashed.' : 'Hashing…');
  });

  api.on('progress', (p) => {
    el.fill.style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : '100%';
    el.count.textContent = `${p.done} / ${p.total}`;
    el.current.textContent = p.current;
  });

  api.on('result', addRow);

  api.on('done', (d) => {
    setBusy(false);
    el.save.disabled = d.count === 0;
    if (d.count === 0) {
      el.placeholder.hidden = false;
      el.placeholder.textContent = d.canceled ? 'Canceled.' : 'That folder has no files.';
      el.table.hidden = true;
    }
    const parts = [`${d.count} file${d.count === 1 ? '' : 's'} hashed`];
    if (d.errors) parts.push(`${d.errors} could not be read`);
    if (d.truncated) parts.push('stopped at 10,000 files');
    if (d.canceled) parts.push('canceled');
    if (received > shown) parts.push(`table shows the first ${shown}; the report has all of them`);
    setStatus(parts.join(' · '), d.errors > 0);
  });

  el.choose.addEventListener('click', async () => {
    try {
      const r = await api.invoke('hasher:choose');
      if (r.canceled) setStatus('No folder chosen.');
    } catch (e) {
      setStatus(reason(e), true);
    }
  });

  el.cancel.addEventListener('click', () => api.invoke('hasher:cancel').catch(() => {}));

  el.save.addEventListener('click', async () => {
    try {
      const r = await api.invoke('hasher:save');
      setStatus(r.canceled ? 'Save canceled.' : `Saved a report with ${r.count} line${r.count === 1 ? '' : 's'}.`);
    } catch (e) {
      setStatus(reason(e), true);
    }
  });
})();
