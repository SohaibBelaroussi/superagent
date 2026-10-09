import type { ReactNode } from 'react';
import { Pressable, type StyleProp, View, type ViewStyle } from 'react-native';
import { Text } from './text';
import { makeStyles, radius, space, useTheme } from './theme';

/**
 * A raised surface: one step lighter than the screen, drawn with the web's 1px inset rim and short
 * shadow rather than a border. Pressable when it has an `onPress`.
 */
export function Card({
  children,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const styles = useStyles();
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: theme.colors.surfacePanel }, style]}
    >
      {children}
    </Pressable>
  );
}

/** A titled group on a screen ("Needs you", "In progress"), its title a heading for screen readers. */
export function Section({
  title,
  action,
  children,
  style,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.section, style]}>
      <View style={styles.sectionHeader}>
        <Text variant="eyebrow" color="mutedForeground" accessibilityRole="header">
          {title.toUpperCase()}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.sm,
    boxShadow: `${theme.shadows.raised}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  section: { gap: space.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
    minHeight: 24,
  },
}));
