import type { OrgLookup, PendingMessage, ShownTurn, Speaker } from '@superagent/client';
import type { ConversationMessage } from '@superagent/shared';
import type { ReactNode } from 'react';
import { MessageView, PendingBubble, RunningCalls, TurnView } from './message-views';

const NONE: ReadonlySet<string> = new Set();

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
      <PendingBubble
        key={message.key}
        message={message}
        onRetry={onRetry ? () => onRetry(message) : undefined}
      />,
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
  // The rows go straight into the parent's scroll view, which spaces them, so it can keep your place
  // when earlier messages load above them.
  return <RunningCalls value={running}>{rows}</RunningCalls>;
}
