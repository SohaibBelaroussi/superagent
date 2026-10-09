import { departmentTone, errorMessage } from '@superagent/client';
import type { TaskPriority } from '@superagent/shared';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { useCreateTask, useOrg } from '../../api/queries';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/feedback';
import { TextField } from '../../ui/field';
import { AvoidKeyboard } from '../../ui/keyboard';
import { Segmented } from '../../ui/segmented';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, toneColors, useTheme } from '../../ui/theme';
import { toast } from '../../ui/toast';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const satisfies readonly { value: TaskPriority; label: string }[];

/** A new task for a department, sent to its lead at once unless you hold it in the inbox. */
export function NewTaskScreen() {
  const theme = useTheme();
  const styles = useStyles();
  const org = useOrg();
  const create = useCreateTask();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [chosen, setChosen] = useState<string | null>(null);
  const [dispatch, setDispatch] = useState(true);
  const departments = org.departments;
  const departmentId = chosen ?? departments[0]?.id ?? null;
  const department = departmentId ? org.department(departmentId) : undefined;
  const canSend = Boolean(department?.lead);
  const ready = Boolean(title.trim() && brief.trim() && departmentId);

  const submit = () => {
    if (!ready || !departmentId || create.isPending) return;
    create.mutate(
      { departmentId, title: title.trim(), brief: brief.trim(), priority, dispatch: dispatch && canSend },
      {
        onSuccess: (task) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(
            dispatch && canSend ? 'Sent to the lead' : 'Added to the inbox',
            `#${task.number} ${task.title}`,
          );
          router.replace(`/tasks/${task.id}`);
        },
      },
    );
  };

  return (
    <AvoidKeyboard style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {create.isError ? (
          <Notice tone="destructive" title="Couldn’t create the task">
            {errorMessage(create.error)}
          </Notice>
        ) : null}
        <View style={{ gap: space.sm }}>
          <Text variant="label">Department</Text>
          {departments.length === 0 ? (
            <Text variant="caption" color="mutedForeground">
              {org.ready ? 'No departments yet: set one up in the web app.' : 'Loading the departments…'}
            </Text>
          ) : (
            <View accessibilityRole="radiogroup" accessibilityLabel="Department" style={styles.departments}>
              {departments.map((item) => {
                const selected = item.id === departmentId;
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    onPress={() => setChosen(item.id)}
                    style={[styles.department, selected && styles.departmentSelected]}
                  >
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: toneColors(theme, departmentTone(item.slug)).indicator },
                      ]}
                    />
                    <Text variant="caption" color={selected ? 'foreground' : 'mutedForeground'}>
                      {item.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
        <TextField
          label="Title"
          testID="new-task-title"
          value={title}
          onChangeText={setTitle}
          maxLength={200}
          autoFocus
        />
        <TextField
          label="Brief"
          testID="new-task-brief"
          hint="What to do, and what a good result looks like. The lead reads it as written."
          value={brief}
          onChangeText={setBrief}
          maxLength={20_000}
          multiline
        />
        <View style={{ gap: space.sm }}>
          <Text variant="label">Priority</Text>
          <Segmented label="Priority" options={PRIORITY_OPTIONS} value={priority} onChange={setPriority} />
        </View>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text variant="label">Send it to the lead now</Text>
            <Text variant="caption" color="mutedForeground">
              {canSend
                ? 'Off: it waits in the inbox until you send it.'
                : 'This department has no lead yet: the task waits in its inbox.'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Send it to the lead now"
            value={dispatch && canSend}
            disabled={!canSend}
            onValueChange={setDispatch}
            trackColor={{ true: theme.colors.fillInverse, false: theme.colors.fillStrong }}
            thumbColor={theme.colors.card}
          />
        </View>
        <Button
          title="Create task"
          variant="primary"
          size="lg"
          block
          busy={create.isPending}
          disabled={!ready}
          onPress={submit}
        />
      </ScrollView>
    </AvoidKeyboard>
  );
}

const useStyles = makeStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl },
  departments: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  department: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: theme.colors.fill,
  },
  departmentSelected: { boxShadow: `inset 0 0 0 1.5px ${theme.colors.foreground}` },
  dot: { width: 6, height: 6, borderRadius: 3 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
}));
