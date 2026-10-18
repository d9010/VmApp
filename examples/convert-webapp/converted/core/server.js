'use strict';
// Bookmarks: an Express server. Serves public/ and a small REST API:
//   GET    /api/bookmarks       -> [ { id, title, url, createdAt } ]
//   POST   /api/bookmarks       -> 201 + the new bookmark   (body: { title, url })
//   DELETE /api/bookmarks/:id   -> 204, or 404
// Bookmarks are stored in $DATA_DIR/bookmarks.json (DATA_DIR defaults to ./data).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookmarks.json');

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic replace
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/bookmarks', (_req, res) => {
  res.json(load());
});

app.post('/api/bookmarks', (req, res) => {
  const { title, url } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) {
    return res.status(400).json({ error: 'url must be an http(s) URL' });
  }
  const bookmark = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 200),
    url,
    createdAt: new Date().toISOString(),
  };
  const list = load();
  list.push(bookmark);
  save(list);
  res.status(201).json(bookmark);
});

app.delete('/api/bookmarks/:id', (req, res) => {
  const list = load();
  const next = list.filter((b) => b.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: 'not found' });
  save(next);
  res.status(204).end();
});

app.listen(PORT, HOST, () => {
  console.log(`Bookmarks listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
});
