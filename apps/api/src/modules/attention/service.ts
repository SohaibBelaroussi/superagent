import type { AttentionItem } from '@superagent/shared';
import type { TaskRow } from '../../db/schema';
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
}

/** How long the runner's health is trusted (the inbox is read often; the runner may be down). */
const RUNNER_CHECK_MS = 30_000;

type Approval = PendingApproval & { agentName: string; departmentId: string };

/**
 * What needs the owner (decision D32), computed from live state on every read: tool calls waiting for
 * approval, leads' questions, tasks that stalled, results to review, and setup problems.
 */
export class AttentionService {
  private runnerCheck: { at: number; healthy: Promise<boolean> } | undefined;

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
          ? `${data.cause === 'no_lead' ? 'Its department has a lead now' : `It could not be sent: ${text(data.reason) ?? 'unknown error'}`}. Send it to the lead (phase "queued").`
          : 'Its department has no lead',
        since: createdAt.toISOString(),
      };
    }
    return undefined;
  }

  private runnerHealthy(): Promise<boolean> {
    const now = Date.now();
    if (!this.runnerCheck || now - this.runnerCheck.at > RUNNER_CHECK_MS) {
      this.runnerCheck = { at: now, healthy: this.deps.workspaces.healthy() };
    }
    return this.runnerCheck.healthy;
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
    const sandboxed = this.deps.directory
      .agents()
      .filter((agent) =>
        agent.current.tools.some((grant) => (WORKSPACE_GRANTS as readonly string[]).includes(grant.key)),
      );
    if (sandboxed.length > 0) {
      const names = sandboxed.map((agent) => agent.name).join(', ');
      if (!this.deps.workspaces.enabled) {
        items.push(
          item(
            'sandboxes',
            'Sandboxes are off',
            `Set RUNNER_URL and RUNNER_TOKEN: ${names} can't use files or commands.`,
          ),
        );
      } else if (!(await this.runnerHealthy())) {
        items.push(
          item(
            'sandboxes',
            "The sandbox runner can't be reached",
            `${names} can't use files or commands until it is back.`,
          ),
        );
      }
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
