// Runs in <head> before first paint so a saved light/dark choice never flashes the wrong theme.
(function () {
  try {
    var t = localStorage.getItem('b2d-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system setting */ }
})();
