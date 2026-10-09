import { errorMessage, type OrgLookup } from '@superagent/client';
import type { AttentionItem, Task } from '@superagent/shared';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { CircleCheck, Globe } from 'lucide-react-native';
import { type ReactNode, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useAttention, useBoard, useMessageTask, useOrg, useUpdateTask } from '../../api/queries';
import { useSignedIn } from '../../api/session';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { TextField } from '../../ui/field';
import { Screen } from '../../ui/screen';
import { Card, Section } from '../../ui/surface';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, toneColors, useTheme } from '../../ui/theme';
import { toast } from '../../ui/toast';
import { ApprovalCard } from '../tasks/approval-card';
import { DepartmentLabel, KINDS, RelativeTime } from '../tasks/bits';

type Kind = AttentionItem['kind'];

/** What blocks an agent first. */
const ORDER: readonly Kind[] = ['approval', 'question', 'problem', 'review', 'health'];
const GROUPS: Record<Kind, string> = {
  approval: 'Approvals',
  question: 'Questions',
  problem: 'Problems',
  review: 'Results to review',
  health: 'Setup',
};

/** An item, as it stood when acted on: a later one under the same id (a new question) still shows. */
const itemKey = (item: AttentionItem) => `${item.id}|${item.since}`;

interface ItemProps {
  item: AttentionItem;
  /** Its task, when the board has it: its lead names who you answer, its phase what you can do. */
  task: Task | undefined;
  org: OrgLookup;
  /** Its action went through: the inbox drops it before the list catches up. */
  onDone: () => void;
}

const openTask = (taskId: string) => router.push(`/tasks/${taskId}`);

const leadOf = (task: Task | undefined, org: OrgLookup) =>
  (task && org.agent(task.leadAgentId)) ?? (task ? org.department(task.departmentId)?.lead : undefined);

/** What needs you, each kind with its action, as in the web app's inbox. */
export function InboxScreen() {
  const styles = useStyles();
  const attention = useAttention();
  const board = useBoard();
  const org = useOrg();
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const tasks = useMemo(
    () =>
      new Map((board.data?.columns.flatMap((column) => column.tasks) ?? []).map((task) => [task.id, task])),
    [board.data],
  );
  const items = (attention.data ?? []).filter((item) => !done.has(itemKey(item)));

  return (
    <Screen
      edges={['top', 'left', 'right']}
      onRefresh={() => void attention.refetch()}
      refreshing={attention.isRefetching}
    >
      <View style={styles.header}>
        <Text variant="display" accessibilityRole="header">
          Inbox
        </Text>
        <Text variant="bodySmall" color="mutedForeground">
          {attention.isSuccess
            ? items.length === 0
              ? 'Nothing needs you.'
              : `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you.`
            : ' '}
        </Text>
      </View>

      {attention.isPending ? (
        <View style={{ gap: space.md }}>
          <Skeleton style={styles.skeleton} />
          <Skeleton style={styles.skeleton} />
        </View>
      ) : attention.isError ? (
        <Notice
          tone="destructive"
          title="Couldn’t load what needs you"
          action={<Button title="Try again" size="sm" onPress={() => void attention.refetch()} />}
        >
          {errorMessage(attention.error)}
        </Notice>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={CircleCheck}
            title="You’re all caught up"
            description="Approvals, questions, problems and results to review show up here."
          />
        </Card>
      ) : (
        ORDER.map((kind) => {
          const group = items.filter((item) => item.kind === kind);
          if (group.length === 0) return null;
          return (
            <Section key={kind} title={`${GROUPS[kind]} · ${group.length}`}>
              <View style={{ gap: space.md }}>
                {group.map((item) => (
                  <InboxItem
                    key={item.id}
                    item={item}
                    task={item.taskId ? tasks.get(item.taskId) : undefined}
                    org={org}
                    onDone={() => setDone((current) => new Set(current).add(itemKey(item)))}
                  />
                ))}
              </View>
            </Section>
          );
        })
      )}
    </Screen>
  );
}

function InboxItem(props: ItemProps) {
  const { item } = props;
  const taskId = item.taskId;
  switch (item.kind) {
    case 'approval':
      return <ApprovalCard item={item} onOpen={taskId ? () => openTask(taskId) : undefined} />;
    case 'question':
      return <QuestionItem {...props} />;
    case 'review':
      return <ReviewItem {...props} />;
    case 'problem':
      return <ProblemItem {...props} />;
    case 'health':
      return <HealthItem {...props} />;
  }
}

/** The card an item sits in: what it is and where it comes from (a tap opens its task), then the rest. */
function ItemCard({
  item,
  task,
  org,
  children,
}: Pick<ItemProps, 'item' | 'task' | 'org'> & { children?: ReactNode }) {
  const theme = useTheme();
  const styles = useStyles();
  const kind = KINDS[item.kind];
  const Icon = kind.icon;
  const department = item.departmentId ? org.department(item.departmentId) : undefined;
  const lead = leadOf(task, org);
  const taskId = item.taskId;
  return (
    <View style={styles.card} accessibilityLabel={`${kind.label}: ${item.title}`}>
      <Pressable
        accessibilityRole={taskId ? 'link' : undefined}
        accessibilityHint={taskId ? 'Opens the task' : undefined}
        disabled={!taskId}
        onPress={taskId ? () => openTask(taskId) : undefined}
        style={styles.head}
      >
        <Icon
          size={18}
          color={toneColors(theme, kind.tone).foreground}
          strokeWidth={2}
          style={{ marginTop: 1 }}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="label">{item.title}</Text>
          <View style={styles.meta}>
            {department ? <DepartmentLabel department={department} variant="meta" /> : null}
            {lead ? (
              <Text variant="meta" color="mutedForeground" numberOfLines={1}>
                {lead.name}
              </Text>
            ) : null}
            <RelativeTime iso={item.since} />
          </View>
        </View>
      </Pressable>
      {children}
    </View>
  );
}

/** A message to the task's lead: an answer, or the changes a result needs. */
function Reply({
  taskId,
  label,
  placeholder,
  sent,
  onDone,
  onCancel,
}: {
  taskId: string;
  label: string;
  placeholder: string;
  sent: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const styles = useStyles();
  const message = useMessageTask(taskId);
  const [text, setText] = useState('');
  const send = () => {
    const value = text.trim();
    if (!value || message.isPending) return;
    message.mutate(
      { message: value, mode: 'steer' },
      {
        onSuccess: (task) => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          toast.success(sent, `#${task.number} ${task.title}`);
          onDone();
        },
      },
    );
  };
  return (
    <View style={{ gap: space.sm }}>
      <TextField
        label={label}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        maxLength={20_000}
        multiline
        autoFocus={Boolean(onCancel)}
      />
      <View style={styles.buttons}>
        {onCancel ? <Button title="Cancel" variant="ghost" onPress={onCancel} /> : null}
        <Button
          title="Send"
          variant="primary"
          busy={message.isPending}
          disabled={!text.trim()}
          onPress={send}
        />
      </View>
    </View>
  );
}

/** A lead's question: what it asked, and your answer, which sends the task back to it. */
function QuestionItem({ item, task, org, onDone }: ItemProps) {
  const styles = useStyles();
  const lead = leadOf(task, org)?.name ?? 'the lead';
  return (
    <ItemCard item={item} task={task} org={org}>
      {item.detail ? (
        <View style={styles.quote}>
          <Text variant="bodySmall" selectable>
            {item.detail}
          </Text>
        </View>
      ) : null}
      {item.taskId ? (
        <Reply
          taskId={item.taskId}
          label={`Answer ${lead}`}
          placeholder="Your answer"
          sent={`Sent to ${lead}`}
          onDone={onDone}
        />
      ) : null}
    </ItemCard>
  );
}

/** A result to review: accept it, or say what to change, which goes back to the lead. */
function ReviewItem({ item, task, org, onDone }: ItemProps) {
  const styles = useStyles();
  const update = useUpdateTask(item.taskId ?? '');
  const [changing, setChanging] = useState(false);
  const lead = leadOf(task, org)?.name ?? 'the lead';
  // Still in review as far as the board knows (an item can outlive its task's review by a moment).
  const reviewable = Boolean(item.taskId) && (!task || task.phase === 'review');
  const accept = () =>
    update.mutate(
      { phase: 'done' },
      {
        onSuccess: (next) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success('Accepted', `#${next.number} ${next.title}`);
          onDone();
        },
      },
    );
  return (
    <ItemCard item={item} task={task} org={org}>
      {item.detail ? (
        <Text variant="bodySmall" numberOfLines={6}>
          {item.detail}
        </Text>
      ) : null}
      {changing && item.taskId ? (
        <Reply
          taskId={item.taskId}
          label={`What should ${lead} change?`}
          placeholder="What to change"
          sent={`Sent back to ${lead}`}
          onDone={onDone}
          onCancel={() => setChanging(false)}
        />
      ) : reviewable ? (
        <View style={styles.buttons}>
          <Button title="Ask for changes" variant="ghost" onPress={() => setChanging(true)} />
          <Button title="Accept" variant="primary" busy={update.isPending} onPress={accept} />
        </View>
      ) : null}
    </ItemCard>
  );
}

/** A task that failed or couldn't start: what happened, and its task to look into. */
function ProblemItem({ item, task, org }: ItemProps) {
  const styles = useStyles();
  const taskId = item.taskId;
  return (
    <ItemCard item={item} task={task} org={org}>
      {item.detail ? (
        <Text variant="bodySmall" numberOfLines={6}>
          {item.detail}
        </Text>
      ) : null}
      {taskId ? (
        <View style={styles.buttons}>
          <Button title="Open the task" onPress={() => openTask(taskId)} />
        </View>
      ) : null}
    </ItemCard>
  );
}

/** Something wrong with the setup: what to fix, which the web app does. */
function HealthItem({ item, task, org }: ItemProps) {
  const styles = useStyles();
  const { session } = useSignedIn();
  return (
    <ItemCard item={item} task={task} org={org}>
      {item.detail ? <Text variant="bodySmall">{item.detail}</Text> : null}
      <Text variant="caption" color="mutedForeground">
        Fixed in the web app’s settings.
      </Text>
      <View style={styles.buttons}>
        <Button
          title="Open the web app"
          icon={Globe}
          onPress={() => void WebBrowser.openBrowserAsync(session.server)}
        />
      </View>
    </ItemCard>
  );
}

const useStyles = makeStyles((theme) => ({
  header: { gap: space.xs },
  skeleton: { height: 120, borderRadius: radius.card },
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: theme.colors.card,
    boxShadow: `${theme.shadows.raised}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  head: { flexDirection: 'row', gap: space.md },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  quote: { borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: space.md },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, flexWrap: 'wrap' },
}));
