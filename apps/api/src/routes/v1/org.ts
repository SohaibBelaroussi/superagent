import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  AgentListSchema,
  AgentRoleSchema,
  type AgentSummary,
  type AgentVersion,
  AgentVersionListSchema,
  CatalogToolListSchema,
  CreateAgentInputSchema,
  CreateDepartmentInputSchema,
  type Department,
  DepartmentListSchema,
  DepartmentSchema,
  UpdateAgentInputSchema,
  UpdateDepartmentInputSchema,
} from '@superagent/shared';
import type { AgentVersionRow } from '../../db/schema';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';
import type {
  AgentEntry,
  AgentVersionEntry,
  DepartmentEntry,
  OrgDirectory,
} from '../../modules/org/directory';

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toSummary(a: AgentEntry): AgentSummary {
  return { id: a.id, key: a.key, name: a.name, role: a.role, description: a.current.description };
}

function toVersion(v: AgentVersionEntry | AgentVersionRow): AgentVersion {
  return {
    version: v.version,
    description: v.description,
    instructions: v.instructions,
    model: v.model,
    tools: v.tools,
    skills: v.skills,
    mcp: v.mcp.map((grant) => ({ ...grant, requireApproval: grant.requireApproval ?? false })),
    createdAt: v.createdAt.toISOString(),
  };
}

function toAgent(a: AgentEntry): AgentDefinition {
  return {
    id: a.id,
    key: a.key,
    name: a.name,
    role: a.role,
    departmentId: a.departmentId,
    activeVersion: a.activeVersion,
    current: toVersion(a.current),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    archivedAt: iso(a.archivedAt),
  };
}

function toDepartment(d: DepartmentEntry, directory: OrgDirectory): Department {
  const lead = directory.leadOf(d.id);
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    description: d.description,
    autoClose: d.autoClose,
    lead: lead ? toSummary(lead) : null,
    members: directory.membersOf(d.id).map(toSummary),
    skills: d.skills,
    mcp: d.mcp,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    archivedAt: iso(d.archivedAt),
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});
const params = z.object({ id: z.uuid() });
const includeArchived = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

const listDepartments = createRoute({
  method: 'get',
  path: '/departments',
  tags: ['departments'],
  summary: 'List departments',
  request: { query: z.object({ includeArchived }) },
  responses: { 200: json(DepartmentListSchema, 'Departments with their lead and specialists') },
});

const createDepartment = createRoute({
  method: 'post',
  path: '/departments',
  tags: ['departments'],
  summary: 'Create a department',
  description: 'Then add its lead and specialists with POST /v1/agents.',
  request: body(CreateDepartmentInputSchema),
  responses: {
    201: json(DepartmentSchema, 'Department created'),
    400: problemResponse('Invalid request'),
    409: problemResponse('Slug already taken'),
  },
});

const getDepartment = createRoute({
  method: 'get',
  path: '/departments/{id}',
  tags: ['departments'],
  summary: 'Get a department',
  request: { params },
  responses: { 200: json(DepartmentSchema, 'The department'), 404: problemResponse('Not found') },
});

const updateDepartment = createRoute({
  method: 'patch',
  path: '/departments/{id}',
  tags: ['departments'],
  summary: 'Update a department',
  request: { params, ...body(UpdateDepartmentInputSchema) },
  responses: {
    200: json(DepartmentSchema, 'Updated department'),
    404: problemResponse('Not found'),
    409: problemResponse('Archived'),
  },
});

const archiveDepartment = createRoute({
  method: 'delete',
  path: '/departments/{id}',
  tags: ['departments'],
  summary: 'Archive a department',
  description: 'Only empty departments can be archived: archive their agents first.',
  request: { params },
  responses: {
    204: { description: 'Archived' },
    404: problemResponse('Not found'),
    409: problemResponse('Still has active agents'),
  },
});

const listAgents = createRoute({
  method: 'get',
  path: '/agents',
  tags: ['agents'],
  summary: 'List agent definitions',
  request: {
    query: z.object({ departmentId: z.uuid().optional(), role: AgentRoleSchema.optional(), includeArchived }),
  },
  responses: { 200: json(AgentListSchema, 'Agents with their active version') },
});

const createAgent = createRoute({
  method: 'post',
  path: '/agents',
  tags: ['agents'],
  summary: 'Create an agent',
  description:
    'Creates version 1 and starts the agent right away (it appears under /api/agents/<key>). ' +
    "A lead's team is its department's specialists.",
  request: body(CreateAgentInputSchema),
  responses: {
    201: json(AgentDefinitionSchema, 'Agent created'),
    400: problemResponse('Invalid request, unknown tool or unusable model'),
    404: problemResponse('Department not found'),
    409: problemResponse('Key taken, department archived, or the department already has a lead'),
  },
});

const getAgent = createRoute({
  method: 'get',
  path: '/agents/{id}',
  tags: ['agents'],
  summary: 'Get an agent',
  request: { params },
  responses: { 200: json(AgentDefinitionSchema, 'The agent'), 404: problemResponse('Not found') },
});

const updateAgent = createRoute({
  method: 'patch',
  path: '/agents/{id}',
  tags: ['agents'],
  summary: 'Update an agent',
  description:
    'Changing description, instructions, model or tools creates and activates a new version. ' +
    'The change applies to the next run, without a restart.',
  request: { params, ...body(UpdateAgentInputSchema) },
  responses: {
    200: json(AgentDefinitionSchema, 'Updated agent'),
    400: problemResponse('Invalid request'),
    404: problemResponse('Not found'),
    409: problemResponse('Archived'),
  },
});

const archiveAgent = createRoute({
  method: 'delete',
  path: '/agents/{id}',
  tags: ['agents'],
  summary: 'Archive an agent',
  description:
    'Stops the agent; its versions are kept. Refused while it has tool calls waiting for your decision, or (a lead) runs on its tasks.',
  request: { params },
  responses: {
    204: { description: 'Archived' },
    404: problemResponse('Not found'),
    409: problemResponse('Archived already, tool calls wait for your decision, or the lead is working'),
  },
});

const listVersions = createRoute({
  method: 'get',
  path: '/agents/{id}/versions',
  tags: ['agents'],
  summary: "List an agent's versions",
  request: { params },
  responses: { 200: json(AgentVersionListSchema, 'Newest first'), 404: problemResponse('Not found') },
});

const activateVersion = createRoute({
  method: 'post',
  path: '/agents/{id}/versions/{version}/activate',
  tags: ['agents'],
  summary: 'Activate a version (rollback)',
  request: { params: z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }) },
  responses: {
    200: json(AgentDefinitionSchema, 'Agent on the activated version'),
    400: problemResponse('That version uses a tool or model that no longer exists'),
    404: problemResponse('No such agent or version'),
  },
});

const listCatalog = createRoute({
  method: 'get',
  path: '/catalog/tools',
  tags: ['catalog'],
  summary: 'Tools an agent can be granted',
  responses: { 200: json(CatalogToolListSchema, 'Tool catalog') },
});

export function registerOrgRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { org } = deps;
  const directory = org.directory;

  v1.openapi(listDepartments, (c) => {
    const items = directory.departments({ includeArchived: c.req.valid('query').includeArchived });
    return c.json({ items: items.map((d) => toDepartment(d, directory)) }, 200);
  });

  v1.openapi(createDepartment, async (c) => {
    const department = await org.createDepartment(c.req.valid('json'));
    return c.json(toDepartment(department, directory), 201);
  });

  v1.openapi(getDepartment, (c) =>
    c.json(toDepartment(org.getDepartment(c.req.valid('param').id), directory), 200),
  );

  v1.openapi(updateDepartment, async (c) => {
    const department = await org.updateDepartment(c.req.valid('param').id, c.req.valid('json'));
    return c.json(toDepartment(department, directory), 200);
  });

  v1.openapi(archiveDepartment, async (c) => {
    await org.archiveDepartment(c.req.valid('param').id);
    return c.body(null, 204);
  });

  v1.openapi(listAgents, (c) => {
    const { departmentId, role, includeArchived: archived } = c.req.valid('query');
    const items = directory.agents({ departmentId, role, includeArchived: archived });
    return c.json({ items: items.map(toAgent) }, 200);
  });

  v1.openapi(createAgent, async (c) => c.json(toAgent(await org.createAgent(c.req.valid('json'))), 201));

  v1.openapi(getAgent, (c) => c.json(toAgent(org.getAgent(c.req.valid('param').id)), 200));

  v1.openapi(updateAgent, async (c) =>
    c.json(toAgent(await org.updateAgent(c.req.valid('param').id, c.req.valid('json'))), 200),
  );

  v1.openapi(archiveAgent, async (c) => {
    await org.archiveAgent(c.req.valid('param').id);
    return c.body(null, 204);
  });

  v1.openapi(listVersions, async (c) => {
    const rows = await org.versions(c.req.valid('param').id);
    return c.json({ items: rows.map(toVersion) }, 200);
  });

  v1.openapi(activateVersion, async (c) => {
    const { id, version } = c.req.valid('param');
    return c.json(toAgent(await org.activateVersion(id, version)), 200);
  });

  v1.openapi(listCatalog, (c) => c.json({ items: deps.catalog.list() }, 200));
}
