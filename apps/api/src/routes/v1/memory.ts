import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  DepartmentMemorySchema,
  OwnerProfilePatchSchema,
  OwnerProfileSchema,
  UpdateDepartmentMemoryInputSchema,
} from '@superagent/shared';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});

const getProfile = createRoute({
  method: 'get',
  path: '/profile',
  tags: ['memory'],
  summary: 'What the agents know about you',
  description: 'The chief of staff keeps it as you talk, and every department agent gets a read-only copy.',
  responses: { 200: json(OwnerProfileSchema, 'Your profile') },
});

const updateProfile = createRoute({
  method: 'patch',
  path: '/profile',
  tags: ['memory'],
  summary: 'Edit your profile',
  description: 'Fields given replace the stored ones (lists included); null removes a field.',
  request: body(OwnerProfilePatchSchema),
  responses: { 200: json(OwnerProfileSchema, 'Updated profile'), 400: problemResponse('Invalid profile') },
});

const params = z.object({ id: z.uuid() });

const getDepartmentMemory = createRoute({
  method: 'get',
  path: '/departments/{id}/memory',
  tags: ['memory'],
  summary: "A department's notes",
  description:
    "The lead's working notes, shared by all of the department's tasks: rules it learned, what worked.",
  request: { params },
  responses: { 200: json(DepartmentMemorySchema, 'The notes'), 404: problemResponse('Department not found') },
});

const setDepartmentMemory = createRoute({
  method: 'put',
  path: '/departments/{id}/memory',
  tags: ['memory'],
  summary: "Replace a department's notes",
  description: 'For corrections: the lead reads the new notes on its next task.',
  request: { params, ...body(UpdateDepartmentMemoryInputSchema) },
  responses: { 200: json(DepartmentMemorySchema, 'The notes'), 404: problemResponse('Department not found') },
});

export function registerMemoryRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { memory } = deps;

  v1.openapi(getProfile, async (c) => c.json(await memory.profile(), 200));

  v1.openapi(updateProfile, async (c) => c.json(await memory.updateProfile(c.req.valid('json')), 200));

  v1.openapi(getDepartmentMemory, async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ departmentId: id, notes: await memory.departmentNotes(id) }, 200);
  });

  v1.openapi(setDepartmentMemory, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(
      { departmentId: id, notes: await memory.setDepartmentNotes(id, c.req.valid('json').notes) },
      200,
    );
  });
}
