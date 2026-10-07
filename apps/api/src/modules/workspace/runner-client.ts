import type {
  EnsureSandboxResult,
  ExecInput,
  ExecResult,
  FsRequest,
  FsResult,
  ProcessInfo,
  ProcessStatus,
  RunnerReady,
  RunnerSandbox,
} from '@superagent/shared/runner';

/** The runner answered with an error (`code` from its error list), or couldn't be reached. */
export class RunnerRequestError extends Error {
  override name = 'RunnerRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Node's fetch gives up on response headers after 300 s; foreground commands stay under that. */
export const MAX_FOREGROUND_MS = 270_000;

/** The runner's internal API (decision D10), with its bearer token. */
export class RunnerClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async list(): Promise<RunnerSandbox[]> {
    return (await this.request<{ items: RunnerSandbox[] }>('GET', '/sandboxes')).items;
  }

  async get(taskId: string): Promise<RunnerSandbox | undefined> {
    return this.orUndefined(() => this.request<RunnerSandbox>('GET', `/sandboxes/${taskId}`));
  }

  ensure(taskId: string, profile: string, signal?: AbortSignal): Promise<EnsureSandboxResult> {
    return this.request('POST', `/sandboxes/${taskId}`, { profile }, signal);
  }

  /** False if the task had no sandbox. */
  async remove(taskId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/sandboxes/${taskId}`);
      return true;
    } catch (error) {
      if (error instanceof RunnerRequestError && error.status === 404) return false;
      throw error;
    }
  }

  exec(taskId: string, input: ExecInput, signal?: AbortSignal): Promise<ExecResult> {
    return this.request('POST', `/sandboxes/${taskId}/exec`, input, signal);
  }

  async processes(taskId: string): Promise<ProcessInfo[]> {
    return (await this.request<{ items: ProcessInfo[] }>('GET', `/sandboxes/${taskId}/processes`)).items;
  }

  /** A background process and its output from the given offsets; undefined once it is gone. */
  process(
    taskId: string,
    execId: string,
    from: { out: number; err: number } = { out: 0, err: 0 },
  ): Promise<ProcessStatus | undefined> {
    const query = new URLSearchParams({ outFrom: String(from.out), errFrom: String(from.err) });
    return this.orUndefined(() =>
      this.request<ProcessStatus>('GET', `/sandboxes/${taskId}/processes/${execId}?${query}`),
    );
  }

  async kill(taskId: string, execId: string): Promise<boolean> {
    const result = await this.orUndefined(() =>
      this.request<{ killed: boolean }>('DELETE', `/sandboxes/${taskId}/processes/${execId}`),
    );
    return result?.killed ?? false;
  }

  /** A file operation in the task's sandbox. `peek` reads without creating one. */
  fs(
    taskId: string,
    request: FsRequest,
    options: { profile: string; peek?: boolean },
    signal?: AbortSignal,
  ): Promise<FsResult> {
    const query = new URLSearchParams({ profile: options.profile, ...(options.peek ? { peek: '1' } : {}) });
    return this.request('POST', `/sandboxes/${taskId}/fs?${query}`, request, signal);
  }

  /** Whether the runner can run sandboxes (Docker reachable, images built); undefined if it's down. */
  async ready(): Promise<RunnerReady | undefined> {
    try {
      return await this.request<RunnerReady>('GET', '/ready', undefined, AbortSignal.timeout(5_000));
    } catch {
      return undefined;
    }
  }

  private async orUndefined<T>(call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RunnerRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RunnerRequestError(
        503,
        'runner_unreachable',
        `The sandbox runner can't be reached: ${String(error)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const problem = json as { code?: string; message?: string } | undefined;
      throw new RunnerRequestError(
        response.status,
        problem?.code ?? 'runner_error',
        problem?.message ?? `The runner answered ${response.status}`,
      );
    }
    return json as T;
  }
}
