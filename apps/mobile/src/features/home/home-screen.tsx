import {
  errorMessage,
  formatCost,
  formatTokens,
  type OrgLookup,
  PRIORITIES,
  plural,
  profileQuery,
  taskProgress,
  usageQuery,
} from '@superagent/client';
import type { AttentionItem, Task, TaskPhase } from '@superagent/shared';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { CircleCheck, Plus, Settings } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useAttention, useBoard, useOrg } from '../../api/queries';
import { Button, IconButton } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Screen } from '../../ui/screen';
import { Card, Section } from '../../ui/surface';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, toneColors, useTheme } from '../../ui/theme';
import { QuickAsk } from '../conversations/quick-ask';
import { DepartmentLabel, KINDS, PhaseIcon, ProgressBar, RelativeTime } from '../tasks/bits';

/** With a lead now: sent, being worked on, or waiting for you. The inbox hasn't started yet. */
const IN_PROGRESS = new Set<TaskPhase>(['queued', 'working', 'waiting']);

function greeting(hour: number): string {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Local midnight six days ago: the start of "this week", stable for the whole day. */
function weekStart(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 6);
  return date.toISOString();
}

/** Home: what needs you, what's in progress, what finished; the same as the web app's home page. */
export function HomeScreen() {
  const styles = useStyles();
  const org = useOrg();
  const attention = useAttention();
  const board = useBoard();
  const profile = useQuery(profileQuery());
  const [from] = useState(weekStart);
  const usage = useQuery(usageQuery('day', from));

  const tasks = useMemo(() => board.data?.columns.flatMap((column) => column.tasks) ?? [], [board.data]);
  const running = tasks
    .filter((task) => IN_PROGRESS.has(task.phase))
    .sort(
      (a, b) =>
        PRIORITIES[a.priority].rank - PRIORITIES[b.priority].rank ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  const finished = tasks
    .filter((task) => task.phase === 'review' || task.closedAt)
    .sort((a, b) => Date.parse(b.closedAt ?? b.updatedAt) - Date.parse(a.closedAt ?? a.updatedAt))
    .slice(0, 6);
  const doneThisWeek = tasks.filter((task) => task.phase === 'done').length;
  const needs = attention.data ?? [];
  const name = profile.data?.name?.trim().split(/\s+/)[0];
  const today = new Date();
  const summary = [
    needs.length ? plural(needs.length, 'thing needs you', 'things need you') : 'Nothing needs you',
    running.length ? `${plural(running.length, 'task')} in progress` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const refresh = () => {
    void attention.refetch();
    void board.refetch();
    void usage.refetch();
  };

  return (
    <Screen
      edges={['top', 'left', 'right']}
      onRefresh={refresh}
      refreshing={attention.isRefetching || board.isRefetching}
    >
      <View style={styles.header}>
        <View style={styles.topRow}>
          <Text variant="caption" color="mutedForeground">
            {today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
          <IconButton icon={Settings} label="Settings" onPress={() => router.push('/settings')} />
        </View>
        <Text variant="display" accessibilityRole="header">
          {greeting(today.getHours())}
          {name ? `, ${name}` : ''}
        </Text>
        <Text variant="bodySmall" color="mutedForeground">
          {attention.isSuccess && board.isSuccess ? summary : ' '}
        </Text>
        <Button
          title="New task"
          variant="primary"
          icon={Plus}
          onPress={() => router.push('/new-task')}
          style={styles.newTask}
        />
        <QuickAsk />
      </View>

      <View style={styles.stats}>
        <Stat label="Need you" value={attention.isSuccess ? String(needs.length) : null} />
        <Stat label="In progress" value={board.isSuccess ? String(running.length) : null} />
        <Stat label="Done this week" value={board.isSuccess ? String(doneThisWeek) : null} />
        <Stat
          label="Spent this week"
          value={usage.isSuccess ? formatCost(usage.data.total.costUsd) : null}
          hint={usage.isSuccess ? `${formatTokens(usage.data.total.totalTokens)} tokens` : undefined}
        />
      </View>

      <Section title="Needs you">
        {attention.isPending ? (
          <RowsSkeleton />
        ) : attention.isError ? (
          <Notice tone="destructive" title="Couldn’t load what needs you">
            {errorMessage(attention.error)}
          </Notice>
        ) : needs.length === 0 ? (
          <Card>
            <EmptyState
              compact
              icon={CircleCheck}
              title="You’re all caught up"
              description="Approvals, questions and results to review show up here."
            />
          </Card>
        ) : (
          <View style={styles.rows}>
            {needs.slice(0, 8).map((item) => (
              <AttentionRow key={item.id} item={item} org={org} />
            ))}
          </View>
        )}
      </Section>

      <Section title="In progress">
        {board.isPending ? (
          <RowsSkeleton />
        ) : board.isError ? (
          <Notice tone="destructive" title="Couldn’t load the board">
            {errorMessage(board.error)}
          </Notice>
        ) : running.length === 0 ? (
          <Card>
            <EmptyState
              compact
              title="Nothing in progress"
              description="Tasks your departments are working on show up here."
            />
          </Card>
        ) : (
          <View style={styles.rows}>
            {running.slice(0, 8).map((task) => (
              <TaskRow key={task.id} task={task} org={org} />
            ))}
          </View>
        )}
      </Section>

      {finished.length > 0 ? (
        <Section title="Recently finished">
          <View style={styles.rows}>
            {finished.map((task) => (
              <TaskRow key={task.id} task={task} org={org} />
            ))}
          </View>
        </Section>
      ) : null}
    </Screen>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stat} accessible accessibilityLabel={value === null ? label : `${label}: ${value}`}>
      <Text variant="caption" color="mutedForeground">
        {label}
      </Text>
      {value === null ? (
        <Skeleton style={styles.statSkeleton} />
      ) : (
        <Text variant="title" numeric>
          {value}
        </Text>
      )}
      {hint ? (
        <Text variant="meta" color="mutedForeground">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function AttentionRow({ item, org }: { item: AttentionItem; org: OrgLookup }) {
  const theme = useTheme();
  const styles = useStyles();
  const kind = KINDS[item.kind];
  const Icon = kind.icon;
  const department = item.departmentId ? org.department(item.departmentId) : undefined;
  const taskId = item.taskId;
  const body = (
    <>
      <Icon size={18} color={toneColors(theme, kind.tone).foreground} strokeWidth={2} />
      <View style={styles.rowText}>
        <Text variant="label" numberOfLines={2}>
          {item.title}
        </Text>
        {item.detail ? (
          <Text variant="caption" color="mutedForeground" numberOfLines={1}>
            {item.detail}
          </Text>
        ) : null}
        <View style={styles.rowMeta}>
          {department ? <DepartmentLabel department={department} variant="meta" /> : null}
          <RelativeTime iso={item.since} />
        </View>
      </View>
    </>
  );
  return taskId ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kind.label}: ${item.title}`}
      onPress={() => router.push(`/tasks/${taskId}`)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePanel }]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={styles.row}>{body}</View>
  );
}

function TaskRow({ task, org }: { task: Task; org: OrgLookup }) {
  const theme = useTheme();
  const styles = useStyles();
  const progress = task.closedAt ? null : taskProgress(task);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Task ${task.number}: ${task.title}`}
      onPress={() => router.push(`/tasks/${task.id}`)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePanel }]}
    >
      <PhaseIcon phase={task.phase} />
      <View style={styles.rowText}>
        <Text variant="label" numberOfLines={2}>
          <Text variant="label" color="placeholder" numeric>
            #{task.number}{' '}
          </Text>
          {task.title}
        </Text>
        {progress ? (
          <View style={styles.progress}>
            <ProgressBar percent={progress.percent} />
          </View>
        ) : null}
        <View style={styles.rowMeta}>
          <DepartmentLabel department={org.department(task.departmentId)} variant="meta" />
          <RelativeTime iso={task.closedAt ?? task.updatedAt} />
        </View>
      </View>
    </Pressable>
  );
}

function RowsSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.rows}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={styles.row}>
          <Skeleton style={{ width: 18, height: 18, borderRadius: 9 }} />
          <View style={styles.rowText}>
            <Skeleton style={{ height: 14, width: '70%' }} />
            <Skeleton style={{ height: 10, width: '40%' }} />
          </View>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  header: { gap: space.xs },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  newTask: { marginTop: space.md },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  stat: {
    flexBasis: '47%',
    flexGrow: 1,
    gap: 2,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: theme.colors.card,
    boxShadow: `${theme.shadows.raised}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  statSkeleton: { height: 26, width: 48, marginVertical: 2 },
  rows: {
    borderRadius: radius.card,
    backgroundColor: theme.colors.card,
    overflow: 'hidden',
    boxShadow: `${theme.shadows.raised}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    alignItems: 'flex-start',
    minHeight: 52,
  },
  rowText: { flex: 1, gap: 3 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  progress: { flexDirection: 'row', marginVertical: 2, maxWidth: 200 },
}));
