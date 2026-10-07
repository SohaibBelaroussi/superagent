import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import type { HonoBindings, HonoVariables } from '@mastra/hono';
import type { TokenService } from '../auth/tokens';
import type { Config } from '../config';
import type { KeyCheck } from '../crypto/key-check';
import type { Db } from '../db/client';
import type { DecisionService } from '../modules/attention/decisions';
import type { AttentionService } from '../modules/attention/service';
import type { IdentityService } from '../modules/browser/identities';
import type { BrowserService } from '../modules/browser/service';
import type { McpService } from '../modules/capabilities/mcp/service';
import type { PluginService } from '../modules/capabilities/plugins/service';
import type { SecretService } from '../modules/capabilities/secrets';
import type { SkillStore } from '../modules/capabilities/skills';
import type { DispatchService } from '../modules/dispatch/service';
import type { KnowledgeService } from '../modules/knowledge/service';
import type { EventBus } from '../modules/ledger/events';
import type { TaskService } from '../modules/ledger/service';
import type { MemoryService } from '../modules/memory/service';
import type { OrgService } from '../modules/org/service';
import type { ProviderService } from '../modules/providers/service';
import type { ScheduleService } from '../modules/schedules/service';
import type { SettingsService } from '../modules/settings/service';
import type { ToolCatalog } from '../modules/tools/catalog';
import type { UsageService } from '../modules/usage/service';
import type { WorkspaceService } from '../modules/workspace/service';

/** Hono environment shared by Mastra's adapter and our routes (requestContext, mastra, ...). */
export type AppEnv = { Bindings: HonoBindings; Variables: HonoVariables };

/** Everything the HTTP layer needs. Built once in bootstrap(). */
export interface AppDeps {
  config: Config;
  logger: IMastraLogger;
  mastra: Mastra;
  db: Db;
  tokens: TokenService;
  providers: ProviderService;
  settings: SettingsService;
  org: OrgService;
  catalog: ToolCatalog;
  tasks: TaskService;
  dispatch: DispatchService;
  bus: EventBus;
  knowledge: KnowledgeService;
  memory: MemoryService;
  schedules: ScheduleService;
  attention: AttentionService;
  decisions: DecisionService;
  workspaces: WorkspaceService;
  browsers: BrowserService;
  identities: IdentityService;
  secrets: SecretService;
  mcp: McpService;
  skills: SkillStore;
  plugins: PluginService;
  usage: UsageService;
  /** Whether SUPERAGENT_ENCRYPTION_KEY opens the database's sealed values (checked at boot). */
  keyCheck: KeyCheck;
}
