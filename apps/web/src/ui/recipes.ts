/*
 * Shared class recipes. Two distances from the canvas, so two elevations: a raised surface in the flow
 * (card, panel, field) and an overlay detached from it (popover, menu, dialog, tooltip).
 */

/** A card or panel in the flow. Fields inside it take one step up so they still read as fields. */
export const raisedSurface =
  'bg-card shadow-raised [--field:var(--field-on-surface)] [--field-rim:var(--field-rim-on-surface)]';

/** Popovers, menus and tooltips. */
export const overlaySurface =
  'bg-popover shadow-overlay [--field:var(--field-on-surface)] [--field-rim:var(--field-rim-on-surface)]';

/** Dialogs and sheets. */
export const dialogSurface =
  'bg-dialog shadow-overlay [--field:var(--field-on-surface)] [--field-rim:var(--surface-rim)]';

/** The page frame: one step below its cards, so they rise from it. */
export const frameSurface =
  'bg-background shadow-raised [--field:var(--card)] [--field-rim:var(--surface-rim)]';

/** Hover animates colour only: a background that fades trails the pointer across a list. */
export const colorTransition = 'transition-[color] duration-fast ease-out-custom';

export const focusRing =
  'focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-border-focus focus-visible:outline-offset-0';

export const focusRingInset =
  'focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-border-focus focus-visible:-outline-offset-1';

/** Popups grow from their anchor and fade. */
export const popupMotion =
  'origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out-custom data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0';

/** A row in a menu or list popup: a ghost row whose highlight is the focus cue. */
export const menuItem =
  'flex min-h-control-md w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1 text-left text-body-sm text-foreground/90 outline-hidden data-highlighted:bg-fill data-highlighted:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-icon-md [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

export const menuPopup = `min-w-44 max-h-(--available-height) overflow-y-auto rounded-xl p-1 outline-hidden ${overlaySurface} ${popupMotion}`;

export const menuLabel = 'px-2.5 pt-1.5 pb-1 text-meta tracking-wider text-muted-foreground uppercase';

export const menuSeparator = '-mx-1 my-1 h-px bg-border';

/** A box you write a message in: rounded, its edge brightening while you type. Callers add the fill. */
export const composerSurface =
  'rounded-[22px] border border-border transition-colors duration-200 focus-within:border-border-strong';
