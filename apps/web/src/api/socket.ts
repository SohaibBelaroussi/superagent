/**
 * The address of a WebSocket route on this origin. A browser can't put a header on a WebSocket, so the
 * token goes as `?apiKey=` (the API's request log never records it).
 */
export function socketUrl(path: string, token: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('apiKey', token);
  return url.toString();
}
