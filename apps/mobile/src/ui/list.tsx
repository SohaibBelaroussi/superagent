import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from './text';
import { makeStyles, radius, space, useTheme } from './theme';

/** A group of rows on one surface, divided by hairlines (settings, a task's checklist). */
export function List({ children, label }: { children: ReactNode; label?: string }) {
  const styles = useStyles();
  return (
    <View accessibilityRole="list" accessibilityLabel={label} style={styles.list}>
      {children}
    </View>
  );
}

/** A row: a title, what it says under it, and what's at its end. Pressable when it goes somewhere. */
export function ListRow({
  title,
  subtitle,
  icon: Icon,
  end,
  onPress,
  chevron = Boolean(onPress),
  destructive = false,
  last = false,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  end?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  /** No hairline under it. */
  last?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = useStyles();
  const content = (
    <>
      {Icon ? (
        <Icon
          size={20}
          color={destructive ? theme.colors.destructiveForeground : theme.colors.mutedForeground}
          strokeWidth={1.75}
        />
      ) : null}
      <View style={styles.text}>
        <Text variant="label" color={destructive ? 'destructiveForeground' : 'foreground'} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="mutedForeground" numberOfLines={3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {end}
      {chevron ? <ChevronRight size={18} color={theme.colors.placeholder} /> : null}
    </>
  );
  return (
    <View accessibilityRole={onPress ? undefined : 'text'} style={[styles.rowWrap, !last && styles.divider]}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={onPress}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.fillHover }]}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.row}>{content}</View>
      )}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  list: {
    backgroundColor: theme.colors.card,
    borderRadius: radius.card,
    overflow: 'hidden',
    boxShadow: `${theme.shadows.raised}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  rowWrap: {},
  divider: { borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  text: { flex: 1, gap: 2 },
}));
