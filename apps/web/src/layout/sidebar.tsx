import type { Department } from '@superagent/shared';
import { OPEN_PHASES } from '@superagent/shared/phases';
import { ChevronsUpDown, House, LogOut, Monitor, Moon, SquareKanban, Sun } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router';
import { useLiveStatus } from '../api/live';
import { useBoard, useDepartments, useProfile } from '../api/queries';
import { useMe, useSession } from '../api/session';
import { cn } from '../lib/cn';
import { type ThemeChoice, useTheme } from '../lib/theme';
import { departmentTone, TONE_DOT } from '../lib/tones';
import { Avatar } from '../ui/avatar';
import { LogoMark } from '../ui/icons';
import { Menu, MenuGroup, MenuItem, MenuLabel, MenuRadioGroup, MenuSeparator } from '../ui/menu';
import { colorTransition, focusRingInset } from '../ui/recipes';
import { StatusDot } from '../ui/status-dot';

const navRow = cn(
  'flex h-control-md w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-label text-muted-foreground outline-hidden hover:bg-fill-subtle hover:text-foreground',
  '[&_svg]:size-icon-md [&_svg]:shrink-0',
  colorTransition,
  focusRingInset,
);
const navRowActive = 'bg-fill text-foreground hover:bg-fill';

function NavItem({
  to,
  icon: Icon,
  label,
  end,
  onNavigate,
  trailing,
}: {
  to: string;
  icon: ComponentType<{ 'aria-hidden'?: boolean }>;
  label: string;
  end?: boolean;
  onNavigate?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        className={({ isActive }) => cn(navRow, isActive && navRowActive)}
      >
        <Icon aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </NavLink>
    </li>
  );
}

function DepartmentLink({
  department,
  openTasks,
  onNavigate,
}: {
  department: Department;
  openTasks: number;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const active = pathname === '/board' && params.get('department') === department.slug;
  return (
    <li>
      <NavLink
        to={`/board?department=${encodeURIComponent(department.slug)}`}
        onClick={onNavigate}
        className={cn(navRow, active && navRowActive)}
        aria-current={active ? 'page' : undefined}
      >
        <span className="flex size-icon-md items-center justify-center" aria-hidden>
          <span className={cn('size-2 rounded-full', TONE_DOT[departmentTone(department.slug)])} />
        </span>
        <span className="min-w-0 flex-1 truncate">{department.name}</span>
        {openTasks > 0 ? (
          <span className="text-meta text-muted-foreground tabular-nums">{openTasks}</span>
        ) : null}
      </NavLink>
    </li>
  );
}

const LIVE_LABEL = { live: 'Live', connecting: 'Connecting…', offline: 'Reconnecting…' } as const;

function LiveIndicator() {
  const status = useLiveStatus();
  return (
    <div
      className="flex h-7 items-center gap-2 px-2.5 text-caption text-muted-foreground"
      role="status"
      aria-live="polite"
      title={
        status === 'live' ? 'Updates arrive as they happen' : 'Updates paused until the connection is back'
      }
    >
      <StatusDot
        tone={status === 'live' ? 'green' : status === 'offline' ? 'amber' : 'neutral'}
        ring={status === 'connecting'}
      />
      {LIVE_LABEL[status]}
    </div>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor aria-hidden /> },
  { value: 'light', label: 'Light', icon: <Sun aria-hidden /> },
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden /> },
];

function AccountMenu() {
  const me = useMe();
  const { signOut } = useSession();
  const profile = useProfile();
  const { choice, setChoice } = useTheme();
  const name = profile.data?.name?.trim() || me.name;
  return (
    <Menu
      side="top"
      align="start"
      className="w-56"
      trigger={
        <button
          type="button"
          className={cn(navRow, 'h-11 gap-2.5 px-2 data-popup-open:bg-fill')}
          aria-label="Account and theme"
        >
          <Avatar name={name} size="md" tone="neutral" />
          <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
            <span className="w-full truncate text-left text-label text-foreground">{name}</span>
            <span className="w-full truncate text-left text-meta text-muted-foreground">{me.token.name}</span>
          </span>
          <ChevronsUpDown aria-hidden className="text-muted-foreground" />
        </button>
      }
    >
      <MenuGroup>
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup value={choice} onValueChange={setChoice} options={THEMES} />
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon={<LogOut aria-hidden />} onClick={() => void signOut()}>
        Sign out of this browser
      </MenuItem>
    </Menu>
  );
}

/** The rail: navigation, departments, the live connection and the account. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const departments = useDepartments();
  const board = useBoard();
  const openByDepartment = new Map<string, number>();
  for (const column of board.data?.columns ?? []) {
    if (!OPEN_PHASES.includes(column.phase)) continue;
    for (const task of column.tasks) {
      openByDepartment.set(task.departmentId, (openByDepartment.get(task.departmentId) ?? 0) + 1);
    }
  }
  const active = (departments.data ?? []).filter((department) => !department.archivedAt);

  return (
    <nav aria-label="Main" className="flex h-full min-h-0 flex-col gap-5 px-2.5 py-3">
      <div className="flex h-8 items-center gap-2 px-2.5">
        <LogoMark className="text-foreground" />
        <span className="text-[0.9375rem] font-[560] tracking-[-0.01em] text-foreground">superagent</span>
      </div>

      <ul className="flex flex-col gap-0.5">
        <NavItem to="/" end icon={House} label="Home" onNavigate={onNavigate} />
        <NavItem to="/board" end icon={SquareKanban} label="Board" onNavigate={onNavigate} />
      </ul>

      <section aria-labelledby="sidebar-departments" className="flex min-h-0 flex-col gap-1">
        <h2 id="sidebar-departments" className="px-2.5 text-eyebrow text-placeholder uppercase">
          Departments
        </h2>
        {active.length === 0 && departments.isSuccess ? (
          <p className="px-2.5 py-1 text-caption text-muted-foreground">None yet.</p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
            {active.map((department) => (
              <DepartmentLink
                key={department.id}
                department={department}
                openTasks={openByDepartment.get(department.id) ?? 0}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="mt-auto flex flex-col gap-1">
        <LiveIndicator />
        <AccountMenu />
      </div>
    </nav>
  );
}
