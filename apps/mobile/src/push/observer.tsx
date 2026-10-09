import { queryKeys } from '@superagent/client';
import type { MyPush } from '@superagent/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { type Href, router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useMyPush } from '../api/push';
import { useAttention } from '../api/queries';
import { toast } from '../ui/toast';
import { answerNotification } from './answer';
import { type NotificationData, notificationData } from './notifications';
import { onPushInApp } from './receive';
import { pushAvailable, sendNewToken } from './registration';

// A notification drawn while the app is in front (it shows a banner instead, so rarely) goes to the
// shade quietly. A push's own data message is never shown as it is.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => ({
    shouldShowBanner: false,
    shouldShowList: notificationData(notification) !== null,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Where a notification leads: its task (whose screen has its actions), or the chief. */
export function pushTarget({ kind, taskId }: Pick<NotificationData, 'kind' | 'taskId'>): Href | null {
  if (kind === 'chief') return '/chief';
  if (taskId) return `/tasks/${taskId}`;
  return kind === 'test' ? null : '/inbox';
}

const responseKey = (response: Notifications.NotificationResponse) =>
  `${response.notification.request.identifier}|${response.notification.date}|${response.actionIdentifier}`;

/**
 * Push while signed in: a tap on a notification opens what it's about, its actions are answered, a
 * push that arrives with the app open shows as a banner inside it, FCM's new tokens reach the server,
 * and the launcher's badge counts what needs you.
 */
export function PushObserver() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const where = useRef(pathname);
  where.current = pathname;
  const attention = useAttention();
  const myPush = useMyPush();
  const loaded = myPush.isSuccess;
  const device = myPush.data?.device ?? null;

  useEffect(() => {
    if (!pushAvailable()) return;
    // The tap that started the app can come both ways: once is enough.
    const seen = new Set<string>();
    const respond = (response: Notifications.NotificationResponse) => {
      const key = responseKey(response);
      if (seen.has(key)) return;
      seen.add(key);
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        void answerNotification(response);
        return;
      }
      const data = notificationData(response.notification);
      const target = data ? pushTarget(data) : null;
      if (target) router.navigate(target);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      respond(last);
      Notifications.clearLastNotificationResponse();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(respond);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    onPushInApp((payload) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention });
      const target = pushTarget(payload);
      // Already on the screen it's about, which live events keep up to date.
      if (target && where.current === target) return;
      toast.notice(payload.title, payload.body, target ? () => router.navigate(target) : undefined);
    });
    return () => onPushInApp(null);
  }, [queryClient]);

  const tokenChecked = useRef(false);
  useEffect(() => {
    if (!pushAvailable() || !loaded) return;
    if (!device) {
      tokenChecked.current = true;
      return;
    }
    const send = (token: string) =>
      sendNewToken(device.kinds, token)
        .then((next) => {
          if (next) queryClient.setQueryData<MyPush>(queryKeys.myPush, { configured: true, device: next });
        })
        .catch(() => {
          // Sent again at the next start.
        });
    // FCM may have replaced the token while the app was closed: once per start, for a phone that
    // was registered already (one registering now has just sent it).
    if (!tokenChecked.current) {
      tokenChecked.current = true;
      void Notifications.getDevicePushTokenAsync()
        .then((token) => send(String(token.data)))
        .catch(() => {});
    }
    const subscription = Notifications.addPushTokenListener((token) => void send(String(token.data)));
    return () => subscription.remove();
  }, [loaded, device, queryClient]);

  const count = attention.data?.length;
  useEffect(() => {
    if (!pushAvailable() || count === undefined) return;
    void Notifications.setBadgeCountAsync(count).catch(() => {});
  }, [count]);

  return null;
}
