import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ApiError } from '../../../http/problem';
import { assertPublicUrl, type ResolveHost } from '../../tools/web';
import type { ArchiveFile, ArchiveLimits, ArchiveRequest, WorkerMessage } from './archive.worker';

export const ARCHIVE_LIMITS: ArchiveLimits = {
  streamed: 1024 * 1024 * 1024,
  kept: 64 * 1024 * 1024,
  files: 5_000,
  file: 20 * 1024 * 1024,
};
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const MAX_SMALL_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
/** Chunks in flight to the worker before the download waits for it. */
const IN_FLIGHT = 8;

// From source (tsx, Vitest) the worker sits next to this file; in the bundle, next to main.mjs.
const WORKER_URL = import.meta.url.endsWith('.ts')
  ? new URL('./archive.worker.ts', import.meta.url)
  : new URL('./archive.worker.mjs', import.meta.url);

export interface PluginFile {
  mode: number;
  data: Buffer;
}

export interface Unpacked {
  files: Map<string, PluginFile>;
  /** The archive's pax comment: GitHub sets it to the commit. */
  comment: string | null;
  refused: string[];
  /** Of the downloaded bytes. */
  sha256: string;
}

const fail = (message: string) => new ApiError(422, 'plugin_unavailable', message);

/**
 * Fetches plugin archives for the installer (decision D38): every hop of every request is checked
 * for a public address (unless the owner allowed a private source), redirects are followed by hand,
 * and archives are unpacked by a worker as they download.
 */
export class PluginFetcher {
  constructor(
    private readonly options: {
      resolveHost?: ResolveHost;
      /** Sent to api.github.com only (never across its redirects): raises GitHub's rate limits. */
      githubToken?: () => Promise<string | undefined>;
    } = {},
  ) {}

  /** A branch, tag or commit of a GitHub repository, as a commit SHA. */
  async resolveSha(repo: string, ref: string): Promise<string> {
    const token = await this.options.githubToken?.();
    const response = await this.get(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        accept: 'application/vnd.github.sha',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    );
    if (response.status === 404 || response.status === 422) {
      throw fail(`GitHub has no ${ref} in ${repo}`);
    }
    if (!response.ok) throw fail(`GitHub answered ${response.status} for ${repo}@${ref}`);
    const sha = (await this.readSmall(response)).toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw fail(`GitHub did not return a commit for ${repo}@${ref}`);
    return sha;
  }

  /** A small file of a repository at a commit, or undefined if it doesn't exist. */
  async readRaw(repo: string, sha: string, path: string): Promise<Buffer | undefined> {
    const response = await this.get(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw fail(`GitHub answered ${response.status} for ${path}`);
    return this.readSmall(response);
  }

  /** Downloads a .tar.gz and unpacks the plugin's files from it in a worker, as the bytes arrive. */
  async unpack(
    url: string,
    request: ArchiveRequest,
    options: { allowPrivate?: boolean; signal?: AbortSignal } = {},
  ): Promise<Unpacked> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ...(options.signal ? [options.signal] : []),
    ]);
    const response = await this.get(url, {}, { allowPrivate: options.allowPrivate, signal });
    if (!response.ok || !response.body) throw fail(`The archive's server answered ${response.status}`);
    const worker = new Worker(WORKER_URL, {
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    const hash = createHash('sha256');
    let inFlight = 0;
    let wake: (() => void) | undefined;
    const result = new Promise<Unpacked>((resolve, reject) => {
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'ack') {
          inFlight -= 1;
          wake?.();
        } else if (message.type === 'error') {
          reject(fail(message.message));
        } else {
          resolve({
            files: new Map(
              message.files.map((file: ArchiveFile) => [
                file.path,
                {
                  mode: file.mode,
                  data: Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength),
                },
              ]),
            ),
            comment: message.comment,
            refused: message.refused,
            sha256: hash.digest('hex'),
          });
        }
      });
      worker.on('error', (error) => reject(fail(`Unpacking failed: ${error.message}`)));
      worker.on('exit', (code) => reject(fail(`Unpacking stopped (exit ${code})`)));
    });
    // The worker may fail early: stop downloading then.
    let stopped = false;
    result.catch(() => {
      stopped = true;
      wake?.();
    });
    try {
      let downloaded = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        downloaded += value.byteLength;
        if (downloaded > MAX_DOWNLOAD_BYTES) throw fail('The archive is too large to download');
        hash.update(value);
        while (inFlight >= IN_FLIGHT && !stopped) await new Promise<void>((resolve) => (wake = resolve));
        inFlight += 1;
        const copy = new Uint8Array(value);
        worker.postMessage({ type: 'chunk', data: copy }, [copy.buffer]);
      }
      if (!stopped) worker.postMessage({ type: 'end' });
      return await result;
    } finally {
      void worker.terminate();
    }
  }

  /** One request, following redirects by hand: each hop's address is checked before it is asked. */
  private async get(
    raw: string,
    headers: Record<string, string> = {},
    options: { allowPrivate?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> {
    let url = new URL(raw);
    const origin = url.origin;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!options.allowPrivate) {
        if (url.protocol !== 'https:') throw fail('Plugins are fetched over https');
        try {
          await assertPublicUrl(url.toString(), this.options.resolveHost);
        } catch (error) {
          throw fail((error as Error).message);
        }
      }
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'user-agent': 'superagent-plugin-installer',
            // Credentials stay with the origin they were meant for.
            ...(url.origin === origin ? headers : { accept: headers.accept ?? '*/*' }),
          },
          redirect: 'manual',
          signal: options.signal ?? AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw fail(`Could not reach ${url.host}: ${(error as Error).message}`);
      }
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel();
      url = new URL(location, url);
    }
    throw fail('Too many redirects');
  }

  private async readSmall(response: Response): Promise<Buffer> {
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_SMALL_BYTES) throw fail('A manifest is too large');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_SMALL_BYTES) throw fail('A manifest is too large');
    return body;
  }
}
