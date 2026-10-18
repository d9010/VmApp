'use strict';
// Front end: plain fetch() calls to the REST API of server.js (same origin, relative URLs).

const $ = (id) => document.getElementById(id);

function showError(message) {
  const el = $('error');
  el.textContent = message || '';
  el.hidden = !message;
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'HTTP ' + res.status;
    try { message = (await res.json()).error || message; } catch { /* no JSON body */ }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

async function refresh() {
  const list = await request('GET', '/api/bookmarks');
  const ul = $('list');
  ul.textContent = '';
  for (const b of list) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const a = document.createElement('a');
    a.href = b.url;
    a.textContent = b.title;
    a.rel = 'noreferrer';
    const small = document.createElement('small');
    small.textContent = b.url;
    meta.append(a, small);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      try {
        await request('DELETE', '/api/bookmarks/' + encodeURIComponent(b.id));
        await refresh();
      } catch (err) { showError(err.message); }
    });
    li.append(meta, del);
    ul.appendChild(li);
  }
  $('empty').hidden = list.length > 0;
}

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  try {
    await request('POST', '/api/bookmarks', { title: $('title').value, url: $('url').value });
    $('title').value = '';
    $('url').value = '';
    await refresh();
  } catch (err) { showError(err.message); }
});

refresh().catch((err) => showError(err.message));
