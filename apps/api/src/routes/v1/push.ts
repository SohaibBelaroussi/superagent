import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  MyPushSchema,
  PushConfigInputSchema,
  PushDeviceInputSchema,
  PushDeviceSchema,
  PushStatusSchema,
} from '@superagent/shared';
import { ADMIN_TOKEN_ID } from '../../auth/tokens';
import { currentUser, requireAdminToken } from '../../http/auth';
import { ApiError, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const tags = ['push'];
const adminOnly = problemResponse('Only the admin token can set up push notifications');
const deviceOnly = problemResponse('Only a device token has a device to register');
const json = <T>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });

const getMine = createRoute({
  method: 'get',
  path: '/push/device',
  tags,
  summary: "This device's push registration",
  description: 'Whether the server can send pushes, and what this device token registered.',
  responses: { 200: json(MyPushSchema, 'Push for this device') },
});

const putMine = createRoute({
  method: 'put',
  path: '/push/device',
  tags,
  summary: 'Register this device for push notifications',
  description:
    'With a device token. The key, made on the phone, encrypts every payload sent to it (D54); it is ' +
    'sealed on the server and never returned. Registering again replaces the push token, key and kinds.',
  request: body(PushDeviceInputSchema),
  responses: {
    200: json(PushDeviceSchema, 'Registered'),
    400: problemResponse('Invalid request'),
    403: deviceOnly,
  },
});

const deleteMine = createRoute({
  method: 'delete',
  path: '/push/device',
  tags,
  summary: 'Stop push notifications to this device',
  responses: { 204: { description: 'Unregistered (or never was)' }, 403: deviceOnly },
});

const testMine = createRoute({
  method: 'post',
  path: '/push/device/test',
  tags,
  summary: 'Send this device a test notification',
  responses: {
    204: { description: 'Sent' },
    403: deviceOnly,
    409: problemResponse('Push is not set up, or this device is not registered'),
    502: problemResponse('FCM refused it'),
  },
});

const getStatus = createRoute({
  method: 'get',
  path: '/push',
  tags,
  summary: 'Push notifications: the Firebase project and the devices that get them',
  responses: { 200: json(PushStatusSchema, 'Push status'), 403: adminOnly },
});

const putConfig = createRoute({
  method: 'put',
  path: '/push/config',
  tags,
  summary: 'Set the Firebase service account pushes are sent with',
  description:
    'Requires the admin token. The key file is checked with Google, then sealed; it is never returned.',
  request: body(PushConfigInputSchema),
  responses: {
    200: json(PushStatusSchema, 'Set up'),
    400: problemResponse('Not a service account key'),
    403: adminOnly,
    422: problemResponse('Google refused the service account'),
  },
});

const deleteConfig = createRoute({
  method: 'delete',
  path: '/push/config',
  tags,
  summary: 'Forget the Firebase service account (nothing is sent any more)',
  responses: { 204: { description: 'Forgotten' }, 403: adminOnly },
});

/** The calling device token's id; the admin token has no device. */
function deviceToken(c: Parameters<typeof currentUser>[0]): string {
  const { tokenId } = currentUser(c);
  if (tokenId === ADMIN_TOKEN_ID) {
    throw new ApiError(
      403,
      'device_token_required',
      'Register push with a device token, not the admin token',
    );
  }
  return tokenId;
}

export function registerPushRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  v1.openapi(getMine, async (c) => {
    const { tokenId } = currentUser(c);
    return c.json(await deps.push.mine(tokenId === ADMIN_TOKEN_ID ? null : tokenId), 200);
  });

  v1.openapi(putMine, async (c) => {
    const device = await deps.push.register(deviceToken(c), c.req.valid('json'));
    deps.logger.info('A device registered for push', { deviceId: device.id, kinds: device.kinds });
    return c.json(device, 200);
  });

  v1.openapi(deleteMine, async (c) => {
    await deps.push.unregister(deviceToken(c));
    return c.body(null, 204);
  });

  v1.openapi(testMine, async (c) => {
    await deps.push.test(deviceToken(c));
    return c.body(null, 204);
  });

  v1.openapi(getStatus, async (c) => {
    requireAdminToken(c);
    return c.json(await deps.push.status(), 200);
  });

  v1.openapi(putConfig, async (c) => {
    requireAdminToken(c);
    const { serviceAccount } = c.req.valid('json');
    const status = await deps.settings.lock.run(() => deps.push.configure(serviceAccount));
    return c.json(status, 200);
  });

  v1.openapi(deleteConfig, async (c) => {
    requireAdminToken(c);
    await deps.settings.lock.run(() => deps.push.unconfigure());
    return c.body(null, 204);
  });
}
