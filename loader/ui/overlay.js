'use strict';
/* global overlay */
// The virtual-input overlay page (INV-H3). It draws what the loader tells it: a ring at the virtual pointer, ripples on a
// press, a fading caption of the keys typed. The text is inserted as text. The state is mirrored into data- attributes
// (data-x, data-y, data-inside, data-down on the ring; data-text on the caption) so the tests can read what is drawn.

(() => {
  const ring = document.getElementById('ring');
  const ripples = document.getElementById('ripples');
  const caption = document.getElementById('caption');
  let idleTimer = null;
  let captionTimer = null;
  let seen = 0;

  function ripple(x, y, delay) {
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (delay) el.style.animationDelay = `${delay}ms`;
    el.addEventListener('animationend', () => el.remove());
    ripples.appendChild(el);
  }

  function setRing(m) {
    ring.dataset.x = String(Math.round(m.x));
    ring.dataset.y = String(Math.round(m.y));
    ring.dataset.inside = String(!!m.inside);
    ring.dataset.down = String(!!m.down);
    if (!m.inside) {
      ring.hidden = true;
      return;
    }
    ring.hidden = false;
    ring.classList.remove('idle');
    ring.style.transform = `translate3d(${m.x}px, ${m.y}px, 0) scale(${m.down ? 0.8 : 1})`;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ring.classList.add('idle'), 4000);
    for (let i = 0; i < (m.ripples || 0); i++) ripple(m.x, m.y, i * 140);
  }

  function setCaption(text) {
    clearTimeout(captionTimer);
    caption.dataset.text = text || '';
    if (!text) {
      caption.classList.remove('show');
      return;
    }
    caption.textContent = text;
    caption.classList.add('show');
    captionTimer = setTimeout(() => caption.classList.remove('show'), 2200);
  }

  overlay.onEvent((m) => {
    if (!m || typeof m !== 'object') return;
    seen++;
    document.body.dataset.events = String(seen);
    if (m.t === 'ring') setRing(m);
    else if (m.t === 'caption') setCaption(typeof m.text === 'string' ? m.text : '');
  });
  overlay.ready();
})();
