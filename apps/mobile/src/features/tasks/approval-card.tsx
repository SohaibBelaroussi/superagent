import { decisionKey, prettyArgs } from '@superagent/client';
import type { AttentionItem } from '@superagent/shared';
import * as Haptics from 'expo-haptics';
import { ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useDecide } from '../../api/queries';
import { Button } from '../../ui/button';
import { TextField } from '../../ui/field';
import { Text } from '../../ui/text';
import { makeStyles, radius, space, useTheme } from '../../ui/theme';
import { RelativeTime } from './bits';

type Kind = 'approve' | 'decline';

/**
 * A tool call waiting for you: what it would do, then Approve, or Decline with an optional reason the
 * agent reads. No swipe or long press decides: only these buttons, with the call in view.
 */
export function ApprovalCard({ item }: { item: AttentionItem }) {
  const theme = useTheme();
  const styles = useStyles();
  const decide = useDecide();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [showAll, setShowAll] = useState(false);
  // Decided here: the card stays settled until the list drops the item, so it can't be decided twice.
  const [decided, setDecided] = useState<Kind | null>(null);
  // One key per answer, kept across retries: a retry after a lost response is the same decision.
  const keys = useRef(new Map<Kind, string>());
  const keyFor = (kind: Kind) => {
    const existing = keys.current.get(kind);
    if (existing) return existing;
    const key = decisionKey();
    keys.current.set(kind, key);
    return key;
  };
  const answer = (kind: Kind) =>
    decide.mutate(
      { item, kind, reason: kind === 'decline' ? reason : undefined, key: keyFor(kind) },
      {
        onSuccess: () => {
          setDecided(kind);
          void Haptics.notificationAsync(
            kind === 'approve'
              ? Haptics.NotificationFeedbackType.Success
              : Haptics.NotificationFeedbackType.Warning,
          );
        },
      },
    );
  const args = prettyArgs(item.args);
  const busy = decide.isPending || decided !== null;

  return (
    <View accessibilityLabel={`${item.title}: waiting for your approval`} style={styles.card}>
      <View style={styles.head}>
        <ShieldQuestion size={18} color={theme.colors.warningIndicator} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label">{item.title}</Text>
          <Text variant="caption" color="mutedForeground">
            Waiting since <RelativeTime iso={item.since} variant="caption" color="mutedForeground" />. The
            task carries on once you decide.
          </Text>
        </View>
      </View>

      {args ? (
        <View style={styles.args}>
          <ScrollView horizontal contentContainerStyle={styles.argsContent}>
            <Text variant="mono" selectable numberOfLines={showAll ? undefined : 8}>
              {args}
            </Text>
          </ScrollView>
          {args.split('\n').length > 8 ? (
            <Button
              size="sm"
              variant="ghost"
              title={showAll ? 'Show less' : 'Show all'}
              onPress={() => setShowAll((value) => !value)}
            />
          ) : null}
        </View>
      ) : null}

      {decided ? (
        <View accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.decided}>
          {decided === 'approve' ? (
            <ShieldCheck size={16} color={theme.colors.successIndicator} />
          ) : (
            <ShieldX size={16} color={theme.colors.destructiveIndicator} />
          )}
          <Text variant="caption" color="mutedForeground">
            {decided === 'approve'
              ? 'Approved. The lead carries on.'
              : 'Declined. The lead carries on without it.'}
          </Text>
        </View>
      ) : declining ? (
        <View style={{ gap: space.md }}>
          <TextField
            label="Reason"
            hint="Optional. The agent reads it."
            value={reason}
            onChangeText={setReason}
            maxLength={1000}
            multiline
            placeholder="Use the knowledge base instead"
            autoFocus
          />
          <View style={styles.buttons}>
            <Button title="Back" variant="ghost" disabled={busy} onPress={() => setDeclining(false)} />
            <Button
              title={`Decline ${item.tool ?? 'it'}`}
              variant="destructive"
              busy={decide.isPending}
              disabled={busy}
              onPress={() => answer('decline')}
            />
          </View>
        </View>
      ) : (
        <View style={styles.buttons}>
          <Button title="Decline…" variant="ghost" disabled={busy} onPress={() => setDeclining(true)} />
          <Button
            title="Approve"
            variant="primary"
            busy={decide.isPending && decide.variables?.kind === 'approve'}
            disabled={busy}
            onPress={() => answer('approve')}
          />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: theme.colors.warningSubtle,
    boxShadow: `inset 0 0 0 1px ${theme.colors.warningEdge}`,
  },
  head: { flexDirection: 'row', gap: space.md },
  args: {
    borderRadius: radius.md,
    backgroundColor: theme.colors.fillSubtle,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
    gap: space.xs,
    paddingBottom: space.xs,
  },
  argsContent: { padding: space.md },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, flexWrap: 'wrap' },
  decided: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space.xs + 2 },
}));
