import type { LucideIcon } from 'lucide-react-native';
import { type ReactNode, useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import { Text } from './text';
import { makeStyles, radius, space, useTheme } from './theme';

export type NoticeTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

/** A boxed message: what went wrong, or what to know, with what to do about it. */
export function Notice({
  tone = 'neutral',
  title,
  children,
  action,
}: {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const theme = useTheme();
  const styles = useStyles();
  const colors =
    tone === 'neutral'
      ? { surface: theme.colors.fill, edge: theme.colors.border, ink: theme.colors.foreground }
      : {
          surface: theme.colors[`${tone}Subtle`],
          edge: theme.colors[`${tone}Edge`],
          ink: theme.colors[`${tone}Foreground`],
        };
  return (
    <View
      accessibilityRole={tone === 'destructive' ? 'alert' : undefined}
      style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.edge }]}
    >
      <Text variant="label" style={{ color: colors.ink }}>
        {title}
      </Text>
      {typeof children === 'string' ? (
        <Text variant="bodySmall" color="foreground">
          {children}
        </Text>
      ) : (
        children
      )}
      {action ? <View style={styles.noticeAction}>{action}</View> : null}
    </View>
  );
}

/** Nothing to show yet, said plainly, with a way forward when there is one. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      {Icon ? (
        <View style={styles.emptyIcon}>
          <Icon size={22} color={theme.colors.mutedForeground} strokeWidth={1.75} />
        </View>
      ) : null}
      <Text variant="label" center>
        {title}
      </Text>
      {description ? (
        <Text variant="bodySmall" color="mutedForeground" center>
          {description}
        </Text>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function Spinner({ label }: { label?: string }) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <View style={styles.spinner} accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'}>
      <ActivityIndicator color={theme.colors.mutedForeground} />
      {label ? (
        <Text variant="caption" color="mutedForeground">
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/** A placeholder in the shape of what's loading; it breathes unless the system asks for less motion. */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce || cancelled) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.6, duration: 800, useNativeDriver: true }),
        ]),
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [opacity]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ backgroundColor: theme.colors.fill, borderRadius: radius.md, opacity }, style]}
    />
  );
}

const useStyles = makeStyles((theme) => ({
  notice: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space.md,
    gap: space.xs,
  },
  noticeAction: { marginTop: space.sm, flexDirection: 'row', gap: space.sm },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxxl, paddingHorizontal: space.xl },
  emptyCompact: { paddingVertical: space.xl },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.fillSubtle,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
    marginBottom: space.xs,
  },
  emptyAction: { marginTop: space.sm },
  spinner: { alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl },
}));
