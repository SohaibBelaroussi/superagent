import { posix } from 'node:path';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { SandboxListSchema, WorkspaceListingSchema } from '@superagent/shared';
import type { Context } from 'hono';
import { ApiError, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const taskParams = z.object({ id: z.uuid() });

/** A path inside the workspace: relative, no way out. */
function workspacePath(raw: string | undefined): string {
  const value = (raw ?? '').trim() || '.';
  if (value.includes('\0') || posix.isAbsolute(value)) {
    throw new ApiError(400, 'invalid_path', 'Paths are relative to the workspace folder');
  }
  const normal = posix.normalize(value);
  if (normal === '..' || normal.startsWith('../')) {
    throw new ApiError(400, 'invalid_path', 'Paths stay inside the workspace folder');
  }
  return normal;
}

const listFiles = createRoute({
  method: 'get',
  path: '/tasks/{id}/files',
  tags: ['workspace'],
  summary: "List a task's workspace files",
  description:
    "What the task's agents wrote in its sandbox. Reading never starts work, and works after the sandbox is gone.",
  request: {
    params: taskParams,
    query: z.object({
      path: z.string().max(4096).optional().describe('A folder in the workspace (default: its root)'),
      depth: z.coerce.number().int().min(1).max(10).default(3).describe('How many levels down'),
    }),
  },
  responses: {
    200: json(WorkspaceListingSchema, 'Files and folders'),
    400: problemResponse('Bad path, or not a folder'),
    404: problemResponse('No such task, folder or workspace'),
    503: problemResponse('Sandboxes are off or the runner is unreachable'),
  },
});

const downloadFile = createRoute({
  method: 'get',
  path: '/tasks/{id}/files/{path}',
  tags: ['workspace'],
  summary: 'Download a workspace file',
  description:
    'The file as an attachment. Encode slashes in the path (`src%2Fmain.py`) or write them plainly (`/files/src/main.py`).',
  request: { params: taskParams.extend({ path: z.string().min(1).max(4096) }) },
  responses: {
    200: { description: 'The file', content: { 'application/octet-stream': { schema: z.string() } } },
    400: problemResponse('Bad path, or a folder'),
    404: problemResponse('No such task, file or workspace'),
    413: problemResponse('Too large to download here'),
    503: problemResponse('Sandboxes are off or the runner is unreachable'),
  },
});

const listSandboxes = createRoute({
  method: 'get',
  path: '/sandboxes',
  tags: ['workspace'],
  summary: 'Task sandboxes',
  description:
    'One container per task that ran commands. Idle ones are stopped, and long-stopped ones removed.',
  responses: {
    200: json(SandboxListSchema, 'Sandboxes'),
    503: problemResponse('Sandboxes are off or the runner is unreachable'),
  },
});

const removeSandbox = createRoute({
  method: 'delete',
  path: '/sandboxes/{id}',
  tags: ['workspace'],
  summary: "Remove a task's sandbox",
  description: "Removes the container; the task's files stay, and its next command starts a fresh sandbox.",
  request: { params: z.object({ id: z.uuid().describe('The task id') }) },
  responses: {
    204: { description: 'Removed' },
    404: problemResponse('No sandbox for this task'),
    503: problemResponse('Sandboxes are off or the runner is unreachable'),
  },
});

export function registerWorkspaceRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { tasks, workspaces } = deps;

  v1.openapi(listFiles, async (c) => {
    const { id } = c.req.valid('param');
    const { path, depth } = c.req.valid('query');
    const task = await tasks.get(id);
    return c.json(await workspaces.files(task, workspacePath(path), depth, c.req.raw.signal), 200);
  });

  const download = async (c: Context<AppEnv>, id: string, rawPath: string) => {
    const task = await tasks.get(id);
    const path = workspacePath(rawPath);
    if (path === '.')
      throw new ApiError(400, 'is_directory', 'That is the workspace folder: list it instead');
    const { content } = await workspaces.download(task, path, c.req.raw.signal);
    const name = posix.basename(path).replace(/[^\w.-]+/g, '_') || 'file';
    return c.body(new Uint8Array(content), 200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  };

  v1.openapi(downloadFile, async (c) => {
    const { id, path } = c.req.valid('param');
    return download(c, id, path) as never;
  });
  // The same file with its path written plainly (several segments).
  v1.get('/tasks/:id/files/:path{.+}', async (c) => {
    const parsed = taskParams.safeParse({ id: c.req.param('id') });
    if (!parsed.success) throw new ApiError(400, 'invalid_id', 'Not a task id');
    return download(c, parsed.data.id, c.req.param('path'));
  });

  v1.openapi(listSandboxes, async (c) => c.json({ items: await workspaces.list() }, 200));

  v1.openapi(removeSandbox, async (c) => {
    await workspaces.remove(c.req.valid('param').id);
    return c.body(null, 204);
  });
}
