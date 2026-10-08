import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import {
  Building2,
  CalendarClock,
  ChartColumn,
  CornerDownLeft,
  House,
  Inbox,
  Library,
  type LucideIcon,
  MessagesSquare,
  Plus,
  Search,
  SquareKanban,
  SquareStack,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAttention, useBoard } from '../../api/queries';
import { cn } from '../../lib/cn';
import { THEME_CHOICES, useTheme } from '../../lib/theme';
import { departmentTone, TONE_DOT } from '../../lib/tones';
import { Kbd } from '../../ui/feedback';
import { dialogSurface, menuItem, menuLabel } from '../../ui/recipes';
import type { ChiefDraft } from '../conversations/chief-page';
import { SETTINGS_SECTIONS } from '../settings/sections';
import { NewTaskDialog } from '../tasks/new-task-dialog';
import { useOrg } from '../tasks/org';

interface Command {
  value: string;
  label: string;
  /** Words it also answers to. */
  keywords?: string;
  hint?: string;
  icon?: LucideIcon;
  /** A department's colour, in place of an icon. */
  dot?: string;
  run(): void;
}

interface Group {
  value: string;
  items: Command[];
}

const ASK = 'ask-the-chief';

/** Every word of the query appears in the command's label or keywords. */
function matches(command: Command, query: string): boolean {
  const haystack = `${command.label} ${command.keywords ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Pages, tasks and actions in one search: ⌘K (Ctrl+K) anywhere. Whatever you type can also go to the
 * chief of staff, last of all, so Enter runs a match first and asks the chief only when nothing else fits.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const org = useOrg();
  const board = useBoard();
  const waiting = useAttention().data?.length ?? 0;
  const { setChoice } = useTheme();
  const [query, setQuery] = useState('');
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  // However it closes (Escape, a click outside, ⌘K again, a command), it opens empty next time.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const close = () => onOpenChange(false);
  const go = (to: string) => () => {
    close();
    navigate(to);
  };
  // On a department's board or page, a new task starts in that department.
  const pageSlug = pathname.startsWith('/departments/')
    ? pathname.slice('/departments/'.length)
    : pathname === '/board'
      ? params.get('department')
      : null;
  const boardDepartment = pageSlug ? org.departmentBySlug(pageSlug)?.id : undefined;

  // Built each render: a few dozen entries, and the query changes them anyway.
  const groups = ((): Group[] => {
    const pages: Command[] = [
      { value: 'home', label: 'Home', icon: House, run: go('/') },
      {
        value: 'inbox',
        label: 'Inbox',
        keywords: 'approvals questions reviews attention',
        hint: waiting ? `${waiting} waiting` : undefined,
        icon: Inbox,
        run: go('/inbox'),
      },
      {
        value: 'chief',
        label: 'Chief of staff',
        keywords: 'chat conversation',
        icon: MessagesSquare,
        run: go('/chief'),
      },
      { value: 'board', label: 'Board', keywords: 'tasks kanban', icon: SquareKanban, run: go('/board') },
      {
        value: 'departments',
        label: 'Departments',
        keywords: 'organization teams org chart',
        icon: Building2,
        run: go('/departments'),
      },
      {
        value: 'schedules',
        label: 'Schedules',
        keywords: 'recurring cron repeat',
        icon: CalendarClock,
        run: go('/schedules'),
      },
      {
        value: 'knowledge',
        label: 'Knowledge',
        keywords: 'documents files upload search',
        icon: Library,
        run: go('/knowledge'),
      },
      {
        value: 'usage',
        label: 'Usage',
        keywords: 'cost tokens spend money',
        icon: ChartColumn,
        run: go('/usage'),
      },
      ...SETTINGS_SECTIONS.map((section) => ({
        value: `settings:${section.path}`,
        label: section.label,
        keywords: `settings ${section.keywords}`,
        hint: 'Settings',
        icon: section.icon,
        run: go(`/settings/${section.path}`),
      })),
      ...org.departments.map((department) => ({
        value: `department:${department.slug}`,
        label: department.name,
        keywords: `${department.slug} department team notes`,
        hint: 'Department',
        dot: TONE_DOT[departmentTone(department.slug)],
        run: go(`/departments/${encodeURIComponent(department.slug)}`),
      })),
    ];
    const agents: Command[] = [...org.agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => {
        const department = org.department(agent.departmentId);
        const role = agent.role === 'lead' ? 'Lead' : 'Specialist';
        return {
          value: `agent:${agent.key}`,
          label: agent.name,
          keywords: `${agent.key} ${role} agent ${department?.name ?? ''}`,
          hint: department ? `${role}, ${department.name}` : role,
          icon: UserRound,
          run: go(`/agents/${encodeURIComponent(agent.key)}`),
        };
      });
    const tasks: Command[] = (board.data?.columns ?? [])
      .flatMap((column) => column.tasks)
      .sort((a, b) => b.number - a.number)
      .map((task) => ({
        value: `task:${task.id}`,
        label: `#${task.number} ${task.title}`,
        keywords: task.phase,
        hint: org.department(task.departmentId)?.name,
        icon: SquareStack,
        run: go(`/tasks/${task.id}`),
      }));
    const actions: Command[] = [
      {
        value: 'new-task',
        label: 'New task…',
        keywords: 'create add assign',
        icon: Plus,
        run: () => {
          close();
          setNewTaskOpen(true);
        },
      },
      {
        value: 'new-department',
        label: 'New department…',
        keywords: 'create add team',
        icon: Plus,
        run: go('/departments?new=1'),
      },
      {
        value: 'new-schedule',
        label: 'New schedule…',
        keywords: 'create add recurring repeat cron',
        icon: Plus,
        run: go('/schedules?new=1'),
      },
      ...THEME_CHOICES.map((theme) => ({
        value: `theme:${theme.value}`,
        label: `${theme.label} theme`,
        keywords: 'appearance mode',
        icon: theme.icon,
        run: () => {
          setChoice(theme.value);
          close();
        },
      })),
    ];
    const question = query.trim();
    const ask: Command[] = question
      ? [
          {
            value: ASK,
            label: `Ask the chief: “${question}”`,
            icon: MessagesSquare,
            run: () => {
              close();
              const state: ChiefDraft = { send: question };
              // Already there: the conversation sends it without another history entry.
              navigate('/chief', { state, replace: pathname === '/chief' });
            },
          },
        ]
      : [];
    return [
      { value: 'Go to', items: pages },
      { value: 'Tasks', items: tasks },
      { value: 'Agents', items: agents },
      { value: 'Actions', items: actions },
      ...(ask.length > 0 ? [{ value: 'Ask', items: ask }] : []),
    ];
  })();

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
          <Dialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12dvh]">
            <Dialog.Popup
              aria-label="Command palette"
              className={cn(
                'flex max-h-[min(34rem,80dvh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl outline-hidden',
                dialogSurface,
                'transition-[opacity,scale] duration-150 ease-out-custom data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0',
              )}
            >
              <Autocomplete.Root
                open
                inline
                items={groups}
                value={query}
                onValueChange={setQuery}
                autoHighlight="always"
                keepHighlight
                itemToStringValue={(item: Command) => item.label}
                filter={(item: Command, value) => item.value === ASK || matches(item, value)}
              >
                <Autocomplete.InputGroup className="flex items-center gap-2.5 border-b border-border px-4">
                  <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <Autocomplete.Input
                    aria-label="Search pages, tasks and actions"
                    placeholder="Search, or ask the chief…"
                    className="h-12 w-full bg-transparent text-body text-foreground outline-hidden placeholder:text-placeholder"
                  />
                  <Kbd>Esc</Kbd>
                </Autocomplete.InputGroup>
                {/* Nothing is ever empty: whatever you type, the chief can be asked. */}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 [scroll-padding-block:0.375rem]">
                  <Autocomplete.List>
                    {(group: Group) => (
                      <Autocomplete.Group key={group.value} items={group.items} className="not-last:mb-1.5">
                        <Autocomplete.GroupLabel className={menuLabel}>{group.value}</Autocomplete.GroupLabel>
                        <Autocomplete.Collection>
                          {(command: Command) => (
                            <Autocomplete.Item
                              key={command.value}
                              value={command}
                              onClick={() => command.run()}
                              className={cn(menuItem, 'scroll-my-1.5')}
                            >
                              {command.dot ? (
                                <span className="flex size-icon-md items-center justify-center" aria-hidden>
                                  <span className={cn('size-2 rounded-full', command.dot)} />
                                </span>
                              ) : command.icon ? (
                                <command.icon aria-hidden />
                              ) : null}
                              <span className="min-w-0 flex-1 truncate">{command.label}</span>
                              {command.hint ? (
                                <span className="shrink-0 text-caption text-muted-foreground">
                                  {command.hint}
                                </span>
                              ) : null}
                            </Autocomplete.Item>
                          )}
                        </Autocomplete.Collection>
                      </Autocomplete.Group>
                    )}
                  </Autocomplete.List>
                </div>
                <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-caption text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Kbd>
                      <CornerDownLeft aria-hidden className="size-3" />
                    </Kbd>
                    to open
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd>
                    to move
                  </span>
                </div>
              </Autocomplete.Root>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} departmentId={boardDepartment} />
    </>
  );
}
