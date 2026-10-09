import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useAttention } from '../../api/queries';
import { useTheme } from '../../ui/theme';

/** The tabs, native on each platform (Material's bottom bar on Android). The inbox counts what needs you. */
export default function TabsLayout() {
  const theme = useTheme();
  const waiting = useAttention().data?.length ?? 0;
  return (
    <NativeTabs
      backgroundColor={theme.colors.sidebar}
      iconColor={{ default: theme.colors.mutedForeground, selected: theme.colors.foreground }}
      labelStyle={{
        default: { color: theme.colors.mutedForeground, fontFamily: 'MonaSans-Medium' },
        selected: { color: theme.colors.foreground, fontFamily: 'MonaSans-Medium' },
      }}
      indicatorColor={theme.colors.fillActive}
      badgeBackgroundColor={theme.colors.fillDestructive}
      badgeTextColor={theme.colors.fillDestructiveForeground}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house" md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="tray" md="inbox" />
        <NativeTabs.Trigger.Badge hidden={waiting === 0}>{String(waiting)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chief">
        <NativeTabs.Trigger.Label>Chief</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="forum" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="board">
        <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="rectangle.split.3x1" md="view_kanban" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
