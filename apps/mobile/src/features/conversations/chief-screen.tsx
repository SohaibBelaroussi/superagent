import {
  errorMessage,
  LOST_AFTER_MS,
  type PendingMessage,
  pendingMessage,
  randomId,
  storedPending,
} from '@superagent/client';
import * as Haptics from 'expo-haptics';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronsUp, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useConversation, useSendToChief, useStopChief } from '../../api/conversations';
import { useOrg } from '../../api/queries';
import { Avatar } from '../../ui/avatar';
import { StatusDot } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Notice, Skeleton } from '../../ui/feedback';
import { AvoidKeyboard } from '../../ui/keyboard';
import { Text } from '../../ui/text';
import { MAX_FONT_SCALE, makeStyles, radius, space, type, useTheme } from '../../ui/theme';
import { ConversationList } from './conversation-list';
import { takeHandoff } from './handoff';
import { useSpeakers } from './message-views';
import { useStickToEnd } from './scroll';

const SUGGESTIONS = [
  'What’s on the board right now?',
  'What needs my attention today?',
  'Start a research task: compare the top open-source agent frameworks.',
];

/**
 * Your conversation with the chief of staff: its answers stream in, departments' reports appear. A
 * message written while it answers waits for that answer to end (D47). Home's quick ask arrives as a
 * `handoff` id (its words stay in memory, out of the route) and goes out once.
 */
export function ChiefScreen() {
  const theme = useTheme();
  const styles = useStyles();
  const org = useOrg();
  const speaker = useSpeakers(org);
  // Native tabs keep the screen once opened: its stream is open only while it's in front.
  const focused = useIsFocused();
  const conversation = useConversation({ kind: 'chief' }, { live: focused });
  const { history, messages, arrived, turns, running: runningCalls, active: running, status } = conversation;
  const send = useSendToChief();
  const stop = useStopChief();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState('');
  const input = useRef<TextInput>(null);
  const { props: scrolling, toEnd, keepPlace, away } = useStickToEnd(messages[0]?.id);

  // A message is pending until the history has it.
  const stored = storedPending(pending, messages);
  const shownPending = pending.filter((message) => !stored.has(message.key));

  // Sending waits for the history: a pending message is matched against what it already holds.
  const ready = history.isSuccess;

  function submit(text: string, key = randomId()) {
    const message = text.trim();
    if (!message || !ready) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPending((list) => [
      ...list.filter((item) => item.key !== key),
      pendingMessage(key, message, messages),
    ]);
    toEnd();
    send.mutate(message, {
      onSuccess: ({ delivery }) =>
        setPending((list) => list.map((item) => (item.key === key ? { ...item, state: delivery } : item))),
      onError: (error) =>
        setPending((list) =>
          list.map((item) =>
            item.key === key ? { ...item, state: 'failed', error: `Not sent: ${errorMessage(error)}` } : item,
          ),
        ),
    });
  }

  // The ones the history has caught up with are done with. The rest know those messages aren't theirs.
  useEffect(() => {
    if (stored.size === 0) return;
    const taken = [...stored.values()];
    setPending((list) =>
      list
        .filter((message) => !stored.has(message.key))
        .map((message) => ({ ...message, known: new Set([...message.known, ...taken]) })),
    );
  });

  // A queued message goes out within a second of the chief going idle. One still waiting well after
  // that was lost (the server restarted, say): offer it again.
  useEffect(() => {
    if (running || status !== 'live' || !pending.some((message) => message.state === 'queued')) return;
    const timer = setTimeout(() => {
      setPending((list) =>
        list.map((message) =>
          message.state === 'queued'
            ? { ...message, state: 'failed', error: 'Not sent: the chief didn’t pick it up' }
            : message,
        ),
      );
    }, LOST_AFTER_MS);
    return () => clearTimeout(timer);
  }, [running, status, pending]);

  // Home's quick ask: sent once the history is in, then dropped from the route.
  const { handoff } = useLocalSearchParams<{ handoff?: string }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per handed-off message.
  useEffect(() => {
    if (!handoff || !ready) return;
    router.setParams({ handoff: undefined });
    const text = takeHandoff(handoff);
    if (text) submit(text);
  }, [handoff, ready]);

  const onSend = () => {
    if (!draft.trim() || !ready) return;
    submit(draft);
    setDraft('');
  };

  const empty =
    history.isSuccess &&
    messages.length === 0 &&
    arrived.length === 0 &&
    turns.length === 0 &&
    shownPending.length === 0;
  const statusLine = running
    ? 'Answering…'
    : status === 'live'
      ? 'Routes your work to the departments'
      : status === 'offline'
        ? 'Reconnecting…'
        : 'Connecting…';

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.screen}>
      <View style={styles.header}>
        <Avatar name="Chief of staff" size="md" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading" accessibilityRole="header">
            Chief of staff
          </Text>
          <View accessibilityLiveRegion="polite" style={styles.statusLine}>
            <StatusDot
              tone={
                running ? 'amber' : status === 'live' ? 'green' : status === 'offline' ? 'amber' : 'neutral'
              }
              live={running}
            />
            <Text variant="caption" color="mutedForeground" numberOfLines={1}>
              {statusLine}
            </Text>
          </View>
        </View>
        {running ? (
          <Button title="Stop" size="sm" icon={Square} busy={stop.isPending} onPress={() => stop.mutate()} />
        ) : null}
      </View>

      <AvoidKeyboard style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <ScrollView
            {...scrolling}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            {history.hasNextPage ? (
              <Button
                title="Earlier messages"
                variant="ghost"
                size="sm"
                icon={ChevronsUp}
                busy={history.isFetchingNextPage}
                onPress={() => keepPlace(() => history.fetchNextPage())}
                style={{ alignSelf: 'center' }}
              />
            ) : null}
            {history.isPending ? (
              <ConversationSkeleton />
            ) : history.isError && !history.data ? (
              <Notice tone="destructive" title="Couldn’t load the conversation">
                {errorMessage(history.error)}
              </Notice>
            ) : empty ? (
              <Welcome
                onPick={(suggestion) => {
                  setDraft(suggestion);
                  input.current?.focus();
                }}
              />
            ) : (
              <ConversationList
                messages={messages}
                arrived={arrived}
                turns={turns}
                pending={shownPending}
                running={runningCalls}
                org={org}
                speaker={speaker}
                defaultAgent="chief"
                onRetry={(message) => submit(message.text, message.key)}
              />
            )}
          </ScrollView>
          {away ? (
            <View style={styles.latest} pointerEvents="box-none">
              <Button title="Latest" size="sm" icon={ArrowDown} onPress={() => toEnd()} />
            </View>
          ) : null}
        </View>

        <View style={styles.composer}>
          <TextInput
            ref={input}
            testID="chief-message"
            accessibilityLabel="Message the chief of staff"
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={20_000}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            placeholder={
              running ? 'Write now: it reads this once it’s done…' : 'Ask, delegate, or check on something…'
            }
            placeholderTextColor={theme.colors.placeholder}
            selectionColor={theme.colors.brand}
            cursorColor={theme.colors.foreground}
            style={[type.body, styles.input]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !draft.trim() || !ready }}
            disabled={!draft.trim() || !ready}
            onPress={onSend}
            hitSlop={6}
            style={({ pressed }) => [
              styles.send,
              { backgroundColor: draft.trim() && ready ? theme.colors.fillInverse : theme.colors.fill },
              pressed && { backgroundColor: theme.colors.fillInverseActive },
            ]}
          >
            <ArrowUp
              size={20}
              color={draft.trim() && ready ? theme.colors.background : theme.colors.placeholder}
            />
          </Pressable>
        </View>
      </AvoidKeyboard>
    </SafeAreaView>
  );
}

function Welcome({ onPick }: { onPick: (suggestion: string) => void }) {
  const styles = useStyles();
  return (
    <View style={styles.welcome}>
      <Avatar name="Chief of staff" size="lg" />
      <View style={{ gap: space.xs, maxWidth: 360 }}>
        <Text variant="title" center>
          What can I take off your plate?
        </Text>
        <Text variant="bodySmall" color="mutedForeground" center>
          I know every department. Ask me anything, hand me work, and I’ll route it to the right team and tell
          you when it’s done.
        </Text>
      </View>
      <View style={{ gap: space.sm, alignSelf: 'stretch' }}>
        {SUGGESTIONS.map((suggestion) => (
          <Pressable
            key={suggestion}
            accessibilityRole="button"
            onPress={() => onPick(suggestion)}
            style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
          >
            <Text variant="bodySmall">{suggestion}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ConversationSkeleton() {
  return (
    <View accessibilityLabel="Loading the conversation" style={{ gap: space.xl }}>
      <Skeleton style={{ alignSelf: 'flex-end', width: '45%', height: 40, borderRadius: radius.lg }} />
      <View style={{ gap: space.sm }}>
        <Skeleton style={{ width: 128, height: 16 }} />
        <Skeleton style={{ width: '75%', height: 16, marginLeft: space.xxl }} />
        <Skeleton style={{ width: '65%', height: 16, marginLeft: space.xxl }} />
      </View>
      <Skeleton style={{ height: 80, borderRadius: radius.card }} />
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  content: { padding: space.lg, gap: space.xl, flexGrow: 1 },
  latest: { position: 'absolute', bottom: space.md, left: 0, right: 0, alignItems: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    margin: space.md,
    padding: space.xs + 2,
    paddingLeft: space.lg,
    borderRadius: radius.lg,
    backgroundColor: theme.colors.card,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 160,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    color: theme.colors.foreground,
  },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  welcome: { alignItems: 'center', gap: space.lg, paddingVertical: space.xxxl },
  suggestion: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: theme.colors.fillSubtle,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  suggestionPressed: { backgroundColor: theme.colors.fill },
}));
