/**
 * Generates the phone app's colour tokens from the web app's theme (D52), so the two can't drift:
 *
 *   node scripts/tokens.mts           writes src/ui/tokens.ts
 *   node scripts/tokens.mts --check   fails when src/ui/tokens.ts is out of date
 *
 * React Native has no `oklch()`, `color-mix()` or CSS variables, so each role is computed here for each
 * theme: dark from `:root`, light from `:root` with `html.light` on top. Out-of-gamut colours are
 * clipped to sRGB. Shadows keep their CSS shape (React Native's `boxShadow` reads it) with their
 * colours converted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Vars = Map<string, string>;

/** The `--name: value;` declarations of the first block that `selector` opens. */
function declarations(css: string, selector: string): Vars {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in the theme`);
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const vars: Vars = new Map();
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(match[1] as string, (match[2] as string).replace(/\s+/g, ' ').trim());
  }
  return vars;
}

/** Replaces `var(--x)` until none is left. */
function resolve(value: string, vars: Vars, depth = 0): string {
  if (depth > 20) throw new Error(`Variables nest too deep in "${value}"`);
  const next = value.replace(/var\(--([a-z0-9-]+)\)/g, (_, name: string) => {
    const found = vars.get(name);
    if (found === undefined) throw new Error(`--${name} is not defined`);
    return found;
  });
  return next === value ? value : resolve(next, vars, depth + 1);
}

/** sRGB, gamma-encoded, each 0..1, with alpha. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const number = (text: string, percentOf = 1): number =>
  text.endsWith('%') ? (Number.parseFloat(text) / 100) * percentOf : Number.parseFloat(text);

function oklchToRgba(l: number, c: number, h: number, a: number): Rgba {
  const hue = (h * Math.PI) / 180;
  const A = c * Math.cos(hue);
  const B = c * Math.sin(hue);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const [r, g, b] = linear.map((value) => {
    const v = Math.min(1, Math.max(0, value));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
  return { r, g, b, a };
}

const OKLCH = /oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)/g;

function parseColor(text: string): Rgba {
  const value = text.trim();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const oklch = new RegExp(OKLCH.source).exec(value);
  if (oklch && oklch[0].length === value.length) {
    const [, l, c, h, alpha] = oklch as unknown as [string, string, string, string, string | undefined];
    return oklchToRgba(number(l), number(c, 0.4), Number.parseFloat(h), alpha ? number(alpha) : 1);
  }
  const mix = /^color-mix\(in (srgb|oklab), (.+) ([\d.]+)%, (.+)\)$/.exec(value);
  if (mix) {
    const [, space, first, percent, second] = mix as unknown as [string, string, string, string, string];
    const p = Number.parseFloat(percent) / 100;
    const one = parseColor(first);
    const two = parseColor(second);
    // Premultiplied, as CSS mixes: against transparent, the colour keeps its hue and takes the share
    // as its alpha. Both spaces agree there; in sRGB both operands are opaque in our theme.
    const alpha = one.a * p + two.a * (1 - p);
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
    if (space === 'oklab' && two.a === 0) return { ...one, a: one.a * p };
    const channel = (key: 'r' | 'g' | 'b') => (one[key] * one.a * p + two[key] * two.a * (1 - p)) / alpha;
    return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    const digits = hex[1] as string;
    const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
    const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) : 1 };
  }
  throw new Error(`Can't read the colour "${value}"`);
}

function format({ r, g, b, a }: Rgba): string {
  const byte = (v: number) => Math.round(v * 255);
  if (a >= 1) return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${Number(a.toFixed(3))})`;
}

const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/** Ramps (gray-3, blue-600…) are what roles are made of; the app names roles only. */
const RAMP = /^(background-\d|gray-\d+|(red|orange|amber|green|cyan|blue|purple|pink)-\d+|fill-tint)$/;
const SHADOW = /^elevation-/;
const TONE_PART =
  /^badge-(neutral|green|red|amber|blue|purple|orange|cyan|pink)-(strong|subtle|edge|indicator|foreground)$/;

interface Theme {
  colors: Record<string, string>;
  tones: Record<string, Record<string, string>>;
  shadows: Record<string, string>;
}

function theme(vars: Vars): Theme {
  const colors: Record<string, string> = {};
  const tones: Record<string, Record<string, string>> = {};
  const shadows: Record<string, string> = {};
  for (const [name, raw] of vars) {
    if (RAMP.test(name) || name === 'color-scheme') continue;
    const value = resolve(raw, vars);
    if (SHADOW.test(name)) {
      shadows[camel(name.replace(SHADOW, ''))] = value.replace(new RegExp(OKLCH.source, 'g'), (color) =>
        format(parseColor(color)),
      );
      continue;
    }
    const tone = TONE_PART.exec(name);
    if (tone) {
      const [, hue, part] = tone as unknown as [string, string, string];
      tones[hue] ??= {};
      (tones[hue] as Record<string, string>)[part] = format(parseColor(value));
      continue;
    }
    colors[camel(name)] = format(parseColor(value));
  }
  return { colors, tones, shadows };
}

/** The generated module's source, for `theme.css`'s text. */
export function generateTokens(css: string): string {
  const dark = declarations(css, ':root');
  const light = new Map([...dark, ...declarations(css, 'html.light')]);
  const themes = { dark: theme(dark), light: theme(light) };
  return [
    '// Generated by scripts/tokens.mts from apps/web/src/styles/theme.css: run `pnpm --filter',
    "// @superagent/mobile tokens` after changing the theme. Don't edit by hand.",
    '',
    `export const themes = ${JSON.stringify(themes, null, 2)} as const;`,
    '',
    'export type ThemeName = keyof typeof themes;',
    'export type ColorRole = keyof (typeof themes)["dark"]["colors"];',
    '',
  ].join('\n');
}

const here = dirname(fileURLToPath(import.meta.url));
const THEME_CSS = join(here, '..', '..', 'web', 'src', 'styles', 'theme.css');
const OUTPUT = join(here, '..', 'src', 'ui', 'tokens.ts');

export function themeCss(): string {
  return readFileSync(THEME_CSS, 'utf8');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/tokens.mts')) {
  const source = generateTokens(themeCss());
  if (process.argv.includes('--check')) {
    if (readFileSync(OUTPUT, 'utf8') !== source) {
      console.error('src/ui/tokens.ts is out of date: run `pnpm --filter @superagent/mobile tokens`.');
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, source);
    console.log('wrote src/ui/tokens.ts');
  }
}
