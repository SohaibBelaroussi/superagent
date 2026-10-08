import type { ConversationMessage } from '@superagent/shared';
import type { ReactNode } from 'react';
import type { ShownTurn } from '../../api/conversations';
import type { OrgLookup } from '../tasks/org';
import {
  MessageView,
  OwnerBubble,
  type PendingMessage,
  RunningCalls,
  type Speaker,
  TurnView,
} from './message-views';

const NONE: ReadonlySet<string> = new Set();

const PENDING_NOTE: Record<PendingMessage['state'], string> = {
  sending: 'Sending…',
  started: 'Sent',
  queued: 'Sends once the current answer is done',
  failed: 'Not sent',
};

/**
 * A conversation in order: stored messages, what reached the agent since, your messages on their way,
 * the turn being taken (the answer to them), then your messages waiting for that turn to end. An
 * agent's consecutive messages share one name line.
 */
export function ConversationList({
  messages,
  arrived = [],
  turns = [],
  pending = [],
  running = NONE,
  org,
  speaker,
  defaultAgent,
  onRetry,
}: {
  messages: ConversationMessage[];
  arrived?: ConversationMessage[];
  turns?: ShownTurn[];
  pending?: PendingMessage[];
  /** Tool calls running right now. */
  running?: ReadonlySet<string>;
  org: OrgLookup;
  speaker: (key: string | null) => Speaker;
  /** Who takes the turns when a turn doesn't say (the chief, or the task's lead). */
  defaultAgent: string | null;
  onRetry?: (message: PendingMessage) => void;
}) {
  const name = (key: string) => speaker(key).name;
  const lead = speaker(defaultAgent).name;
  const rows: ReactNode[] = [];
  let previous: string | null = null;
  const pendingRow = (message: PendingMessage) => {
    previous = null;
    rows.push(
      <div key={message.key} className={message.state === 'failed' ? undefined : 'opacity-70'}>
        <OwnerBubble text={message.text}>
          <span className="flex items-center gap-2 text-caption text-muted-foreground">
            {message.state === 'failed'
              ? (message.error ?? PENDING_NOTE.failed)
              : PENDING_NOTE[message.state]}
            {message.state === 'failed' && onRetry ? (
              <button
                type="button"
                className="text-foreground underline underline-offset-4"
                onClick={() => onRetry(message)}
              >
                Retry
              </button>
            ) : null}
          </span>
        </OwnerBubble>
      </div>,
    );
  };

  for (const message of [...messages, ...arrived]) {
    const author = message.role === 'agent' ? (message.author ?? defaultAgent) : null;
    rows.push(
      <MessageView
        key={message.id}
        message={message}
        org={org}
        name={name}
        speaker={speaker(author)}
        showSpeaker={author === null || author !== previous}
        lead={lead}
      />,
    );
    previous = author;
  }
  for (const message of pending) if (message.state !== 'queued') pendingRow(message);
  for (const turn of turns) {
    const author = turn.agent ?? defaultAgent;
    rows.push(
      <TurnView
        key={turn.runId}
        turn={turn}
        speaker={speaker(author)}
        showSpeaker={author !== previous}
        name={name}
        org={org}
      />,
    );
    previous = author;
  }
  for (const message of pending) if (message.state === 'queued') pendingRow(message);
  return (
    <RunningCalls value={running}>
      <div className="flex flex-col gap-5">{rows}</div>
    </RunningCalls>
  );
}
