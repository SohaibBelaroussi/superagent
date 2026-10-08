import { turnOffNotifications, turnOnNotifications } from '../../lib/notifications';
import { toast } from '../../ui/toast';

/** Turns notifications off when `currentlyOn`, else on (asking the browser if needed), and says how it went. */
export async function toggleNotifications(currentlyOn: boolean): Promise<void> {
  if (currentlyOn) {
    turnOffNotifications();
    toast.info('Notifications off');
    return;
  }
  switch (await turnOnNotifications()) {
    case 'on':
      toast.success('Notifications on', 'While superagent is hidden, you’ll hear when something needs you.');
      break;
    case 'blocked':
      toast.error(
        'Notifications are blocked',
        'Allow them for this site in your browser’s settings, then try again.',
      );
      break;
    case 'unsupported':
      toast.error(
        'Notifications aren’t available here',
        'This browser can’t show them from a page. A desktop browser can.',
      );
      break;
    case 'dismissed':
      // You closed the browser's question without answering: nothing to say.
      break;
  }
}
