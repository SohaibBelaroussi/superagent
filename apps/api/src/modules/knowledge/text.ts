import { Worker } from 'node:worker_threads';

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
};
const ALIASES: Record<string, string> = {
  'text/x-markdown': 'text/markdown',
  'application/x-pdf': 'application/pdf',
};

/** The document's media type, or undefined when we can't read it. Generic uploads go by extension. */
export function documentType(filename: string, declared?: string): string | undefined {
  const type = declared?.split(';')[0]?.trim().toLowerCase();
  const known = type ? (ALIASES[type] ?? type) : undefined;
  if (known && (TEXT_TYPES.has(known) || known === 'text/html' || known === 'application/pdf')) return known;
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[extension];
}

export interface ExtractLimits {
  /** More text than this is refused rather than indexed in part. */
  maxChars: number;
  maxPages: number;
  timeoutMs: number;
  /** Heap for the worker that reads the document. */
  memoryMb: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxChars: 10_000_000,
  maxPages: 2000,
  timeoutMs: 60_000,
  memoryMb: 512,
};

export class ExtractError extends Error {
  override name = 'ExtractError';
  constructor(
    readonly code: 'too_large' | 'unreadable' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

// From source (tsx, Vitest) the worker sits next to this file; in the bundle, next to main.mjs.
const WORKER_URL = import.meta.url.endsWith('.ts')
  ? new URL('./extract.worker.ts', import.meta.url)
  : new URL('./extract.worker.mjs', import.meta.url);

const MAX_PARALLEL = 2;
let running = 0;
const waiting: Array<() => void> = [];

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  while (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * Plain text of a document of a type `documentType` accepted, read in a worker thread with a memory
 * limit and a timeout: a hostile file (a PDF bomb, a pathological HTML page) costs the worker, not the
 * API. At most two documents are read at once.
 */
export function extractText(
  body: Uint8Array,
  type: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<string> {
  return inSlot(
    () =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker(WORKER_URL, {
          workerData: { body, type, maxChars: limits.maxChars, maxPages: limits.maxPages },
          resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb, maxYoungGenerationSizeMb: 32 },
        });
        let done = false;
        const settle = (outcome: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          void worker.terminate();
          outcome();
        };
        const timer = setTimeout(
          () => settle(() => reject(new ExtractError('timeout', 'Reading this document took too long'))),
          limits.timeoutMs,
        );
        worker.once(
          'message',
          (result: { ok: boolean; text?: string; code?: 'too_large' | 'unreadable'; message?: string }) =>
            settle(() =>
              result.ok
                ? resolve(result.text ?? '')
                : reject(
                    new ExtractError(result.code ?? 'unreadable', result.message ?? 'Unreadable document'),
                  ),
            ),
        );
        // Out-of-memory and crashes in the worker end up here.
        worker.once('error', (error) => settle(() => reject(new ExtractError('unreadable', error.message))));
        worker.once('exit', (code) =>
          settle(() => reject(new ExtractError('unreadable', `The document reader stopped (exit ${code})`))),
        );
      }),
  );
}

/**
 * Splits text into passages of about `size` characters, on paragraph and then sentence boundaries.
 * Each passage starts with the end of the previous one (`overlap`), so a fact cut in two is still found.
 */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];
  const pieces = clean
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= size ? [p] : splitLong(p, size)));
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      const fromWord = tail.indexOf(' ');
      current = `${fromWord >= 0 ? tail.slice(fromWord + 1) : tail}\n\n${piece}`;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, size: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const sentence of paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph]) {
    if (sentence.length > size) {
      if (current.trim()) out.push(current.trim());
      current = '';
      for (let i = 0; i < sentence.length; i += size) out.push(sentence.slice(i, i + size).trim());
    } else if (current.length + sentence.length > size) {
      out.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** Common words that would match nearly every passage (English and French). */
const STOPWORDS = new Set(
  (
    'a an and are as at be but by do does for from has have how i if in into is it its me my of on or our so that ' +
    'the their them then there these they this to was we were what when where which who why will with you your ' +
    'au aux avec ce ces dans de des du elle en est et il je la le les leur mais ne nous on ou par pas pour qui que ' +
    'quoi sa se ses son sur ta te tu un une vos votre vous'
  ).split(' '),
);

/**
 * The query's words without common ones, for Postgres to tokenise exactly like the indexed text (so
 * emails, versions and file names stay whole). Empty when nothing worth searching is left.
 */
export function searchQuery(query: string): string {
  return query
    .normalize('NFC')
    .split(/\s+/)
    .filter((word) => {
      const bare = word.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
      return bare.length > 1 && !STOPWORDS.has(bare);
    })
    .slice(0, 32)
    .join(' ');
}
