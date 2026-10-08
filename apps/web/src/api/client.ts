import { type Problem, ProblemSchema } from '@superagent/shared';
import type { z } from 'zod';

/** An error answer from the API (problem+json), or a network failure (status 0). */
export class ProblemError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
    this.status = status;
    this.problem = problem;
  }

  get code(): string | undefined {
    return this.problem.code;
  }
}

/** The response didn't match the schema the app was built against: the API and the app have drifted. */
export class ResponseShapeError extends Error {
  constructor(path: string, issues: string) {
    super(`Unexpected response from ${path}: ${issues}`);
    this.name = 'ResponseShapeError';
  }
}

let currentToken: string | null = null;
let unauthorizedHandler: ((token: string) => void) | null = null;

/** The token every request carries. Set by the session when you sign in, cleared when you sign out. */
export function setApiToken(token: string | null): void {
  currentToken = token;
}

export function getApiToken(): string | null {
  return currentToken;
}

/** Called with the refused token when the API refuses the session's token (revoked elsewhere). */
export function onUnauthorized(handler: ((token: string) => void) | null): void {
  unauthorizedHandler = handler;
}

/**
 * Reports a 401 for `token`. Only the token still in use counts: an answer to a request made with an
 * older token (signed out and in again meanwhile) must not sign out the new session.
 */
export function notifyUnauthorized(token: string): void {
  if (token === currentToken) unauthorizedHandler?.(token);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is (multipart uploads). */
  body?: BodyInit;
  signal?: AbortSignal;
  /** Use this token instead of the session's (sign-in checks a token before keeping it). */
  token?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
}

function url(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers({ accept: 'application/json', ...options.headers });
  const token = options.token ?? currentToken;
  if (token) headers.set('authorization', `Bearer ${token}`);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  }

  let response: Response;
  try {
    response = await fetch(url(path, options.query), {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: options.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ProblemError(0, {
      type: 'about:blank',
      title: 'Network error',
      status: 0,
      code: 'network_error',
      detail: "Can't reach the server. Check your connection.",
    });
  }

  if (!response.ok) {
    const problem = await readProblem(response);
    // Only the session's own token: a token being checked at sign-in is the caller's business.
    if (response.status === 401 && options.token === undefined && token) notifyUnauthorized(token);
    throw new ProblemError(response.status, problem);
  }
  return response;
}

async function readProblem(response: Response): Promise<Problem> {
  const fallback: Problem = {
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    detail: `The server answered ${response.status}.`,
  };
  try {
    const parsed = ProblemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Calls the API and parses the JSON answer with `schema`. */
export async function api<T extends z.ZodType>(
  schema: T,
  path: string,
  options: RequestOptions = {},
): Promise<z.infer<T>> {
  const response = await send(path, options);
  const data: unknown = await response.json();
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ResponseShapeError(
      path,
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** Calls the API where the answer has no body worth reading (204). */
export async function apiVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await send(path, options);
}

/** A message for people, from whatever a request threw. */
export function errorMessage(error: unknown): string {
  if (error instanceof ProblemError) {
    const fields = error.problem.errors?.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    return fields ? `${error.message} (${fields})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
