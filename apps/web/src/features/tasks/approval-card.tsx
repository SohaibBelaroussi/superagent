import type { AttentionItem } from '@superagent/shared';
import { ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { useRef, useState } from 'react';
import { decisionKey, useDecide } from '../../api/queries';
import { Button } from '../../ui/button';
import { CodeBlock } from '../../ui/code-block';
import { Dialog } from '../../ui/dialog';
import { Spinner } from '../../ui/feedback';
import { Field, Textarea } from '../../ui/field';
import { RelativeTime } from '../../ui/time';

type Kind = 'approve' | 'decline';

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
  // Decided here: the card stays settled until the inbox drops the item, so it can't be decided twice.
  const [decided, setDecided] = useState<Kind | null>(null);
  // One key per answer, kept across retries: a retry after a lost response is the same decision.
  const keys = useRef(new Map<Kind, string>());
  const keyFor = (kind: Kind) => {
    const existing = keys.current.get(kind);
    if (existing) return existing;
    const key = decisionKey();
    keys.current.set(kind, key);
    return key;
  };
  const answer = (kind: Kind, onDone?: () => void) =>
    decide.mutate(
      { item, kind, reason: kind === 'decline' ? reason : undefined, key: keyFor(kind) },
      {
        onSuccess: () => {
          setDecided(kind);
          onDone?.();
        },
      },
    );
  const args = prettyArgs(item.args);
  const busy = decide.isPending || decided !== null;

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
      {args ? <CodeBlock value={args} className="max-h-56" /> : null}
      {decided ? (
        <p role="status" className="flex items-center justify-end gap-1.5 text-caption text-muted-foreground">
          {decided === 'approve' ? (
            <ShieldCheck aria-hidden className="size-3.5 text-success-indicator" />
          ) : (
            <ShieldX aria-hidden className="size-3.5 text-destructive-indicator" />
          )}
          {decided === 'approve'
            ? 'Approved. The lead carries on.'
            : 'Declined. The lead carries on without it.'}
        </p>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setDeclineOpen(true)}>
            Decline…
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => answer('approve')}>
            {decide.isPending && decide.variables?.kind === 'approve' ? <Spinner /> : null}
            Approve
          </Button>
        </div>
      )}

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
              onClick={() => answer('decline', () => setDeclineOpen(false))}
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
