// Runs before the app. A file rather than an inline script: the app's Content-Security-Policy allows
// scripts from its own origin only, and no eval.

// Zod compiles object parsers with `new Function` when it may, and finds out by trying as each schema is
// made, which the CSP reports. Set before any module loads, so no schema is made without it, whichever
// chunk the bundler puts the schemas in.
globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };

// The saved theme, before the first paint, so a page never flashes the other one.
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
