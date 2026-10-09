import { attentionLine, taskProgress } from '@superagent/client';
import type { AgentDefinition, AttentionItem, Department, Task } from '@superagent/shared';
import { router } from 'expo-router';
import { CircleAlert } from 'lucide-react-native';
import { View } from 'react-native';
import { Card } from '../../ui/surface';
import { Text } from '../../ui/text';
import { space, toneColors, useTheme } from '../../ui/theme';
import { DepartmentLabel, PhaseBadge, PriorityBadge, ProgressBar, RelativeTime, usageLine } from './bits';

/**
 * A task on the board or the home screen: its number and department, title, chips, progress, what
 * it waits for, its lead and what it cost. The whole card opens the task.
 */
export function TaskCard({
  task,
  department,
  lead,
  attention,
  showPhase = false,
  showDepartment = true,
}: {
  task: Task;
  department?: Department;
  lead?: AgentDefinition;
  attention?: AttentionItem;
  showPhase?: boolean;
  showDepartment?: boolean;
}) {
  const theme = useTheme();
  const progress = task.closedAt ? null : taskProgress(task);
  const status = attention ? attentionLine(attention, task.title) : null;
  const usage = usageLine(task.usage);
  return (
    <Card
      onPress={() => router.push(`/tasks/${task.id}`)}
      accessibilityLabel={`Task ${task.number}: ${task.title}${status ? `. ${status.text}` : ''}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text variant="meta" color="placeholder" numeric>
          #{task.number}
        </Text>
        {showDepartment ? <DepartmentLabel department={department} variant="meta" /> : null}
        <View style={{ flex: 1 }} />
        <RelativeTime iso={task.updatedAt} />
      </View>
      <Text variant="cardTitle" numberOfLines={3}>
        {task.title}
      </Text>
      {showPhase || task.priority === 'urgent' || task.priority === 'high' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2 }}>
          {showPhase ? <PhaseBadge phase={task.phase} /> : null}
          <PriorityBadge priority={task.priority} />
        </View>
      ) : null}
      {progress ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <ProgressBar percent={progress.percent} />
          <Text variant="meta" color="mutedForeground" numeric>
            {progress.label}
          </Text>
        </View>
      ) : null}
      {status ? (
        <View style={{ flexDirection: 'row', gap: space.xs + 2, alignItems: 'flex-start' }}>
          <CircleAlert size={14} color={toneColors(theme, status.tone).foreground} style={{ marginTop: 2 }} />
          <Text variant="caption" tone={status.tone} style={{ flex: 1 }} numberOfLines={2}>
            {status.text}
          </Text>
        </View>
      ) : null}
      {lead || usage ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.sm,
          }}
        >
          <Text variant="caption" color="mutedForeground" numberOfLines={1} style={{ flexShrink: 1 }}>
            {lead?.name ?? ''}
          </Text>
          {usage ? (
            <Text variant="meta" color="mutedForeground" numeric>
              {usage}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
