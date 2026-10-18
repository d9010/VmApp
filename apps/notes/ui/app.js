'use strict';
// Notes UI: static script (the CSP allows script-src 'self' only). All logic goes through window.vmapp.

(() => {
  const api = window.vmapp;
  const $ = (id) => document.getElementById(id);
  const el = {
    empty: $('empty'), main: $('main'), list: $('list'), listEmpty: $('list-empty'),
    noSel: $('no-selection'), pane: $('editor-pane'), title: $('note-title'), dirty: $('dirty'),
    text: $('text'), status: $('status'),
    btnNew: $('btn-new'), btnImport: $('btn-import'), btnSave: $('btn-save'),
    btnExport: $('btn-export'), btnDelete: $('btn-delete'),
  };

  let notes = [];
  let current = null; // name of the open note
  let saved = ''; // text as last loaded or saved

  function setStatus(message, isError) {
    el.status.textContent = message || '';
    el.status.classList.toggle('error', !!isError);
  }

  const isDirty = () => current !== null && el.text.value !== saved;
  function refreshDirty() {
    el.dirty.hidden = !isDirty();
  }

  function renderList() {
    el.list.replaceChildren();
    for (const n of notes) {
      const li = document.createElement('li');
      li.textContent = n.name.replace(/\.md$/, '');
      li.title = n.name;
      li.classList.toggle('active', n.name === current);
      li.addEventListener('click', () => openNote(n.name));
      el.list.appendChild(li);
    }
    el.listEmpty.hidden = notes.length > 0;
  }

  function showEditor(open) {
    el.pane.hidden = !open;
    el.noSel.hidden = open;
  }

  async function confirmDiscard() {
    // keep it simple: unsaved edits are saved before switching away
    if (isDirty()) await save();
  }

  async function openNote(name) {
    try {
      await confirmDiscard();
      const text = await api.invoke('notes:read', name);
      current = name;
      saved = text;
      el.text.value = text;
      el.title.textContent = name;
      showEditor(true);
      refreshDirty();
      renderList();
      setStatus(`Opened ${name}`);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function save() {
    if (current === null) return;
    try {
      const text = el.text.value;
      await api.invoke('notes:save', current, text);
      saved = text;
      refreshDirty();
      setStatus(`Saved ${current}`);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function newNote() {
    try {
      await confirmDiscard();
      const { name } = await api.invoke('notes:create', 'Untitled');
      await openNote(name);
      el.text.focus();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function removeNote() {
    if (current === null) return;
    try {
      const r = await api.invoke('notes:delete', current);
      if (!r.deleted) return setStatus('Delete canceled');
      setStatus(`Deleted ${current}`);
      current = null;
      saved = '';
      el.text.value = '';
      showEditor(false);
      refreshDirty();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function exportNote() {
    if (current === null) return;
    try {
      const r = await api.invoke('notes:export', current, el.text.value);
      setStatus(`Exported ${r.file}`);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function importFile() {
    try {
      await confirmDiscard();
      const r = await api.invoke('notes:import');
      if (r.canceled) return setStatus('Import canceled');
      await openNote(r.name);
      setStatus(`Imported ${r.name}`);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  el.btnNew.addEventListener('click', newNote);
  el.btnImport.addEventListener('click', importFile);
  el.btnSave.addEventListener('click', save);
  el.btnExport.addEventListener('click', exportNote);
  el.btnDelete.addEventListener('click', removeNote);
  el.text.addEventListener('input', refreshDirty);
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
      ev.preventDefault();
      save();
    }
  });

  api.on('notes:changed', (list) => {
    notes = list;
    renderList();
  });
  api.on('notes:exported', (info) => setStatus(`Exported ${info.file} to your export folder`));

  async function start() {
    const status = await api.invoke('notes:status');
    if (!status.notesGranted) {
      el.empty.hidden = false;
      return;
    }
    el.main.hidden = false;
    notes = status.notes;
    renderList();
    showEditor(false);
    if (!status.exportGranted) {
      el.btnExport.disabled = true;
      el.btnExport.title = 'No export folder was granted';
    }
    if (status.last && notes.some((n) => n.name === status.last)) await openNote(status.last);
  }

  start().catch((e) => setStatus(e.message, true));
})();
