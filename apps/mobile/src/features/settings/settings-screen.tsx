import { PUSH_KIND_ORDER } from '@superagent/client';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { BellRing, Globe, LogOut } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { useLiveStatus } from '../../api/live';
import { useMyPush } from '../../api/push';
import { useSession, useSignedIn } from '../../api/session';
import { pushAvailable } from '../../push/registration';
import { StatusDot } from '../../ui/badge';
import { List, ListRow } from '../../ui/list';
import { Screen } from '../../ui/screen';
import { Segmented } from '../../ui/segmented';
import { Section } from '../../ui/surface';
import { Text } from '../../ui/text';
import { space, type ThemeChoice, useThemeChoice } from '../../ui/theme';
import { confirmSignOut } from '../auth/confirm-sign-out';

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: ThemeChoice; label: string }[];

/** This phone's connection, its notifications, the theme, and the way to the web app for the rest. */
export function SettingsScreen() {
  const { session, me } = useSignedIn();
  const { signOut } = useSession();
  const { choice, setChoice } = useThemeChoice();
  const live = useLiveStatus();
  const push = useMyPush();
  const device = push.data?.device;
  const pushState = !pushAvailable()
    ? 'Not on iPhone yet'
    : device
      ? `On: ${device.kinds.length} of ${PUSH_KIND_ORDER.length} kinds`
      : push.isSuccess
        ? 'Off'
        : undefined;
  const [leaving, setLeaving] = useState(false);
  const liveLabel = live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Offline, retrying';

  const leave = () =>
    confirmSignOut(() => {
      setLeaving(true);
      void signOut();
    });

  return (
    <Screen>
      <Section title="Server">
        <List label="Server">
          <ListRow title={session.server} subtitle={me?.version ? `Version ${me.version}` : undefined} />
          <ListRow
            title="Updates"
            end={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <StatusDot tone={live === 'live' ? 'green' : live === 'connecting' ? 'amber' : 'red'} />
                <Text variant="caption" color="mutedForeground">
                  {liveLabel}
                </Text>
              </View>
            }
          />
          <ListRow title="This phone" subtitle={session.tokenName} last />
        </List>
      </Section>

      <Section title="Notifications">
        <List label="Notifications">
          <ListRow
            icon={BellRing}
            title="Notifications"
            subtitle={pushState}
            onPress={() => router.push('/notifications')}
            last
          />
        </List>
      </Section>

      <Section title="Theme">
        <Segmented label="Theme" options={THEMES} value={choice} onChange={setChoice} />
      </Section>

      <Section title="More">
        <List label="More">
          <ListRow
            icon={Globe}
            title="Open the web app"
            subtitle="Departments, agents, schedules, models and the rest."
            onPress={() => void WebBrowser.openBrowserAsync(session.server)}
          />
          <ListRow
            icon={LogOut}
            title={leaving ? 'Signing out…' : 'Sign out'}
            destructive
            chevron={false}
            onPress={leaving ? undefined : leave}
            last
          />
        </List>
      </Section>

      <Text variant="meta" color="placeholder" center>
        superagent {Constants.expoConfig?.version ?? ''}
      </Text>
    </Screen>
  );
}
