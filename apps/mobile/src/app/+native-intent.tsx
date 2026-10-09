/**
 * Links from outside the app (another app, a web page, an agent's link in the in-app browser) may open
 * only the pairing screen, which names the server and waits for the owner (D53). Every other screen
 * opens only from inside the app, so a link can't make it act for the owner. Anything else is ignored.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    // `superagent://pair?…` and `/pair?…` alike.
    const route = `/${path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '')}`;
    return /^\/pair(?:[/?#]|$)/.test(route) ? route : null;
  } catch {
    return null;
  }
}
