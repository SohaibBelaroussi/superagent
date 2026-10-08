import {
  type BrowserViewerEvent,
  BrowserViewerEventSchema,
  type BrowserViewerInput,
} from '@superagent/shared';
import { Globe, Hand, MousePointerClick } from 'lucide-react';
import {
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
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

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
  );
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
 * with a key) type nothing.
 */
export function typedText(event: { key: string; ctrlKey: boolean; metaKey: boolean }): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined;
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

/**
 * The live view's connection: its state, the image its frames go into, and a way to send input.
 * Frames are written straight into the image, not through React state, so a busy page costs no
 * renders. It connects again after a drop, unless the token was revoked.
 */
export function useLiveView(path: string) {
  const { state: session } = useSession();
  const token = session.status === 'signed-in' ? session.token : null;
  const [state, setState] = useState<LiveState>(INITIAL);
  const [hasFrame, setHasFrame] = useState(false);
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
          // Connected: live once frames come, waiting if the browser isn't open (it says so).
          failures = 0;
          setState((current) => ({ ...current, status: framed ? 'live' : 'waiting' }));
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
          setState((current) => ({ ...current, status: 'refused' }));
          return;
        }
        setState((current) => ({ ...current, status: 'reconnecting' }));
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

  return { state, hasFrame, image, send, clearError };
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
  const { state, hasFrame, image, send, clearError } = useLiveView(path);
  const interactive = state.status === 'live' && (kind === 'sign-in' || state.takenOver);
  const screen = useRef<HTMLDivElement>(null);
  /**
   * Where the keyboard goes: a text field kept empty. Keys are sent as keys; text that comes without
   * them (a phone's keyboard, an input method, dictation) is sent as typed characters.
   */
  const keys = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  /** Keys pressed while the page had the keyboard: only their releases go to it. */
  const held = useRef(new Set<string>());
  const pressed = useRef<(typeof BUTTONS)[number] | null>(null);
  const moving = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | undefined>(undefined);
  /** A finger down: where, and whether it has become a scroll. */
  const touch = useRef<{ x: number; y: number; scrolled: boolean } | null>(null);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  /**
   * The frames' size, from the frames themselves: input is in their pixels, and a viewer that joins
   * late never hears the viewport, which is only announced when it changes.
   */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const frameSize = size ?? state.viewport;

  useEffect(() => {
    onStatus?.(state.status);
  }, [state.status, onStatus]);

  useEffect(() => {
    if (!editingAddress) setAddress(state.url ?? '');
  }, [state.url, editingAddress]);

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

  const click = (point: { x: number; y: number }, modifiers: number) => {
    send({ type: 'mouse', eventType: 'mousePressed', ...point, button: 'left', clickCount: 1, modifiers });
    send({ type: 'mouse', eventType: 'mouseReleased', ...point, button: 'left', clickCount: 1, modifiers });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const point = pointAt(event.clientX, event.clientY);
    if (!point) return;
    keys.current?.focus({ preventScroll: true });
    event.preventDefault();
    if (event.pointerType === 'touch') {
      touch.current = { x: event.clientX, y: event.clientY, scrolled: false };
      return;
    }
    const button = BUTTONS[event.button] ?? 'left';
    pressed.current = button;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    send({
      type: 'mouse',
      eventType: 'mousePressed',
      ...point,
      button,
      clickCount: Math.min(Math.max(event.detail, 1), 3),
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
    if (!pressed.current) return;
    const point = pointAt(event.clientX, event.clientY);
    const button = pressed.current;
    pressed.current = null;
    if (!point) return;
    send({
      type: 'mouse',
      eventType: 'mouseReleased',
      ...point,
      button,
      clickCount: Math.min(Math.max(event.detail, 1), 3),
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
        button: pressed.current ?? 'none',
        modifiers,
      });
    });
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>, down: boolean) => {
    if (!interactive) return;
    // An input method or a phone's keyboard: its text comes as input (below), not as keys.
    if (composing.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Unidentified' || event.key === 'Process') return;
    // Pasting is the browser's own paste event (below), with the text: let it happen.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    event.preventDefault();
    // A key pressed elsewhere (Enter in the address bar, which hands the keyboard over) is released
    // here: the page never saw it go down.
    const id = event.code || event.key;
    if (down) held.current.add(id);
    else if (!held.current.delete(id)) return;
    const text = down ? typedText(event) : undefined;
    send({
      type: 'keyboard',
      eventType: down ? 'keyDown' : 'keyUp',
      key: event.key.slice(0, 32),
      code: event.code.slice(0, 32),
      modifiers: modifiersOf(event),
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
    if (interactive && text) typeText(text);
  };

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    event.currentTarget.value = '';
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
        {kind === 'task' && state.status === 'live' ? (
          state.takenOver ? (
            <Button size="sm" onClick={() => send({ type: 'takeover', on: false })}>
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
            'relative w-full touch-none select-none',
            interactive ? 'cursor-default' : 'cursor-not-allowed',
            // Typing goes to the page: the frame says so.
            'has-[textarea:focus]:outline-1 has-[textarea:focus]:-outline-offset-1 has-[textarea:focus]:outline-solid has-[textarea:focus]:outline-border-focus',
            !hasFrame && 'hidden',
          )}
          style={{ aspectRatio: ratio }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onPointerCancel={() => {
            touch.current = null;
            pressed.current = null;
          }}
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
            tabIndex={interactive ? 0 : -1}
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
      ) : interactive ? (
        <p className="flex items-center gap-2 border-t border-border px-3 py-2 text-caption text-muted-foreground">
          <MousePointerClick aria-hidden className="size-3.5 shrink-0" />
          Click the page to type into it; pasting works too.
        </p>
      ) : null}
    </Panel>
  );
}
