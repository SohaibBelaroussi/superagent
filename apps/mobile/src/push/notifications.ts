import { PUSH_KIND_ORDER, PUSH_KINDS } from '@superagent/client';
import type { PushKind, PushPayload } from '@superagent/shared';
import * as Notifications from 'expo-notifications';

/*
 * How the phone shows a push (D54): the app draws each notification itself from the decrypted payload,
 * on a channel per kind (Android lets the owner tune or silence each), with the actions its kind
 * takes. Every channel is private: where the lock screen hides private notifications, it shows only
 * the kind (the patched builder's public version), and an action runs only once the phone is unlocked.
 */

export type ShownKind = PushPayload['kind'];

/** What a notification carries for its tap and actions: never the token or anything secret. */
export interface NotificationData {
  kind: ShownKind;
  taskId: string | null;
  itemId: string | null;
  title: string;
  body: string;
}

/** The actions on a notification, by kind. Their ids are what `answer.ts` handles. */
export type ActionId = 'approve' | 'decline' | 'reply' | 'accept' | 'changes';

const CHANNEL_NAMES: Record<ShownKind, string> = {
  ...Object.fromEntries(PUSH_KIND_ORDER.map((kind) => [kind, PUSH_KINDS[kind].label])),
  test: 'Tests',
} as Record<ShownKind, string>;

/** Blocking an agent interrupts (a heads-up); the rest arrive quietly in the shade. */
const IMPORTANCE: Record<ShownKind, Notifications.AndroidImportance> = {
  approval: Notifications.AndroidImportance.HIGH,
  question: Notifications.AndroidImportance.HIGH,
  review: Notifications.AndroidImportance.DEFAULT,
  problem: Notifications.AndroidImportance.DEFAULT,
  chief: Notifications.AndroidImportance.DEFAULT,
  test: Notifications.AndroidImportance.HIGH,
};

const quiet = { opensAppToForeground: false, isAuthenticationRequired: true } as const;
const reply = (placeholder: string) => ({ submitButtonTitle: 'Send', placeholder });

const CATEGORIES: Partial<Record<PushKind, Notifications.NotificationAction[]>> = {
  approval: [
    { identifier: 'approve', buttonTitle: 'Approve', options: quiet },
    { identifier: 'decline', buttonTitle: 'Decline', options: { ...quiet, isDestructive: true } },
  ],
  question: [{ identifier: 'reply', buttonTitle: 'Answer', textInput: reply('Your answer'), options: quiet }],
  review: [
    { identifier: 'accept', buttonTitle: 'Accept', options: quiet },
    {
      identifier: 'changes',
      buttonTitle: 'Ask for changes',
      textInput: reply('What should change?'),
      options: quiet,
    },
  ],
  chief: [
    { identifier: 'reply', buttonTitle: 'Reply', textInput: reply('Reply to the chief'), options: quiet },
  ],
};

/**
 * The channels and the actions, set before drawing and before asking for the permission (Android 13
 * asks only once the app has a channel). Each call replaces what's there, so it's safe to repeat.
 */
export async function setUpNotifications(): Promise<void> {
  // Android's channels (elsewhere this does nothing).
  for (const kind of Object.keys(CHANNEL_NAMES) as ShownKind[]) {
    await Notifications.setNotificationChannelAsync(kind, {
      name: CHANNEL_NAMES[kind],
      description: kind === 'test' ? 'The test sent from settings.' : PUSH_KINDS[kind].description,
      importance: IMPORTANCE[kind],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }
  for (const [kind, actions] of Object.entries(CATEGORIES)) {
    await Notifications.setNotificationCategoryAsync(kind, actions);
  }
}

/** One notification per thing: a newer push about the same item replaces the one shown. */
export const notificationId = (payload: Pick<PushPayload, 'kind' | 'itemId'>) =>
  payload.itemId ?? payload.kind;

/** Draws a push as a notification, with its kind's actions. `note` replaces its text (a failed action). */
export async function drawNotification(payload: NotificationData, note?: string): Promise<void> {
  await setUpNotifications();
  const data: NotificationData = { ...payload };
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId(payload),
    content: {
      title: payload.title,
      body: note ?? payload.body,
      subtitle: CHANNEL_NAMES[payload.kind],
      data: { ...data },
      categoryIdentifier: payload.kind in CATEGORIES ? payload.kind : undefined,
    },
    // Now, on its kind's channel.
    trigger: { channelId: payload.kind },
  });
}

export async function dismissNotification(identifier: string): Promise<void> {
  await Notifications.dismissNotificationAsync(identifier).catch(() => {});
}

/**
 * A notification's data. Listeners get it parsed; the background task gets Android's raw form, with
 * the data as a JSON string (`dataString`).
 */
function contentData(content: Notifications.NotificationContent): Record<string, unknown> | null {
  if (content.data && typeof content.data === 'object') return content.data;
  const raw = (content as { dataString?: unknown }).dataString;
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What a notification the app drew carries (anything else: not ours). */
export function notificationData(notification: Notifications.Notification): NotificationData | null {
  const data = contentData(notification.request.content) as Partial<NotificationData> | null;
  if (!data || typeof data.kind !== 'string' || !(data.kind in CHANNEL_NAMES)) return null;
  return {
    kind: data.kind,
    taskId: typeof data.taskId === 'string' ? data.taskId : null,
    itemId: typeof data.itemId === 'string' ? data.itemId : null,
    title: typeof data.title === 'string' ? data.title : (notification.request.content.title ?? ''),
    body: typeof data.body === 'string' ? data.body : (notification.request.content.body ?? ''),
  };
}
