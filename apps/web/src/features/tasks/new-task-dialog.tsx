import type { Task, TaskPriority } from '@superagent/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useCreateTask } from '../../api/queries';
import { departmentTone, PRIORITIES, TONE_DOT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Notice, Spinner } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Select } from '../../ui/select';
import { Switch } from '../../ui/switch';
import { Segmented } from '../../ui/tabs';
import { toast } from '../../ui/toast';
import { useOrg } from './org';

const PRIORITY_OPTIONS = (['low', 'normal', 'high', 'urgent'] as const).map((value) => ({
  value,
  label: PRIORITIES[value].label,
}));

/** Hand a department a task: what to do, how urgent, and whether its lead starts now. */
export function NewTaskDialog({
  open,
  onOpenChange,
  departmentId: initialDepartment,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId?: string;
  onCreated?: (task: Task) => void;
}) {
  const org = useOrg();
  const create = useCreateTask();
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [due, setDue] = useState('');
  const [dispatch, setDispatch] = useState(true);
  const [errors, setErrors] = useState<{ title?: string; brief?: string; department?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);

  // Each opening starts fresh, on the department the board is showing. Only on opening: later
  // changes to the org list must not wipe what you typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the dialog opens, see above
  useEffect(() => {
    if (!open) return;
    setDepartmentId(initialDepartment ?? org.departments[0]?.id ?? null);
    setTitle('');
    setBrief('');
    setPriority('normal');
    setDue('');
    setDispatch(true);
    setErrors({});
    setFailure(null);
    create.reset();
  }, [open]);

  const department = departmentId ? org.department(departmentId) : undefined;
  const hasLead = Boolean(department?.lead);
  const willDispatch = dispatch && hasLead;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      department: department ? undefined : 'Choose a department.',
      title: title.trim() ? undefined : 'Give the task a title.',
      brief: brief.trim() ? undefined : 'Say what you want done.',
    };
    setErrors(next);
    if (next.department || next.title || next.brief || !department) return;
    setFailure(null);
    try {
      const task = await create.mutateAsync({
        departmentId: department.id,
        title: title.trim(),
        brief: brief.trim(),
        priority,
        dueAt: due ? new Date(due).toISOString() : undefined,
        dispatch: willDispatch,
      });
      toast.success(
        `Task #${task.number} created`,
        willDispatch ? `${department.lead?.name ?? 'The lead'} is on it.` : 'It waits in the inbox.',
      );
      onOpenChange(false);
      onCreated?.(task);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New task"
      description="Tell a department what you need. Its lead plans the work and reports back."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-task" variant="primary" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : null}
            {willDispatch ? 'Create and send' : 'Create task'}
          </Button>
        </>
      }
    >
      <form id="new-task" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <Notice tone="destructive">{failure}</Notice> : null}
        {org.ready && org.departments.length === 0 ? (
          <Notice tone="warning" title="No departments yet">
            Create a department first (in the API for now: POST /v1/departments).
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Department" error={errors.department}>
            {(control) => (
              <Select
                {...control}
                value={departmentId}
                onValueChange={setDepartmentId}
                placeholder="Choose a department"
                options={org.departments.map((item) => ({
                  value: item.id,
                  label: item.lead ? item.name : `${item.name} (no lead)`,
                  icon: (
                    <span
                      aria-hidden
                      className={`size-2 rounded-full ${TONE_DOT[departmentTone(item.slug)]}`}
                    />
                  ),
                }))}
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
        </div>

        <Field label="Title" error={errors.title}>
          {(control) => (
            <Input
              {...control}
              value={title}
              maxLength={200}
              placeholder="Summarize this week’s AI agent news"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Brief"
          error={errors.brief}
          hint="What to do, what good looks like, any constraints. Markdown works."
        >
          {(control) => (
            <Textarea
              {...control}
              value={brief}
              maxLength={20_000}
              rows={6}
              placeholder="Find the three most important releases, with a source for each…"
              onChange={(event) => setBrief(event.target.value)}
            />
          )}
        </Field>

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="Due" hint="Optional.">
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
            )}
          </Field>
          <Switch
            className="sm:pt-7"
            checked={willDispatch}
            onCheckedChange={setDispatch}
            disabled={!hasLead}
            label="Send it to the lead now"
            hint={
              department
                ? hasLead
                  ? `${department.lead?.name} starts on it right away.`
                  : 'This department has no lead yet, so the task waits in the inbox.'
                : undefined
            }
          />
        </div>
      </form>
    </Dialog>
  );
}
