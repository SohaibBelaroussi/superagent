import { render } from '@testing-library/react-native';
import { ExpoRoot, Slot } from 'expo-router';
// Also sets up what Expo Router needs under Jest (gesture handler, Reanimated and linking mocks).
import { getMockContext } from 'expo-router/testing-library';

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
  // Routes load synchronously, as `renderRouter` has them.
  process.env.EXPO_ROUTER_IMPORT_MODE = 'sync';
  const context = getMockContext({
    appDir: './src/app',
    overrides: { '(tabs)/_layout': { default: () => <Slot /> } },
  });
  await render(<ExpoRoot context={context} location={url} />);
}
