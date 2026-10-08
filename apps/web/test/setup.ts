import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw';

// jsdom lacks a few browser APIs the app and Base UI touch.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.scrollTo ??= () => {};

// jsdom's FormData and File aren't the ones Node's fetch serializes: a multipart upload would go out
// with an empty "blob". Requests are Node's here, so the app builds its forms with Node's classes, as a
// browser builds them with its own.
const nodeFormData = (
  await new Response('', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;
globalThis.FormData = nodeFormData;
globalThis.File = (await import('node:buffer')).File as unknown as typeof File;

// Pages load on first visit: a test's first page waits for its module, which takes longer than the
// default second when every test file runs at once.
configure({ asyncUtilTimeout: 3000 });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.localStorage.clear();
});
afterAll(() => server.close());
