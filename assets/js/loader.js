/* ============================================================
   Velanzo - Loading screen
   Shows the crown logo with a blinking animation, then removes
   the overlay. Loads first so the white cover is shown before
   the rest of the page scripts.
   ============================================================ */
(function () {
  var el = document.getElementById('luno-loader');
  if (!el) return;

  el.innerHTML =
    '<img class="loader__crown" src="assets/images/velanzo-logo-bw.jpg" alt="Velanzo">';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var HOLD = reduce ? 500 : 2300;

  // Lock scroll while the loader is up.
  document.documentElement.style.overflow = 'hidden';

  function remove() {
    document.documentElement.style.overflow = '';
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function done() {
    el.classList.add('is-done');
    // Let page FX (scroll reveals etc.) know the curtain is lifting.
    try { window.dispatchEvent(new CustomEvent('luno:loader-done')); } catch (e) {}
    setTimeout(remove, 600);
  }

  function startLoader() {
    if (el.classList.contains('fonts-loaded')) return;
    el.classList.add('fonts-loaded');
    setTimeout(done, HOLD);
  }

  // Start immediately - no font dependency for the crown image
  var fallback = setTimeout(startLoader, 300);

  if (document.fonts && document.fonts.load) {
    document.fonts.load('600 1em Fraunces').then(function () {
      clearTimeout(fallback);
      startLoader();
    }).catch(function () {
      clearTimeout(fallback);
      startLoader();
    });
  } else {
    clearTimeout(fallback);
    startLoader();
  }
})();
