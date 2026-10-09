import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { answerNotification } from './answer';
import { receivePush } from './receive';

/*
 * Where pushes arrive (D54), defined as the app's bundle loads (index.ts imports this first): Android
 * runs the task for every push, with the app open, in the background or closed, and for a
 * notification's actions when the app isn't in front. iPhone push comes later (APNs).
 */

export const PUSH_TASK = 'superagent-push';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_TASK, async ({ data }) => {
  if (!data) return;
  if ('actionIdentifier' in data) await answerNotification(data);
  else await receivePush(data.data ?? {});
});

if (Platform.OS === 'android') void Notifications.registerTaskAsync(PUSH_TASK).catch(() => {});
