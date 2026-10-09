/*
 * Native modules a test can't load stand in as small in-memory fakes, and MSW answers the network
 * (only the network: never our own hooks). Each test starts signed out, with empty stores.
 */
import { afterAll, afterEach, beforeAll, jest } from '@jest/globals';
import { configure } from '@testing-library/react-native';
import { resetDevice } from './device';
import { server } from './msw';

jest.mock('expo-secure-store', () => require('./device').secureStore);
jest.mock('expo-sqlite/kv-store', () => ({ Storage: require('./device').kvStore }));
jest.mock('expo-network', () => require('./device').network);
jest.mock('expo-clipboard', () => require('./device').clipboard);
jest.mock('expo-web-browser', () => require('./device').browser);
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));
jest.mock('expo-device', () => ({ modelName: 'Pixel 9', osName: 'Android', osVersion: '16' }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()],
}));

configure({ asyncUtilTimeout: 5_000 });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetDevice();
});
afterAll(() => server.close());
