import type { IMastraLogger } from '@mastra/core/logger';
import type { RequestContext } from '@mastra/core/request-context';
import {
  type SkillSource,
  WORKSPACE_TOOLS,
  Workspace,
  type WorkspaceToolsConfig,
} from '@mastra/core/workspace';
import type { Sandbox, ToolGrant, WorkspaceEntry } from '@superagent/shared';
import type { FsEntry } from '@superagent/shared/runner';
import type { TaskRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import type { TaskService } from '../ledger/service';
import { RunnerFilesystem } from './filesystem';
import { type RunnerClient, RunnerRequestError } from './runner-client';
import { RunnerSandbox } from './sandbox';

/** Tells a specialist which task (and so which sandbox) it works in. Set by its lead when delegating. */
export const TASK_CONTEXT_KEY = 'superagent.taskId';
const TASK_THREAD = /^task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The catalog keys that give an agent a workspace instead of a tool. */
export const WORKSPACE_GRANTS = ['files', 'shell'] as const;
/** Files the owner downloads in one go. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export function taskFromThread(threadId: unknown): string | undefined {
  return typeof threadId === 'string' ? TASK_THREAD.exec(threadId)?.[1] : undefined;
}

/**
 * The task a request works on: a lead's own task thread first (it can't be talked out of it), else
 * the task its lead handed down when delegating.
 */
export function taskOf(requestContext: RequestContext | undefined): string | undefined {
  if (!requestContext) return undefined;
  const memory = requestContext.get('MastraMemory') as { thread?: { id?: string } } | undefined;
  const fromThread =
    taskFromThread(memory?.thread?.id) ?? taskFromThread(requestContext.get('mastra__threadId'));
  if (fromThread) return fromThread;
  const handed = requestContext.get(TASK_CONTEXT_KEY);
  return typeof handed === 'string' && UUID.test(handed) ? handed : undefined;
}

/** A lead hands its task down to the specialist it delegates to, or nothing outside a task. */
export function shareTaskOnDelegation(context: { threadId?: string; requestContext: RequestContext }): void {
  const taskId = taskFromThread(context.threadId);
  if (taskId) context.requestContext.set(TASK_CONTEXT_KEY, taskId);
  else context.requestContext.delete(TASK_CONTEXT_KEY);
}

const FILE_WRITES = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
] as const;

/** An agent's skills (decision D37): read from our store, the list looked up per request. */
export interface AgentSkills {
  source: SkillSource;
  paths(): string[];
}

export interface WorkspaceDeps {
  /** Unset when no runner is configured: workspace grants then give no tools. */
  client?: RunnerClient;
  profile: string;
  tasks: TaskService;
  logger: IMastraLogger;
}

/**
 * Task workspaces (decision D33): each task has a folder and a sandbox container, run by the runner.
 * An agent granted `files` or `shell` gets Mastra's workspace tools inside a task, and none outside.
 */
export class WorkspaceService {
  private readonly sandboxes = new Map<string, RunnerSandbox>();
  private readonly filesystems = new Map<string, RunnerFilesystem>();
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly deps: WorkspaceDeps) {}

  get enabled(): boolean {
    return Boolean(this.deps.client);
  }

  /**
   * The `workspace` option of an agent: inside a task, the task's workspace if it is granted files or
   * shell; otherwise its skills alone, while it has some. Undefined when it can have neither.
   */
  workspaceFor(
    agentKey: string,
    grants: ToolGrant[],
    skills?: AgentSkills,
  ): ((args: { requestContext: RequestContext }) => Workspace | undefined) | undefined {
    // Skills come from our store, never from the (sandbox-writable) task folder.
    const skillOptions = skills ? { skillSource: skills.source, skills: () => skills.paths() } : {};
    const skillsOnly = skills ? this.skillsWorkspace(agentKey, skillOptions) : undefined;
    const task = this.taskWorkspace(agentKey, grants, skillOptions);
    if (!task && !skillsOnly) return undefined;
    return ({ requestContext }) => {
      if (task && taskOf(requestContext)) return task;
      return skillsOnly && (skills?.paths().length ?? 0) > 0 ? skillsOnly : undefined;
    };
  }

  private skillsWorkspace(agentKey: string, options: object): Workspace {
    const id = `skills-${agentKey}`;
    let workspace = this.workspaces.get(id);
    if (!workspace) {
      workspace = new Workspace({ id, name: 'Skills', ...options });
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }

  /** The task workspace of an agent granted files or shell, built once per shape and agent. */
  private taskWorkspace(agentKey: string, grants: ToolGrant[], skillOptions: object): Workspace | undefined {
    const files = grants.find((grant) => grant.key === 'files');
    const shell = grants.find((grant) => grant.key === 'shell');
    const client = this.deps.client;
    if ((!files && !shell) || !client) return undefined;
    const tools: WorkspaceToolsConfig = {};
    for (const name of FILE_WRITES) if (files?.requireApproval) tools[name] = { requireApproval: true };
    if (shell?.requireApproval) {
      tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND] = { requireApproval: true };
      tools[WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS] = { requireApproval: true };
    }
    // The shape (files, commands or both) is fixed per workspace; approvals change in place.
    const id = `ws-${agentKey}-${files ? 'f' : ''}${shell ? 's' : ''}`;
    let workspace = this.workspaces.get(id);
    if (workspace) workspace.setToolsConfig(tools);
    else {
      const taskIn = (requestContext: RequestContext) => {
        const taskId = taskOf(requestContext);
        if (!taskId) throw new Error('Workspace tools only work inside a task');
        return taskId;
      };
      workspace = new Workspace({
        id,
        name: 'Task workspace',
        ...(files
          ? { filesystem: ({ requestContext }) => this.filesystem(client, taskIn(requestContext)) }
          : {}),
        ...(shell
          ? {
              sandbox: ({ requestContext }) => this.sandbox(client, taskIn(requestContext)),
              sandboxCacheKey: ({ requestContext }) => {
                const taskId = taskOf(requestContext);
                return taskId ? `task:${taskId}` : undefined;
              },
              instructions: { dynamicSandbox: 'resolve' as const },
            }
          : {}),
        ...skillOptions,
        tools,
      });
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }

  /** Sandboxes with their tasks, for the owner. */
  async list(): Promise<Sandbox[]> {
    const runner = this.requireRunner();
    const items = await this.wrap(() => runner.list());
    const tasks = await this.deps.tasks.byIds(items.map((item) => item.taskId));
    return items.map((item) => {
      const task = tasks.get(item.taskId);
      return {
        id: item.taskId,
        taskId: item.taskId,
        taskNumber: task?.number ?? null,
        taskTitle: task?.title ?? null,
        profile: item.profile,
        state: item.state,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
      };
    });
  }

  /** Removes a task's sandbox container. Its files stay, and its next command starts a fresh one. */
  async remove(taskId: string): Promise<void> {
    const runner = this.requireRunner();
    if (!(await this.wrap(() => runner.remove(taskId)))) {
      throw new ApiError(404, 'sandbox_not_found', 'No sandbox for this task');
    }
    this.sandboxes.delete(taskId);
  }

  /** The files of a task's workspace, read without starting work (and without a sandbox if it has none). */
  async files(
    task: TaskRow,
    path: string,
    depth: number,
    signal?: AbortSignal,
  ): Promise<{ items: WorkspaceEntry[]; truncated: boolean }> {
    const runner = this.requireRunner();
    const result = await this.wrap(
      () =>
        runner.fs(
          task.id,
          { op: 'list', path, maxDepth: depth, limit: 2_000 },
          { profile: this.deps.profile, peek: true },
          signal,
        ),
      task,
    );
    return {
      items: (result.entries ?? []).map((entry) => this.entry(entry, path)),
      truncated: Boolean(result.truncated),
    };
  }

  async download(
    task: TaskRow,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ content: Buffer; size: number }> {
    const runner = this.requireRunner();
    const result = await this.wrap(
      () =>
        runner.fs(
          task.id,
          { op: 'read', path, maxBytes: MAX_DOWNLOAD_BYTES },
          { profile: this.deps.profile, peek: true },
          signal,
        ),
      task,
    );
    if (result.truncated) {
      throw new ApiError(
        413,
        'file_too_large',
        `Files over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB can't be downloaded here`,
      );
    }
    return { content: Buffer.from(result.contentBase64 ?? '', 'base64'), size: result.size ?? 0 };
  }

  /** What stops sandboxes from working right now, if anything (for the attention inbox). */
  async problem(): Promise<string | undefined> {
    if (!this.deps.client) return 'off';
    const ready = await this.deps.client.ready();
    if (!ready) return 'unreachable';
    if (!ready.docker) return 'no-docker';
    if (ready.images[this.deps.profile] === false) return 'no-image';
    return undefined;
  }

  private sandbox(client: RunnerClient, taskId: string): RunnerSandbox {
    let sandbox = this.sandboxes.get(taskId);
    if (!sandbox) {
      sandbox = new RunnerSandbox(client, taskId, this.deps.profile);
      this.sandboxes.set(taskId, sandbox);
    }
    return sandbox;
  }

  private filesystem(client: RunnerClient, taskId: string): RunnerFilesystem {
    let filesystem = this.filesystems.get(taskId);
    if (!filesystem) {
      filesystem = new RunnerFilesystem(client, taskId, this.deps.profile);
      this.filesystems.set(taskId, filesystem);
    }
    return filesystem;
  }

  private entry(entry: FsEntry, base: string): WorkspaceEntry {
    const prefix = base === '.' || base === '' ? '' : `${base.replace(/\/+$/, '')}/`;
    return {
      path: `${prefix}${entry.path}`,
      type: entry.type === 'directory' ? 'directory' : entry.type === 'symlink' ? 'symlink' : 'file',
      size: entry.type === 'directory' ? null : entry.size,
      modifiedAt: entry.modifiedAt,
    };
  }

  private requireRunner(): RunnerClient {
    if (!this.deps.client) {
      throw new ApiError(503, 'sandboxes_disabled', 'Sandboxes are off: set RUNNER_URL and RUNNER_TOKEN');
    }
    return this.deps.client;
  }

  /** Runner errors as /v1 problems. */
  private async wrap<T>(call: () => Promise<T>, task?: TaskRow): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RunnerRequestError)) throw error;
      const label = task ? `Task #${task.number}` : 'This task';
      switch (error.code) {
        case 'sandbox_not_found':
          throw new ApiError(404, 'workspace_not_found', `${label} has no files: no agent has worked in it`);
        case 'not_found':
          throw new ApiError(404, 'file_not_found', 'No such file or folder in the workspace');
        case 'is_directory':
          throw new ApiError(400, 'is_directory', 'That is a folder: list it instead');
        case 'not_directory':
          throw new ApiError(400, 'not_directory', 'That is a file: download it instead');
        case 'not_regular':
          throw new ApiError(400, 'not_regular', 'That is not a regular file (a pipe, socket or device)');
        case 'fs_timeout':
          throw new ApiError(504, 'workspace_timeout', 'Reading the workspace took too long');
        case 'invalid_request':
          throw new ApiError(400, 'invalid_path', error.message);
        case 'runner_unreachable':
        case 'image_missing':
          throw new ApiError(503, 'runner_unavailable', error.message);
        default:
          this.deps.logger.error('Runner request failed', { code: error.code, error: error.message });
          throw new ApiError(502, 'runner_error', error.message);
      }
    }
  }
}
