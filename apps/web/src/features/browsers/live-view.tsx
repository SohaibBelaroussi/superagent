import {
  type BrowserViewerEvent,
  BrowserViewerEventSchema,
  type BrowserViewerInput,
} from '@superagent/shared';
import { Globe, Hand, Keyboard, MousePointerClick } from 'lucide-react';
import {
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { socketUrl } from '../../api/client';
import { useSession } from '../../api/session';
import { cn } from '../../lib/cn';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { EmptyState, Notice } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { Panel } from '../../ui/layout';
import { toast } from '../../ui/toast';

/*
 * A live view of a browser the API runs: its screencast's frames (JPEG, as bare base64 strings) and
 * events come over a WebSocket, and the owner's mouse and keyboard go back the same way. In a task's
 * browser the owner takes over first, and the agents' browser tools wait meanwhile; a sign-in session
 * is the owner's from the start.
 */

export type LiveStatus = 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'refused';

export interface LiveState {
  status: LiveStatus;
  url: string | null;
  viewport: { width: number; height: number } | null;
  takenOver: boolean;
  /** The last thing the browser refused (a blocked address, input before taking over). */
  error: string | null;
}

const INITIAL: LiveState = { status: 'connecting', url: null, viewport: null, takenOver: false, error: null };
/** Waits before connecting again, growing with each failure. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];
/** The most of a paste typed into the page: it goes a key at a time. */
export const MAX_TYPED = 2_000;
/** Two presses of a button this close in time and place make a double click (then a triple). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP = 4;
/** Escape twice within this gives the keyboard back to the app. */
const LEAVE_MS = 600;

/** The page runs Chromium on Linux, where shortcuts take Ctrl: a Mac's Cmd is sent as Ctrl. */
const MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Keys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** AltGr, which Windows reports as Ctrl and Alt together. */
  altGraph?: boolean;
}

/**
 * CDP's modifier bits (Alt 1, Ctrl 2, Meta 4, Shift 8) for the page. AltGr is neither Ctrl nor Alt
 * there (Chromium types nothing with Ctrl down), and a Mac's Cmd is Ctrl.
 */
export function modifiersOf(event: Keys, mac = MAC): number {
  const ctrl = event.altGraph ? false : event.ctrlKey || (mac && event.metaKey);
  const alt = event.altGraph ? false : event.altKey;
  const meta = !mac && event.metaKey;
  return (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const BUTTONS = ['left', 'middle', 'right'] as const;
/** How far a finger moves before a touch is a scroll, not a tap (CSS pixels). */
const TAP_SLOP = 6;

/** Edits a phone's keyboard makes without keys, as the keys that make them. */
const EDITS: Record<string, { key: string; code: string; text?: string }> = {
  deleteContentBackward: { key: 'Backspace', code: 'Backspace' },
  deleteContentForward: { key: 'Delete', code: 'Delete' },
  insertLineBreak: { key: 'Enter', code: 'Enter', text: '\r' },
  insertParagraph: { key: 'Enter', code: 'Enter', text: '\r' },
};

/**
 * What a key types: a printable character, or a carriage return for Enter. Shortcuts (Ctrl or Cmd
 * with a key) type nothing; AltGr with a key types its character (@, #, € on many layouts).
 */
export function typedText(event: Pick<Keys, 'ctrlKey' | 'metaKey' | 'altGraph'> & { key: string }) {
  if ((event.ctrlKey && !event.altGraph) || event.metaKey) return undefined;
  if (event.key === 'Enter') return '\r';
  return [...event.key].length === 1 ? event.key : undefined;
}

/**
 * Text as the key presses that type it: a key down carrying each character, then its key up. (A "char"
 * event alone types nothing in Chromium.) A line break is Enter.
 */
export function keystrokes(text: string): BrowserViewerInput[] {
  return [...text.slice(0, MAX_TYPED * 2)].slice(0, MAX_TYPED).flatMap((character): BrowserViewerInput[] => {
    const enter = character === '\n' || character === '\r';
    const key = enter ? 'Enter' : character;
    return [
      { type: 'keyboard', eventType: 'keyDown', key, text: enter ? '\r' : character },
      { type: 'keyboard', eventType: 'keyUp', key },
    ];
  });
}

/** A paste shortcut, whatever the layout: Ctrl or Cmd with V (or the key in its place), or Shift+Insert. */
const isPaste = (event: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'v' || event.code === 'KeyV')) ||
  (event.shiftKey && event.key === 'Insert');

/**
 * The live view's connection: its state, the image its frames go into, and a way to send input.
 * Frames are written straight into the image, not through React state, so a busy page costs no
 * renders. It connects again after a drop, unless the token was revoked. Each connection starts from
 * what the API tells it (who has the browser, what it shows): `connection` counts them.
 */
export function useLiveView(path: string) {
  const { state: session } = useSession();
  const token = session.status === 'signed-in' ? session.token : null;
  const [state, setState] = useState<LiveState>(INITIAL);
  const [hasFrame, setHasFrame] = useState(false);
  const [connection, setConnection] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;
    let closed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let framed = false;

    const handle = (event: BrowserViewerEvent) => {
      if ('status' in event) {
        const status = event.status;
        if (status === 'taken_over' || status === 'released') {
          setState((current) => ({ ...current, takenOver: status === 'taken_over' }));
        } else if (status === 'browser_closed') {
          framed = false;
          setHasFrame(false);
          setState((current) => ({ ...current, status: 'waiting', takenOver: false, url: null }));
        } else if (status === 'streaming') {
          setState((current) => ({ ...current, status: 'live' }));
        } else {
          // Connected: what follows says whether the browser is open (streaming) or not (closed). Who
          // has it is said again too: nothing is kept from a connection before.
          failures = 0;
          framed = false;
          setConnection((count) => count + 1);
          setState((current) => ({ ...current, status: 'connecting', takenOver: false, error: null }));
        }
      } else if ('url' in event) {
        setState((current) => ({ ...current, url: event.url }));
      } else if ('viewport' in event) {
        setState((current) => ({ ...current, viewport: event.viewport }));
      } else {
        setState((current) => ({ ...current, error: event.message }));
      }
    };

    const connect = () => {
      const ws = new WebSocket(socketUrl(path, token));
      socket.current = ws;
      ws.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        if (message.data.startsWith('{')) {
          let data: unknown;
          try {
            data = JSON.parse(message.data);
          } catch {
            return;
          }
          const parsed = BrowserViewerEventSchema.safeParse(data);
          if (parsed.success) handle(parsed.data);
          return;
        }
        if (image.current) image.current.src = `data:image/jpeg;base64,${message.data}`;
        if (!framed) {
          framed = true;
          setHasFrame(true);
          setState((current) => ({ ...current, status: 'live' }));
        }
      };
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null;
        if (closed) return;
        // 1008: the token was revoked. The session signs out; there is nothing to reconnect with.
        if (event.code === 1008) {
          setState((current) => ({ ...current, status: 'refused', takenOver: false }));
          return;
        }
        setState((current) => ({ ...current, status: 'reconnecting', takenOver: false }));
        timer = setTimeout(connect, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
        failures++;
      };
    };

    setState(INITIAL);
    setHasFrame(false);
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, [path, token]);

  const send = useCallback((input: BrowserViewerInput) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(input));
  }, []);

  const clearError = useCallback(() => setState((current) => ({ ...current, error: null })), []);

  return { state, hasFrame, connection, image, send, clearError };
}

const STATUS: Record<LiveStatus, { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' }> = {
  connecting: { label: 'Connecting…', tone: 'neutral' },
  waiting: { label: 'Not open', tone: 'neutral' },
  live: { label: 'Live', tone: 'green' },
  reconnecting: { label: 'Reconnecting…', tone: 'amber' },
  refused: { label: 'Signed out', tone: 'red' },
};

/**
 * A browser on screen, as it is now, for watching or using: a task's (`kind="task"`, used after taking
 * over) or a sign-in session's (used from the start).
 */
export function LiveView({
  path,
  kind,
  label,
  waiting,
  onStatus,
}: {
  /** Its WebSocket route: `/v1/tasks/{id}/browser/stream` or `/v1/browser-identities/{id}/stream`. */
  path: string;
  kind: 'task' | 'sign-in';
  /** What it shows, for screen readers: "The task's browser". */
  label: string;
  /** What to say while no browser is open. */
  waiting: { title: string; description: string };
  onStatus?: (status: LiveStatus) => void;
}) {
  const { state, hasFrame, connection, image, send, clearError } = useLiveView(path);
  const interactive = state.status === 'live' && (kind === 'sign-in' || state.takenOver);
  const screen = useRef<HTMLDivElement>(null);
  /**
   * Where the keyboard goes: a text field kept empty, out of the tab order, entered by clicking the
   * page (or the Keyboard button) and left with Escape twice. Keys are sent as keys; text that comes
   * without them (a phone's keyboard, an input method, dictation) is sent as the keys that type it.
   */
  const keys = useRef<HTMLTextAreaElement>(null);
  const keyboardButton = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const composing = useRef(false);
  /** What an input method committed: some browsers send it again as input after it ends. */
  const committed = useRef<string | null>(null);
  /** Keys pressed while the page had the keyboard: only their releases go to it, all of them on leaving. */
  const held = useRef(new Map<string, { key: string; code: string }>());
  const lastEscape = useRef(0);
  const pressed = useRef<{ button: (typeof BUTTONS)[number]; count: number } | null>(null);
  const lastPress = useRef<{ at: number; x: number; y: number; button: number; count: number } | null>(null);
  const moving = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | undefined>(undefined);
  /** A finger down: where, and whether it has become a scroll. */
  const touch = useRef<{ x: number; y: number; scrolled: boolean } | null>(null);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  /**
   * The frames' size, from the frames themselves: input is in their pixels, and the viewport is only
   * announced when it changes.
   */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const frameSize = size ?? state.viewport;

  useEffect(() => {
    onStatus?.(state.status);
  }, [state.status, onStatus]);

  useEffect(() => {
    if (!editingAddress) setAddress(state.url ?? '');
  }, [state.url, editingAddress]);

  /** Lets go of every key and button the page still has down (when the keyboard leaves, or the page). */
  const letGo = useCallback(() => {
    for (const { key, code } of held.current.values())
      send({ type: 'keyboard', eventType: 'keyUp', key, code });
    held.current.clear();
    const point = moving.current;
    if (pressed.current && point) {
      send({
        type: 'mouse',
        eventType: 'mouseReleased',
        ...point,
        button: pressed.current.button,
        clickCount: 1,
      });
    }
    pressed.current = null;
    touch.current = null;
  }, [send]);

  // A new connection, or the page no longer ours: nothing is still down there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each connection, and when the page stops being ours
  useEffect(() => {
    held.current.clear();
    pressed.current = null;
    touch.current = null;
    lastPress.current = null;
    composing.current = false;
  }, [connection, interactive]);

  /** The point on the page under a pointer, in the frames' pixels. */
  const pointAt = useCallback(
    (clientX: number, clientY: number) => {
      const box = image.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return null;
      const width = frameSize?.width ?? box.width;
      const height = frameSize?.height ?? box.height;
      return {
        x: Math.round(((clientX - box.left) / box.width) * width),
        y: Math.round(((clientY - box.top) / box.height) * height),
      };
    },
    [image, frameSize],
  );

  // The wheel scrolls the page in the browser, not this one: a listener that may cancel it.
  useEffect(() => {
    const element = screen.current;
    if (!element || !interactive) return;
    const onWheel = (event: WheelEvent) => {
      const point = pointAt(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      send({
        type: 'mouse',
        eventType: 'mouseWheel',
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifiersOf(event),
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [interactive, pointAt, send]);

  // A phone's keyboard deletes and breaks lines as edits, not keys.
  useEffect(() => {
    const field = keys.current;
    if (!field || !interactive) return;
    const onBeforeInput = (event: InputEvent) => {
      const edit = EDITS[event.inputType];
      if (!edit) return;
      event.preventDefault();
      send({
        type: 'keyboard',
        eventType: 'keyDown',
        key: edit.key,
        code: edit.code,
        ...(edit.text ? { text: edit.text } : {}),
      });
      send({ type: 'keyboard', eventType: 'keyUp', key: edit.key, code: edit.code });
    };
    field.addEventListener('beforeinput', onBeforeInput);
    return () => field.removeEventListener('beforeinput', onBeforeInput);
  }, [interactive, send]);

  useEffect(() => () => cancelAnimationFrame(frame.current ?? 0), []);

  /** How many clicks this press makes: browsers report none on pointer events, so they're counted here. */
  const clickCount = (event: PointerEvent<HTMLDivElement>): number => {
    const last = lastPress.current;
    const now = event.timeStamp;
    const count =
      last &&
      last.button === event.button &&
      now - last.at < MULTI_CLICK_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <= MULTI_CLICK_SLOP
        ? Math.min(last.count + 1, 3)
        : 1;
    lastPress.current = { at: now, x: event.clientX, y: event.clientY, button: event.button, count };
    return count;
  };

  const click = (point: { x: number; y: number }, modifiers: number) => {
    send({ type: 'mouse', eventType: 'mousePressed', ...point, button: 'left', clickCount: 1, modifiers });
    send({ type: 'mouse', eventType: 'mouseReleased', ...point, button: 'left', clickCount: 1, modifiers });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    // The back and forward buttons are the app's, not the page's.
    const button = BUTTONS[event.button];
    if (!button && event.pointerType !== 'touch') return;
    const point = pointAt(event.clientX, event.clientY);
    if (!point) return;
    keys.current?.focus({ preventScroll: true });
    event.preventDefault();
    moving.current = point;
    if (event.pointerType === 'touch') {
      touch.current = { x: event.clientX, y: event.clientY, scrolled: false };
      return;
    }
    const count = clickCount(event);
    pressed.current = { button: button ?? 'left', count };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    send({
      type: 'mouse',
      eventType: 'mousePressed',
      ...point,
      button: button ?? 'left',
      clickCount: count,
      modifiers: modifiersOf(event),
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.pointerType === 'touch') {
      const start = touch.current;
      touch.current = null;
      const point = pointAt(event.clientX, event.clientY);
      if (start && !start.scrolled && point) click(point, modifiersOf(event));
      return;
    }
    const down = pressed.current;
    if (!down) return;
    pressed.current = null;
    const point = pointAt(event.clientX, event.clientY);
    if (!point) return;
    send({
      type: 'mouse',
      eventType: 'mouseReleased',
      ...point,
      button: down.button,
      clickCount: down.count,
      modifiers: modifiersOf(event),
    });
  };

  // Moves go at most once a frame.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.pointerType === 'touch') {
      const start = touch.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!start.scrolled && Math.hypot(dx, dy) < TAP_SLOP) return;
      start.scrolled = true;
      start.x = event.clientX;
      start.y = event.clientY;
      const point = pointAt(event.clientX, event.clientY);
      const box = image.current?.getBoundingClientRect();
      if (!point || !box) return;
      // The page follows the finger: dragging up scrolls down, in the frames' pixels.
      const scale = (frameSize?.width ?? box.width) / box.width;
      send({ type: 'mouse', eventType: 'mouseWheel', ...point, deltaX: -dx * scale, deltaY: -dy * scale });
      return;
    }
    moving.current = pointAt(event.clientX, event.clientY);
    if (frame.current !== undefined) return;
    const modifiers = modifiersOf(event);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const point = moving.current;
      if (!point) return;
      send({
        type: 'mouse',
        eventType: 'mouseMoved',
        ...point,
        button: pressed.current?.button ?? 'none',
        modifiers,
      });
    });
  };

  const leaveKeyboard = () => {
    letGo();
    keyboardButton.current?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>, down: boolean) => {
    if (!interactive) return;
    // An input method, a dead key or a phone's keyboard: the text comes as input (below), not as keys.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Unidentified' || event.key === 'Process' || event.key === 'Dead') return;
    // Pasting is the browser's own paste event (below), with the text: let it happen.
    if (isPaste(event)) return;
    event.preventDefault();
    if (down) committed.current = null;
    // Escape twice gives the keyboard back to the app; once still goes to the page.
    if (down && event.key === 'Escape' && !event.repeat) {
      if (event.timeStamp - lastEscape.current < LEAVE_MS) {
        lastEscape.current = 0;
        leaveKeyboard();
        return;
      }
      lastEscape.current = event.timeStamp;
    }
    // A key pressed elsewhere (Enter in the address bar, which hands the keyboard over) is released
    // here: the page never saw it go down.
    const id = event.code || event.key;
    const key = event.key.slice(0, 32);
    const code = event.code.slice(0, 32);
    if (down) held.current.set(id, { key, code });
    else if (!held.current.delete(id)) return;
    const altGraph = event.getModifierState?.('AltGraph') ?? false;
    const text = down
      ? typedText({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altGraph })
      : undefined;
    send({
      type: 'keyboard',
      eventType: down ? 'keyDown' : 'keyUp',
      key,
      code,
      modifiers: modifiersOf({ ...event, altGraph }),
      ...(text ? { text } : {}),
    });
  };

  const typeText = (text: string) => {
    // "\r\n" is one line break.
    for (const input of keystrokes(text.replace(/\r\n/g, '\n'))) send(input);
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const text = event.currentTarget.value;
    event.currentTarget.value = '';
    // What the input method committed, sent again as input once it ended (Safari): typed already.
    if (text && text === committed.current) {
      committed.current = null;
      return;
    }
    if (interactive && text) typeText(text);
  };

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    event.currentTarget.value = '';
    committed.current = event.data || null;
    if (interactive && event.data) typeText(event.data);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!interactive) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if ([...text].length > MAX_TYPED) toast.info('Only the first 2,000 characters were typed');
    typeText(text);
  };

  const go = (event: FormEvent) => {
    event.preventDefault();
    // Read-only until the page is yours: the agents navigate it.
    if (!interactive) return;
    const target = address.trim();
    if (!target) return;
    clearError();
    send({ type: 'navigate', url: /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}` });
    setEditingAddress(false);
    keys.current?.focus({ preventScroll: true });
  };

  const status = STATUS[state.status];
  const ratio = frameSize ? `${frameSize.width} / ${frameSize.height}` : '16 / 10';

  return (
    <Panel className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {/* Announced as it changes: connecting, live, who has it. */}
        <div role="status" aria-label="Browser" className="flex items-center gap-2">
          <Badge tone={status.tone} dot={state.status === 'live' ? 'pulse' : true}>
            {status.label}
          </Badge>
          {kind === 'task' && state.status === 'live' ? (
            state.takenOver ? (
              <Badge tone="amber">You have it</Badge>
            ) : (
              <Badge>Agents have it</Badge>
            )
          ) : null}
        </div>
        <form onSubmit={go} className="flex min-w-0 flex-1 items-center gap-2">
          <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Input
            aria-label="Address"
            value={interactive ? address : (state.url ?? '')}
            readOnly={!interactive}
            disabled={state.status !== 'live'}
            spellCheck={false}
            placeholder={state.status === 'live' ? '' : 'No page'}
            className="h-control-sm min-w-0 flex-1 font-mono text-caption"
            onFocus={() => setEditingAddress(interactive)}
            onBlur={() => setEditingAddress(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        {interactive ? (
          <Button
            ref={keyboardButton}
            size="icon-sm"
            variant="ghost"
            tooltip="Start typing into the page"
            onClick={() => keys.current?.focus({ preventScroll: true })}
          >
            <Keyboard aria-hidden />
          </Button>
        ) : null}
        {kind === 'task' && state.status === 'live' ? (
          state.takenOver ? (
            <Button
              size="sm"
              onClick={() => {
                letGo();
                send({ type: 'takeover', on: false });
              }}
            >
              Give it back
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => send({ type: 'takeover', on: true })}>
              <Hand aria-hidden />
              Take over
            </Button>
          )
        ) : null}
      </div>

      {state.error ? (
        <Notice
          tone="warning"
          className="mx-3 mt-3"
          action={
            <Button size="sm" variant="ghost" onClick={clearError}>
              Dismiss
            </Button>
          }
        >
          {state.error}
        </Notice>
      ) : null}
      {state.status === 'refused' ? (
        <Notice tone="destructive" className="mx-3 mt-3">
          This browser’s token was revoked, so the view closed.
        </Notice>
      ) : null}

      <div className="relative bg-fill-subtle">
        <div
          ref={screen}
          role="application"
          aria-label={label}
          className={cn(
            'relative w-full select-none',
            // While it's yours, a finger drives the page; otherwise it scrolls this one.
            interactive ? 'cursor-default touch-none' : 'cursor-not-allowed',
            // Typing goes to the page: the frame says so.
            'has-[textarea:focus]:outline-1 has-[textarea:focus]:-outline-offset-1 has-[textarea:focus]:outline-solid has-[textarea:focus]:outline-border-focus',
            !hasFrame && 'hidden',
          )}
          style={{ aspectRatio: ratio }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onPointerCancel={letGo}
          onContextMenu={(event) => interactive && event.preventDefault()}
        >
          <img
            ref={image}
            alt={state.url ? `The page at ${state.url}` : 'The page'}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width > 0 && (width !== size?.width || height !== size?.height)) setSize({ width, height });
            }}
            className="block size-full object-contain"
          />
          <textarea
            ref={keys}
            aria-label="Type into the page"
            aria-describedby={hintId}
            tabIndex={-1}
            disabled={!interactive}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="pointer-events-none absolute top-0 left-0 size-px resize-none overflow-hidden opacity-0"
            onKeyDown={(event) => onKey(event, true)}
            onKeyUp={(event) => onKey(event, false)}
            onInput={onInput}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={onCompositionEnd}
            onPaste={onPaste}
            onBlur={letGo}
          />
        </div>
        {!hasFrame ? (
          <EmptyState
            compact
            icon={<Globe />}
            title={state.status === 'live' || state.status === 'waiting' ? waiting.title : status.label}
            description={state.status === 'waiting' ? waiting.description : undefined}
          />
        ) : null}
      </div>

      {kind === 'task' && state.status === 'live' && !state.takenOver ? (
        <p className="flex items-center gap-2 border-t border-border px-3 py-2 text-caption text-muted-foreground">
          <MousePointerClick aria-hidden className="size-3.5 shrink-0" />
          Agents are using this browser. Take over to use it yourself: their browser tools wait until you give
          it back.
        </p>
      ) : null}
      <p
        id={hintId}
        className={cn(
          'flex items-center gap-2 border-t border-border px-3 py-2 text-caption text-muted-foreground',
          !interactive && 'hidden',
        )}
      >
        <MousePointerClick aria-hidden className="size-3.5 shrink-0" />
        Click the page to type into it; pasting works too. Press Esc twice to stop typing into it.
      </p>
    </Panel>
  );
}
