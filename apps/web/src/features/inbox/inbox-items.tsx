import type { AttentionItem, Task } from '@superagent/shared';
import { ArrowUp, Check, Send } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useMessageTask, useUpdateTask } from '../../api/queries';
import { cn } from '../../lib/cn';
import { TONE_TEXT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { Spinner } from '../../ui/feedback';
import { composerSurface } from '../../ui/recipes';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { ApprovalCard } from '../tasks/approval-card';
import type { OrgLookup } from '../tasks/org';
import { DepartmentLabel } from '../tasks/task-bits';
import { KINDS } from './kinds';

interface ItemProps {
  item: AttentionItem;
  /** The item's task, when the board has it: its phase and lead decide the actions offered. */
  task: Task | undefined;
  org: OrgLookup;
  /** Its action went through: the inbox can drop it before the list catches up. */
  onDone: () => void;
}

const leadOf = (task: Task | undefined, org: OrgLookup) =>
  (task && org.agent(task.leadAgentId)) ?? (task ? org.department(task.departmentId)?.lead : undefined);

/** Where an item comes from: its department, and its task's lead. */
function Origin({ item, task, org }: Pick<ItemProps, 'item' | 'task' | 'org'>) {
  const department = item.departmentId ? org.department(item.departmentId) : undefined;
  const lead = leadOf(task, org);
  if (!department && !lead) return null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      {department ? <DepartmentLabel department={department} /> : null}
      {department && lead ? <span aria-hidden>·</span> : null}
      {lead ? <span className="truncate">{lead.name}</span> : null}
    </p>
  );
}

/** The card every item sits in: what it is, where it comes from, when, then its body and actions. */
function ItemCard({
  item,
  task,
  org,
  children,
  actions,
}: Pick<ItemProps, 'item' | 'task' | 'org'> & { children?: ReactNode; actions?: ReactNode }) {
  const kind = KINDS[item.kind];
  const Icon = kind.icon;
  return (
    <article
      aria-label={item.title}
      className="flex flex-col gap-3 rounded-xl bg-card px-4 py-3.5 shadow-raised"
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT[kind.tone])} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {item.taskId ? (
            <Link
              to={`/tasks/${item.taskId}`}
              className="text-label text-foreground underline-offset-4 hover:underline"
            >
              {item.title}
            </Link>
          ) : (
            <p className="text-label text-foreground">{item.title}</p>
          )}
          <Origin item={item} task={task} org={org} />
        </div>
        <RelativeTime iso={item.since} className="shrink-0 text-caption text-placeholder" />
      </div>
      {children ? <div className="flex flex-col gap-3 pl-7">{children}</div> : null}
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </article>
  );
}

/** A message to the task's lead, from the inbox: an answer, changes asked for, or how to go on. */
function Reply({
  taskId,
  label,
  placeholder,
  send,
  sentTitle,
  onDone,
  onCancel,
}: {
  taskId: string;
  label: string;
  placeholder: string;
  send: string;
  sentTitle: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const message = useMessageTask(taskId);
  const [text, setText] = useState('');
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || message.isPending) return;
    message.mutate(
      { message: value, mode: 'steer' },
      {
        onSuccess: (task) => {
          toast.success(sentTitle, `#${task.number} ${task.title}`);
          onDone();
        },
      },
    );
  };
  return (
    <form onSubmit={submit} className={cn('bg-field', composerSurface)}>
      <label className="sr-only" htmlFor={`reply-${taskId}`}>
        {label}
      </label>
      <textarea
        id={`reply-${taskId}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
        }}
        maxLength={20_000}
        rows={2}
        placeholder={placeholder}
        className="field-sizing-content block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-body-sm text-foreground outline-hidden placeholder:text-placeholder"
      />
      <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || message.isPending}>
          {message.isPending ? <Spinner className="size-3.5" /> : <ArrowUp aria-hidden />}
          {send}
        </Button>
      </div>
    </form>
  );
}

/** A lead's question: what it asked, and your answer, which sends the task back to it. */
function QuestionItem({ item, task, org, onDone }: ItemProps) {
  const lead = leadOf(task, org)?.name ?? 'the lead';
  return (
    <ItemCard item={item} task={task} org={org}>
      {item.detail ? (
        <blockquote className="border-l-2 border-border pl-3 text-body-sm whitespace-pre-wrap text-foreground/90">
          {item.detail}
        </blockquote>
      ) : null}
      {item.taskId ? (
        <Reply
          taskId={item.taskId}
          label={`Answer ${lead}`}
          placeholder={`Answer ${lead}…`}
          send="Reply"
          sentTitle={`Sent to ${lead}`}
          onDone={onDone}
        />
      ) : null}
    </ItemCard>
  );
}

/** A result to review: accept it, or ask for changes, which goes back to the lead. */
function ReviewItem({ item, task, org, onDone }: ItemProps) {
  const update = useUpdateTask(item.taskId ?? '');
  const [changes, setChanges] = useState(false);
  const lead = leadOf(task, org)?.name ?? 'the lead';
  const accept = () =>
    update.mutate(
      { phase: 'done' },
      {
        onSuccess: (done) => {
          toast.success('Accepted', `#${done.number} ${done.title}`);
          onDone();
        },
      },
    );
  return (
    <ItemCard
      item={item}
      task={task}
      org={org}
      actions={
        changes || !item.taskId ? null : (
          <>
            <Button size="sm" onClick={() => setChanges(true)}>
              Request changes
            </Button>
            <Button variant="primary" size="sm" disabled={update.isPending} onClick={accept}>
              {update.isPending ? <Spinner className="size-3.5" /> : <Check aria-hidden />}
              Accept
            </Button>
          </>
        )
      }
    >
      {item.detail ? (
        <p className="line-clamp-4 text-body-sm whitespace-pre-wrap text-foreground/90">{item.detail}</p>
      ) : null}
      {changes && item.taskId ? (
        <Reply
          taskId={item.taskId}
          label={`What should ${lead} change?`}
          placeholder="What should change?"
          send="Send back"
          sentTitle={`Sent back to ${lead}`}
          onDone={onDone}
          onCancel={() => setChanges(false)}
        />
      ) : null}
    </ItemCard>
  );
}

/**
 * A task that stopped, or never got going. One in the inbox goes to its lead; one that stopped takes a
 * message telling the lead how to go on (it goes back to work with it).
 */
function ProblemItem({ item, task, org, onDone }: ItemProps) {
  const update = useUpdateTask(item.taskId ?? '');
  const [message, setMessage] = useState(false);
  const lead = leadOf(task, org);
  const canSend = task?.phase === 'inbox' && Boolean(org.department(task.departmentId)?.lead);
  const canMessage = task?.phase === 'waiting';
  const send = () =>
    update.mutate(
      { phase: 'queued' },
      {
        onSuccess: (queued) => {
          toast.success('Sent to the lead', `#${queued.number} ${queued.title}`);
          onDone();
        },
      },
    );
  return (
    <ItemCard
      item={item}
      task={task}
      org={org}
      actions={
        message ? null : (
          <>
            {canMessage ? (
              <Button size="sm" onClick={() => setMessage(true)}>
                Tell {lead?.name ?? 'the lead'} how to go on
              </Button>
            ) : null}
            {canSend ? (
              <Button variant="primary" size="sm" disabled={update.isPending} onClick={send}>
                {update.isPending ? <Spinner className="size-3.5" /> : <Send aria-hidden />}
                Send to lead
              </Button>
            ) : null}
          </>
        )
      }
    >
      {item.detail ? (
        <p className="text-body-sm whitespace-pre-wrap text-foreground/90">{item.detail}</p>
      ) : null}
      {message && item.taskId ? (
        <Reply
          taskId={item.taskId}
          label={`Tell ${lead?.name ?? 'the lead'} how to go on`}
          placeholder="Try again, or do it another way…"
          send="Send"
          sentTitle={`Sent to ${lead?.name ?? 'the lead'}`}
          onDone={onDone}
          onCancel={() => setMessage(false)}
        />
      ) : null}
    </ItemCard>
  );
}

/** Something about the setup that stops agents: what it is, and what to do. */
function HealthItem({ item, task, org }: ItemProps) {
  return (
    <ItemCard item={item} task={task} org={org}>
      {item.detail ? <p className="text-body-sm text-foreground/90">{item.detail}</p> : null}
    </ItemCard>
  );
}

/** One thing that needs you, with the actions that settle it. */
export function InboxItem(props: ItemProps) {
  const { item, org } = props;
  switch (item.kind) {
    case 'approval': {
      const department = item.departmentId ? org.department(item.departmentId) : undefined;
      return (
        <ApprovalCard
          item={item}
          context={
            item.taskId ? (
              <p className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
                <Link
                  to={`/tasks/${item.taskId}`}
                  className="truncate text-foreground/90 underline-offset-4 hover:underline"
                >
                  {item.detail ?? `#${item.taskNumber}`}
                </Link>
                {department ? (
                  <>
                    <span aria-hidden>·</span>
                    <DepartmentLabel department={department} />
                  </>
                ) : null}
              </p>
            ) : null
          }
        />
      );
    }
    case 'question':
      return <QuestionItem {...props} />;
    case 'review':
      return <ReviewItem {...props} />;
    case 'problem':
      return <ProblemItem {...props} />;
    case 'health':
      return <HealthItem {...props} />;
  }
}
