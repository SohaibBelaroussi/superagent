import type { Tone } from '@superagent/client';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { Platform, StyleSheet, useColorScheme } from 'react-native';
import { preferences } from '../lib/preferences';
import { type ThemeName, themes } from './tokens';

/*
 * The phone's design system (D52): the web app's colour roles (generated into ./tokens from its
 * theme.css), its type roles grown for a phone, and touch-sized controls. Components name roles,
 * never raw colours or sizes.
 */

const FONT = {
  regular: 'MonaSans-Regular',
  medium: 'MonaSans-Medium',
  semibold: 'MonaSans-SemiBold',
} as const;

/** Text roles: the web's names, sized for a phone (its 14 px body is small in a hand). */
export const type = {
  display: { fontFamily: FONT.medium, fontSize: 28, lineHeight: 34, letterSpacing: -0.3 },
  title: { fontFamily: FONT.medium, fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  heading: { fontFamily: FONT.medium, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: FONT.regular, fontSize: 16, lineHeight: 23 },
  label: { fontFamily: FONT.medium, fontSize: 15, lineHeight: 20 },
  cardTitle: { fontFamily: FONT.semibold, fontSize: 15, lineHeight: 20 },
  bodySmall: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 21 },
  caption: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  meta: { fontFamily: FONT.medium, fontSize: 11, lineHeight: 14, letterSpacing: 0.3 },
  eyebrow: { fontFamily: FONT.medium, fontSize: 12, lineHeight: 16, letterSpacing: 0.8 },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 19,
  },
} as const;

export type TypeRole = keyof typeof type;

/** Spacing, on a 4-point grid. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 16, card: 20, sheet: 24, pill: 999 } as const;

/** Control heights: touch targets are at least 44 pt (48 dp counts the hit slop). */
export const control = { sm: 36, md: 44, lg: 52 } as const;

/** How the system's text size may grow ours, before layouts give way. */
export const MAX_FONT_SCALE = 1.6;

export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Theme {
  name: ThemeName;
  colors: (typeof themes)[ThemeName]['colors'];
  tones: (typeof themes)[ThemeName]['tones'];
  shadows: (typeof themes)[ThemeName]['shadows'];
}

/** A tone's surface and inks: badge fills, its dot, and the text that reads on them. */
export function toneColors(theme: Theme, tone: Tone) {
  const t = theme.tones[tone === 'neutral' ? 'neutral' : tone];
  return {
    strong: 'strong' in t ? t.strong : theme.colors.fillStrong,
    subtle: 'subtle' in t ? t.subtle : theme.colors.fill,
    edge: 'edge' in t ? t.edge : theme.colors.border,
    indicator: 'indicator' in t ? t.indicator : theme.colors.mutedForeground,
    foreground: tone === 'neutral' ? theme.colors.mutedForeground : t.foreground,
  };
}

interface ThemeValue {
  theme: Theme;
  choice: ThemeChoice;
  setChoice(choice: ThemeChoice): void;
}

const THEME_KEY = 'superagent.theme';

const ThemeContext = createContext<ThemeValue | null>(null);

function readChoice(): ThemeChoice {
  const stored = preferences.get(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** The theme: what you picked, else the system's; dark when the system says nothing. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const name: ThemeName = choice === 'system' ? (system === 'light' ? 'light' : 'dark') : choice;
  const value = useMemo<ThemeValue>(
    () => ({
      theme: { name, ...themes[name] },
      choice,
      setChoice: (next) => {
        preferences.set(THEME_KEY, next);
        setChoiceState(next);
      },
    }),
    [name, choice],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useThemeChoice(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useThemeChoice() outside <ThemeProvider>');
  return value;
}

export function useTheme(): Theme {
  return useThemeChoice().theme;
}

/**
 * Styles that depend on the theme, made once per theme: `const useStyles = makeStyles((t) => ({...}))`
 * at module level, then `const styles = useStyles()` in the component.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (theme: Theme) => T): () => T {
  const made = new Map<ThemeName, T>();
  return function useStyles(): T {
    const theme = useTheme();
    let styles = made.get(theme.name);
    if (!styles) {
      styles = StyleSheet.create(factory(theme));
      made.set(theme.name, styles);
    }
    return styles;
  };
}
