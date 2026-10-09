import type { Tone } from '@superagent/client';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import { Text } from './text';
import { makeStyles, radius, space, toneColors, useTheme } from './theme';

/** A small tinted label: phases, priorities, kinds. Hue only where it means something. */
export function Badge({
  tone = 'neutral',
  label,
  dot = false,
  live = false,
}: {
  tone?: Tone;
  label: string;
  dot?: boolean;
  /** Work is happening now: the dot pulses. */
  live?: boolean;
}) {
  const theme = useTheme();
  const styles = useStyles();
  const colors = toneColors(theme, tone);
  return (
    <View style={[styles.badge, { backgroundColor: colors.subtle }]}>
      {dot ? <StatusDot tone={tone} live={live} /> : null}
      <Text variant="meta" style={{ color: colors.foreground }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** A tone's dot; a live one pulses, unless the system asks for less motion. */
export function StatusDot({
  tone = 'neutral',
  live = false,
  size = 7,
}: {
  tone?: Tone;
  live?: boolean;
  size?: number;
}) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!live) return;
    let loop: Animated.CompositeAnimation | undefined;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce || cancelled) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        ]),
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
      opacity.setValue(1);
    };
  }, [live, opacity]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: toneColors(theme, tone).indicator,
        opacity,
      }}
    />
  );
}

/** A count on a dot of colour: the inbox's on its tab. */
export function CountBadge({ count, tone = 'orange' }: { count: number; tone?: Tone }) {
  const theme = useTheme();
  const styles = useStyles();
  if (count <= 0) return null;
  return (
    <View style={[styles.count, { backgroundColor: toneColors(theme, tone).indicator }]}>
      <Text variant="meta" numeric style={{ color: theme.colors.background }}>
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}

const useStyles = makeStyles(() => ({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 1,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  count: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
