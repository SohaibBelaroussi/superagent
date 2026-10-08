/** Whether this is a Mac (or an iPad with a keyboard), where shortcuts use ⌘ rather than Ctrl. */
export function isApple(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.userAgent;
  return /mac|iphone|ipad/i.test(platform);
}

/** The command palette's shortcut as this keyboard writes it. */
export const paletteShortcut = (): string => (isApple() ? '⌘K' : 'Ctrl K');
