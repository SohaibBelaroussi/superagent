// Unpacks a plugin's .tar.gz in a worker thread, as it downloads: the archive streams in as chunks,
// is gunzipped and read as tar, and only the plugin's files are kept, in memory (nothing touches the
// disk). Paths, entry types and sizes are checked here, and a hostile archive (a gzip bomb, a million
// entries) only costs this worker, which the caller limits in memory and time. Self-contained on
// purpose: no imports from the app, so Node runs it straight from source and from the bundle.
import { parentPort, workerData } from 'node:worker_threads';
import { createGunzip } from 'node:zlib';

export interface ArchiveLimits {
  /** Decompressed bytes that may stream past (a gzip bomb stops here). */
  streamed: number;
  /** Bytes kept, files kept, bytes per file. */
  kept: number;
  files: number;
  file: number;
}

export interface ArchiveRequest {
  /**
   * Strip exactly one top folder (GitHub tarballs: <owner>-<repo>-<sha7>/), then this folder (a plugin
   * in a subfolder). Null `root`: keep the archive's own layout (a common top folder is dropped after).
   */
  stripTop: boolean;
  root: string | null;
  /** Keep only these (relative to the plugin root): "dir/" prefixes or exact paths. Null: keep all. */
  keep: string[] | null;
  limits: ArchiveLimits;
}

export interface ArchiveFile {
  path: string;
  mode: number;
  data: Uint8Array;
}

export type WorkerMessage =
  | { type: 'ack' }
  | { type: 'done'; files: ArchiveFile[]; comment: string | null; refused: string[] }
  | { type: 'error'; message: string };

class ArchiveError extends Error {}

const request = workerData as ArchiveRequest;
const port = parentPort;

const kept: ArchiveFile[] = [];
const refused: string[] = [];
const seen = new Set<string>();
let keptBytes = 0;
let streamed = 0;
let comment: string | null = null;
let top: string | undefined;

/** A path inside the plugin, or undefined when the entry isn't part of it. Throws on a bad path. */
function pluginPath(raw: string): string | undefined {
  if (raw.includes('\0') || raw.includes('\\')) throw new ArchiveError(`Bad path in the archive: ${raw}`);
  let path = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path) return undefined;
  if (path.startsWith('/')) throw new ArchiveError(`Absolute path in the archive: ${raw}`);
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ArchiveError(`Bad path in the archive: ${raw}`);
  }
  if (request.stripTop) {
    const [first, ...rest] = parts;
    top ??= first;
    if (first !== top) throw new ArchiveError('The archive has more than one top folder');
    path = rest.join('/');
    if (!path) return undefined;
  }
  if (request.root) {
    if (!path.startsWith(`${request.root}/`)) return undefined;
    path = path.slice(request.root.length + 1);
  }
  if (path.length > 300) throw new ArchiveError(`Path too long in the archive: ${path.slice(0, 80)}…`);
  return path.normalize('NFC');
}

function wanted(path: string): boolean {
  if (!request.keep) return true;
  return request.keep.some((rule) => (rule.endsWith('/') ? path.startsWith(rule) : path === rule));
}

/** A streaming ustar/pax reader: headers need 512 contiguous bytes; file data is consumed in place. */
class TarReader {
  private buffer: Buffer = Buffer.alloc(0);
  private state: 'header' | 'data' | 'pad' = 'header';
  private left = 0;
  private pad = 0;
  private entry:
    | { type: string; path: string | undefined; mode: number; size: number; keep: boolean; chunks: Buffer[] }
    | undefined;
  private pax: Record<string, string> = {};

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.state === 'header') {
        if (this.buffer.length < 512) return;
        const header = this.buffer.subarray(0, 512);
        this.buffer = this.buffer.subarray(512);
        if (header.every((byte) => byte === 0)) continue;
        this.begin(header);
      }
      if (this.state === 'data' && this.entry) {
        const take = Math.min(this.left, this.buffer.length);
        if (this.entry.keep && take > 0) this.entry.chunks.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.left -= take;
        if (this.left > 0) return;
        this.finish(this.entry);
        this.state = 'pad';
      }
      if (this.state === 'pad') {
        const take = Math.min(this.pad, this.buffer.length);
        this.buffer = this.buffer.subarray(take);
        this.pad -= take;
        if (this.pad > 0) return;
        this.state = 'header';
      }
    }
  }

  private begin(header: Buffer): void {
    const text = (offset: number, length: number) =>
      header
        .subarray(offset, offset + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const octal = (offset: number, length: number) => Number.parseInt(text(offset, length).trim() || '0', 8);
    const size = octal(124, 12);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError('Corrupt tar header');
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'L' || type === 'K') throw new ArchiveError('GNU long-name entries are not supported');
    const prefix = text(345, 155);
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    const meta = type === 'x' || type === 'g';
    if (meta && size > 65_536) throw new ArchiveError('An oversized pax header');
    let path: string | undefined;
    let keep = meta;
    if (!meta) {
      path = pluginPath(this.pax.path ?? name);
      this.pax = {};
      if (path !== undefined && wanted(path)) {
        if (type === '5') keep = false;
        else if (type !== '0' && type !== '\0') {
          const kind = { '1': 'hard link', '2': 'symlink', '3': 'device', '4': 'device', '6': 'FIFO' }[type];
          refused.push(`${path} (${kind ?? `entry type ${type}`})`);
        } else {
          if (size > request.limits.file)
            throw new ArchiveError(`${path} is larger than ${request.limits.file} bytes`);
          const folded = path.toLowerCase();
          if (seen.has(folded))
            throw new ArchiveError(`${path} appears twice (names differing in case only)`);
          seen.add(folded);
          keptBytes += size;
          if (kept.length >= request.limits.files) throw new ArchiveError('The plugin has too many files');
          if (keptBytes > request.limits.kept) throw new ArchiveError('The plugin is too large');
          keep = true;
        }
      }
    }
    this.entry = { type, path, mode: octal(100, 8) & 0o777, size, keep, chunks: [] };
    this.left = size;
    this.pad = (512 - (size % 512)) % 512;
    this.state = 'data';
  }

  private finish(entry: NonNullable<TarReader['entry']>): void {
    const data = Buffer.concat(entry.chunks);
    if (entry.type === 'x' || entry.type === 'g') {
      const record: Record<string, string> = {};
      for (let at = 0; at < data.length; ) {
        const space = data.indexOf(32, at);
        const length = Number(data.subarray(at, space).toString());
        if (space < 0 || !Number.isInteger(length) || length <= 0)
          throw new ArchiveError('Corrupt pax header');
        const pair = data.subarray(space + 1, at + length - 1).toString('utf8');
        const eq = pair.indexOf('=');
        record[pair.slice(0, eq)] = pair.slice(eq + 1);
        at += length;
      }
      if (entry.type === 'x') this.pax = record;
      else comment = record.comment ?? comment;
      return;
    }
    if (entry.keep && entry.path !== undefined) {
      kept.push({ path: entry.path, mode: entry.mode || 0o644, data: new Uint8Array(data) });
    }
  }
}

const reader = new TarReader();
const gunzip = createGunzip();
let failed = false;
const fail = (error: unknown) => {
  if (failed) return;
  failed = true;
  port?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  } satisfies WorkerMessage);
};

gunzip.on('data', (chunk: Buffer) => {
  if (failed) return;
  streamed += chunk.length;
  try {
    if (streamed > request.limits.streamed)
      throw new ArchiveError('The archive is too large once decompressed');
    reader.push(chunk);
  } catch (error) {
    fail(error);
    gunzip.destroy();
  }
});
gunzip.on('error', (error) => fail(new ArchiveError(`Not a gzip archive: ${error.message}`)));
gunzip.on('end', () => {
  if (failed) return;
  let files = kept;
  let skippedLinks = refused;
  if (!request.stripTop && !request.root) {
    // A tarball of one folder: its folder is the plugin's root.
    const firsts = new Set(files.map((file) => file.path.split('/')[0]));
    const [only] = firsts;
    if (firsts.size === 1 && only && files.every((file) => file.path.includes('/'))) {
      const strip = (path: string) => (path.startsWith(`${only}/`) ? path.slice(only.length + 1) : path);
      files = files.map((file) => ({ ...file, path: strip(file.path) }));
      skippedLinks = refused.map(strip);
    }
  }
  port?.postMessage(
    { type: 'done', files, comment, refused: skippedLinks } satisfies WorkerMessage,
    files.map((file) => file.data.buffer as ArrayBuffer),
  );
});

port?.on('message', (message: { type: 'chunk'; data: Uint8Array } | { type: 'end' }) => {
  if (failed) return;
  if (message.type === 'end') {
    gunzip.end();
    return;
  }
  gunzip.write(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength), () =>
    port?.postMessage({ type: 'ack' } satisfies WorkerMessage),
  );
});
