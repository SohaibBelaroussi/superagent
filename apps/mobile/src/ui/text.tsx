import type { Tone } from '@superagent/client';
import { Text as NativeText, type TextProps as NativeTextProps } from 'react-native';
import { MAX_FONT_SCALE, type TypeRole, toneColors, type, useTheme } from './theme';
import type { ColorRole } from './tokens';

export interface TextProps extends NativeTextProps {
  /** The type role: size, weight and line height. */
  variant?: TypeRole;
  /** A colour role (`foreground`, `mutedForeground`…), or a tone's ink. */
  color?: ColorRole;
  tone?: Tone;
  /** Digits that line up (counts, costs, times). */
  numeric?: boolean;
  /** Centre the text. */
  center?: boolean;
}

/** Text in one of the type roles, in a colour role. It follows the system's text size, up to a cap. */
export function Text({
  variant = 'body',
  color = 'foreground',
  tone,
  numeric,
  center,
  style,
  ...props
}: TextProps) {
  const theme = useTheme();
  const ink = tone ? toneColors(theme, tone).foreground : theme.colors[color];
  return (
    <NativeText
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      {...props}
      style={[
        type[variant],
        { color: ink },
        numeric && { fontVariant: ['tabular-nums'] },
        center && { textAlign: 'center' },
        style,
      ]}
    />
  );
}
