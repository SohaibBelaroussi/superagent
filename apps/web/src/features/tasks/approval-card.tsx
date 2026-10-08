import type { AttentionItem } from '@superagent/shared';
import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { useDecide } from '../../api/queries';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Spinner } from '../../ui/feedback';
import { Field, Textarea } from '../../ui/field';
import { RelativeTime } from '../../ui/time';

function prettyArgs(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

/** A tool call waiting for you, with what it would do and the two answers. */
export function ApprovalCard({ item }: { item: AttentionItem }) {
  const decide = useDecide();
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState('');
  const args = prettyArgs(item.args);
  const busy = decide.isPending;

  return (
    <section
      aria-label="Waiting for your approval"
      className="flex flex-col gap-3 rounded-xl bg-warning-subtle px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--warning-edge)]"
    >
      <div className="flex items-start gap-3">
        <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-indicator" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-label text-foreground">{item.title}</p>
          <p className="text-caption text-muted-foreground">
            Waiting since <RelativeTime iso={item.since} />. The task carries on once you decide.
          </p>
        </div>
      </div>
      {args ? (
        <pre className="max-h-56 overflow-auto rounded-lg bg-fill-subtle px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-foreground/90 shadow-rim">
          {args}
        </pre>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => setDeclineOpen(true)}>
          Decline…
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => decide.mutate({ item, kind: 'approve' })}>
          {busy ? <Spinner /> : null}
          Approve
        </Button>
      </div>

      <Dialog
        open={declineOpen}
        onOpenChange={setDeclineOpen}
        title={`Decline ${item.tool ?? 'this call'}?`}
        description="The agent is told it was declined and carries on without it."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeclineOpen(false)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                decide.mutate({ item, kind: 'decline', reason }, { onSuccess: () => setDeclineOpen(false) })
              }
            >
              Decline
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="Optional. The agent reads it.">
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={1000}
              value={reason}
              placeholder="Use the knowledge base instead"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      </Dialog>
    </section>
  );
}
