import type { WorkspaceEntry } from '@superagent/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage, ProblemError } from '../../api/client';
import { fetchTaskFile, useTaskFiles } from '../../api/workspaces';
import { cn } from '../../lib/cn';
import { formatBytes, plural } from '../../lib/format';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { Panel } from '../../ui/layout';
import { Markdown } from '../../ui/markdown';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { Segmented } from '../../ui/tabs';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';

/** A file or folder of the workspace, with what's in it. */
export interface FileNode {
  name: string;
  path: string;
  type: WorkspaceEntry['type'];
  size: number | null;
  modifiedAt: string | null;
  children: FileNode[];
}

/**
 * The listing as a tree: folders first, then files, by name (numbers in order). A folder the listing
 * left out (past its depth) is filled in from the paths under it.
 */
export function fileTree(entries: readonly WorkspaceEntry[]): FileNode[] {
  const root: FileNode = {
    name: '',
    path: '',
    type: 'directory',
    size: null,
    modifiedAt: null,
    children: [],
  };
  const byPath = new Map<string, FileNode>([['', root]]);
  const folder = (path: string): FileNode => {
    const found = byPath.get(path);
    if (found) return found;
    const slash = path.lastIndexOf('/');
    const node: FileNode = {
      name: path.slice(slash + 1),
      path,
      type: 'directory',
      size: null,
      modifiedAt: null,
      children: [],
    };
    folder(slash < 0 ? '' : path.slice(0, slash)).children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const entry of entries) {
    const path = entry.path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!path || path === '.') continue;
    if (entry.type === 'directory') {
      folder(path).modifiedAt = entry.modifiedAt;
      continue;
    }
    if (byPath.has(path)) continue;
    const slash = path.lastIndexOf('/');
    const node: FileNode = {
      name: path.slice(slash + 1),
      path,
      type: entry.type,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      children: [],
    };
    folder(slash < 0 ? '' : path.slice(0, slash)).children.push(node);
    byPath.set(path, node);
  }
  const order = (nodes: FileNode[]) => {
    nodes.sort((a, b) =>
      (a.type === 'directory') !== (b.type === 'directory')
        ? a.type === 'directory'
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    for (const node of nodes) order(node.children);
  };
  order(root.children);
  return root.children;
}

const count = (nodes: readonly FileNode[]): number =>
  nodes.reduce((sum, node) => sum + (node.type === 'directory' ? count(node.children) : 1), 0);

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // Shown as an image, where its scripts never run.
  svg: 'image/svg+xml',
};
const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const CODE = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'ps1',
  'sql',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'htm',
  'css',
  'php',
  'swift',
  'lua',
  'r',
]);
/** The most of a file read to show it as text, or as an image. */
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function FileIcon({ node, open }: { node: FileNode; open?: boolean }) {
  const className = 'size-4 shrink-0 text-muted-foreground';
  if (node.type === 'directory')
    return open ? (
      <FolderOpen aria-hidden className={className} />
    ) : (
      <Folder aria-hidden className={className} />
    );
  if (node.type === 'symlink') return <Link2 aria-hidden className={className} />;
  const ext = extension(node.name);
  if (ext in IMAGE_TYPES) return <FileImage aria-hidden className={className} />;
  if (MARKDOWN.has(ext) || ext === 'txt') return <FileText aria-hidden className={className} />;
  if (CODE.has(ext)) return <FileCode aria-hidden className={className} />;
  return <File aria-hidden className={className} />;
}

/** Saves a workspace file through the browser's own download. */
async function download(taskId: string, node: FileNode): Promise<void> {
  try {
    const blob = await fetchTaskFile(taskId, node.path);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = node.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    toast.error(`Couldn’t download ${node.name}`, errorMessage(error));
  }
}

/** What the agents working on a task wrote in its workspace: browse, preview, download. */
export function TaskFiles({ taskId }: { taskId: string }) {
  const files = useTaskFiles(taskId);
  const tree = useMemo(() => fileTree(files.data?.items ?? []), [files.data]);
  const [previewing, setPreviewing] = useState<FileNode | null>(null);

  if (files.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">Loading the files…</span>
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }
  if (files.isError) {
    const problem = files.error instanceof ProblemError ? files.error : null;
    if (problem?.status === 404) return <NoFiles />;
    return (
      <Notice
        tone={problem?.status === 503 ? 'warning' : 'destructive'}
        title={problem?.status === 503 ? 'Workspaces can’t be read now' : 'Couldn’t load the files'}
        action={
          <Button size="sm" onClick={() => files.refetch()}>
            Retry
          </Button>
        }
      >
        {errorMessage(files.error)}
      </Notice>
    );
  }
  if (tree.length === 0) return <NoFiles />;

  const total = count(tree);
  return (
    <>
      <Panel className="flex flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <p className="text-label text-foreground">{plural(total, 'file')}</p>
          <Button
            size="icon-sm"
            variant="ghost"
            tooltip="Look again"
            disabled={files.isFetching}
            onClick={() => files.refetch()}
          >
            <RefreshCw aria-hidden className={cn(files.isFetching && 'motion-safe:animate-spin')} />
          </Button>
        </div>
        <FileList
          nodes={tree}
          depth={0}
          openAll={total <= 40}
          onPreview={setPreviewing}
          onDownload={(node) => void download(taskId, node)}
        />
        {files.data.truncated ? (
          <p className="border-t border-border px-4 py-2 text-caption text-muted-foreground">
            There are more files than shown here.
          </p>
        ) : null}
      </Panel>
      <FilePreview
        taskId={taskId}
        file={previewing}
        onOpenChange={(open) => {
          if (!open) setPreviewing(null);
        }}
      />
    </>
  );
}

function NoFiles() {
  return (
    <EmptyState
      compact
      icon={<Folder />}
      title="No files yet"
      description="What the agents write while they work on this task shows up here."
    />
  );
}

const rowClass = cn(
  'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-body-sm text-foreground outline-hidden hover:bg-fill-subtle',
  colorTransition,
  focusRingInset,
);

function FileList({
  nodes,
  depth,
  openAll,
  onPreview,
  onDownload,
}: {
  nodes: readonly FileNode[];
  depth: number;
  openAll: boolean;
  onPreview: (node: FileNode) => void;
  onDownload: (node: FileNode) => void;
}) {
  return (
    <ul
      className={cn('flex flex-col', depth === 0 && 'px-2 py-1.5')}
      aria-label={depth === 0 ? 'Files' : undefined}
    >
      {nodes.map((node) =>
        node.type === 'directory' ? (
          <FolderRow
            key={node.path}
            node={node}
            depth={depth}
            openAll={openAll}
            onPreview={onPreview}
            onDownload={onDownload}
          />
        ) : (
          <li key={node.path} className="flex items-center gap-1">
            <button
              type="button"
              className={rowClass}
              style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
              onClick={() => onPreview(node)}
            >
              <FileIcon node={node} />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.size !== null ? (
                <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                  {formatBytes(node.size)}
                </span>
              ) : null}
              {node.modifiedAt ? (
                <span className="hidden w-24 shrink-0 text-right text-caption text-muted-foreground sm:block">
                  <RelativeTime iso={node.modifiedAt} />
                </span>
              ) : null}
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              tooltip={`Download ${node.name}`}
              onClick={() => onDownload(node)}
            >
              <Download aria-hidden />
            </Button>
          </li>
        ),
      )}
    </ul>
  );
}

function FolderRow({
  node,
  depth,
  openAll,
  onPreview,
  onDownload,
}: {
  node: FileNode;
  depth: number;
  openAll: boolean;
  onPreview: (node: FileNode) => void;
  onDownload: (node: FileNode) => void;
}) {
  const [open, setOpen] = useState(openAll);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        className={cn(rowClass, 'pr-10')}
        style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
        onClick={() => setOpen((shown) => !shown)}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            '-ml-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <FileIcon node={node} open={open} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
          {node.children.length}
        </span>
      </button>
      {open && node.children.length > 0 ? (
        <FileList
          nodes={node.children}
          depth={depth + 1}
          openAll={openAll}
          onPreview={onPreview}
          onDownload={onDownload}
        />
      ) : null}
    </li>
  );
}

type Preview =
  | { kind: 'text'; text: string; markdown: boolean }
  | { kind: 'image'; blob: Blob }
  | { kind: 'binary' }
  | { kind: 'large' };

/** What a file looks like: text (decoded as UTF-8), an image, or neither. */
async function previewOf(taskId: string, node: FileNode, signal: AbortSignal): Promise<Preview> {
  const ext = extension(node.name);
  const image = IMAGE_TYPES[ext];
  const limit = image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (node.size !== null && node.size > limit) return { kind: 'large' };
  const blob = await fetchTaskFile(taskId, node.path, signal);
  if (image) return { kind: 'image', blob: new Blob([blob], { type: image }) };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // A NUL in the first few kilobytes: not text.
  if (bytes.subarray(0, 8000).includes(0)) return { kind: 'binary' };
  return { kind: 'text', text: new TextDecoder().decode(bytes), markdown: MARKDOWN.has(ext) };
}

function FilePreview({
  taskId,
  file,
  onOpenChange,
}: {
  taskId: string;
  /** The file shown; the dialog is open while there is one. */
  file: FileNode | null;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useQuery({
    // Keyed by when it changed: a file's content at a time doesn't change, and it stays out of the
    // task's keys, which every task event refreshes.
    queryKey: ['workspace-file', taskId, file?.path ?? '', file?.modifiedAt ?? ''],
    queryFn: ({ signal }) => previewOf(taskId, file as FileNode, signal),
    enabled: file !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
  });
  const [view, setView] = useState<'rendered' | 'source'>('rendered');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const data = preview.data;

  // Each file opens formatted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each file shown
  useEffect(() => setView('rendered'), [file?.path]);

  useEffect(() => {
    if (data?.kind !== 'image') return;
    const url = URL.createObjectURL(data.blob);
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setImageUrl(null);
    };
  }, [data]);

  return (
    <Dialog
      open={file !== null}
      onOpenChange={onOpenChange}
      size="lg"
      title={file?.name ?? ''}
      description={
        file
          ? [
              // Where it is, when that's more than its name.
              file.path !== file.name ? file.path : null,
              file.size !== null ? formatBytes(file.size) : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      footer={
        <>
          {data?.kind === 'text' && data.markdown ? (
            <Segmented
              aria-label="Show"
              size="sm"
              className="mr-auto"
              value={view}
              onValueChange={setView}
              options={[
                { value: 'rendered', label: 'Formatted' },
                { value: 'source', label: 'Source' },
              ]}
            />
          ) : null}
          <Button variant="primary" disabled={!file} onClick={() => file && void download(taskId, file)}>
            <Download aria-hidden />
            Download
          </Button>
        </>
      }
    >
      <div className="pb-2">
        {preview.isPending ? (
          <div role="status">
            <span className="sr-only">Loading the file…</span>
            <Skeleton className="h-48 rounded-lg" />
          </div>
        ) : preview.isError ? (
          <Notice tone="destructive" title="Couldn’t open it">
            {errorMessage(preview.error)}
          </Notice>
        ) : data?.kind === 'large' ? (
          <p className="text-body-sm text-muted-foreground">Too large to show here: download it.</p>
        ) : data?.kind === 'binary' ? (
          <p className="text-body-sm text-muted-foreground">
            There’s no preview for this kind of file: download it.
          </p>
        ) : data?.kind === 'image' ? (
          imageUrl ? (
            <img
              src={imageUrl}
              alt={file?.name ?? ''}
              className="mx-auto max-h-[60vh] max-w-full rounded-lg"
            />
          ) : null
        ) : data?.kind === 'text' ? (
          data.markdown && view === 'rendered' ? (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg bg-fill-subtle px-4 py-3">
              <Markdown>{data.text}</Markdown>
            </div>
          ) : data.text.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">It’s empty.</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-fill-subtle px-4 py-3 font-mono text-caption whitespace-pre-wrap break-words text-foreground">
              {data.text}
            </pre>
          )
        ) : null}
      </div>
    </Dialog>
  );
}
