import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useAttention } from '../../api/queries';
import { notificationsOn, showNotification, useNotificationsOn } from '../../lib/notifications';

/** More than this at once is shown as one, pointing at the inbox. */
const AT_ONCE = 3;

/**
 * Tells you when something new needs you while the app is hidden, if you turned it on (D48). What was
 * there when the app opened isn't news; something that leaves and comes back is again. A click brings
 * the app forward on the task (or the inbox).
 */
export function useAttentionNotifications(): void {
  const on = useNotificationsOn();
  // Task items arrive with task events; setup problems only by asking again, which a hidden tab
  // otherwise stops doing.
  const attention = useAttention({ inBackground: on });
  const navigate = useNavigate();
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    const items = attention.data;
    if (!items) return;
    const before = known.current;
    known.current = new Set(items.map((item) => item.id));
    if (!before || document.visibilityState === 'visible' || !notificationsOn()) return;
    const fresh = items.filter((item) => !before.has(item.id));
    if (fresh.length === 0) return;
    const open = (to: string) => () => {
      window.focus();
      navigate(to);
    };
    if (fresh.length > AT_ONCE) {
      showNotification(
        `${fresh.length} things need you`,
        { body: fresh[0]?.title, tag: `superagent:inbox:${Date.now()}`, icon: '/icon-192.png' },
        open('/inbox'),
      );
      return;
    }
    for (const item of fresh) {
      // Tagged by item and time: the same item coming back is a new notification, not a quiet update.
      const shown = showNotification(
        item.title,
        { body: item.detail ?? undefined, tag: `${item.id}:${item.since}`, icon: '/icon-192.png' },
        open(item.taskId ? `/tasks/${item.taskId}` : '/inbox'),
      );
      if (!shown) return;
    }
  }, [attention.data, navigate]);
}
