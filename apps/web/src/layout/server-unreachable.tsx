import { CloudOff } from 'lucide-react';
import { useSession } from '../api/session';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/feedback';

/** The stored token couldn't be checked because the server didn't answer: offer a retry, not a sign-out. */
export function ServerUnreachable() {
  const { retry } = useSession();
  return (
    <div className="flex h-dvh items-center justify-center bg-sidebar p-6">
      <EmptyState
        icon={<CloudOff />}
        title="Can’t reach superagent"
        description="The server didn’t answer. Check that it’s running and that this device is on your tailnet."
        action={
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
