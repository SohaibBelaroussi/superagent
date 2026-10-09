import { type ReactNode, type Ref, useId, useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';
import { Text } from './text';
import { MAX_FONT_SCALE, makeStyles, radius, space, type, useTheme } from './theme';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  hint?: string;
  error?: string | null;
  /** Monospaced, for tokens and links. */
  mono?: boolean;
  /** Next to the label (a paste button). */
  accessory?: ReactNode;
  /** The input itself, to move the focus to it. */
  ref?: Ref<TextInput>;
}

/**
 * A labelled text field: the label names it for screen readers, a hint or an error under it says
 * more. Secrets are typed in plain text fields with autofill off, never password fields (D45).
 */
export function TextField({ label, hint, error, mono, accessory, multiline, ...props }: TextFieldProps) {
  const theme = useTheme();
  const styles = useStyles();
  const [focused, setFocused] = useState(false);
  const hintId = useId();
  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text variant="label" nativeID={`${hintId}-label`}>
          {label}
        </Text>
        {accessory}
      </View>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={theme.colors.placeholder}
        selectionColor={theme.colors.brand}
        cursorColor={theme.colors.foreground}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        multiline={multiline}
        {...props}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={[
          styles.input,
          mono ? type.mono : type.body,
          multiline && styles.multiline,
          focused && { boxShadow: `inset 0 0 0 1px ${theme.colors.fieldRimFocus}` },
          error ? { boxShadow: `inset 0 0 0 1px ${theme.colors.destructiveIndicator}` } : null,
        ]}
      />
      {error ? (
        <Text variant="caption" color="destructiveForeground">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" color="mutedForeground">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  field: { gap: space.xs + 2 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: theme.colors.field,
    color: theme.colors.foreground,
    boxShadow: `inset 0 0 0 1px ${theme.colors.fieldRim}`,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top', paddingTop: space.md },
}));
