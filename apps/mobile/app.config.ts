import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Which build this is (`APP_VARIANT`):
 * - development: a debug build on the emulator, its JavaScript from Metro;
 * - test: a release build for the end-to-end flows, which reach the stack on this computer;
 * - production: a release build for a phone, which reaches the server over HTTPS only.
 *
 * The first two may use plain HTTP to this computer (localhost, or 10.0.2.2 from the emulator), and
 * nowhere else.
 */
const variant = process.env.APP_VARIANT ?? 'development';
// A release bundle (Expo sets NODE_ENV=production for it) must say which build it is: one made for a
// phone without saying so would otherwise be a development build, which allows plain HTTP.
if (process.env.NODE_ENV === 'production' && !process.env.APP_VARIANT) {
  throw new Error('Set APP_VARIANT for a release build: production for a phone, test for the flows');
}
if (!['development', 'test', 'production'].includes(variant)) {
  throw new Error(`APP_VARIANT must be development, test or production, not "${variant}"`);
}

// The theme's screen colour (`background`), so nothing flashes white while the app starts.
const DARK_BACKGROUND = '#0d0d0d';
const LIGHT_BACKGROUND = '#fafafa';
/** The mark's tile, as on the web app's icons. */
const ICON_BACKGROUND = '#151515';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'superagent',
  slug: 'superagent',
  scheme: 'superagent',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  backgroundColor: DARK_BACKGROUND,
  // Rendered from the web app's mark: `pnpm --filter @superagent/mobile icons`.
  icon: './assets/icon.png',
  android: {
    package: 'dev.superagent.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/adaptive-icon-monochrome.png',
      backgroundColor: ICON_BACKGROUND,
    },
    // The token lives in the keystore, which a backup can't carry anyway: don't back the app up.
    allowBackup: false,
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW'],
  },
  ios: {
    bundleIdentifier: 'dev.superagent.app',
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
  },
  plugins: [
    'expo-router',
    [
      'expo-font',
      {
        fonts: [
          './assets/fonts/MonaSans-Regular.ttf',
          './assets/fonts/MonaSans-Medium.ttf',
          './assets/fonts/MonaSans-SemiBold.ttf',
        ],
      },
    ],
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission: 'superagent uses the camera to scan the pairing code the web app shows.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 96,
        backgroundColor: LIGHT_BACKGROUND,
        dark: { image: './assets/splash-icon.png', backgroundColor: DARK_BACKGROUND },
      },
    ],
    './plugins/cmake-version.js',
    ...(variant === 'production' ? [] : ['./plugins/local-http.js']),
  ],
  extra: { variant },
});
