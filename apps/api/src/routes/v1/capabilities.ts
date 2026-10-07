import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  CapabilitiesSchema,
  CreateMcpServerInputSchema,
  InstallPluginInputSchema,
  McpServerListSchema,
  McpServerSchema,
  PluginListSchema,
  PluginPreviewSchema,
  PluginSchema,
  PreviewPluginInputSchema,
  PutSecretInputSchema,
  SecretListSchema,
  SecretNameSchema,
  SecretSchema,
  SkillListSchema,
  SkillSchema,
  UpdateMcpServerInputSchema,
} from '@superagent/shared';
import { problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } });
const idParams = z.object({ id: z.uuid() });

const getCapabilities = createRoute({
  method: 'get',
  path: '/capabilities',
  tags: ['capabilities'],
  summary: 'Everything an agent can be given',
  description:
    'Catalog tools, skills, MCP servers with their tools, and installed plugins, each with how to grant it.',
  responses: { 200: json(CapabilitiesSchema, 'Capabilities') },
});

const listSecrets = createRoute({
  method: 'get',
  path: '/secrets',
  tags: ['capabilities'],
  summary: 'Secrets',
  description: 'Names only: values are never returned.',
  responses: { 200: json(SecretListSchema, 'Secrets') },
});

const putSecret = createRoute({
  method: 'put',
  path: '/secrets/{name}',
  tags: ['capabilities'],
  summary: 'Set a secret',
  description:
    'Creates it, or replaces its value. MCP servers refer to it in headers or environment as { "secret": "NAME" }; ' +
    'the ones using it reconnect with the new value.',
  request: { params: z.object({ name: SecretNameSchema }), ...body(PutSecretInputSchema) },
  responses: { 200: json(SecretSchema, 'The secret (without its value)') },
});

const deleteSecret = createRoute({
  method: 'delete',
  path: '/secrets/{name}',
  tags: ['capabilities'],
  summary: 'Delete a secret',
  request: { params: z.object({ name: SecretNameSchema }) },
  responses: {
    204: { description: 'Deleted' },
    404: problemResponse('No such secret'),
    409: problemResponse('An MCP server uses it'),
  },
});

const listServers = createRoute({
  method: 'get',
  path: '/mcp-servers',
  tags: ['capabilities'],
  summary: 'MCP servers',
  responses: { 200: json(McpServerListSchema, 'MCP servers') },
});

const createServer = createRoute({
  method: 'post',
  path: '/mcp-servers',
  tags: ['capabilities'],
  summary: 'Add a remote MCP server',
  description:
    'A Streamable HTTP server, reached at public addresses only unless allowPrivateNetwork. Its tools are ' +
    'listed right away; grant them to agents or departments with "mcp": [{ "server": slug }].',
  request: body(CreateMcpServerInputSchema),
  responses: {
    201: json(McpServerSchema, 'Added (status says whether its tools could be listed)'),
    400: problemResponse('Invalid URL, or a missing secret'),
    409: problemResponse('The slug is taken'),
  },
});

const getServer = createRoute({
  method: 'get',
  path: '/mcp-servers/{id}',
  tags: ['capabilities'],
  summary: 'An MCP server',
  request: { params: idParams },
  responses: { 200: json(McpServerSchema, 'The server'), 404: problemResponse('No such server') },
});

const updateServer = createRoute({
  method: 'patch',
  path: '/mcp-servers/{id}',
  tags: ['capabilities'],
  summary: 'Change an MCP server',
  description:
    'Its connection changes apply to the next call; disabling it takes its tools away from agents.',
  request: { params: idParams, ...body(UpdateMcpServerInputSchema) },
  responses: { 200: json(McpServerSchema, 'The server'), 404: problemResponse('No such server') },
});

const deleteServer = createRoute({
  method: 'delete',
  path: '/mcp-servers/{id}',
  tags: ['capabilities'],
  summary: 'Delete an MCP server added by hand',
  request: { params: idParams },
  responses: {
    204: { description: 'Deleted' },
    404: problemResponse('No such server'),
    409: problemResponse('It is granted, or it came with a plugin'),
  },
});

const refreshServer = createRoute({
  method: 'post',
  path: '/mcp-servers/{id}/refresh',
  tags: ['capabilities'],
  summary: "List an MCP server's tools again",
  request: { params: idParams },
  responses: {
    200: json(McpServerSchema, 'The server, with its tools'),
    404: problemResponse('No such server'),
  },
});

const listSkills = createRoute({
  method: 'get',
  path: '/skills',
  tags: ['capabilities'],
  summary: 'Skills',
  description:
    'Imported with plugins. Attach them by ref (or a plugin name for all its skills) to agents or departments.',
  responses: { 200: json(SkillListSchema, 'Skills') },
});

const getSkill = createRoute({
  method: 'get',
  path: '/skills/{id}',
  tags: ['capabilities'],
  summary: 'A skill, with its files',
  request: { params: idParams },
  responses: { 200: json(SkillSchema, 'The skill'), 404: problemResponse('No such skill') },
});

const previewPlugin = createRoute({
  method: 'post',
  path: '/plugins/preview',
  tags: ['capabilities'],
  summary: 'Preview a plugin',
  description:
    'Fetches it (pinned to a commit), checks it and shows what it would install: skills, MCP servers, the ' +
    'values it needs, and what it skips. Agent Plugins 1.0, .codex-plugin, .claude-plugin and plain skill folders.',
  request: body(PreviewPluginInputSchema),
  responses: {
    200: json(PluginPreviewSchema, 'What it would install'),
    422: problemResponse('It could not be fetched, or is not a plugin'),
  },
});

const installPlugin = createRoute({
  method: 'post',
  path: '/plugins',
  tags: ['capabilities'],
  summary: 'Install a previewed plugin',
  description:
    'Its skills are usable at once; its MCP servers are set up in the background (status shows progress).',
  request: body(InstallPluginInputSchema),
  responses: {
    201: json(PluginSchema, 'Installed (or installing)'),
    400: problemResponse('Missing inputs'),
    404: problemResponse('The preview expired'),
    409: problemResponse('A plugin with this name is installed'),
  },
});

const listPlugins = createRoute({
  method: 'get',
  path: '/plugins',
  tags: ['capabilities'],
  summary: 'Plugins',
  responses: { 200: json(PluginListSchema, 'Plugins') },
});

const getPlugin = createRoute({
  method: 'get',
  path: '/plugins/{id}',
  tags: ['capabilities'],
  summary: 'A plugin',
  request: { params: idParams },
  responses: { 200: json(PluginSchema, 'The plugin'), 404: problemResponse('No such plugin') },
});

const uninstallPlugin = createRoute({
  method: 'delete',
  path: '/plugins/{id}',
  tags: ['capabilities'],
  summary: 'Uninstall a plugin',
  description:
    'Its skills and servers leave every agent (a new version) and department, its containers and volumes ' +
    'go, then its files, skills, servers and secrets.',
  request: { params: idParams },
  responses: {
    204: { description: 'Uninstalled' },
    404: problemResponse('No such plugin'),
    409: problemResponse('Calls to its tools wait for approval'),
  },
});

export function registerCapabilityRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { catalog, secrets, mcp, skills, plugins, settings } = deps;

  v1.openapi(getCapabilities, async (c) =>
    c.json(
      {
        tools: catalog.list(),
        skills: skills.list().map((skill) => ({
          ref: `${skill.plugin}/${skill.name}`,
          plugin: skill.plugin,
          name: skill.name,
          description: skill.description,
        })),
        mcpServers: mcp.list().map((server) => ({
          slug: server.slug,
          name: server.name,
          transport: server.transport,
          status: server.status,
          enabled: server.enabled,
          tools: server.tools,
        })),
        plugins: (await plugins.list()).map((plugin) => ({
          name: plugin.name,
          title: plugin.title,
          version: plugin.version,
          status: plugin.status,
        })),
      },
      200,
    ),
  );

  v1.openapi(listSecrets, async (c) => c.json({ items: await secrets.list() }, 200));
  v1.openapi(putSecret, async (c) =>
    c.json(await secrets.put(c.req.valid('param').name, c.req.valid('json')), 200),
  );
  v1.openapi(deleteSecret, async (c) => {
    await secrets.remove(c.req.valid('param').name);
    return c.body(null, 204);
  });

  v1.openapi(listServers, (c) => c.json({ items: mcp.list() }, 200));
  v1.openapi(createServer, async (c) => c.json(await mcp.create(c.req.valid('json')), 201));
  v1.openapi(getServer, (c) => c.json(mcp.get(c.req.valid('param').id), 200));
  v1.openapi(updateServer, async (c) =>
    c.json(await mcp.update(c.req.valid('param').id, c.req.valid('json')), 200),
  );
  v1.openapi(deleteServer, async (c) => {
    // Under the config lock: an agent write must not grant the server while it goes.
    await settings.lock.run(() => mcp.remove(c.req.valid('param').id));
    return c.body(null, 204);
  });
  v1.openapi(refreshServer, async (c) => c.json(await mcp.refresh(c.req.valid('param').id), 200));

  v1.openapi(listSkills, (c) => c.json({ items: skills.list().map((skill) => skills.summary(skill)) }, 200));
  v1.openapi(getSkill, async (c) => c.json(await skills.get(c.req.valid('param').id), 200));

  v1.openapi(previewPlugin, async (c) => c.json(await plugins.preview(c.req.valid('json').source), 200));
  v1.openapi(installPlugin, async (c) => c.json(await plugins.install(c.req.valid('json')), 201));
  v1.openapi(listPlugins, async (c) => c.json({ items: await plugins.list() }, 200));
  v1.openapi(getPlugin, async (c) => c.json(await plugins.get(c.req.valid('param').id), 200));
  v1.openapi(uninstallPlugin, async (c) => {
    await plugins.uninstall(c.req.valid('param').id);
    return c.body(null, 204);
  });
}
