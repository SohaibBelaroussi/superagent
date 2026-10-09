import { errorMessage } from '@superagent/client';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { ClipboardPaste, QrCode } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { normalizeServer, parsePairingLink } from '../../api/pairing';
import { useSession } from '../../api/session';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/feedback';
import { TextField } from '../../ui/field';
import { Logo } from '../../ui/logo';
import { Text } from '../../ui/text';
import { makeStyles, space } from '../../ui/theme';

/**
 * Signing in (D53): scan the pairing code the web app's Devices page shows, or paste its link (the
 * emulator shares this computer's clipboard). A server address and a token also work.
 */
export function SignInScreen() {
  const styles = useStyles();
  const { state, signInWithToken } = useSession();
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [withToken, setWithToken] = useState(false);
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoked = state.status === 'signed-out' && state.reason === 'revoked';

  const openPairingLink = (text: string) => {
    const parsed = parsePairingLink(text);
    if (!parsed) {
      setLinkError('That isn’t a pairing link. It starts with superagent://pair.');
      return;
    }
    if ('error' in parsed) {
      setLinkError(parsed.error);
      return;
    }
    setLinkError(null);
    router.push({ pathname: '/pair', params: { server: parsed.server, code: parsed.code } });
  };

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    setLink(text);
    if (text) openPairingLink(text);
  };

  const submitToken = async () => {
    const normalized = normalizeServer(server);
    if ('error' in normalized) {
      setError(normalized.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signInWithToken(normalized.server, token);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <Logo size={56} />
            <Text variant="display" center accessibilityRole="header">
              superagent
            </Text>
            <Text variant="bodySmall" color="mutedForeground" center>
              Pair this phone with your server: open the web app, go to Settings, Devices, and choose Pair a
              phone.
            </Text>
          </View>

          {revoked ? (
            <Notice tone="warning" title="This phone was signed out">
              Its token was revoked. Pair it again to sign back in.
            </Notice>
          ) : null}

          <Button
            title="Scan the pairing code"
            variant="primary"
            size="lg"
            icon={QrCode}
            block
            onPress={() => router.push('/scan')}
          />

          <View style={{ gap: space.md }}>
            <TextField
              label="Or paste the pairing link"
              value={link}
              onChangeText={(text) => {
                setLink(text);
                setLinkError(null);
              }}
              placeholder="superagent://pair?…"
              mono
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              error={linkError}
              accessory={
                <Button
                  title="Paste"
                  size="sm"
                  variant="ghost"
                  icon={ClipboardPaste}
                  onPress={() => void paste()}
                />
              }
            />
            <Button title="Pair" disabled={!link.trim()} onPress={() => openPairingLink(link)} />
          </View>

          <View style={styles.divider} />

          {withToken ? (
            <View style={{ gap: space.md }}>
              <TextField
                label="Server"
                hint="Its tailnet address, like https://superagent.example.ts.net"
                value={server}
                onChangeText={setServer}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                importantForAutofill="no"
              />
              <TextField
                label="Token"
                hint="An admin token is swapped for a token of this phone’s own, and isn’t kept."
                value={token}
                onChangeText={setToken}
                mono
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
              />
              {error ? (
                <Notice tone="destructive" title="Couldn’t sign in">
                  {error}
                </Notice>
              ) : null}
              <Button
                title="Sign in"
                variant="primary"
                block
                busy={busy}
                disabled={!server.trim() || !token.trim()}
                onPress={() => void submitToken()}
              />
            </View>
          ) : (
            <Button
              title="Use a server address and a token"
              variant="ghost"
              onPress={() => setWithToken(true)}
              style={{ alignSelf: 'center' }}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: space.xl, gap: space.xl, paddingTop: space.xxxl },
  hero: { alignItems: 'center', gap: space.md, marginBottom: space.md },
  divider: { height: 1, backgroundColor: theme.colors.border },
}));
