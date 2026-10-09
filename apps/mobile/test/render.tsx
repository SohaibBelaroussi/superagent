import { beforeAll } from '@jest/globals';
import { render } from '@testing-library/react-native';
import { ExpoRoot, Slot } from 'expo-router';
// Also sets up what Expo Router needs under Jest (gesture handler, Reanimated and linking mocks).
import { getMockContext } from 'expo-router/testing-library';

/** The app's routes, with the tabs' layout drawing the route at the URL directly (see `renderApp`). */
function appContext() {
  // Routes load synchronously, as `renderRouter` has them.
  process.env.EXPO_ROUTER_IMPORT_MODE = 'sync';
  const context = getMockContext({
    appDir: './src/app',
    overrides: { '(tabs)/_layout': { default: () => <Slot /> } },
  });
  // As the app's own route context does, leave out `+native-intent` (it's not a screen).
  const routes = context.keys().filter((key) => !/(^|\/)\+native-intent(\.[tj]sx?)?$/.test(key));
  return Object.assign((id: string) => context(id), { ...context, keys: () => routes });
}

// Loading the routes transforms the app, Expo Router and React Native's components. On a cold cache,
// as in CI, that takes far longer than a test may: each file that renders the app does it first.
beforeAll(() => {
  const context = appContext();
  for (const route of context.keys()) context(route);
}, 180_000);

/**
 * Renders the whole app, its real routes, screens and providers, at `url`. The network is MSW's
 * (test/msw.ts); the keystore starts empty unless the test signs in first (`signedIn()`).
 *
 * Like Expo Router's `renderRouter`, with two differences:
 * - The tab bar is native, and under Jest it can't switch tabs, so the tabs' layout renders the
 *   route at `url` directly.
 * - Real timers. `renderRouter` turns fake ones on, and the live event stream's bytes then stop
 *   reaching the app after a file's first test.
 */
export async function renderApp(url = '/') {
  await render(<ExpoRoot context={appContext()} location={url} />);
}
