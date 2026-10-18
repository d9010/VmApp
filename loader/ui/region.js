'use strict';
/* global region */
// "Select a region…" page: drag a rectangle, release to confirm, Esc or a right click to cancel. Positions are window-local
// points; the main process turns them into global desktop points. The page can only send a rectangle or a cancel.

(() => {
  const dim = document.getElementById('dim');
  const sel = document.getElementById('sel');
  const size = document.getElementById('size');
  const hint = document.getElementById('hint');
  let start = null;
  let box = null;
  let sent = false;

  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  function draw(r) {
    sel.style.left = `${r.x}px`;
    sel.style.top = `${r.y}px`;
    sel.style.width = `${r.w}px`;
    sel.style.height = `${r.h}px`;
    size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    size.style.top = r.y < 30 ? `${r.h + 6}px` : '-26px';
  }

  function finish(fn) {
    if (sent) return;
    sent = true;
    Promise.resolve(fn()).catch(() => {});
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) return finish(() => region.cancel());
    if (e.button !== 0 || sent) return;
    start = { x: e.clientX, y: e.clientY };
    box = rectOf(start, start);
    dim.hidden = true;
    hint.hidden = true;
    sel.hidden = false;
    draw(box);
  });
  window.addEventListener('mousemove', (e) => {
    if (!start || sent) return;
    box = rectOf(start, { x: e.clientX, y: e.clientY });
    draw(box);
  });
  window.addEventListener('mouseup', (e) => {
    if (!start || e.button !== 0 || sent) return;
    box = rectOf(start, { x: e.clientX, y: e.clientY });
    start = null;
    if (box.w < 8 || box.h < 8) {
      // a click, not a selection: start over
      sel.hidden = true;
      dim.hidden = false;
      hint.hidden = false;
      return;
    }
    finish(() => region.done(box));
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    finish(() => region.cancel());
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(() => region.cancel());
  });
})();
