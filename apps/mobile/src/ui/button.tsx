import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import { Text } from './text';
import { control, makeStyles, radius, space, useTheme } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructive-ghost';

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  title: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  /** Working on it: a spinner, and no second press. */
  busy?: boolean;
  /** Stretch to the row's width. */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A pill, as on the web: the primary one in the inverse colour, the rest on the fill ladder. Pressed
 * states are the next rung up. Its label is its accessible name unless one is given.
 */
export function Button({
  title,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  busy = false,
  block = false,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const theme = useTheme();
  const styles = useStyles();
  const inactive = Boolean(disabled) || busy;
  const ink = {
    primary: theme.colors.background,
    secondary: theme.colors.foreground,
    ghost: theme.colors.foreground,
    destructive: theme.colors.fillDestructiveForeground,
    'destructive-ghost': theme.colors.destructiveForeground,
  }[variant];
  const fills = {
    primary: [theme.colors.fillInverse, theme.colors.fillInverseActive],
    secondary: [theme.colors.fill, theme.colors.fillActive],
    ghost: ['transparent', theme.colors.fillHover],
    destructive: [theme.colors.fillDestructive, theme.colors.fillDestructiveActive],
    'destructive-ghost': ['transparent', theme.colors.fillHover],
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      hitSlop={size === 'sm' ? 6 : undefined}
      {...props}
      style={({ pressed }) => [
        styles.base,
        size === 'sm' ? styles.small : size === 'lg' ? styles.large : styles.medium,
        { backgroundColor: pressed ? fills[1] : fills[0] },
        variant === 'primary' && inactive && { backgroundColor: theme.colors.fillInverseDisabled },
        inactive && variant !== 'primary' && styles.inactive,
        block && styles.block,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={ink} />
      ) : Icon ? (
        <Icon size={size === 'sm' ? 16 : 18} color={ink} strokeWidth={2} />
      ) : null}
      <Text
        variant={size === 'sm' ? 'caption' : 'label'}
        style={[styles.label, { color: ink }]}
        numberOfLines={1}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/** A round icon-only button, named for screen readers. */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  tint,
  children,
}: {
  icon: LucideIcon;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  tint?: string;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.icon, pressed && { backgroundColor: theme.colors.fillActive }]}
    >
      <Icon size={20} color={tint ?? theme.colors.foreground} strokeWidth={2} />
      {children ? <View style={styles.iconBadge}>{children}</View> : null}
    </Pressable>
  );
}

const useStyles = makeStyles(() => ({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  small: { minHeight: control.sm, paddingHorizontal: space.md },
  medium: { minHeight: control.md, paddingHorizontal: space.lg },
  large: { minHeight: control.lg, paddingHorizontal: space.xl },
  block: { alignSelf: 'stretch' },
  inactive: { opacity: 0.45 },
  label: { flexShrink: 1 },
  icon: {
    width: control.md,
    height: control.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadge: { position: 'absolute', top: 6, right: 6 },
}));
