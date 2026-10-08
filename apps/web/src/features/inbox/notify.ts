import { turnOffNotifications, turnOnNotifications } from '../../lib/notifications';
import { toast } from '../../ui/toast';

/** Turns notifications on (asking the browser if needed) or off, and says how it went. */
export async function toggleNotifications(on: boolean): Promise<void> {
  if (on) {
    turnOffNotifications();
    toast.info('Notifications off');
    return;
  }
  const result = await turnOnNotifications();
  if (result === 'on') {
    toast.success(
      'Notifications on',
      'You’ll hear about approvals, questions and results while superagent is in the background.',
    );
  } else if (result === 'blocked') {
    toast.error(
      'Notifications are blocked',
      'Allow them for this site in your browser’s settings, then try again.',
    );
  }
}
