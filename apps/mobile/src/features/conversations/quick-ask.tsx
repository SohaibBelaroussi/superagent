import { router } from 'expo-router';
import { ArrowUp } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Avatar } from '../../ui/avatar';
import { MAX_FONT_SCALE, makeStyles, radius, space, type, useTheme } from '../../ui/theme';
import { handOff } from './handoff';

/** One line to the chief of staff: the conversation opens with it sent. */
export function QuickAsk() {
  const theme = useTheme();
  const styles = useStyles();
  const [text, setText] = useState('');
  const ready = Boolean(text.trim());

  const submit = () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    router.navigate({ pathname: '/chief', params: { handoff: handOff(message) } });
  };

  return (
    <View style={styles.row}>
      <Avatar name="Chief of staff" size="md" />
      <TextInput
        accessibilityLabel="Ask your chief of staff"
        testID="quick-ask"
        value={text}
        onChangeText={setText}
        maxLength={20_000}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        placeholder="Ask your chief of staff…"
        placeholderTextColor={theme.colors.placeholder}
        selectionColor={theme.colors.brand}
        cursorColor={theme.colors.foreground}
        returnKeyType="send"
        onSubmitEditing={submit}
        style={[type.body, styles.input]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask"
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        onPress={submit}
        hitSlop={6}
        style={({ pressed }) => [
          styles.send,
          { backgroundColor: ready ? theme.colors.fillInverse : theme.colors.fill },
          pressed && { backgroundColor: theme.colors.fillInverseActive },
        ]}
      >
        <ArrowUp size={18} color={ready ? theme.colors.background : theme.colors.placeholder} />
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.xs + 2,
    paddingLeft: space.md,
    borderRadius: radius.lg,
    backgroundColor: theme.colors.card,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  input: { flex: 1, minHeight: 40, color: theme.colors.foreground },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
}));
