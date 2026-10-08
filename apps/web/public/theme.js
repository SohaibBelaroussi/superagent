// Applies the saved theme before the first paint, so a page never flashes the other one. A file rather
// than an inline script: the app's Content-Security-Policy allows scripts from its own origin only.
(() => {
  let choice = 'system';
  try {
    choice = localStorage.getItem('superagent.theme') ?? 'system';
  } catch {
    // Storage blocked (private mode, site data off): follow the system.
  }
  const prefersLight =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  const theme = choice === 'light' || choice === 'dark' ? choice : prefersLight ? 'light' : 'dark';
  document.documentElement.classList.add(theme);
})();
