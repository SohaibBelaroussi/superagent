import type { AttentionItem } from '@superagent/shared';
import type { TaskRow } from '../../db/schema';
import { approvalId, type DispatchService, type PendingApproval } from '../dispatch/service';
import type { TaskService } from '../ledger/service';
import type { OrgDirectory } from '../org/directory';
import type { ProviderService } from '../providers/service';
import type { ScheduleService } from '../schedules/service';
import type { SettingsService } from '../settings/service';

export interface AttentionDeps {
  dispatch: DispatchService;
  directory: OrgDirectory;
  tasks: TaskService;
  schedules: ScheduleService;
  settings: SettingsService;
  providers: ProviderService;
  /** Whether document storage is configured. */
  storageEnabled: boolean;
}

type Approval = PendingApproval & { task?: TaskRow; agentName: string; departmentId: string };

/**
 * What needs the owner (decision D32), computed from live state on every read: tool calls waiting for
 * approval, leads' questions, tasks that stalled, results to review, and setup problems.
 */
export class AttentionService {
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
    for (const task of await this.deps.tasks.openTasks(['waiting', 'review', 'inbox'])) {
      if (waitingForApproval.has(task.id)) continue;
      const item = await this.taskItem(task);
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
    const leads = new Map(this.deps.directory.agents({ role: 'lead' }).map((lead) => [lead.key, lead]));
    const approvals: Approval[] = [];
    for (const approval of await this.deps.dispatch.listApprovals()) {
      const lead = leads.get(approval.agentKey);
      if (!lead) continue;
      const task = approval.threadId ? await this.deps.tasks.getByThread(approval.threadId) : undefined;
      approvals.push({ ...approval, agentName: lead.name, departmentId: lead.departmentId, task });
    }
    return approvals;
  }

  private async taskItem(task: TaskRow): Promise<AttentionItem | undefined> {
    const base = {
      id: `task:${task.id}`,
      taskId: task.id,
      taskNumber: task.number,
      departmentId: task.departmentId,
      agent: null,
      tool: null,
    };
    const events = await this.deps.tasks.recentEvents(task.id, 20);
    if (task.phase === 'review') {
      const report = events.findLast((e) => e.type === 'reported');
      return {
        ...base,
        kind: 'review',
        title: `#${task.number} ${task.title} is ready for review`,
        detail: typeof report?.data.summary === 'string' ? report.data.summary : null,
        since: task.updatedAt.toISOString(),
      };
    }
    if (task.phase === 'waiting') {
      const last = events.findLast(
        (e) => e.type === 'reported' || (e.type === 'phase_changed' && e.data.to === 'waiting'),
      );
      const question = last?.type === 'reported' && last.data.outcome === 'blocked';
      const detail = question ? last?.data.summary : last?.data.reason;
      return {
        ...base,
        kind: question ? 'question' : 'problem',
        title: question
          ? `#${task.number} ${task.title}: the lead needs you`
          : `#${task.number} ${task.title} stopped`,
        detail: typeof detail === 'string' ? detail : null,
        since: last?.createdAt ?? task.updatedAt.toISOString(),
      };
    }
    if (task.phase === 'inbox' && events.some((e) => e.type === 'not_dispatched')) {
      return {
        ...base,
        kind: 'problem',
        title: `#${task.number} ${task.title} has nobody to work on it`,
        detail: 'Its department has no lead',
        since: task.createdAt.toISOString(),
      };
    }
    return undefined;
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
    const active = (await this.deps.schedules.list()).filter((s) => s.status === 'active');
    for (const departmentId of new Set(active.map((s) => s.departmentId))) {
      if (this.deps.directory.leadOf(departmentId)) continue;
      const department = this.deps.directory.department(departmentId);
      items.push(
        item(
          `schedules-${departmentId}`,
          `${department?.name ?? 'A department'} has schedules but no lead`,
          'Their tasks wait in the inbox until the department has a lead.',
          departmentId,
        ),
      );
    }
    return items;
  }
}
