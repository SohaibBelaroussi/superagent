import { useEffect, useRef, useState } from 'react';

/**
 * An editor's draft of something the server keeps. What you changed is the difference from where
 * editing started (`base`), so a save sends only that: a field changed elsewhere meanwhile is never
 * written back with its old value. When the server's copy changes while you edit (saved on another
 * device, or by an agent), the draft takes it in and keeps your changes on top, and `changedElsewhere`
 * says so until you save or discard.
 */
export function useServerDraft<S, D extends object, C extends object>({
  server,
  revision,
  toDraft,
  diff,
}: {
  /** The server's copy now. */
  server: S;
  /** Changes whenever the server's copy does: its `updatedAt`, or the object itself. */
  revision: unknown;
  toDraft: (server: S) => D;
  /** What of `draft` differs from `base`, as the update to send (keyed by the draft's fields). */
  diff: (base: D, draft: D) => C;
}) {
  const [base, setBase] = useState<D>(() => toDraft(server));
  const [draft, setDraft] = useState<D>(base);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const seen = useRef(revision);
  const saving = useRef(false);
  const changes = diff(base, draft);
  const dirty = Object.keys(changes).length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new server copy only
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    // A save under way makes what it saved the new start itself.
    if (saving.current) return;
    const latest = toDraft(server);
    setBase(latest);
    setDraft(keepChanges(latest, draft, changes));
    if (dirty) setChangedElsewhere(true);
  }, [revision]);

  return {
    draft,
    /** Changes some fields of the draft. */
    patch: (next: Partial<D>) => setDraft((current) => ({ ...current, ...next })),
    changes,
    dirty,
    changedElsewhere,
    /** Throws your changes away: back to the server's copy. */
    discard: () => {
      const latest = toDraft(server);
      setBase(latest);
      setDraft(latest);
      setChangedElsewhere(false);
    },
    /**
     * Sends the changes with `send`. What it returns is the new start; anything typed while it was
     * saving stays a change.
     */
    save: async (send: (changes: C) => Promise<S>): Promise<S> => {
      saving.current = true;
      try {
        const saved = await send(changes);
        setBase(toDraft(saved));
        setChangedElsewhere(false);
        return saved;
      } finally {
        saving.current = false;
      }
    },
  };
}

/** `latest`, with the fields you changed (the keys of `changes`) taken from `draft`. */
function keepChanges<D extends object, C extends object>(latest: D, draft: D, changes: C): D {
  const next = { ...latest };
  for (const key of Object.keys(changes) as (keyof D & keyof C)[]) next[key] = draft[key];
  return next;
}
