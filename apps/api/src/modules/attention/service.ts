import type { AttentionItem } from '@superagent/shared';
import type { KeyCheck } from '../../crypto/key-check';
import type { TaskRow } from '../../db/schema';
import type { BrowserService } from '../browser/service';
import type { McpService } from '../capabilities/mcp/service';
import { approvalId, type DispatchService, type PendingApproval } from '../dispatch/service';
import type { TaskService, TaskSignals } from '../ledger/service';
import type { OrgDirectory } from '../org/directory';
import type { ProviderService } from '../providers/service';
import type { ScheduleService } from '../schedules/service';
import type { SettingsService } from '../settings/service';
import { WORKSPACE_GRANTS, type WorkspaceService } from '../workspace/service';

export interface AttentionDeps {
  dispatch: DispatchService;
  directory: OrgDirectory;
  tasks: TaskService;
  schedules: ScheduleService;
  settings: SettingsService;
  providers: ProviderService;
  /** Whether document storage is configured. */
  storageEnabled: boolean;
  workspaces: WorkspaceService;
  browsers: BrowserService;
  mcp: McpService;
  /** Whether SUPERAGENT_ENCRYPTION_KEY opens the database's sealed values (checked at boot). */
  keyCheck: KeyCheck;
}

/** How long the runner's health is trusted (the inbox is read often; the runner may be down). */
const RUNNER_CHECK_MS = 30_000;

type Approval = PendingApproval & { agentName: string; departmentId: string };

/**
 * What needs the owner (decision D32), computed from live state on every read: tool calls waiting for
 * approval, leads' questions, tasks that stalled, results to review, and setup problems.
 */
export class AttentionService {
  private runnerCheck: { at: number; problem: Promise<string | undefined> } | undefined;
  private browserCheck: { at: number; problem: Promise<string | undefined> } | undefined;

  constructor(private readonly deps: AttentionDeps) {}

  async list(): Promise<AttentionItem[]> {
    const approvals = await this.approvals();
    const items: AttentionItem[] = approvals.map((approval) => ({
      id: approvalId(approval),
      kind: 'approval',
      title: `${approval.agentName} wants to run ${approval.tool}`,
      detail: approval.task ? `#${approval.task.number} ${approval.task.title}` : null,
      taskId: approval.task?.id ?? null,
      taskNumber: approval.task?.number ?? null,
      departmentId: approval.departmentId,
      agent: approval.agentKey,
      tool: approval.tool,
      args: approval.args,
      since: approval.since.toISOString(),
    }));
    const waitingForApproval = new Set(
      approvals.flatMap((approval) => (approval.task ? [approval.task.id] : [])),
    );
    const open = (await this.deps.tasks.openTasks(['waiting', 'review', 'inbox'])).filter(
      (task) => !waitingForApproval.has(task.id),
    );
    const signals = await this.deps.tasks.lastSignals(open.map((task) => task.id));
    for (const task of open) {
      const item = this.taskItem(task, signals.get(task.id) ?? {});
      if (item) items.push(item);
    }
    items.push(...(await this.identityWaits()));
    items.push(...(await this.health()));
    return items.sort((a, b) => b.since.localeCompare(a.since));
  }

  /** The approval an attention id points at, if it still waits. */
  async findApproval(id: string): Promise<Approval | undefined> {
    if (!id.startsWith('approval:')) return undefined;
    return (await this.approvals()).find((approval) => approvalId(approval) === id);
  }

  private async approvals(): Promise<Approval[]> {
    const approvals: Approval[] = [];
    for (const approval of await this.deps.dispatch.listApprovals()) {
      const agent = this.deps.directory.agentByKey(approval.agentKey);
      if (!agent) continue;
      approvals.push({ ...approval, agentName: agent.name, departmentId: agent.departmentId });
    }
    return approvals;
  }

  private taskItem(task: TaskRow, signals: TaskSignals): AttentionItem | undefined {
    const base = {
      id: `task:${task.id}`,
      taskId: task.id,
      taskNumber: task.number,
      departmentId: task.departmentId,
      agent: null,
      tool: null,
    };
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    if (task.phase === 'review') {
      return {
        ...base,
        kind: 'review',
        title: `#${task.number} ${task.title} is ready for review`,
        detail: text(signals.reported?.data.summary),
        since: task.updatedAt.toISOString(),
      };
    }
    if (task.phase === 'waiting') {
      const { reported, waiting } = signals;
      const last = reported && (!waiting || reported.seq > waiting.seq) ? reported : waiting;
      const question = last?.type === 'reported' && last.data.outcome === 'blocked';
      return {
        ...base,
        kind: question ? 'question' : 'problem',
        title: question
          ? `#${task.number} ${task.title}: the lead needs you`
          : `#${task.number} ${task.title} stopped`,
        detail: text(question ? last?.data.summary : last?.data.reason),
        since: (last?.createdAt ?? task.updatedAt).toISOString(),
      };
    }
    if (task.phase === 'inbox' && signals.notDispatched) {
      const { data, createdAt } = signals.notDispatched;
      const hasLead = Boolean(this.deps.directory.leadOf(task.departmentId));
      return {
        ...base,
        kind: 'problem',
        title: hasLead
          ? `#${task.number} ${task.title} waits in the inbox`
          : `#${task.number} ${task.title} has nobody to work on it`,
        detail: hasLead
          ? `${data.cause === 'no_lead' ? 'Its department has a lead now' : `It could not be sent: ${text(data.reason) ?? 'unknown error'}`}. Send it to its lead.`
          : 'Its department has no lead',
        since: createdAt.toISOString(),
      };
    }
    return undefined;
  }

  /** Tasks whose browser waits for an identity another browser is using. */
  private async identityWaits(): Promise<AttentionItem[]> {
    const waits = this.deps.browsers.waitingTasks();
    if (waits.length === 0) return [];
    const tasks = await this.deps.tasks.byIds(waits.map((wait) => wait.taskId));
    return waits.flatMap((wait) => {
      const task = tasks.get(wait.taskId);
      if (!task) return [];
      return [
        {
          id: `task:${task.id}`,
          kind: 'problem' as const,
          title: `#${task.number} ${task.title} waits for the browser identity "${wait.identity}"`,
          detail: 'Another browser is using it. Closing that browser lets this task go on.',
          taskId: task.id,
          taskNumber: task.number,
          departmentId: task.departmentId,
          agent: null,
          tool: null,
          since: wait.since,
        },
      ];
    });
  }

  private mcpCheck: { at: number; problem: Promise<string | undefined> } | undefined;

  /** Whether the runner can run stdio MCP servers (image and network), checked at most every 30 s. */
  private mcpProblem(): Promise<string | undefined> {
    const now = Date.now();
    if (!this.mcpCheck || now - this.mcpCheck.at > RUNNER_CHECK_MS) {
      this.mcpCheck = {
        at: now,
        problem: this.deps.workspaces.problem().then(async (sandboxes) => {
          if (sandboxes === 'off' || sandboxes === 'unreachable' || sandboxes === 'no-docker')
            return sandboxes;
          return (await this.deps.browsers.runnerReady())?.mcp === false ? 'no-image' : undefined;
        }),
      };
    }
    return this.mcpCheck.problem;
  }

  private limitsCheck: { at: number; ignored: Promise<boolean> } | undefined;

  /** Whether the runner's Docker ignores container limits (the runner then creates no container). */
  private limitsIgnored(): Promise<boolean> {
    const now = Date.now();
    if (!this.limitsCheck || now - this.limitsCheck.at > RUNNER_CHECK_MS) {
      this.limitsCheck = {
        at: now,
        ignored: this.deps.browsers.runnerReady().then(
          (ready) => ready?.docker === true && ready.limits === false,
          () => false,
        ),
      };
    }
    return this.limitsCheck.ignored;
  }

  private browserProblem(): Promise<string | undefined> {
    const now = Date.now();
    if (!this.browserCheck || now - this.browserCheck.at > RUNNER_CHECK_MS) {
      this.browserCheck = { at: now, problem: this.deps.browsers.problem() };
    }
    return this.browserCheck.problem;
  }

  private sandboxProblem(): Promise<string | undefined> {
    const now = Date.now();
    if (!this.runnerCheck || now - this.runnerCheck.at > RUNNER_CHECK_MS) {
      this.runnerCheck = { at: now, problem: this.deps.workspaces.problem() };
    }
    return this.runnerCheck.problem;
  }

  /** Setup problems that stop work. */
  private async health(): Promise<AttentionItem[]> {
    const now = new Date().toISOString();
    const item = (
      check: string,
      title: string,
      detail: string,
      departmentId: string | null = null,
    ): AttentionItem => ({
      id: `health:${check}`,
      kind: 'health',
      title,
      detail,
      taskId: null,
      taskNumber: null,
      departmentId,
      agent: null,
      tool: null,
      since: now,
    });
    const items: AttentionItem[] = [];
    const { models } = this.deps.settings.get();
    if (!models.default) {
      items.push(
        item('default-model', 'No default model is set: agents cannot run', 'Pick one in settings.'),
      );
    } else if (!this.deps.providers.isUsable(models.default, 'chat')) {
      items.push(
        item(
          'default-model',
          "The default model can't be used",
          'Its provider is disabled, its key unreadable, or the model is gone.',
        ),
      );
    }
    if (models.fast && !this.deps.providers.isUsable(models.fast, 'chat')) {
      items.push(
        item(
          'fast-model',
          "The fast model can't be used",
          'Long threads are compressed with the default model meanwhile.',
        ),
      );
    }
    if (!this.deps.storageEnabled) {
      items.push(
        item(
          'storage',
          'Document uploads are off',
          'Set S3_ACCESS_KEY and S3_SECRET_KEY to store documents.',
        ),
      );
    }
    if (this.deps.keyCheck === 'mismatch') {
      items.push(
        item(
          'encryption-key',
          "The encryption key doesn't open this database's secrets",
          "SUPERAGENT_ENCRYPTION_KEY is not the key its provider keys and secrets were sealed with (a restore with another .env?). Start with the right key, or set each provider's key and each secret again.",
        ),
      );
    }
    if (await this.limitsIgnored()) {
      items.push(
        item(
          'runner-limits',
          "The runner's Docker ignores container limits",
          'No sandbox, browser or MCP server starts, new or stopped, until the daemon enforces memory, CPU and process limits. Rootless Docker needs cgroup delegation (docs/runbooks/server.md).',
        ),
      );
    }
    const sandboxed = this.deps.directory
      .agents()
      .filter((agent) =>
        agent.current.tools.some((grant) => (WORKSPACE_GRANTS as readonly string[]).includes(grant.key)),
      );
    if (sandboxed.length > 0) {
      const names = sandboxed.map((agent) => agent.name).join(', ');
      const problem = await this.sandboxProblem();
      const what = {
        off: ['Sandboxes are off', `Set RUNNER_URL and RUNNER_TOKEN: ${names} can't use files or commands.`],
        unreachable: [
          "The sandbox runner can't be reached",
          `${names} can't use files or commands until it is back.`,
        ],
        'no-docker': [
          "The sandbox runner can't reach Docker",
          `Check its access to the Docker socket (DOCKER_SOCKET_GID on Linux): ${names} can't use files or commands.`,
        ],
        'no-image': [
          'The sandbox image is not built',
          `Build it with "docker compose --profile app build sandbox-dev": ${names} can't use files or commands.`,
        ],
      }[problem ?? ''];
      if (what) items.push(item('sandboxes', what[0] as string, what[1] as string));
    }
    // MCP servers someone is granted that don't work: their tools are missing or failing.
    for (const server of this.deps.mcp.list()) {
      if (!server.enabled || server.status !== 'failed') continue;
      const users = this.deps.directory.grantingMcp(server.slug);
      if (users.length === 0 && !server.plugin) continue;
      items.push(
        item(
          `mcp-${server.slug}`,
          `The MCP server ${server.name} does not work`,
          `${server.statusDetail ?? 'Its tools could not be listed'}${users.length > 0 ? ` (granted to ${users.join(', ')})` : ''}. Fix it, then list its tools again (POST /v1/mcp-servers/{id}/refresh).`,
        ),
      );
    }
    if (this.deps.mcp.list().some((server) => server.enabled && server.transport === 'stdio')) {
      const problem = await this.mcpProblem();
      const what = {
        off: [
          'Plugin MCP servers are off',
          'Set RUNNER_URL and RUNNER_TOKEN: their stdio servers cannot run.',
        ],
        unreachable: [
          "The runner can't be reached",
          "Plugins' stdio MCP servers can't run until it is back.",
        ],
        'no-docker': ["The runner can't reach Docker", "Plugins' stdio MCP servers can't run."],
        'no-image': [
          'Plugin MCP servers are not set up',
          'Build the MCP image ("docker compose --profile mcp build mcp") and start the egress proxy ("docker compose up -d egress").',
        ],
      }[problem ?? ''];
      if (what) items.push(item('mcp', what[0] as string, what[1] as string));
    }
    const browsing = this.deps.directory
      .agents()
      .filter((agent) => agent.current.tools.some((grant) => grant.key === 'browser'));
    if (browsing.length > 0) {
      const names = browsing.map((agent) => agent.name).join(', ');
      const problem = await this.browserProblem();
      const what = {
        off: ['Browsers are off', `Set RUNNER_URL and RUNNER_TOKEN: ${names} can't use the browser.`],
        unreachable: ["The runner can't be reached", `${names} can't use the browser until it is back.`],
        'no-docker': ["The runner can't reach Docker", `${names} can't use the browser.`],
        'no-image': [
          'Browsers are not set up',
          `Build the browser image ("docker compose --profile browser build browser") and start the egress proxy ("docker compose up -d egress"): ${names} can't use the browser.`,
        ],
      }[problem ?? ''];
      if (what) items.push(item('browsers', what[0] as string, what[1] as string));
    }
    const active = (await this.deps.schedules.list()).filter((s) => s.status === 'active');
    for (const departmentId of new Set(active.map((s) => s.departmentId))) {
      const department = this.deps.directory.department(departmentId);
      if (!department || department.archivedAt || this.deps.directory.leadOf(departmentId)) continue;
      items.push(
        item(
          `schedules-${departmentId}`,
          `${department.name} has schedules but no lead`,
          'Their tasks wait in the inbox until the department has a lead.',
          departmentId,
        ),
      );
    }
    return items;
  }
}
