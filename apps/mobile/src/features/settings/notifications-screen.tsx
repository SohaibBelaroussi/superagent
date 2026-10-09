import { errorMessage, PUSH_KIND_ORDER, PUSH_KINDS } from '@superagent/client';
import type { PushKind } from '@superagent/shared';
import * as WebBrowser from 'expo-web-browser';
import { BellRing } from 'lucide-react-native';
import { Linking, Switch, View } from 'react-native';
import { useMyPush, useRegisterPush, useTestPush, useUnregisterPush } from '../../api/push';
import { useSignedIn } from '../../api/session';
import { PushSetupError, pushAvailable } from '../../push/registration';
import { Button } from '../../ui/button';
import { Notice, Skeleton } from '../../ui/feedback';
import { List, ListRow } from '../../ui/list';
import { Screen } from '../../ui/screen';
import { Section } from '../../ui/surface';
import { Text } from '../../ui/text';
import { radius, space, useTheme } from '../../ui/theme';
import { toast } from '../../ui/toast';

/** A switch in the theme's colours, named for screen readers. */
function Toggle({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <Switch
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      trackColor={{ false: theme.colors.fillStrong, true: theme.colors.successIndicator }}
      thumbColor={value ? theme.colors.card : theme.colors.mutedForeground}
    />
  );
}

/**
 * This phone's notifications (D54): on or off, which kinds, and a test. The server sends them through
 * the owner's Firebase project, set up in the web app; each phone chooses what it gets.
 */
export function NotificationsScreen() {
  const { session } = useSignedIn();
  const status = useMyPush();
  const register = useRegisterPush();
  const unregister = useUnregisterPush();
  const test = useTestPush();

  if (!pushAvailable()) {
    return (
      <Screen>
        <Notice tone="info" title="Notifications come to iPhone later">
          They need Apple’s push service, which takes its developer program. Android phones get them now.
        </Notice>
      </Screen>
    );
  }

  if (status.isPending) {
    return (
      <Screen>
        <Skeleton style={{ height: 120, borderRadius: radius.card }} />
      </Screen>
    );
  }
  if (status.isError) {
    return (
      <Screen onRefresh={() => void status.refetch()} refreshing={status.isRefetching}>
        <Notice
          tone="destructive"
          title="Couldn’t load the notifications"
          action={<Button title="Try again" size="sm" onPress={() => void status.refetch()} />}
        >
          {errorMessage(status.error)}
        </Notice>
      </Screen>
    );
  }

  const { configured, device } = status.data;
  const busy = register.isPending || unregister.isPending;
  const setupError = register.error instanceof PushSetupError ? register.error : null;
  const toggle = (on: boolean) => {
    register.reset();
    if (on) register.mutate([...PUSH_KIND_ORDER]);
    else unregister.mutate();
  };
  const choose = (kind: PushKind, on: boolean) => {
    if (!device) return;
    const kinds = on ? [...device.kinds, kind] : device.kinds.filter((item) => item !== kind);
    register.mutate(PUSH_KIND_ORDER.filter((item) => kinds.includes(item)));
  };

  return (
    <Screen onRefresh={() => void status.refetch()} refreshing={status.isRefetching}>
      {!configured ? (
        <Notice
          tone="warning"
          title="The server can’t send notifications yet"
          action={
            <Button
              title="Open the web app"
              size="sm"
              onPress={() => void WebBrowser.openBrowserAsync(session.server)}
            />
          }
        >
          Set up a Firebase project in the web app, under Settings → Notifications. It’s free.
        </Notice>
      ) : null}

      <Section title="This phone">
        <List label="This phone">
          <ListRow
            icon={BellRing}
            title={busy && !device ? 'Turning on…' : 'Get notifications'}
            subtitle={
              device
                ? 'Encrypted for this phone: Google passes them on without reading them.'
                : 'Approvals, questions and results, even with the app closed.'
            }
            end={
              <Toggle
                label="Get notifications"
                value={Boolean(device)}
                disabled={busy || (!configured && !device)}
                onChange={toggle}
              />
            }
            last
          />
        </List>
      </Section>

      {setupError ? (
        <Notice
          tone="destructive"
          title="Notifications aren’t on"
          action={
            setupError.reason === 'denied' ? (
              <Button title="Open Android’s settings" size="sm" onPress={() => void Linking.openSettings()} />
            ) : undefined
          }
        >
          {setupError.message}
        </Notice>
      ) : register.error ? (
        <Notice tone="destructive" title="That didn’t work">
          {errorMessage(register.error)}
        </Notice>
      ) : null}

      {device ? (
        <>
          <Section title="What to get">
            <List label="What to get">
              {PUSH_KIND_ORDER.map((kind, index) => (
                <ListRow
                  key={kind}
                  title={PUSH_KINDS[kind].label}
                  subtitle={PUSH_KINDS[kind].description}
                  end={
                    <Toggle
                      label={PUSH_KINDS[kind].label}
                      value={device.kinds.includes(kind)}
                      disabled={busy}
                      onChange={(on) => choose(kind, on)}
                    />
                  }
                  last={index === PUSH_KIND_ORDER.length - 1}
                />
              ))}
            </List>
          </Section>

          {device.lastError ? (
            <Notice tone="warning" title="The last notification didn’t go through">
              {device.lastError}
            </Notice>
          ) : null}

          <View style={{ gap: space.sm }}>
            <Button
              title="Send a test notification"
              busy={test.isPending}
              disabled={!configured}
              onPress={() =>
                test.mutate(undefined, {
                  onSuccess: () => toast.success('Test sent', 'It arrives in a few seconds.'),
                })
              }
            />
            <Text variant="caption" color="mutedForeground" center>
              With the app open, it shows inside the app. Each kind has its own channel in Android’s settings,
              to tune or silence it there.
            </Text>
          </View>
        </>
      ) : null}
    </Screen>
  );
}
