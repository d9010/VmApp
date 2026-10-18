'use strict';
// Window Net Test page: what the test asks for, from the page itself. A no-cors fetch resolves (an opaque response) when the request
// reached the server and rejects when anything refused it; the page cannot tell which part refused, the Inspector can.
const note = (s) => {
  const li = document.createElement('li');
  li.textContent = s;
  document.getElementById('log').appendChild(li);
};

window.__fetch = (url) =>
  fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(
    (r) => (note(`fetched ${url}: ${r.type}`), { ok: true, type: r.type }),
    (e) => (note(`refused ${url}: ${e}`), { ok: false, error: String(e) }),
  );

// a script from the network: never runs (no feature adds a network source to script-src, and the request filter refuses scripts)
window.__script = (url) =>
  new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve({ loaded: true });
    s.onerror = () => resolve({ loaded: false });
    document.head.appendChild(s);
  });

// an image from the network: allowed with the grant (img-src https:)
window.__image = (url) =>
  new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve({ loaded: true, width: i.naturalWidth });
    i.onerror = () => resolve({ loaded: false });
    i.src = url;
  });
