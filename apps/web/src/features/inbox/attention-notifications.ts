import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useAttention } from '../../api/queries';
import { notificationsOn } from '../../lib/notifications';

/** More than this at once is shown as one, pointing at the inbox. */
const AT_ONCE = 3;

/**
 * Tells you when something new needs you while the app is in the background, if you turned it on. What
 * was there when the app opened isn't news; something that leaves and comes back is again. A click
 * brings the app forward on the task (or the inbox).
 */
export function useAttentionNotifications(): void {
  const attention = useAttention();
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
    const show = (title: string, body: string | undefined, tag: string, to: string) => {
      const notification = new Notification(title, { body, tag, icon: '/icon-192.png' });
      notification.onclick = () => {
        window.focus();
        navigate(to);
        notification.close();
      };
    };
    if (fresh.length > AT_ONCE) {
      show(`${fresh.length} things need you`, fresh[0]?.title, 'superagent:inbox', '/inbox');
      return;
    }
    for (const item of fresh) {
      show(item.title, item.detail ?? undefined, item.id, item.taskId ? `/tasks/${item.taskId}` : '/inbox');
    }
  }, [attention.data, navigate]);
}
