/* Aplica el tema guardado antes del primer render. auto = seguir al sistema. */
(function () {
  try {
    var t = localStorage.getItem('sinoptica.tema');
    if (t === 'dark' || t === 'light') document.documentElement.dataset.tema = t;
  } catch (e) { /* sin localStorage: queda auto */ }
})();
