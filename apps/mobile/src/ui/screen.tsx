import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, type StyleProp, View, type ViewStyle } from 'react-native';
import { type Edge, SafeAreaView } from 'react-native-safe-area-context';
import { makeStyles, space, useTheme } from './theme';

/**
 * A screen's body: the theme's background, the safe area's edges, and (when scrolling) a pull to
 * refresh. Headers come from the navigator; tabs keep the bottom edge themselves.
 */
export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  edges = ['left', 'right'],
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <SafeAreaView edges={edges} style={styles.screen}>
      {scroll ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.content, contentStyle]}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={Boolean(refreshing)}
                onRefresh={onRefresh}
                tintColor={theme.colors.mutedForeground}
                colors={[theme.colors.foreground]}
                progressBackgroundColor={theme.colors.card}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const useStyles = makeStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: space.lg, gap: space.xxl, paddingBottom: space.xxxl * 2 },
  fill: { flex: 1 },
}));
