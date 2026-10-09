import {
  attentionByTask,
  BOARD_COLUMNS,
  CLOSED_PHASES,
  departmentTone,
  errorMessage,
  PHASES,
  PRIORITIES,
} from '@superagent/client';
import type { Task, TaskPhase } from '@superagent/shared';
import { router } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAttention, useBoard, useOrg } from '../../api/queries';
import { IconButton } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, toneColors, useTheme } from '../../ui/theme';
import { PhaseIcon } from '../tasks/bits';
import { TaskCard } from '../tasks/task-card';

/** A page of the board: one of the board's columns, or the closed tasks (failed and cancelled). */
type Page = { key: TaskPhase | 'closed'; label: string; tasks: Task[] };

/**
 * The board, one phase at a time (side-by-side columns don't fit a phone): a strip of phases with
 * their counts, a swipe or a tap between them, and a filter by department.
 */
export function BoardScreen() {
  const theme = useTheme();
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const [departmentId, setDepartmentId] = useState<string | undefined>(undefined);
  const board = useBoard(departmentId);
  const attention = useAttention();
  const org = useOrg();
  const pager = useRef<FlatList<Page>>(null);
  const strip = useRef<ScrollView>(null);
  const [index, setIndex] = useState<number | null>(null);
  /** Where each phase's chip starts in the strip, to bring the selected one into view. */
  const chipAt = useRef(new Map<number, number>());

  const pages = useMemo<Page[]>(() => {
    const byPhase = new Map((board.data?.columns ?? []).map((column) => [column.phase, column.tasks]));
    const order = (tasks: Task[]) =>
      [...tasks].sort(
        (a, b) =>
          PRIORITIES[a.priority].rank - PRIORITIES[b.priority].rank ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
    const columns: Page[] = BOARD_COLUMNS.map((phase) => ({
      key: phase,
      label: PHASES[phase].label,
      tasks: order(byPhase.get(phase) ?? []),
    }));
    const closed = CLOSED_PHASES.flatMap((phase) => byPhase.get(phase) ?? []);
    if (closed.length) columns.push({ key: 'closed', label: 'Closed', tasks: order(closed) });
    return columns;
  }, [board.data]);

  // Open on what needs you, else on what's moving, else on the first phase with anything in it.
  const initial = useMemo(() => {
    const at = (key: Page['key']) => pages.findIndex((page) => page.key === key && page.tasks.length > 0);
    const found = [
      at('waiting'),
      at('working'),
      at('review'),
      pages.findIndex((page) => page.tasks.length),
    ].find((value) => value >= 0);
    return found ?? 0;
  }, [pages]);
  const selected = Math.min(index ?? initial, pages.length - 1);
  const attentionFor = useMemo(() => attentionByTask(attention.data), [attention.data]);

  useEffect(() => {
    const x = chipAt.current.get(selected);
    if (x !== undefined) strip.current?.scrollTo({ x: Math.max(0, x - space.lg), animated: true });
  }, [selected]);

  const go = (next: number) => {
    setIndex(next);
    pager.current?.scrollToIndex({ index: next, animated: true });
  };
  const onSwipe = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    if (next !== selected) setIndex(next);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.screen}>
      <View style={styles.header}>
        <Text variant="display" accessibilityRole="header">
          Board
        </Text>
        <IconButton icon={Plus} label="New task" onPress={() => router.push('/new-task')} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        testID="board-departments"
      >
        <Chip label="All" selected={departmentId === undefined} onPress={() => setDepartmentId(undefined)} />
        {org.departments.map((department) => (
          <Chip
            key={department.id}
            label={department.name}
            dot={toneColors(theme, departmentTone(department.slug)).indicator}
            selected={departmentId === department.id}
            onPress={() => setDepartmentId(department.id)}
          />
        ))}
      </ScrollView>

      <ScrollView
        ref={strip}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.phases}
      >
        <View accessibilityRole="tablist" accessibilityLabel="Phases" style={styles.phaseRow}>
          {pages.map((page, pageIndex) => {
            const active = pageIndex === selected;
            return (
              <Pressable
                key={page.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={board.isSuccess ? `${page.label}, ${page.tasks.length}` : page.label}
                onPress={() => go(pageIndex)}
                onLayout={(event) => {
                  const { x } = event.nativeEvent.layout;
                  chipAt.current.set(pageIndex, x);
                  // The selected phase's place is known only now when the board first draws.
                  if (pageIndex === selected)
                    strip.current?.scrollTo({ x: Math.max(0, x - space.lg), animated: false });
                }}
                style={[styles.phase, active && styles.phaseActive]}
              >
                {page.key === 'closed' ? null : <PhaseIcon phase={page.key} size={15} />}
                <Text variant="label" color={active ? 'foreground' : 'mutedForeground'}>
                  {page.label}
                </Text>
                <Text variant="meta" color="mutedForeground" numeric>
                  {board.isSuccess ? page.tasks.length : '–'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {board.isError ? (
        <View style={styles.padded}>
          <Notice tone="destructive" title="Couldn’t load the board">
            {errorMessage(board.error)}
          </Notice>
        </View>
      ) : board.isPending ? (
        <View style={[styles.padded, { gap: space.md }]}>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} style={{ height: 112, borderRadius: radius.card }} />
          ))}
        </View>
      ) : (
        <FlatList
          ref={pager}
          data={pages}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={selected}
          getItemLayout={(_, itemIndex) => ({ length: width, offset: width * itemIndex, index: itemIndex })}
          onMomentumScrollEnd={onSwipe}
          keyExtractor={(page) => page.key}
          renderItem={({ item: page }) => (
            <FlatList
              style={{ width }}
              data={page.tasks}
              keyExtractor={(task) => task.id}
              contentContainerStyle={styles.column}
              refreshControl={
                <RefreshControl
                  refreshing={board.isRefetching}
                  onRefresh={() => {
                    void board.refetch();
                    void attention.refetch();
                  }}
                  tintColor={theme.colors.mutedForeground}
                  colors={[theme.colors.foreground]}
                  progressBackgroundColor={theme.colors.card}
                />
              }
              ListEmptyComponent={
                <EmptyState
                  title={`Nothing in ${page.label}`}
                  description={
                    page.key === 'closed' ? 'Failed and cancelled tasks.' : PHASES[page.key].description
                  }
                />
              }
              renderItem={({ item: task }) => (
                <TaskCard
                  task={task}
                  department={org.department(task.departmentId)}
                  lead={org.agent(task.leadAgentId)}
                  attention={attentionFor.get(task.id)}
                  showPhase={page.key === 'closed'}
                  showDepartment={departmentId === undefined}
                />
              )}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function Chip({
  label,
  selected,
  dot,
  onPress,
}: {
  label: string;
  selected: boolean;
  dot?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}${selected ? ', shown' : ''}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && { backgroundColor: theme.colors.fillInverse },
        pressed && !selected && { backgroundColor: theme.colors.fillActive },
      ]}
    >
      {dot ? <View style={[styles.chipDot, { backgroundColor: dot }]} /> : null}
      <Text variant="caption" style={{ color: selected ? theme.colors.background : theme.colors.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  chips: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: 34,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: theme.colors.fill,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  phases: { paddingHorizontal: space.md, paddingBottom: space.sm },
  phaseRow: { flexDirection: 'row', gap: space.xs },
  phase: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  phaseActive: { backgroundColor: theme.colors.fill, boxShadow: `inset 0 0 0 1px ${theme.colors.border}` },
  padded: { padding: space.lg },
  column: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl * 2 },
}));
