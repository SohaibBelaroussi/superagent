import type { ToolCallPart } from '@superagent/shared';
import {
  BookOpen,
  CalendarClock,
  CircleCheckBig,
  Clock,
  FileText,
  Globe,
  type LucideIcon,
  MessageSquare,
  MonitorSmartphone,
  NotebookPen,
  Paperclip,
  PlusCircle,
  Search,
  SquareKanban,
  SquareTerminal,
  UserRound,
  Wrench,
  XCircle,
} from 'lucide-react';

type Args = Record<string, unknown>;
const args = (part: ToolCallPart): Args =>
  typeof part.args === 'object' && part.args !== null && !Array.isArray(part.args) ? (part.args as Args) : {};
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const quoted = (value: unknown) => {
  const t = text(value);
  return t ? `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”` : null;
};
const taskRef = (value: unknown) => {
  const t = text(value) ?? (typeof value === 'number' ? String(value) : null);
  if (!t) return 'a task';
  return /^#?\d+$/.test(t) ? `#${t.replace('#', '')}` : 'a task';
};
/** The task a tool's result names ({ task: "#12" }), if any. */
const resultTask = (part: ToolCallPart): string | null => {
  const result = part.result;
  if (typeof result !== 'object' || result === null) return null;
  return text((result as Args).task);
};

export interface ToolSummary {
  icon: LucideIcon;
  /** What the call did (or does, while it runs), in a few words. */
  title: string;
}

/**
 * Tool calls in words. The tools agents have are ours (the catalog, the ledger, memory, schedules), so
 * most get a sentence; anything else is named as is.
 */
export function summarizeTool(part: ToolCallPart, name: (key: string) => string): ToolSummary {
  const a = args(part);
  if (part.delegate) return { icon: UserRound, title: `Asked ${name(part.delegate)}` };
  switch (part.tool) {
    case 'create_task': {
      const created = resultTask(part);
      return {
        icon: PlusCircle,
        title: created
          ? `Created task ${created}: ${text(a.title) ?? ''}`.trim()
          : `Creating ${quoted(a.title) ?? 'a task'}`,
      };
    }
    case 'board_overview':
      return { icon: SquareKanban, title: 'Looked at the board' };
    case 'inspect_task':
      return { icon: FileText, title: `Looked at ${taskRef(a.task)}` };
    case 'message_task':
      return { icon: MessageSquare, title: `Messaged the lead on ${taskRef(a.task)}` };
    case 'cancel_task':
      return { icon: XCircle, title: `Cancelled ${taskRef(a.task)}` };
    case 'update_task': {
      const progress = typeof a.progress === 'number' ? ` (${Math.round(a.progress)}%)` : '';
      return { icon: NotebookPen, title: `Updated the task${progress}` };
    }
    case 'report_to_chief': {
      const outcome = text(a.outcome);
      const label =
        outcome === 'done'
          ? 'Reported it done'
          : outcome === 'blocked'
            ? 'Asked you a question'
            : 'Reported a failure';
      return { icon: CircleCheckBig, title: label };
    }
    case 'add_artifact':
      return { icon: Paperclip, title: `Added ${quoted(a.title) ?? 'a deliverable'}` };
    case 'current_time':
      return { icon: Clock, title: 'Checked the time' };
    case 'update_owner_profile':
      return { icon: UserRound, title: 'Noted something about you' };
    case 'save_department_note':
      return { icon: NotebookPen, title: 'Saved a department note' };
    case 'create_schedule':
      return { icon: CalendarClock, title: `Scheduled ${quoted(a.title) ?? 'a task'}` };
    case 'update_schedule':
    case 'delete_schedule':
    case 'list_schedules':
    case 'run_schedule':
      return {
        icon: CalendarClock,
        title:
          part.tool === 'list_schedules'
            ? 'Looked at the schedules'
            : part.tool === 'run_schedule'
              ? 'Ran a schedule now'
              : part.tool === 'delete_schedule'
                ? 'Deleted a schedule'
                : 'Changed a schedule',
      };
    case 'web_search':
      return { icon: Search, title: `Searched the web for ${quoted(a.query) ?? 'something'}` };
    case 'fetch_page':
      return { icon: Globe, title: `Read ${text(a.url) ?? 'a page'}` };
    case 'knowledge_search':
      return { icon: BookOpen, title: `Searched your documents for ${quoted(a.query) ?? 'something'}` };
  }
  if (part.tool.startsWith('mastra_workspace_')) {
    const command = text(a.command);
    const path = text(a.path);
    return {
      icon: SquareTerminal,
      title: command ? `Ran ${command}` : path ? `Worked on ${path}` : 'Used its workspace',
    };
  }
  if (part.tool.startsWith('browser_')) return { icon: MonitorSmartphone, title: 'Used the browser' };
  return { icon: Wrench, title: `Used ${part.tool}` };
}
