/**
 * How a lead is sent its task and the messages about it. Transcripts read the same wording back, so the
 * owner sees the brief and their own words rather than the prompt around them.
 */

const WORK_ON_IT =
  'Work on it with your team: mark progress with update_task (a checklist and a percentage), delegate to your specialists, and finish with report_to_chief: outcome "done" with the result, "blocked" with your question when you need the owner, or "failed".';

export type MessageFrom = 'owner' | 'chief';

export function briefFor(task: { number: number; title: string; brief: string }, note?: string): string {
  return [
    `Task #${task.number}: ${task.title}`,
    '',
    task.brief,
    ...(note ? ['', `Note from the owner: ${note}`] : []),
    '',
    WORK_ON_IT,
  ].join('\n');
}

/** A message the owner, or the chief on their behalf, sends a lead about a task. */
export function relayedMessage(from: MessageFrom, taskNumber: number, text: string): string {
  return `Message from the ${from === 'chief' ? 'chief of staff' : 'owner'} about task #${taskNumber}:\n\n${text}`;
}

export type LeadInput =
  | { kind: 'brief'; text: string }
  | { kind: 'message'; from: MessageFrom; text: string };

const BRIEF = /^Task #\d+: [^\n]*\n\n/;
const RELAYED = /^Message from the (owner|chief of staff) about task #\d+:\n\n/;

/** What a lead was sent, from its wording; null for anything else. */
export function readLeadInput(text: string): LeadInput | null {
  const brief = BRIEF.exec(text);
  if (brief) {
    const body = text.slice(brief[0].length);
    return {
      kind: 'brief',
      text: body.endsWith(WORK_ON_IT) ? body.slice(0, -WORK_ON_IT.length).trimEnd() : body,
    };
  }
  const relayed = RELAYED.exec(text);
  if (relayed) {
    return {
      kind: 'message',
      from: relayed[1] === 'owner' ? 'owner' : 'chief',
      text: text.slice(relayed[0].length),
    };
  }
  return null;
}
