import { posix } from 'node:path';
import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  type FileContent,
  type FileEntry,
  FileExistsError,
  FileNotFoundError,
  type FileStat,
  FilesystemError,
  IsDirectoryError,
  type ListOptions,
  MastraFilesystem,
  NotDirectoryError,
  type ProviderStatus,
  type ReadOptions,
  type RemoveOptions,
  StaleFileError,
  type WriteOptions,
} from '@mastra/core/workspace';
import type { FsRequest, FsResult, FsStat } from '@superagent/shared/runner';
import { type RunnerClient, RunnerRequestError } from './runner-client';

/** Files an agent reads in one go. Bigger ones: read them in pieces with a command. */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/**
 * Mime types by extension. Mastra's read_file decides from them whether a file is text, a media part
 * it can show the model (images, PDFs) or a binary it only describes.
 */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/vnd.sqlite3',
  '.wasm': 'application/wasm',
  '.pyc': 'application/x-python-code',
  '.so': 'application/x-sharedlib',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
};

/** A file's mime type; one that looks binary is never passed off as text, whatever its name. */
export function mimeTypeOf(path: string, binary: boolean): string | undefined {
  const known = MIME_TYPES[posix.extname(path).toLowerCase()];
  if (known && !(binary && (known.startsWith('text/') || known === 'application/json'))) return known;
  // Not text, and nothing more specific known: read_file describes it instead of decoding it.
  return binary ? 'application/x-binary' : undefined;
}

/**
 * A task's files, in its sandbox (decision D33). Every operation runs inside the task's container, so
 * a symlink planted there resolves there, never in the API's filesystem.
 */
export class RunnerFilesystem extends MastraFilesystem {
  readonly id: string;
  readonly name = 'Task files';
  readonly provider = 'superagent-runner';
  readonly basePath = '/workspace';
  status: ProviderStatus = 'ready';

  constructor(
    private readonly client: RunnerClient,
    readonly taskId: string,
    private readonly profile: string,
  ) {
    super({ name: 'Task files' });
    this.id = `files-${taskId}`;
  }

  getInstructions(): string {
    return "Files are in this task's sandbox, under /workspace; relative paths start there.";
  }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const result = await this.call({ op: 'read', path, maxBytes: MAX_READ_BYTES }, path);
    if (result.truncated) {
      throw new FilesystemError(
        `${path} is larger than ${MAX_READ_BYTES} bytes: read parts of it with a command (head, sed, tail)`,
        'EFBIG',
        path,
      );
    }
    const content = Buffer.from(result.contentBase64 ?? '', 'base64');
    return options?.encoding ? content.toString(options.encoding) : content;
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    await this.call(
      {
        op: 'write',
        path,
        contentBase64: Buffer.from(content).toString('base64'),
        mode: options?.overwrite === false ? 'create' : 'overwrite',
        ...(options?.expectedMtime ? { expectedMtimeMs: options.expectedMtime.getTime() } : {}),
      },
      path,
      options?.expectedMtime,
    );
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    await this.call(
      { op: 'write', path, contentBase64: Buffer.from(content).toString('base64'), mode: 'append' },
      path,
    );
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    await this.call({ op: 'remove', path, kind: 'file', force: options?.force ?? false }, path);
  }

  async copyFile(src: string, dest: string, options?: { overwrite?: boolean }): Promise<void> {
    await this.call({ op: 'copy', path: src, dest, overwrite: options?.overwrite ?? true }, src);
  }

  async moveFile(src: string, dest: string, options?: { overwrite?: boolean }): Promise<void> {
    await this.call({ op: 'move', path: src, dest, overwrite: options?.overwrite ?? true }, src);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.call({ op: 'mkdir', path, recursive: options?.recursive ?? true }, path);
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    await this.call(
      {
        op: 'remove',
        path,
        kind: 'directory',
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      },
      path,
    );
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    const maxDepth = options?.recursive ? Math.min((options.maxDepth ?? 10) + 1, 20) : 1;
    const result = await this.call({ op: 'list', path, maxDepth, limit: 5_000 }, path, undefined, true);
    const extensions = options?.extension
      ? (Array.isArray(options.extension) ? options.extension : [options.extension]).map((e) =>
          e.startsWith('.') ? e : `.${e}`,
        )
      : undefined;
    return (result.entries ?? []).flatMap((entry) => {
      const type = entry.type === 'directory' ? 'directory' : 'file';
      if (extensions && type === 'file' && !extensions.includes(posix.extname(entry.path))) return [];
      return [
        {
          name: entry.path,
          type,
          ...(type === 'file' ? { size: entry.size } : {}),
          ...(entry.type === 'symlink' ? { isSymlink: true, symlinkTarget: entry.target } : {}),
        },
      ];
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof FileNotFoundError) return false;
      throw error;
    }
  }

  async stat(path: string): Promise<FileStat> {
    const stat = (await this.call({ op: 'stat', path }, path)).stat as FsStat;
    const modifiedAt = new Date(stat.mtimeMs);
    return {
      name: posix.basename(stat.path),
      path: stat.path,
      type: stat.type === 'directory' ? 'directory' : 'file',
      size: stat.size,
      createdAt: modifiedAt,
      modifiedAt,
      ...(stat.type === 'file' ? { mimeType: mimeTypeOf(stat.path, stat.binary) } : {}),
    };
  }

  /** Runs one operation in the sandbox, turning runner errors into the workspace's file errors. */
  private async call(
    request: FsRequest,
    path: string,
    expectedMtime?: Date,
    isDirectory = false,
  ): Promise<FsResult> {
    try {
      return await this.client.fs(this.taskId, request, { profile: this.profile });
    } catch (error) {
      if (!(error instanceof RunnerRequestError)) throw error;
      switch (error.code) {
        case 'not_found':
          throw isDirectory ? new DirectoryNotFoundError(path) : new FileNotFoundError(path);
        case 'is_directory':
          throw new IsDirectoryError(path);
        case 'not_directory':
          throw new NotDirectoryError(path);
        case 'exists':
          throw new FileExistsError(path);
        case 'not_empty':
          throw new DirectoryNotEmptyError(path);
        case 'stale':
          throw new StaleFileError(path, expectedMtime ?? new Date(0), new Date());
        default:
          throw new FilesystemError(error.message, error.code, path);
      }
    }
  }
}
