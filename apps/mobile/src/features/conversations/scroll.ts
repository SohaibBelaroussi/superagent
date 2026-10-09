import { useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

/** Closer than this to the end counts as being at the newest message. */
const NEAR_END = 64;
/** How long a "keep my place" waits for the older messages to render. */
const KEEP_PLACE_MS = 1000;

/**
 * A conversation's scrolling: it stays at the newest message as the conversation grows, until you
 * scroll away from it (its own scrolling doesn't count), and it keeps your place when older messages
 * load above what you're reading. Spread `props` on the ScrollView. `firstId` is the oldest message
 * shown: older ones have arrived when it changes.
 */
export function useStickToEnd(firstId?: string) {
  const scroll = useRef<ScrollView>(null);
  const atEnd = useRef(true);
  /** You dragged it since it was last taken to the end. */
  const moved = useRef(false);
  const offset = useRef(0);
  const height = useRef(0);
  /** Older messages are on their way: when they render, the view shifts by what they added. */
  const keeping = useRef(false);
  const first = useRef(firstId);
  first.current = firstId;
  /** The oldest message when they were asked for: growth below it (a streaming answer) isn't them. */
  const keptFirst = useRef<string | undefined>(undefined);
  const [away, setAway] = useState(false);

  const toEnd = (animated = true) => {
    atEnd.current = true;
    moved.current = false;
    setAway(false);
    scroll.current?.scrollToEnd({ animated });
  };

  const keepPlace = (load: () => Promise<unknown>) => {
    keeping.current = true;
    keptFirst.current = first.current;
    void load().finally(() =>
      setTimeout(() => {
        keeping.current = false;
      }, KEEP_PLACE_MS),
    );
  };

  const props = {
    ref: scroll,
    scrollEventThrottle: 100,
    onScrollBeginDrag: () => {
      moved.current = true;
    },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      offset.current = contentOffset.y;
      const near = contentSize.height - layoutMeasurement.height - contentOffset.y < NEAR_END;
      if (near || moved.current) {
        atEnd.current = near;
        setAway(!near);
      }
    },
    onContentSizeChange: (_width: number, contentHeight: number) => {
      const grown = contentHeight - height.current;
      height.current = contentHeight;
      if (keeping.current && grown > 0 && first.current !== keptFirst.current) {
        keeping.current = false;
        scroll.current?.scrollTo({ y: offset.current + grown, animated: false });
      } else if (atEnd.current) {
        scroll.current?.scrollToEnd({ animated: false });
      }
    },
    // The keyboard makes it shorter: the newest message stays in view.
    onLayout: (_event: LayoutChangeEvent) => {
      if (atEnd.current) scroll.current?.scrollToEnd({ animated: false });
    },
  };

  return { props, toEnd, keepPlace, away };
}
