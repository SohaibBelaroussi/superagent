import { Pressable, View } from 'react-native';
import { Text } from './text';
import { control, makeStyles, radius, space, useTheme } from './theme';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** One choice of a few, side by side: a task's sections, a priority. Announced as tabs. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={styles.track}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.selected,
              pressed && !selected && { backgroundColor: theme.colors.fillHover },
            ]}
          >
            <Text variant="label" color={selected ? 'foreground' : 'mutedForeground'} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  track: {
    flexDirection: 'row',
    gap: 2,
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: theme.colors.fillSubtle,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  segment: {
    flex: 1,
    minHeight: control.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  selected: {
    backgroundColor: theme.colors.card,
    boxShadow: `${theme.shadows.raised}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
}));
