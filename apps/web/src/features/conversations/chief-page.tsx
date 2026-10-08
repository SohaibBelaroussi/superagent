import type { ConversationMessage } from '@superagent/shared';
import { ArrowDown, ArrowUp, ChevronsUp, Square } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { useConversation, useSendToChief, useStopChief } from '../../api/conversations';
import { cn } from '../../lib/cn';
import { randomId } from '../../lib/id';
import { useDocumentTitle } from '../../lib/title';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Notice, Skeleton, Spinner } from '../../ui/feedback';
import { composerSurface } from '../../ui/recipes';
import { StatusDot } from '../../ui/status-dot';
import { useOrg } from '../tasks/org';
import { ConversationList } from './conversation-list';
import { type PendingMessage, textOf, useSpeakers } from './message-views';
import { useStickToBottom } from './scroll';

const SUGGESTIONS = [
  'What’s on the board right now?',
  'What needs my attention today?',
  'Start a research task: compare the top open-source agent frameworks.',
];

/** How long a queued message may wait once the chief is idle (it goes out within a second) before it's offered again. */
const LOST_AFTER_MS = 15_000;

type Pending = PendingMessage & {
  /** Your stored messages with the same text when it was sent: none of them is this one. */
  known: ReadonlySet<string>;
};

/**
 * The pending messages the history now has, each with the stored message that is it. Each stored message
 * of yours (with its text, and not there when it was sent) stands for one pending message, in order, so
 * sending the same words twice works.
 */
function storedPending(pending: Pending[], messages: ConversationMessage[]): Map<string, string> {
  const stored = new Map<string, string>();
  const used = new Set<string>();
  for (const item of pending) {
    const match = messages.find(
      (m) => m.role === 'owner' && !used.has(m.id) && !item.known.has(m.id) && textOf(m.parts) === item.text,
    );
    if (match) {
      used.add(match.id);
      stored.set(item.key, match.id);
    }
  }
  return stored;
}

/** Where the home page's quick message travels, to be sent once the chief's page is open. */
export interface ChiefDraft {
  send?: string;
}

/** Your conversation with the chief of staff: its answers stream in, departments' reports appear. */
export function ChiefPage() {
  useDocumentTitle('Chief of staff');
  const org = useOrg();
  const speaker = useSpeakers(org);
  const conversation = useConversation({ kind: 'chief' }, { live: true });
  const { history, messages, arrived, turns, running: runningCalls, active: running, status } = conversation;
  const send = useSendToChief();
  const stop = useStopChief();
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { atBottom, toBottom, keepPlace } = useStickToBottom(scrollRef, contentRef);

  // A message is pending until the history has it.
  const stored = storedPending(pending, messages);
  const shownPending = pending.filter((message) => !stored.has(message.key));

  function submit(text: string, key = randomId()) {
    const message = text.trim();
    if (!message) return;
    const known = new Set(
      messages.filter((m) => m.role === 'owner' && textOf(m.parts) === message).map((m) => m.id),
    );
    setPending((list) => [
      ...list.filter((item) => item.key !== key),
      { key, text: message, state: 'sending', known },
    ]);
    toBottom();
    send.mutate(message, {
      onSuccess: ({ delivery }) =>
        setPending((list) => list.map((item) => (item.key === key ? { ...item, state: delivery } : item))),
      onError: (error) =>
        setPending((list) =>
          list.map((item) =>
            item.key === key ? { ...item, state: 'failed', error: `Not sent: ${errorMessage(error)}` } : item,
          ),
        ),
    });
  }

  // The ones the history has caught up with are done with. The rest know those messages aren't theirs.
  useEffect(() => {
    if (stored.size === 0) return;
    const taken = [...stored.values()];
    setPending((list) =>
      list
        .filter((message) => !stored.has(message.key))
        .map((message) => ({ ...message, known: new Set([...message.known, ...taken]) })),
    );
  });

  // A queued message goes out within a second of the chief going idle. One still waiting well after
  // that was lost (the server restarted, say): offer it again.
  useEffect(() => {
    if (running || status !== 'live' || !pending.some((message) => message.state === 'queued')) return;
    const timer = setTimeout(() => {
      setPending((list) =>
        list.map((message) =>
          message.state === 'queued'
            ? { ...message, state: 'failed', error: 'Not sent: the chief didn’t pick it up' }
            : message,
        ),
      );
    }, LOST_AFTER_MS);
    return () => clearTimeout(timer);
  }, [running, status, pending]);

  // A message written on the home page arrives in the navigation state: send it once, even when the
  // effect runs twice (StrictMode) before the cleared state has rendered.
  const location = useLocation();
  const navigate = useNavigate();
  const handoff = (location.state as ChiefDraft | null)?.send;
  const handedOff = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per handed-off message.
  useEffect(() => {
    if (!handoff || handedOff.current === location.key) return;
    handedOff.current = location.key;
    navigate(location.pathname, { replace: true, state: null });
    submit(handoff);
  }, [handoff, location.key]);

  function onSubmit(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim()) return;
    submit(draft);
    setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  }

  const empty =
    history.isSuccess &&
    messages.length === 0 &&
    arrived.length === 0 &&
    turns.length === 0 &&
    shownPending.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name="Chief of staff" size="md" />
          <div className="flex min-w-0 flex-col leading-tight">
            <h1 className="truncate text-label text-foreground">Chief of staff</h1>
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground" role="status">
              <StatusDot
                tone={
                  running ? 'amber' : status === 'live' ? 'green' : status === 'offline' ? 'amber' : 'neutral'
                }
                ring={running}
              />
              {running
                ? 'Answering…'
                : status === 'live'
                  ? 'Routes your work to the departments'
                  : status === 'offline'
                    ? 'Reconnecting…'
                    : 'Connecting…'}
            </p>
          </div>
        </div>
        {running ? (
          <Button size="sm" disabled={stop.isPending} onClick={() => stop.mutate()}>
            {stop.isPending ? <Spinner className="size-3.5" /> : <Square aria-hidden />}
            Stop
          </Button>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-8">
            {history.hasNextPage ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-center"
                disabled={history.isFetchingNextPage}
                onClick={() => keepPlace(() => history.fetchNextPage())}
              >
                {history.isFetchingNextPage ? <Spinner className="size-3.5" /> : <ChevronsUp aria-hidden />}
                Earlier messages
              </Button>
            ) : null}
            {history.isPending ? (
              <ConversationSkeleton />
            ) : history.isError ? (
              <Notice
                tone="destructive"
                title="Couldn’t load the conversation"
                action={
                  <Button size="sm" onClick={() => history.refetch()}>
                    Retry
                  </Button>
                }
              >
                {errorMessage(history.error)}
              </Notice>
            ) : empty ? (
              <Welcome
                onPick={(suggestion) => {
                  setDraft(suggestion);
                  inputRef.current?.focus();
                }}
              />
            ) : (
              <ConversationList
                messages={messages}
                arrived={arrived}
                turns={turns}
                pending={shownPending}
                running={runningCalls}
                org={org}
                speaker={speaker}
                defaultAgent="chief"
                onRetry={(message) => submit(message.text, message.key)}
              />
            )}
          </div>
        </div>
        {atBottom ? null : (
          <Button
            size="sm"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-overlay"
            onClick={() => toBottom('smooth')}
          >
            <ArrowDown aria-hidden />
            Latest
          </Button>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
        <div className={cn('mx-auto w-full max-w-3xl bg-card shadow-raised', composerSurface)}>
          <label htmlFor="chief-message" className="sr-only">
            Message the chief of staff
          </label>
          <textarea
            id="chief-message"
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={20_000}
            rows={1}
            placeholder={
              running ? 'Write now: it reads this once it’s done…' : 'Ask, delegate, or check on something…'
            }
            className="field-sizing-content block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-body text-foreground outline-hidden placeholder:text-placeholder"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <span className="pl-1 text-caption text-placeholder">
              Enter to send · Shift + Enter for a new line
            </span>
            <Button type="submit" variant="primary" size="icon-sm" tooltip="Send" disabled={!draft.trim()}>
              <ArrowUp aria-hidden />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (suggestion: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-5 py-16 text-center">
      <Avatar name="Chief of staff" size="lg" />
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="text-heading text-foreground">What can I take off your plate?</h2>
        <p className="text-body-sm text-muted-foreground">
          I know every department. Ask me anything, hand me work, and I’ll route it to the right team and tell
          you when it’s done.
        </p>
      </div>
      <ul className="flex w-full max-w-md flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onPick(suggestion)}
              className="w-full rounded-xl bg-fill-subtle px-4 py-2.5 text-left text-body-sm text-foreground/90 shadow-rim outline-hidden transition-colors duration-150 hover:bg-fill focus-visible:outline-1 focus-visible:outline-border-focus"
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading the conversation…</span>
      <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-7 h-4 w-3/4" />
        <Skeleton className="ml-7 h-4 w-2/3" />
      </div>
      <Skeleton className="h-20 rounded-xl" />
    </div>
  );
}
