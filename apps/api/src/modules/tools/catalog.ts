import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import type { CatalogTool, ToolGrant } from '@superagent/shared';
import { z } from 'zod';
import { isValidTimezone, truncate } from '../../util/text';
import type { KnowledgeService } from '../knowledge/service';
import type { OrgDirectory } from '../org/directory';
import type { SettingsService } from '../settings/service';
import { fetchPage, searchWeb, type WebToolsConfig } from './web';

export interface ToolContext {
  settings: SettingsService;
  web: WebToolsConfig;
  knowledge: KnowledgeService;
  directory: OrgDirectory;
}

interface CatalogEntry {
  key: string;
  pack: 'core' | 'web' | 'knowledge';
  description: string;
  create(ctx: ToolContext, options: { requireApproval: boolean }): ToolsInput[string];
}

/** Every tool an agent definition can be granted. New tools ship in code; definitions reference keys. */
const ENTRIES: CatalogEntry[] = [
  {
    key: 'current_time',
    pack: 'core',
    description: "The current date and time in the owner's timezone (or another IANA timezone).",
    create: (ctx, { requireApproval }) =>
      createTool({
        id: 'current_time',
        description: "Get the current date and time. Defaults to the owner's timezone.",
        inputSchema: z.object({
          timezone: z.string().optional().describe('IANA timezone such as Europe/Paris'),
        }),
        requireApproval,
        execute: async ({ timezone }) => {
          const zone = timezone && isValidTimezone(timezone) ? timezone : ctx.settings.get().timezone;
          const now = new Date();
          return {
            iso: now.toISOString(),
            timezone: zone,
            local: new Intl.DateTimeFormat('en-GB', {
              timeZone: zone,
              dateStyle: 'full',
              timeStyle: 'short',
            }).format(now),
          };
        },
      }),
  },
  {
    key: 'web_search',
    pack: 'web',
    description: 'Search the web (self-hosted SearXNG). Returns titles, URLs and snippets.',
    create: (ctx, { requireApproval }) =>
      createTool({
        id: 'web_search',
        description:
          'Search the web. Returns up to `limit` results with title, url and snippet. ' +
          'Use fetch_page to read a result in full.',
        inputSchema: z.object({
          query: z.string().min(1).max(400),
          limit: z.number().int().min(1).max(20).optional(),
        }),
        requireApproval,
        execute: async ({ query, limit }, context) => ({
          results: await searchWeb(ctx.web, query, { limit: limit ?? 8, signal: context?.abortSignal }),
        }),
      }),
  },
  {
    key: 'fetch_page',
    pack: 'web',
    description: 'Read a public web page as markdown (self-hosted Crawl4AI, renders JavaScript).',
    create: (ctx, { requireApproval }) =>
      createTool({
        id: 'fetch_page',
        description:
          'Fetch a public web page and return its main content as markdown. Long pages are truncated.',
        inputSchema: z.object({
          url: z.string().min(1).describe('Full http(s) URL'),
          maxChars: z.number().int().min(1000).max(50_000).optional(),
        }),
        requireApproval,
        execute: async ({ url, maxChars }, context) =>
          fetchPage(ctx.web, url, { maxChars: maxChars ?? 20_000, signal: context?.abortSignal }),
      }),
  },
  {
    key: 'knowledge_search',
    pack: 'knowledge',
    description: "Search the owner's uploaded documents: the agent's department's and the shared ones.",
    create: (ctx, { requireApproval }) =>
      createTool({
        id: 'knowledge_search',
        description:
          "Search the owner's documents for passages about a topic. Returns the best passages with their " +
          'document titles. Use several specific words.',
        inputSchema: z.object({
          query: z.string().min(1).max(400),
          limit: z.number().int().min(1).max(10).optional(),
        }),
        requireApproval,
        execute: async ({ query, limit }, context) => {
          // Department agents search their department's documents and the shared ones.
          const agentKey = (context as { agent?: { agentId?: string } } | undefined)?.agent?.agentId;
          const agent = agentKey ? ctx.directory.agentByKey(agentKey) : undefined;
          const hits = await ctx.knowledge.search(query, {
            departmentId: agent?.departmentId,
            limit: limit ?? 5,
          });
          return {
            results: hits.map((hit) => ({
              document: hit.title,
              documentId: hit.documentId,
              passage: truncate(hit.content, 1500),
            })),
          };
        },
      }),
  },
];

export class ToolCatalog {
  private readonly byKey = new Map(ENTRIES.map((entry) => [entry.key, entry]));

  constructor(private readonly ctx: ToolContext) {}

  list(): CatalogTool[] {
    return ENTRIES.map(({ key, pack, description }) => ({ key, pack, description }));
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Builds a fresh tool record for an agent. Record keys are the names the model sees. */
  build(grants: ToolGrant[]): ToolsInput {
    const tools: ToolsInput = {};
    for (const grant of grants) {
      const entry = this.byKey.get(grant.key);
      if (entry) tools[grant.key] = entry.create(this.ctx, { requireApproval: grant.requireApproval });
    }
    return tools;
  }
}
