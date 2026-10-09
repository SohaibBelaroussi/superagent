import { MyPushSchema, type PushDeviceInput, PushDeviceSchema, type PushKind } from '@superagent/shared';
import { api, apiVoid } from './http';
import { queryKeys } from './queries';

/** What each kind of notification is about, as settings list them on both apps (D54). */
export const PUSH_KINDS: Record<PushKind, { label: string; description: string }> = {
  approval: { label: 'Approvals', description: 'A tool call waits for you to approve it.' },
  question: { label: 'Questions', description: 'A lead asks you something.' },
  review: { label: 'Results to review', description: 'A task is done and waits for your review.' },
  problem: { label: 'Problems', description: 'A task failed, or couldn’t be sent to a lead.' },
  chief: { label: 'The chief’s answers', description: 'The chief answered you.' },
};

/** The order settings list them in: what blocks an agent first. */
export const PUSH_KIND_ORDER: readonly PushKind[] = ['approval', 'question', 'review', 'problem', 'chief'];

/** This device's registration, and whether the server can send at all. */
export const myPushQuery = () => ({
  queryKey: queryKeys.myPush,
  queryFn: ({ signal }: { signal: AbortSignal }) => api(MyPushSchema, '/v1/push/device', { signal }),
});

/** Registers this device for pushes, or changes what it gets (the same call: one per device). */
export const registerPush = (input: PushDeviceInput) =>
  api(PushDeviceSchema, '/v1/push/device', { method: 'PUT', json: input });

/** Stops this device's pushes. */
export const unregisterPush = () => apiVoid('/v1/push/device', { method: 'DELETE' });

/** Sends this device a test notification. */
export const testPush = () => apiVoid('/v1/push/device/test', { method: 'POST' });
