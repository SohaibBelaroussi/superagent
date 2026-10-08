import type { Task } from '@superagent/shared';
import { TERMINAL_PHASES } from '@superagent/shared/phases';
import { ArrowUp } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type Ref, useState } from 'react';
import { useMessageTask } from '../../api/queries';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/button';
import { Spinner } from '../../ui/feedback';
import { Segmented } from '../../ui/tabs';

const COPY = {
  inbox: { placeholder: 'Add a note for the lead, then send the task…', send: 'Send to lead' },
  queued: { placeholder: 'Message the lead…', send: 'Send' },
  working: { placeholder: 'Message the lead…', send: 'Send' },
  waiting: { placeholder: 'Answer the lead…', send: 'Reply' },
  review: { placeholder: 'What should change?', send: 'Request changes' },
} as const;

const MODES = [
  { value: 'steer', label: 'Now', title: 'Delivered into the lead’s current turn' },
  { value: 'queue', label: 'After this turn', title: 'Waits until the lead finishes what it’s doing' },
] as const;

/** Talk to the lead about this task: answer it, steer it, or ask for changes. */
export function TaskComposer({
  task,
  inputRef,
  waitingForApproval = false,
}: {
  task: Task;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** A tool call waits for the owner: the API takes no messages until it's decided. */
  waitingForApproval?: boolean;
}) {
  const send = useMessageTask(task.id);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'steer' | 'queue'>('steer');

  const closedNote = TERMINAL_PHASES.has(task.phase)
    ? task.phase === 'cancelled'
      ? 'This task was cancelled.'
      : 'This task is closed. Send it back to the lead to continue it.'
    : waitingForApproval
      ? 'Approve or decline the tool call above first: the lead takes messages again once it’s decided.'
      : null;
  if (closedNote) {
    return (
      <p className="rounded-[22px] border border-dashed border-border px-4 py-3 text-center text-caption text-muted-foreground">
        {closedNote}
      </p>
    );
  }

  const copy = COPY[task.phase as keyof typeof COPY];
  const canSteer = task.phase === 'queued' || task.phase === 'working';

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (!message || send.isPending) return;
    send.mutate({ message, mode: canSteer ? mode : 'steer' }, { onSuccess: () => setText('') });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        'rounded-[22px] border border-border bg-muted transition-colors duration-200 focus-within:border-border-strong',
        'dark:bg-muted [html.light_&]:bg-card',
      )}
    >
      <label htmlFor={`message-${task.id}`} className="sr-only">
        Message the lead
      </label>
      <textarea
        id={`message-${task.id}`}
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        maxLength={20_000}
        rows={2}
        placeholder={copy.placeholder}
        className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-body text-foreground outline-hidden placeholder:text-placeholder"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
        {canSteer ? (
          <Segmented
            aria-label="When to deliver"
            size="sm"
            value={mode}
            onValueChange={setMode}
            options={MODES}
          />
        ) : (
          <span className="pl-1 text-caption text-placeholder">⌘/Ctrl + Enter to send</span>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || send.isPending}>
          {send.isPending ? <Spinner className="size-3.5" /> : <ArrowUp aria-hidden />}
          {copy.send}
        </Button>
      </div>
    </form>
  );
}
