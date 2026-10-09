import type { Tone } from '@superagent/client';
import { View } from 'react-native';
import { Text } from './text';
import { toneColors, useTheme } from './theme';

const SIZES = { sm: 20, md: 32, lg: 48 } as const;

/** Who's speaking: their initial on their department's colour (the chief's is neutral). */
export function Avatar({
  name,
  tone = 'neutral',
  size = 'sm',
}: {
  name: string;
  tone?: Tone;
  size?: keyof typeof SIZES;
}) {
  const theme = useTheme();
  const colors = toneColors(theme, tone);
  const side = SIZES[size];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: side,
        height: side,
        borderRadius: side / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tone === 'neutral' ? theme.colors.fillStrong : colors.subtle,
      }}
    >
      <Text
        variant={size === 'lg' ? 'heading' : size === 'md' ? 'label' : 'meta'}
        tone={tone === 'neutral' ? undefined : tone}
      >
        {name.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
}
