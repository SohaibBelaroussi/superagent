import { errorMessage } from '@superagent/client';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { Link2 } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { parsePairingLink } from '../../api/pairing';
import { useSession } from '../../api/session';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/feedback';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, useTheme } from '../../ui/theme';

/**
 * Where a pairing link lands (`superagent://pair?server=…&code=…`), scanned, pasted or opened. It says
 * which server the phone would sign in to and waits for you: a link from anywhere must not sign the
 * app in to a server you didn't choose.
 */
export function PairScreen() {
  const theme = useTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ server?: string; code?: string }>();
  const { state, pair, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = parsePairingLink(
    `superagent://pair?server=${encodeURIComponent(params.server ?? '')}&code=${encodeURIComponent(params.code ?? '')}`,
  );

  const confirm = async () => {
    if (!link || 'error' in link) return;
    setBusy(true);
    setError(null);
    try {
      await pair(link);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/');
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  if (!link || 'error' in link) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Notice tone="destructive" title="This pairing link can’t be used">
          {link ? link.error : 'It has no server or no code. Make a new one in the web app.'}
        </Notice>
        <Button title="Back" onPress={() => router.back()} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.server}>
        <Link2 size={20} color={theme.colors.mutedForeground} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="caption" color="mutedForeground">
            Server
          </Text>
          <Text variant="label" selectable>
            {link.server}
          </Text>
        </View>
      </View>
      {state.status === 'signed-in' ? (
        <>
          <Notice tone="warning" title="This phone is signed in already">
            {`It’s signed in to ${state.session.server}. Sign out first, then open the pairing link again.`}
          </Notice>
          <Button title="Sign out" variant="destructive" onPress={() => void signOut()} />
        </>
      ) : (
        <>
          <Text variant="bodySmall" color="mutedForeground">
            Pair only with your own server: it gets this phone’s requests and shows you what it says needs
            you. The code works once.
          </Text>
          {error ? (
            <Notice tone="destructive" title="Couldn’t pair">
              {error}
            </Notice>
          ) : null}
          <Button
            title="Pair this phone"
            variant="primary"
            size="lg"
            block
            busy={busy}
            onPress={() => void confirm()}
          />
          <Button title="Cancel" variant="ghost" block disabled={busy} onPress={() => router.back()} />
        </>
      )}
    </ScrollView>
  );
}

const useStyles = makeStyles((theme) => ({
  content: { padding: space.xl, gap: space.lg, backgroundColor: theme.colors.background, flexGrow: 1 },
  server: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: theme.colors.card,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
}));
