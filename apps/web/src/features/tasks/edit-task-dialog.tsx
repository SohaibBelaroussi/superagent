import type { Task, TaskPriority } from '@superagent/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useUpdateTask } from '../../api/queries';
import { PRIORITIES } from '../../lib/tones';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Spinner } from '../../ui/feedback';
import { Field, Input } from '../../ui/field';
import { Segmented } from '../../ui/tabs';

const PRIORITY_OPTIONS = (['low', 'normal', 'high', 'urgent'] as const).map((value) => ({
  value,
  label: PRIORITIES[value].label,
}));

/** `2026-10-08T14:05` in local time, for a datetime-local input. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function EditTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateTask(task.id);
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [due, setDue] = useState(toLocalInput(task.dueAt));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setPriority(task.priority);
    setDue(toLocalInput(task.dueAt));
    setError(null);
  }, [open, task.title, task.priority, task.dueAt]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError('A task needs a title.');
      return;
    }
    // Compared as the input shows it (to the minute): a due date with seconds that you didn't touch
    // must not be rewritten.
    const dueChanged = due !== toLocalInput(task.dueAt);
    const changes = {
      ...(trimmed !== task.title ? { title: trimmed } : {}),
      ...(priority !== task.priority ? { priority } : {}),
      ...(dueChanged ? { dueAt: due ? new Date(due).toISOString() : null } : {}),
    };
    // Nothing changed: nothing to record in the task's history.
    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }
    update.mutate(changes, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit #${task.number}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-task" variant="primary" disabled={update.isPending}>
            {update.isPending ? <Spinner /> : null}
            Save
          </Button>
        </>
      }
    >
      <form id="edit-task" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        <Field label="Title" error={error}>
          {(control) => (
            <Input
              {...control}
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label="Priority">
          {() => (
            <Segmented
              aria-label="Priority"
              value={priority}
              onValueChange={setPriority}
              options={PRIORITY_OPTIONS}
            />
          )}
        </Field>
        <Field label="Due" hint="Leave empty for no due date.">
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={due}
              onChange={(event) => setDue(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
