import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './text';
import { makeStyles, radius, space, useTheme } from './theme';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastMessage {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

/*
 * Short confirmations and failures ("Sent", "Couldn't send the message"), shown one at a time over
 * the screen for a few seconds, and read out by the screen reader. Callable from anywhere, as on the
 * web: `toast.error(title, detail)`.
 */

let current: ToastMessage | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function show(tone: ToastTone, title: string, detail?: string): void {
  counter += 1;
  current = { id: counter, tone, title, detail };
  for (const listener of listeners) listener();
  AccessibilityInfo.announceForAccessibility(detail ? `${title}. ${detail}` : title);
}

function dismiss(id: number): void {
  if (current?.id !== id) return;
  current = null;
  for (const listener of listeners) listener();
}

export const toast = {
  success: (title: string, detail?: string) => show('success', title, detail),
  error: (title: string, detail?: string) => show('error', title, detail),
  info: (title: string, detail?: string) => show('info', title, detail),
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const DURATION_MS = { success: 2_500, info: 4_000, error: 6_000 } as const;

/** Where toasts appear: once, near the root. */
export function ToastHost() {
  const message = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  const [shown, setShown] = useState<ToastMessage | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const styles = useStyles();

  useEffect(() => {
    if (!message) {
      // Unless a new message cut the fade short: it's the one showing now.
      Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setShown(null);
      });
      return;
    }
    setShown(message);
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const timer = setTimeout(() => dismiss(message.id), DURATION_MS[message.tone]);
    return () => clearTimeout(timer);
  }, [message, opacity]);

  if (!shown) return null;
  const ink =
    shown.tone === 'error'
      ? theme.colors.destructiveForeground
      : shown.tone === 'success'
        ? theme.colors.successForeground
        : theme.colors.foreground;
  return (
    <Animated.View pointerEvents="box-none" style={[styles.host, { top: insets.top + space.sm, opacity }]}>
      <Pressable
        accessibilityRole="alert"
        accessibilityHint="Dismisses the message"
        onPress={() => dismiss(shown.id)}
        style={styles.toast}
      >
        <Text variant="label" style={{ color: ink }}>
          {shown.title}
        </Text>
        {shown.detail ? (
          <Text variant="caption" color="mutedForeground">
            {shown.detail}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const useStyles = makeStyles((theme) => ({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  toast: {
    maxWidth: 480,
    alignSelf: 'stretch',
    backgroundColor: theme.colors.popover,
    borderRadius: radius.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: 2,
    boxShadow: `${theme.shadows.overlay}, inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
}));
