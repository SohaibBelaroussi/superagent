import { useEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { cn } from '../../lib/cn';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { SETTINGS_SECTIONS } from './sections';

const sectionLink = cn(
  'flex h-control-md items-center gap-2.5 rounded-lg px-2.5 text-label text-muted-foreground outline-hidden hover:bg-fill-subtle hover:text-foreground [&_svg]:size-icon-md [&_svg]:shrink-0',
  colorTransition,
  focusRingInset,
);

/**
 * The settings pages: their sections listed beside them on a desktop, as a row above them on a phone.
 * Each section is its own page (`/settings/<section>`).
 */
export function SettingsLayout() {
  const { pathname } = useLocation();
  const row = useRef<HTMLElement>(null);
  // On a phone the row scrolls: keep the current section in view, in its middle. Again once the fonts
  // have loaded, which can widen it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each section change
  useEffect(() => {
    let current = true;
    const bring = () => {
      if (!current) return;
      row.current
        ?.querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    };
    bring();
    void document.fonts?.ready.then(bring);
    return () => {
      current = false;
    };
  }, [pathname]);
  const current = SETTINGS_SECTIONS.find((section) => pathname.startsWith(`/settings/${section.path}`));
  const links = (className: string) =>
    SETTINGS_SECTIONS.map((section) => {
      const active = section === current;
      return (
        <Link
          key={section.path}
          to={`/settings/${section.path}`}
          aria-current={active ? 'page' : undefined}
          className={cn(sectionLink, active && 'bg-fill text-foreground hover:bg-fill', className)}
        >
          <section.icon aria-hidden />
          {section.label}
        </Link>
      );
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <nav
        aria-label="Settings"
        className="hidden w-56 shrink-0 flex-col gap-0.5 border-r border-border px-3 pt-7 pb-6 lg:flex"
      >
        <h2 className="px-2.5 pb-2 text-eyebrow text-placeholder uppercase">Settings</h2>
        {links('')}
      </nav>
      <nav
        ref={row}
        aria-label="Settings sections"
        className="flex shrink-0 gap-1 overflow-x-auto px-4 pt-4 [scrollbar-width:none] lg:hidden"
      >
        {links('shrink-0 whitespace-nowrap')}
      </nav>
      <Outlet />
    </div>
  );
}
