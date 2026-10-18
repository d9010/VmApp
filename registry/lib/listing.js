'use strict';
// The app list behind GET /api/apps and the server-rendered home page: search, sort, slice. One implementation, so the
// page and the API can never disagree about what a search finds or in which order apps come.

const present = require('./present');
const { searchableText } = require('./publisher');

const SORTS = ['popular', 'new', 'updated', 'name'];

const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const COMPARE = {
  popular: (a, b) => b.downloads - a.downloads || b.downloads30d - a.downloads30d || byName(a, b),
  new: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || byName(a, b),
  updated: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || byName(a, b),
  name: byName,
};

/**
 * @param {object} db
 * @param {{sort: string, q: string, limit: number, offset: number}} p `sort` is one of SORTS, `q` already trimmed and lower-cased
 * @returns {{total: number, items: object[]}} the list items (lib/present.js) of the visible apps, `items` being the requested slice
 */
function queryApps(db, { sort, q, limit, offset }) {
  let items = db.apps().map((a) => ({ it: present.listItem(db, a), pub: db.getPublisher(a.publisherId) }));
  if (q) {
    // search sees the app's own id, name and description, and only VERIFIED facts about the publisher
    const terms = q.split(/\s+/);
    items = items.filter(({ it, pub }) => {
      const hay = `${it.id}\n${it.name}\n${it.description}\n${searchableText(pub)}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  items = items.map((x) => x.it);
  items.sort(COMPARE[sort]);
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

module.exports = { SORTS, queryApps };
