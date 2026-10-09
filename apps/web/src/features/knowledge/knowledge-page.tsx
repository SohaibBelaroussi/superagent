import {
  departmentTone,
  errorMessage,
  formatBytes,
  type OrgLookup,
  plural,
  randomId,
} from '@superagent/client';
import type { KnowledgeDocument, KnowledgeHit } from '@superagent/shared';
import { CircleAlert, CircleCheck, FileText, Library, Search, Trash2, Upload } from 'lucide-react';
import { type DragEvent, type ReactNode, useDeferredValue, useRef, useState } from 'react';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  useDeleteDocument,
  useDocuments,
  useKnowledgeSearch,
  useUploadDocument,
} from '../../api/knowledge';
import { cn } from '../../lib/cn';
import { useDocumentTitle } from '../../lib/title';
import { TONE_DOT } from '../../lib/tones';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton, Spinner } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { Page, PageHeader, Section } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';
import { Select } from '../../ui/select';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { useOrg } from '../tasks/org';

const SHARED = 'shared';
const ALL = 'all';

interface UploadState {
  id: string;
  name: string;
  status: 'waiting' | 'uploading' | 'done' | 'failed';
  detail?: string;
}

/** Documents agents search with `knowledge_search`: upload, search and delete them. */
export function KnowledgePage() {
  useDocumentTitle('Knowledge');
  const org = useOrg();
  const documents = useDocuments();
  /** Whose documents: every one, or what one department's agents can search (its own and the shared). */
  const [scope, setScope] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const scopeDepartment = scope === ALL ? undefined : scope;
  const results = useKnowledgeSearch(deferred, scopeDepartment);
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null);
  const remove = useDeleteDocument();

  const listed = (documents.data ?? []).filter(
    (document) =>
      !scopeDepartment || document.departmentId === null || document.departmentId === scopeDepartment,
  );

  return (
    <Page
      width="medium"
      header={
        <PageHeader
          title="Knowledge"
          description="Documents your agents can search with the knowledge_search tool. Share one with every department, or keep it to one."
        />
      }
    >
      <div className="flex flex-col gap-8">
        <Uploader org={org} />

        <Section
          title="Documents"
          action={
            <Select
              aria-label="Whose documents"
              size="sm"
              value={scope}
              onValueChange={setScope}
              className="min-w-48"
              options={[
                { value: ALL, label: 'Every document' },
                ...org.departments.map((department) => ({
                  value: department.id,
                  label: `What ${department.name} can search`,
                  icon: <Dot slug={department.slug} />,
                })),
              ]}
            />
          }
        >
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-placeholder"
            />
            <Input
              type="search"
              aria-label="Search the documents"
              placeholder="Search them as an agent would"
              value={query}
              maxLength={400}
              onChange={(event) => setQuery(event.target.value)}
              className="h-control-lg pl-10"
            />
          </div>

          {query.trim() ? (
            <SearchResults
              query={deferred}
              loading={results.isFetching}
              error={results.isError ? errorMessage(results.error) : null}
              hits={results.data ?? []}
              org={org}
            />
          ) : documents.isError ? (
            <Notice
              tone="destructive"
              title="Couldn’t load the documents"
              action={
                <Button size="sm" onClick={() => documents.refetch()}>
                  Retry
                </Button>
              }
            >
              {errorMessage(documents.error)}
            </Notice>
          ) : documents.isPending ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : listed.length === 0 ? (
            <EmptyState
              compact
              icon={<Library />}
              title="No documents yet"
              description="Upload notes, guides, reports or PDFs above. Agents with the knowledge_search tool find the passages they need."
            />
          ) : (
            <ul className={cn('divide-y divide-border rounded-xl', raisedSurface)} aria-label="Documents">
              {listed.map((document) => (
                <li key={document.id} className="flex items-center gap-3 px-4 py-3">
                  <FileText aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="truncate text-label text-foreground">{document.title}</p>
                    <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground">
                      <DepartmentName org={org} id={document.departmentId} />
                      <span aria-hidden>·</span>
                      <span>{plural(document.chunkCount, 'passage')}</span>
                      <span aria-hidden>·</span>
                      <span>{formatBytes(document.size)}</span>
                      <span aria-hidden>·</span>
                      <RelativeTime iso={document.createdAt} />
                      {document.filename !== document.title ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="truncate">{document.filename}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={`Delete ${document.title}`}
                    onClick={() => setDeleting(document)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete “${deleting?.title ?? ''}”?`}
        description="Agents can no longer find it, and the file is removed. This can’t be undone."
        confirmLabel="Delete document"
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Document deleted');
              setDeleting(null);
            },
            onError: () => setDeleting(null),
          });
        }}
      />
    </Page>
  );
}

/** Drop or choose files; they go up one at a time, each saying how it went. */
function Uploader({ org }: { org: OrgLookup }) {
  const upload = useUploadDocument();
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string>(SHARED);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [over, setOver] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const set = (id: string, next: Partial<UploadState>) =>
    setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...next } : item)));

  const add = (files: readonly File[]) => {
    const departmentId = target === SHARED ? undefined : target;
    for (const file of files) {
      const id = randomId();
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploads((current) => [
          ...current,
          { id, name: file.name, status: 'failed', detail: 'Larger than 20 MB, the most one upload can be.' },
        ]);
        continue;
      }
      setUploads((current) => [...current, { id, name: file.name, status: 'waiting' }]);
      // One at a time: each file's text is read on the server before the next arrives.
      queue.current = queue.current.then(async () => {
        set(id, { status: 'uploading' });
        try {
          const document = await upload.mutateAsync({ file, departmentId });
          set(id, { status: 'done', detail: `${plural(document.chunkCount, 'passage')} to search` });
        } catch (error) {
          set(id, { status: 'failed', detail: errorMessage(error) });
        }
      });
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    add([...event.dataTransfer.files]);
  };

  return (
    <section aria-label="Upload documents" className="flex flex-col gap-3">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for the mouse; the button inside chooses files from the keyboard */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-7 text-center transition-colors duration-150',
          over ? 'border-border-focus bg-fill-subtle' : 'border-border-strong',
        )}
      >
        <div className="flex size-10 items-center justify-center rounded-full bg-fill-subtle text-muted-foreground shadow-rim">
          <Upload aria-hidden className="size-5" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-subheading text-foreground">Drop files here, or choose them</p>
          <p className="text-caption text-muted-foreground">
            Text, Markdown, CSV, JSON, HTML or PDF, up to 20 MB each.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Select
            aria-label="Who can search them"
            value={target}
            onValueChange={setTarget}
            className="min-w-52"
            options={[
              { value: SHARED, label: 'Every department' },
              ...org.departments.map((department) => ({
                value: department.id,
                label: `Only ${department.name}`,
                icon: <Dot slug={department.slug} />,
              })),
            ]}
          />
          <Button variant="primary" onClick={() => input.current?.click()}>
            <Upload aria-hidden />
            Choose files
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              add([...(event.target.files ?? [])]);
              // The same file chosen again is a new upload.
              event.target.value = '';
            }}
          />
        </div>
      </div>
      {uploads.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Uploads" aria-live="polite">
          {uploads.map((item) => (
            <li key={item.id} className="flex items-start gap-2.5 text-body-sm">
              <span className="mt-0.5 flex shrink-0">
                {item.status === 'done' ? (
                  <CircleCheck aria-hidden className="size-4 text-success-indicator" />
                ) : item.status === 'failed' ? (
                  <CircleAlert aria-hidden className="size-4 text-destructive-indicator" />
                ) : (
                  <Spinner className={item.status === 'waiting' ? 'opacity-40' : undefined} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground">{item.name}</span>
                <span className="text-muted-foreground">
                  {' '}
                  {item.status === 'waiting'
                    ? 'waits its turn'
                    : item.status === 'uploading'
                      ? 'is being read…'
                      : `· ${item.detail ?? ''}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SearchResults({
  query,
  loading,
  error,
  hits,
  org,
}: {
  query: string;
  loading: boolean;
  error: string | null;
  hits: readonly KnowledgeHit[];
  org: OrgLookup;
}) {
  if (error)
    return (
      <Notice tone="destructive" title="Couldn’t search">
        {error}
      </Notice>
    );
  if (hits.length === 0) {
    return loading ? (
      <Skeleton className="h-32 rounded-xl" />
    ) : (
      <div role="status">
        <EmptyState
          compact
          icon={<Search />}
          title="Nothing found"
          description="No passage matches those words."
        />
      </div>
    );
  }
  return (
    <>
      <p role="status" className="sr-only">
        {plural(hits.length, 'passage')} found
      </p>
      <ol className={cn('flex flex-col gap-2', loading && 'opacity-70')} aria-label="Search results">
        {hits.map((hit) => (
          <li
            key={`${hit.documentId}:${hit.passage}`}
            className={cn('flex flex-col gap-1.5 rounded-xl px-4 py-3', raisedSurface)}
          >
            <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground">
              <span className="text-label text-foreground">{hit.title}</span>
              <span aria-hidden>·</span>
              <span>passage {hit.passage + 1}</span>
              <span aria-hidden>·</span>
              <DepartmentName org={org} id={hit.departmentId} />
            </p>
            <p className="line-clamp-5 text-body-sm whitespace-pre-wrap text-foreground/85">
              <Highlight text={hit.content} query={query} />
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

/** `text` with the words of `query` marked. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  if (words.length === 0) return text;
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  );
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order
      <mark key={index} className="rounded-[3px] bg-badge-amber-subtle text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function DepartmentName({ org, id }: { org: OrgLookup; id: string | null }) {
  if (!id) return <span>Every department</span>;
  const department = org.department(id);
  return (
    <span className="flex items-center gap-1">
      <Dot slug={department?.slug ?? ''} />
      {department ? `Only ${department.name}` : 'One department'}
    </span>
  );
}

function Dot({ slug }: { slug: string }) {
  return (
    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[departmentTone(slug)])} />
  );
}
