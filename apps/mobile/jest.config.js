// Jest with Expo's preset: whole screens rendered through Expo Router, MSW answering the network
// (test/msw.ts), and in-memory stand-ins for the native modules a test can't load (test/setup.ts).

const path = require('node:path');

// ESM-only packages Babel must transform: the Markdown parser's family, and MSW's dependencies.
const ESM = [
  'mdast-util-[^/]+',
  'micromark[^/]*',
  'unist-util-[^/]+',
  'decode-named-character-reference',
  'character-entities[^/]*',
  'ccount',
  'devlop',
  'longest-streak',
  'markdown-table',
  'zwitch',
  'escape-string-regexp',
  'rettime',
  'until-async',
  '@open-draft',
  '@mswjs',
  'outvariant',
  'strict-event-emitter',
  'headers-polyfill',
  'is-node-process',
  'lucide-react-native',
  // Push's decryption (ESM only).
  '@noble',
  // In jest-expo's own list (Expo Router's navigation).
  'standard-navigation',
];

module.exports = {
  preset: 'jest-expo',
  // MSW's Node build refuses the 'react-native' export condition the preset resolves with: by path,
  // its CommonJS build (Jest runs CommonJS).
  moduleNameMapper: {
    '^msw/node$': path.join(path.dirname(require.resolve('msw/package.json')), 'lib', 'node', 'index.js'),
  },
  setupFiles: ['<rootDir>/test/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  transform: { '\\.mjs$': 'babel-jest' },
  transformIgnorePatterns: [
    `/node_modules/(?!(\\.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|${ESM.join('|')}))`,
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  // Screens load their routes on first render: slower than Jest's default when every file runs at once.
  testTimeout: 15_000,
};
