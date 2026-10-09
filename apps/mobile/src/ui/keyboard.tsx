import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  type KeyboardEvent,
  LayoutAnimation,
  Platform,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';

/**
 * Keeps a screen's content above the keyboard, so its fields and buttons stay reachable: the part the
 * keyboard covers becomes padding. Android draws edge to edge (from Android 15), so the system no
 * longer shrinks the window for the keyboard.
 *
 * It measures where it is on screen when the keyboard moves, so it works under a header or in a
 * sheet. React Native's KeyboardAvoidingView measures from its parent, and comes up short there.
 */
export function AvoidKeyboard({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const view = useRef<View>(null);
  const [covered, setCovered] = useState(0);

  useEffect(() => {
    // iOS says when the keyboard will move, and how: follow it. Android says when it has moved.
    const follow = (event: KeyboardEvent) => {
      if (Platform.OS === 'ios' && event.duration > 0) {
        LayoutAnimation.configureNext({
          duration: event.duration,
          update: { duration: event.duration, type: LayoutAnimation.Types.keyboard },
        });
      }
    };
    const moved = (event: KeyboardEvent) =>
      view.current?.measureInWindow((_x, y, _width, height) => {
        follow(event);
        setCovered(Math.max(0, Math.round(y + height - event.endCoordinates.screenY)));
      });
    const hidden = (event: KeyboardEvent) => {
      follow(event);
      setCovered(0);
    };
    const subscriptions =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillChangeFrame', moved),
            Keyboard.addListener('keyboardWillHide', hidden),
          ]
        : [Keyboard.addListener('keyboardDidShow', moved), Keyboard.addListener('keyboardDidHide', hidden)];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return (
    <View ref={view} style={[style, { paddingBottom: covered }]}>
      {children}
    </View>
  );
}
