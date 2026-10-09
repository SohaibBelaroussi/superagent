/*
 * Native modules a test can't load stand in as small in-memory fakes, and MSW answers the network
 * (only the network: never our own hooks). Each test starts signed out, with empty stores.
 */
import { afterAll, afterEach, beforeAll, jest } from '@jest/globals';
import { timeoutManager } from '@tanstack/react-query';
import { configure } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { resetDevice } from './device';
import { server } from './msw';

// Under Jest the native module carries no app config: the tests run the app as the end-to-end flows
// build it (APP_VARIANT=test), which may use plain HTTP to this computer.
Object.assign(Constants.expoConfig ?? {}, { extra: { variant: 'test' } });

// The query cache forgets what a test left behind minutes later. Those timers mustn't keep Jest
// running once the tests are done.
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => setTimeout(callback, delay).unref(),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  setInterval: (callback, delay) => setInterval(callback, delay).unref(),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
});

jest.mock('expo-secure-store', () => require('./device').secureStore);
jest.mock('expo-sqlite/kv-store', () => ({ Storage: require('./device').kvStore }));
jest.mock('expo-network', () => require('./device').network);
jest.mock('expo-clipboard', () => require('./device').clipboard);
jest.mock('expo-web-browser', () => require('./device').browser);
jest.mock('expo-notifications', () => require('./device').notifications);
jest.mock('expo-task-manager', () => require('./device').taskManager);
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
