'use strict';
// The pure parts of the screenshot picker and the region selection (SPEC 8.2): no Electron, so the unit tests can check them.
// capture-picker.js and region-select.js are the windows around these functions.

const MIN_REGION = 8; // points: a smaller drag counts as a click, not a selection
const MAX_WINDOWS = 80;
const MIN_WINDOW_POINTS = 50; // helper and tooltip windows below this size are not offered

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The part of `rect` inside `bounds` (both {x,y,w,h}), or null when nothing is left. */
function clipRect(rect, bounds) {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const w = Math.min(rect.x + rect.w, bounds.x + bounds.w) - x;
  const h = Math.min(rect.y + rect.h, bounds.y + bounds.h) - y;
  return w >= 1 && h >= 1 ? { x, y, w, h } : null;
}

/** A selection in window-local points -> global desktop points, or null when it is too small or malformed. */
function localToGlobal(sel, origin) {
  if (!isObj(sel)) return null;
  const n = ['x', 'y', 'w', 'h'].map((k) => Number(sel[k]));
  if (n.some((v) => !Number.isFinite(v)) || n[2] < MIN_REGION || n[3] < MIN_REGION) return null;
  return { x: Math.round(origin.x + n[0]), y: Math.round(origin.y + n[1]), w: Math.round(n[2]), h: Math.round(n[3]) };
}

/** hostctl `displays` items -> what the picker page gets (plain numbers and strings). */
function displaysForPage(list) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && Number.isInteger(d.display) && isObj(d.bounds))
    .map((d) => ({
      display: d.display,
      name: String(d.name || `Display ${d.display}`).slice(0, 60),
      main: !!d.main,
      builtin: !!d.builtin,
      scale: num(d.scale) || 1,
      bounds: { x: num(d.bounds.x), y: num(d.bounds.y), w: num(d.bounds.w), h: num(d.bounds.h) },
    }));
}

/** hostctl `windows` items -> the windows worth offering: not the loader's own, not tiny, with an owner, sorted by app. */
function windowsForPage(list, excludePids) {
  const skip = new Set(excludePids || []);
  return (Array.isArray(list) ? list : [])
    .filter((w) => w && Number.isInteger(w.windowId) && !skip.has(w.pid) && w.app && isObj(w.bounds) && num(w.bounds.w) >= MIN_WINDOW_POINTS && num(w.bounds.h) >= MIN_WINDOW_POINTS)
    .map((w) => ({
      windowId: w.windowId,
      app: String(w.app).slice(0, 60),
      title: String(w.title || '').slice(0, 120),
      bounds: { x: num(w.bounds.x), y: num(w.bounds.y), w: num(w.bounds.w), h: num(w.bounds.h) },
    }))
    .sort((a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title))
    .slice(0, MAX_WINDOWS);
}

/**
 * What is selected when the picker opens: the app's suggestion if it exists, else the main display.
 * `suggested` says whether the selection IS the app's suggestion (the page labels it so; the user still has to press Allow).
 */
function preselect(suggestion, displays, windows) {
  const s = isObj(suggestion) ? suggestion : {};
  if (s.target === 'window' && windows.some((w) => w.windowId === s.windowId)) return { selected: { kind: 'window', windowId: s.windowId }, suggested: true };
  if (s.target === 'display' && s.display !== undefined && displays.some((d) => d.display === s.display)) return { selected: { kind: 'display', display: s.display }, suggested: true };
  const main = displays.find((d) => d.main) || displays[0];
  return { selected: main ? { kind: 'display', display: main.display } : null, suggested: s.target === 'display' && s.display === undefined && !!main };
}

/**
 * The checked answer of the picker: `choice` is what the page sent, `offered` is what the main process offered
 * ({displays, windows, region}). Returns the capture target {kind, display? | windowId? | region?} or null when the page
 * asks for something it was not offered.
 */
function targetFromChoice(choice, offered) {
  if (!isObj(choice)) return null;
  if (choice.kind === 'display' && offered.displays.some((d) => d.display === choice.display)) return { kind: 'display', display: choice.display };
  if (choice.kind === 'window' && offered.windows.some((w) => w.windowId === choice.windowId)) return { kind: 'window', windowId: choice.windowId };
  if (choice.kind === 'region' && offered.region) {
    const r = offered.region;
    return { kind: 'region', region: { x: r.x, y: r.y, w: r.w, h: r.h } };
  }
  return null;
}

module.exports = { MIN_REGION, clipRect, localToGlobal, displaysForPage, windowsForPage, preselect, targetFromChoice };
