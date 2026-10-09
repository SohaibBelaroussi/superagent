import {
  decide,
  errorMessage,
  getApiToken,
  messageTask,
  ProblemError,
  sendToChief,
  updateTask,
} from '@superagent/client';
import type * as Notifications from 'expo-notifications';
import { connect } from '../api/connect';
import { loadSession } from '../api/storage';
import { preferences } from '../lib/preferences';
import { type ActionId, dismissNotification, drawNotification, notificationData } from './notifications';

/*
 * A notification's actions (D54), run without opening the app: Approve and Decline call the inbox's
 * decision routes with an idempotency key, Answer and Ask for changes message the task's lead, Accept
 * closes a reviewed task, and Reply goes to the chief. The notification goes once it's done, or comes
 * back saying what went wrong.
 */

const ACTIONS: ReadonlySet<string> = new Set<ActionId>(['approve', 'decline', 'reply', 'accept', 'changes']);

const FAILED: Record<ActionId, string> = {
  approve: 'Couldn’t approve',
  decline: 'Couldn’t decline',
  reply: 'Not sent',
  changes: 'Not sent',
  accept: 'Couldn’t accept',
};

/*
 * Android hands an action to the background task, and to the app's listener when the app is running
 * or next starts: each tap is acted on once. Taps under way are kept in memory, answered ones in the
 * preferences (the app and the background task can be separate runs).
 */
const ANSWERED = 'push.answered';
const running = new Map<string, Promise<void>>();

function answered(): string[] {
  try {
    const list: unknown = JSON.parse(preferences.get(ANSWERED) ?? '[]');
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const remember = (key: string) => preferences.set(ANSWERED, JSON.stringify([...answered(), key].slice(-50)));

/** Acts on a notification's action. Taps on the notification itself (opening it) aren't actions. */
export function answerNotification(response: Notifications.NotificationResponse): Promise<void> {
  const action = response.actionIdentifier;
  if (!ACTIONS.has(action)) return Promise.resolve();
  const { notification } = response;
  const key = `${notification.request.identifier}|${notification.date}|${action}`;
  const pending = running.get(key);
  if (pending) return pending;
  if (answered().includes(key)) return Promise.resolve();
  remember(key);
  const work = perform(response, action as ActionId).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

async function perform(response: Notifications.NotificationResponse, action: ActionId): Promise<void> {
  const identifier = response.notification.request.identifier;
  const data = notificationData(response.notification);
  const session = await loadSession();
  // Not one the app drew, or signed out since: nothing to act for.
  if (!data || !session) return dismissNotification(identifier);
  // In the background the client isn't set up yet.
  if (getApiToken() !== session.token) connect(session.server, session.token);
  const text = response.userText?.trim() ?? '';

  try {
    switch (action) {
      case 'approve':
      case 'decline':
        if (!data.itemId) return dismissNotification(identifier);
        await decide({
          item: { id: data.itemId, taskId: data.taskId },
          kind: action,
          key: `push:${data.itemId}:${action}`,
        });
        break;
      case 'accept':
        if (!data.taskId) return dismissNotification(identifier);
        await updateTask(data.taskId, { phase: 'done' });
        break;
      case 'reply':
      case 'changes':
        if (!text) return drawNotification(data, `${FAILED[action]}: the message was empty.`);
        if (data.kind === 'chief') await sendToChief(text);
        else if (data.taskId) await messageTask(data.taskId, { message: text, mode: 'steer' });
        break;
    }
    await dismissNotification(identifier);
  } catch (error) {
    // Decided or reviewed elsewhere already: nothing left to do here.
    const settled =
      error instanceof ProblemError &&
      (error.status === 404 || error.status === 409) &&
      (action === 'approve' || action === 'decline' || action === 'accept');
    if (settled) return dismissNotification(identifier);
    await drawNotification(data, `${FAILED[action]}: ${errorMessage(error)}`);
  }
}
