import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Closer than this to the end counts as being at the newest message. */
const NEAR_END_PX = 64;
/** How long a "keep my place" waits for the older messages to render. */
const KEEP_PLACE_MS = 1000;

/**
 * Keeps a conversation on its newest message while you are there: whatever grows (an answer streaming
 * in, a new message) scrolls into view, unless you scrolled up to read. Loading older messages above
 * leaves what you are reading where it is.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
) {
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /** While older messages load: the distance from the end to keep. */
  const fromEnd = useRef<number | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const onScroll = () => {
      const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_END_PX;
      stuck.current = near;
      setAtBottom(near);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    // Opening or closing something (a tool call's details) is reading, not news: the view stays put.
    let toggled = false;
    const onToggle = () => {
      toggled = true;
    };
    content.addEventListener('toggle', onToggle, true);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (fromEnd.current !== null) {
              scroller.scrollTop = scroller.scrollHeight - fromEnd.current;
              fromEnd.current = null;
            } else if (toggled) {
              toggled = false;
              onScroll();
            } else if (stuck.current) {
              scroller.scrollTop = scroller.scrollHeight;
            }
          });
    observer?.observe(content);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      content.removeEventListener('toggle', onToggle, true);
      observer?.disconnect();
    };
  }, [scrollRef, contentRef]);

  const toBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      stuck.current = true;
      setAtBottom(true);
      const scroller = scrollRef.current;
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
    },
    [scrollRef],
  );

  /** Loads something above (older messages) without moving the view. */
  const keepPlace = useCallback(
    (load: () => Promise<unknown>) => {
      const scroller = scrollRef.current;
      if (scroller) fromEnd.current = scroller.scrollHeight - scroller.scrollTop;
      void load().finally(() =>
        setTimeout(() => {
          fromEnd.current = null;
        }, KEEP_PLACE_MS),
      );
    },
    [scrollRef],
  );

  return { atBottom, toBottom, keepPlace };
}
