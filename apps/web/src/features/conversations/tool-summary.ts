import { summarizeTool as describeTool, type ToolIcon } from '@superagent/client';
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

/** The web app's icon for each kind of tool call (`summarizeTool`, in `@superagent/client`, names them). */
const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  BookOpen,
  CalendarClock,
  CircleCheckBig,
  Clock,
  FileText,
  Globe,
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
};

export interface ToolSummary {
  icon: LucideIcon;
  /** What the call did (or does, while it runs), in a few words. */
  title: string;
}

/** A tool call in words (see `@superagent/client`), with its icon. */
export function summarizeTool(part: ToolCallPart, name: (key: string) => string): ToolSummary {
  const { icon, title } = describeTool(part, name);
  return { icon: TOOL_ICONS[icon], title };
}
