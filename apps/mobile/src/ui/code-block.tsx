import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button } from './button';
import { Text } from './text';
import { makeStyles, radius, space } from './theme';

/** Text as code (a tool call's arguments, its result): monospaced, sideways scrolling, long ones folded. */
export function CodeBlock({ value, lines = 8 }: { value: string; lines?: number }) {
  const styles = useStyles();
  const [showAll, setShowAll] = useState(false);
  return (
    <View style={styles.block}>
      <ScrollView horizontal contentContainerStyle={styles.content}>
        <Text variant="mono" selectable numberOfLines={showAll ? undefined : lines}>
          {value}
        </Text>
      </ScrollView>
      {value.split('\n').length > lines ? (
        <Button
          size="sm"
          variant="ghost"
          title={showAll ? 'Show less' : 'Show all'}
          onPress={() => setShowAll((shown) => !shown)}
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  block: {
    borderRadius: radius.md,
    backgroundColor: theme.colors.fillSubtle,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
    gap: space.xs,
    paddingBottom: space.xs,
  },
  content: { padding: space.md },
}));
