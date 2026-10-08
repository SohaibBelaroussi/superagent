import type { AttentionItem } from '@superagent/shared';
import type { Tone } from '../../lib/tones';

const RANK: Record<AttentionItem['kind'], number> = {
  approval: 0,
  question: 1,
  problem: 2,
  review: 3,
  health: 4,
};

/** The most pressing attention item per task: an approval beats a question, which beats a stall. */
export function attentionByTask(items: readonly AttentionItem[] | undefined): Map<string, AttentionItem> {
  const byTask = new Map<string, AttentionItem>();
  for (const item of items ?? []) {
    if (!item.taskId) continue;
    const current = byTask.get(item.taskId);
    if (!current || RANK[item.kind] < RANK[current.kind]) byTask.set(item.taskId, item);
  }
  return byTask;
}

/**
 * The server titles task items "#42 Write the report stopped"; on the task's own card the task is
 * already named, so keep what comes after it: "Stopped".
 */
function afterTaskName(title: string, taskTitle: string, number: number | null): string {
  const prefix = `#${number ?? ''} ${taskTitle}`;
  const rest = title.startsWith(prefix) ? title.slice(prefix.length).replace(/^[\s:]+/, '') : title;
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : title;
}

/** What a task's card says about what it is waiting for. */
export function attentionLine(
  item: AttentionItem,
  taskTitle: string,
): { text: string; tone: Tone; detail?: string } {
  const detail = item.detail ?? undefined;
  switch (item.kind) {
    case 'approval':
      return { text: `Approve ${item.tool ?? 'a tool call'}?`, tone: 'orange', detail };
    case 'question':
      return { text: 'The lead needs you', tone: 'orange', detail };
    case 'review':
      return { text: 'Ready for your review', tone: 'purple', detail };
    case 'problem':
      return { text: afterTaskName(item.title, taskTitle, item.taskNumber), tone: 'red', detail };
    default:
      return { text: item.title, tone: 'neutral', detail };
  }
}
