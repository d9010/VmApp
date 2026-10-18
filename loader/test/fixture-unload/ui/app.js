'use strict';
// Unload Test page: when the test asks, it vetoes its own unload the way VS Code does (window.confirmBeforeClose), with a text of
// its own that the loader must never show.
window.__armUnload = () => {
  window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = 'PAGE TEXT: the loader must not show this';
    return e.returnValue;
  });
  document.getElementById('state').textContent = 'armed';
  return true;
};
