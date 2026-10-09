import {
  condenseEvents,
  describeEvent,
  errorMessage,
  formatDate,
  type OrgLookup,
  PHASES,
} from '@superagent/client';
import type { Artifact, Task } from '@superagent/shared';
import { canTransition } from '@superagent/shared/phases';
import * as Haptics from 'expo-haptics';
import { Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Check, CircleSlash, ExternalLink, RotateCcw, Send, Square, SquareCheck } from 'lucide-react-native';
import { type RefObject, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useAttention,
  useCancelTask,
  useMessageTask,
  useOrg,
  useTask,
  useTaskArtifacts,
  useTaskEvents,
  useUpdateTask,
} from '../../api/queries';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';
import { TextField } from '../../ui/field';
import { AvoidKeyboard } from '../../ui/keyboard';
import { Markdown, safeUrl } from '../../ui/markdown';
import { Segmented } from '../../ui/segmented';
import { Card, Section } from '../../ui/surface';
import { Text } from '../../ui/text';
import { MAX_FONT_SCALE, makeStyles, radius, space, toneColors, type, useTheme } from '../../ui/theme';
import { toast } from '../../ui/toast';
import { TaskTranscript } from '../conversations/task-transcript';
import { ApprovalCard } from './approval-card';
import {
  DepartmentLabel,
  EVENT_ICONS,
  PhaseBadge,
  PriorityBadge,
  ProgressBar,
  RelativeTime,
  usageLine,
} from './bits';

type TaskView = 'overview' | 'activity' | 'transcript';

/** A task: what it is and where it stands, what it waits for, and a line to its lead. */
export function TaskScreen({ id }: { id: string }) {
  const task = useTask(id);
  const styles = useStyles();
  if (task.isPending) {
    return (
      <SafeAreaView edges={['left', 'right']} style={styles.screen}>
        <Stack.Screen options={{ title: '' }} />
        <View style={{ padding: space.lg, gap: space.md }}>
          <Skeleton style={{ height: 28, width: '80%' }} />
          <Skeleton style={{ height: 18, width: '50%' }} />
          <Skeleton style={{ height: 160, borderRadius: radius.card }} />
        </View>
      </SafeAreaView>
    );
  }
  if (task.isError) {
    return (
      <SafeAreaView edges={['left', 'right']} style={styles.screen}>
        <Stack.Screen options={{ title: 'Task' }} />
        <View style={{ padding: space.lg }}>
          <Notice
            tone="destructive"
            title="Couldn’t load the task"
            action={<Button title="Try again" size="sm" onPress={() => void task.refetch()} />}
          >
            {errorMessage(task.error)}
          </Notice>
        </View>
      </SafeAreaView>
    );
  }
  return <TaskBody task={task.data} />;
}

function TaskBody({ task }: { task: Task }) {
  const styles = useStyles();
  const org = useOrg();
  const attention = useAttention();
  const update = useUpdateTask(task.id);
  const [view, setView] = useState<TaskView>('overview');
  const composer = useRef<TextInput>(null);
  const department = org.department(task.departmentId);
  const lead = org.agent(task.leadAgentId);
  const items = useMemo(
    () => (attention.data ?? []).filter((item) => item.taskId === task.id),
    [attention.data, task.id],
  );
  const approvals = items.filter((item) => item.kind === 'approval');
  const other = items.find((item) => item.kind === 'question' || item.kind === 'problem');
  const canAccept = canTransition('owner', task.phase, 'done');
  const canQueue = canTransition('owner', task.phase, 'queued') && Boolean(department?.lead);
  const canCancel = canTransition('owner', task.phase, 'cancelled');
  const usage = usageLine(task.usage);
  const progress = task.progress;

  const move = (phase: 'done' | 'queued', message: string) =>
    update.mutate(
      { phase },
      {
        onSuccess: (next) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(message, `#${next.number} ${next.title}`);
        },
      },
    );

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      <Stack.Screen options={{ title: `#${task.number}` }} />
      <AvoidKeyboard style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={{ gap: space.sm }}>
            <View style={styles.metaRow}>
              <DepartmentLabel department={department} />
              {lead ? (
                <>
                  <Text variant="caption" color="placeholder" accessibilityElementsHidden>
                    ·
                  </Text>
                  <Text variant="caption" color="mutedForeground" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {lead.name}
                  </Text>
                </>
              ) : null}
            </View>
            <Text variant="title" accessibilityRole="header" selectable>
              {task.title}
            </Text>
            <View style={styles.badges}>
              <PhaseBadge phase={task.phase} />
              <PriorityBadge priority={task.priority} />
              {task.source !== 'owner' ? (
                <Text variant="meta" color="mutedForeground">
                  {task.source === 'schedule' ? 'From a schedule' : 'From your chief of staff'}
                </Text>
              ) : null}
              {task.dueAt ? (
                <Text variant="meta" color="mutedForeground">
                  Due {formatDate(task.dueAt)}
                </Text>
              ) : null}
            </View>
            {progress !== null && !task.closedAt ? (
              <View style={styles.metaRow}>
                <ProgressBar percent={progress} />
                <Text variant="meta" color="mutedForeground" numeric>
                  {progress}%
                </Text>
              </View>
            ) : null}
            <Text variant="meta" color="placeholder">
              {PHASES[task.phase].description}
              {usage ? ` · ${usage}` : ''}
            </Text>
          </View>

          {approvals.map((item) => (
            <ApprovalCard key={item.id} item={item} />
          ))}
          {other ? (
            <Notice tone={other.kind === 'problem' ? 'destructive' : 'warning'} title={other.title}>
              {other.detail ?? undefined}
            </Notice>
          ) : null}

          <Actions
            task={task}
            canAccept={canAccept}
            canQueue={canQueue}
            busy={update.isPending}
            onAccept={() => move('done', 'Accepted')}
            onQueue={(message) => move('queued', message)}
            onRequestChanges={() => composer.current?.focus()}
          />

          <Segmented
            label="Task sections"
            value={view}
            onChange={setView}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'activity', label: 'Activity' },
              { value: 'transcript', label: 'Transcript' },
            ]}
          />
          {view === 'overview' ? (
            <Overview task={task} />
          ) : view === 'activity' ? (
            <Activity task={task} org={org} />
          ) : (
            <TaskTranscript task={task} org={org} />
          )}

          {canCancel ? <CancelTask task={task} /> : null}
        </ScrollView>
        {task.closedAt ? null : <Composer task={task} inputRef={composer} />}
      </AvoidKeyboard>
    </SafeAreaView>
  );
}

function Actions({
  task,
  canAccept,
  canQueue,
  busy,
  onAccept,
  onQueue,
  onRequestChanges,
}: {
  task: Task;
  canAccept: boolean;
  canQueue: boolean;
  busy: boolean;
  onAccept: () => void;
  onQueue: (message: string) => void;
  onRequestChanges: () => void;
}) {
  const styles = useStyles();
  if (task.phase === 'review' && canAccept) {
    return (
      <View style={styles.actions}>
        <Button title="Request changes" onPress={onRequestChanges} />
        <Button title="Accept" variant="primary" icon={Check} busy={busy} onPress={onAccept} />
      </View>
    );
  }
  if (task.phase === 'inbox' && canQueue) {
    return (
      <View style={styles.actions}>
        <Button
          title="Send to lead"
          variant="primary"
          icon={Send}
          busy={busy}
          onPress={() => onQueue('Sent to the lead')}
        />
      </View>
    );
  }
  if ((task.phase === 'done' || task.phase === 'failed') && canQueue) {
    return (
      <View style={styles.actions}>
        <Button
          title="Send back to lead"
          icon={RotateCcw}
          busy={busy}
          onPress={() => onQueue('Sent back to the lead')}
        />
      </View>
    );
  }
  return null;
}

function Overview({ task }: { task: Task }) {
  const theme = useTheme();
  const artifacts = useTaskArtifacts(task.id);
  return (
    <View style={{ gap: space.xxl }}>
      {task.result ? (
        <Section title="Report">
          <Card>
            <Markdown>{task.result}</Markdown>
          </Card>
        </Section>
      ) : null}
      <Section title="Brief">
        <Card>
          <Markdown>{task.brief}</Markdown>
        </Card>
      </Section>
      {task.checklist.length > 0 ? (
        <Section title="Checklist">
          <Card>
            {task.checklist.map((item, index) => (
              <View
                // The checklist comes whole with each update, in order: its places are its identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                key={index}
                accessible
                accessibilityLabel={`${item.done ? 'Done' : 'To do'}: ${item.text}`}
                style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}
              >
                {item.done ? (
                  <SquareCheck
                    size={18}
                    color={toneColors(theme, 'green').foreground}
                    style={{ marginTop: 2 }}
                  />
                ) : (
                  <Square size={18} color={theme.colors.mutedForeground} style={{ marginTop: 2 }} />
                )}
                <Text
                  variant="bodySmall"
                  color={item.done ? 'mutedForeground' : 'foreground'}
                  style={{ flex: 1 }}
                >
                  {item.text}
                </Text>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}
      {artifacts.data && artifacts.data.length > 0 ? (
        <Section title="Deliverables">
          <View style={{ gap: space.sm }}>
            {artifacts.data.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </View>
        </Section>
      ) : null}
    </View>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const url = artifact.kind === 'link' ? safeUrl(artifact.url) : null;
  if (artifact.kind === 'link') {
    return (
      <Card
        onPress={url ? () => void WebBrowser.openBrowserAsync(url) : undefined}
        accessibilityLabel={`${artifact.title}${url ? `, opens ${new URL(url).host}` : ''}`}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="label" style={{ flex: 1 }} numberOfLines={2}>
            {artifact.title}
          </Text>
          {url ? <ExternalLink size={16} color={theme.colors.mutedForeground} /> : null}
        </View>
        <Text variant="caption" color="mutedForeground" numberOfLines={1}>
          {artifact.url}
        </Text>
      </Card>
    );
  }
  return (
    <Card onPress={() => setOpen((value) => !value)} accessibilityHint={open ? 'Hides it' : 'Shows it'}>
      <Text variant="label">{artifact.title}</Text>
      {open && artifact.content ? <Markdown variant="bodySmall">{artifact.content}</Markdown> : null}
    </Card>
  );
}

function Activity({ task, org }: { task: Task; org: OrgLookup }) {
  const theme = useTheme();
  const styles = useStyles();
  const events = useTaskEvents(task.id);
  const shown = useMemo(() => condenseEvents(events.data ?? []).reverse(), [events.data]);
  if (events.isPending) return <Spinner />;
  if (events.isError) {
    return (
      <Notice tone="destructive" title="Couldn’t load the history">
        {errorMessage(events.error)}
      </Notice>
    );
  }
  if (shown.length === 0) return <EmptyState compact title="Nothing has happened yet" />;
  return (
    <View accessibilityRole="list" style={styles.timeline}>
      {shown.map((event) => {
        const described = describeEvent(event, org);
        const Icon = EVENT_ICONS[described.icon];
        return (
          <View key={event.seq} style={styles.event}>
            <Icon size={16} color={toneColors(theme, described.tone).foreground} style={{ marginTop: 2 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodySmall">{described.title}</Text>
              {described.detail ? (
                <Text variant="caption" color="mutedForeground" numberOfLines={6}>
                  {described.detail}
                </Text>
              ) : null}
              <RelativeTime iso={event.createdAt} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function CancelTask({ task }: { task: Task }) {
  const cancel = useCancelTask(task.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <Button
        title="Cancel task…"
        variant="destructive-ghost"
        icon={CircleSlash}
        onPress={() => setOpen(true)}
        style={{ alignSelf: 'center' }}
      />
    );
  }
  return (
    <Card>
      <Text variant="label">Cancel “{task.title}”?</Text>
      <Text variant="caption" color="mutedForeground">
        The lead stops, and what it was waiting for is declined.
      </Text>
      <TextField label="Reason" hint="Optional." value={reason} onChangeText={setReason} maxLength={1000} />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.xs }}>
        <Button title="Keep it" variant="ghost" onPress={() => setOpen(false)} />
        <Button
          title="Cancel task"
          variant="destructive"
          busy={cancel.isPending}
          onPress={() =>
            cancel.mutate(reason.trim() || undefined, {
              onSuccess: (next) => {
                setOpen(false);
                toast.success('Cancelled', `#${next.number} ${next.title}`);
              },
            })
          }
        />
      </View>
    </Card>
  );
}

/** A message to the task's lead: now (it joins the running turn), or after the current turn. */
function Composer({ task, inputRef }: { task: Task; inputRef: RefObject<TextInput | null> }) {
  const theme = useTheme();
  const styles = useStyles();
  const message = useMessageTask(task.id);
  const [text, setText] = useState('');
  const [later, setLater] = useState(false);
  const working = task.phase === 'working';
  const send = () => {
    const value = text.trim();
    if (!value || message.isPending) return;
    message.mutate(
      { message: value, mode: working && later ? 'queue' : 'steer' },
      {
        onSuccess: () => {
          setText('');
          setLater(false);
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          toast.success(working && later ? 'Sent for after this turn' : 'Sent to the lead');
        },
      },
    );
  };
  return (
    <View style={styles.composer}>
      {working ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: later }}
          onPress={() => setLater((value) => !value)}
          style={styles.later}
        >
          <View style={[styles.box, later && { backgroundColor: theme.colors.fillInverse }]}>
            {later ? <Check size={12} color={theme.colors.background} /> : null}
          </View>
          <Text variant="caption" color="mutedForeground">
            After the lead’s current turn
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.composerRow}>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={20_000}
          accessibilityLabel="Message to the lead"
          placeholder={`Message ${task.leadAgentId ? 'the lead' : 'the department'}`}
          placeholderTextColor={theme.colors.placeholder}
          selectionColor={theme.colors.brand}
          cursorColor={theme.colors.foreground}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[styles.input, type.body]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !text.trim() || message.isPending }}
          disabled={!text.trim() || message.isPending}
          onPress={send}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: text.trim() ? theme.colors.fillInverse : theme.colors.fill },
            pressed && { backgroundColor: theme.colors.fillInverseActive },
          ]}
        >
          <Send size={18} color={text.trim() ? theme.colors.background : theme.colors.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  timeline: { gap: space.lg },
  event: { flexDirection: 'row', gap: space.md },
  composer: {
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  later: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xs,
    minHeight: 32,
  },
  box: {
    width: 18,
    height: 18,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: `inset 0 0 0 1.5px ${theme.colors.borderStrong}`,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderRadius: 22,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    paddingBottom: 11,
    backgroundColor: theme.colors.field,
    color: theme.colors.foreground,
    boxShadow: `inset 0 0 0 1px ${theme.colors.fieldRim}`,
  },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
}));
