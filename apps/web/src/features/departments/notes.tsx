import { errorMessage } from '@superagent/client';
import type { Department } from '@superagent/shared';
import { useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { latestNotes, useDepartmentNotes, useSaveDepartmentNotes } from '../../api/memory';
import { Loaded } from '../../layout/loaded';
import { useReportUnsaved } from '../../lib/unsaved';
import { Button } from '../../ui/button';
import { EmptyState, Notice, Spinner } from '../../ui/feedback';
import { Textarea } from '../../ui/field';
import { Panel } from '../../ui/layout';
import { Markdown } from '../../ui/markdown';
import { toast } from '../../ui/toast';

const MAX_NOTES = 20_000;

/**
 * A department's notes: rules and lessons its lead keeps across tasks, which you can correct. The lead
 * writes them too, so a save first checks they haven't changed since you started.
 */
export function NotesTab({
  department,
  readOnly,
  onUnsavedChange,
}: {
  department: Department;
  readOnly: boolean;
  /** Whether the notes being written aren't saved: the page asks before you leave. */
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const notes = useDepartmentNotes(department.id);
  /** The notes as they were when you started editing; undefined while you're not. */
  const [base, setBase] = useState<string | null | undefined>(undefined);
  const lead = department.lead?.name;

  return (
    <Loaded
      query={notes}
      failure="Couldn’t load the notes"
      skeleton={<Panel className="h-48 animate-pulse" />}
    >
      {(current) =>
        base !== undefined ? (
          <NotesEditor
            department={department}
            base={base}
            onDone={() => setBase(undefined)}
            onUnsavedChange={onUnsavedChange}
          />
        ) : current ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-caption text-muted-foreground">
                Kept by {lead ?? 'the lead'} across tasks. Changes here apply from its next task.
              </p>
              {readOnly ? null : (
                <Button size="sm" onClick={() => setBase(current)}>
                  <Pencil aria-hidden />
                  Edit
                </Button>
              )}
            </div>
            <Panel className="px-5 py-4">
              <Markdown>{current}</Markdown>
            </Panel>
          </div>
        ) : (
          <Panel>
            <EmptyState
              compact
              icon={<NotebookPen />}
              title="No notes yet"
              description={`${lead ?? 'The lead'} keeps notes here as it works: your rules, what it learned, what to remember from one task to the next.`}
              action={
                readOnly ? undefined : (
                  <Button onClick={() => setBase(null)}>
                    <Pencil aria-hidden />
                    Write the first notes
                  </Button>
                )
              }
            />
          </Panel>
        )
      }
    </Loaded>
  );
}

function NotesEditor({
  department,
  base,
  onDone,
  onUnsavedChange,
}: {
  department: Department;
  base: string | null;
  onDone: () => void;
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const save = useSaveDepartmentNotes(department.id);
  const lead = department.lead?.name;
  const [text, setText] = useState(base ?? '');
  /** Notes the lead saved while you were editing. */
  const [theirs, setTheirs] = useState<string | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== (base ?? '');
  useReportUnsaved(dirty, onUnsavedChange);
  const id = `notes-${department.id}`;

  // The button that opened the editor is gone: the keyboard goes to the text.
  useEffect(() => input.current?.focus(), []);

  async function submit(overwrite: boolean) {
    if (!overwrite) {
      setChecking(true);
      try {
        const latest = await latestNotes(queryClient, department.id);
        // No notes and empty notes are the same: only a real change is a conflict.
        if ((latest ?? '') !== (base ?? '')) {
          setTheirs(latest);
          return;
        }
      } catch (error) {
        toast.error('Couldn’t check the notes', errorMessage(error));
        return;
      } finally {
        setChecking(false);
      }
    }
    save.mutate(text, {
      onSuccess: () => {
        onDone();
        toast.success('Notes saved', `${lead ?? 'The lead'} follows them from its next task.`);
      },
    });
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      {theirs !== undefined ? (
        <Notice
          tone="warning"
          title={`${lead ?? 'The lead'} changed these notes while you were editing`}
          action={
            <div className="flex flex-col gap-1.5 sm:flex-row">
              <Button size="sm" onClick={() => void submit(true)} disabled={save.isPending}>
                Replace with mine
              </Button>
              <Button size="sm" variant="ghost" onClick={onDone}>
                Keep theirs
              </Button>
            </div>
          }
        >
          Theirs now read:
          <Markdown className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-fill-subtle px-3 py-2 shadow-rim">
            {theirs || '_(empty)_'}
          </Markdown>
        </Notice>
      ) : null}
      <label htmlFor={id} className="text-label text-foreground">
        {department.name}’s notes
      </label>
      <Textarea
        ref={input}
        id={id}
        aria-describedby={`${id}-hint`}
        value={text}
        maxLength={MAX_NOTES}
        className="max-h-[70dvh] min-h-80 font-mono text-body-sm"
        onChange={(event) => setText(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-caption text-muted-foreground">
        Markdown. One rule or lesson per line works best: {lead ?? 'the lead'} reads all of it on every task.{' '}
        <span className="tabular-nums">
          {text.length.toLocaleString()} / {MAX_NOTES.toLocaleString()}
        </span>
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || checking || save.isPending}>
          {checking || save.isPending ? <Spinner /> : null}
          Save notes
        </Button>
      </div>
    </form>
  );
}
