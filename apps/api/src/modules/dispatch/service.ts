import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import type { Memory } from '@mastra/memory';
import type { TaskRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { truncate } from '../../util/text';
import type { PhaseActor } from '../ledger/phases';
import { TERMINAL_PHASES } from '../ledger/phases';
import type { TaskService } from '../ledger/service';
import type { OrgDirectory } from '../org/directory';

/** The owner's conversation with the chief of staff. */
export const CHIEF_THREAD = 'chief:main';
export const OWNER_RESOURCE = 'owner';

const FAILED_FINISH_REASONS = new Set(['error', 'retry', 'aborted', 'other', 'unknown']);
/** How long new work waits for a lead's run that is wrapping up on the task's thread. */
const IDLE_WAIT_MS = 3000;
const IDLE_POLL_MS = 50;

type Accepted = {
  action: string;
  runId?: string;
  output?: { text: PromiseLike<string>; finishReason?: PromiseLike<string | undefined> };
};

export interface DispatchDeps {
  mastra: Mastra;
  tasks: TaskService;
  directory: OrgDirectory;
  memory: Memory;
  logger: IMastraLogger;
}

function briefFor(task: TaskRow, note?: string): string {
  return [
    `Task #${task.number}: ${task.title}`,
    '',
    task.brief,
    ...(note ? ['', `Note from the owner: ${note}`] : []),
    '',
    'Work on it with your team: mark progress with update_task (phase "working", a checklist), delegate to your specialists, and finish with report_to_chief (outcome "done", "blocked" or "failed") including the result.',
  ].join('\n');
}

/**
 * Chief-to-department messaging (decision D15). The only module that calls Mastra's experimental
 * signal APIs (sendMessage, queueMessage, sendNotificationSignal), per decision D22.
 */
export class DispatchService {
  /** Per task, the run whose end decides whether the lead stalled. Newer work replaces it. */
  private readonly watched = new Map<string, symbol>();
  private closing = false;

  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Shutdown: stops every agent run (leads and the chief) and waits up to `timeoutMs` for them to end,
   * so nothing writes after the database closes. Their tasks are flagged as interrupted at the next boot.
   */
  async close(timeoutMs: number): Promise<void> {
    this.closing = true;
    this.watched.clear();
    const agents = Object.values(this.deps.mastra.listAgents()) as Agent[];
    const activeRuns = () =>
      new Set(agents.flatMap((agent) => agent.listActiveThreadRuns().map((run) => run.runId)));
    for (const runId of activeRuns()) agents.some((agent) => agent.abortRunStream(runId));
    const deadline = Date.now() + timeoutMs;
    while (activeRuns().size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
  }

  async ensureChiefThread(): Promise<void> {
    const { memory } = this.deps;
    if (!(await memory.getThreadById({ threadId: CHIEF_THREAD }))) {
      await memory.createThread({
        threadId: CHIEF_THREAD,
        resourceId: OWNER_RESOURCE,
        title: 'Chief of staff',
      });
    }
  }

  /** The lead a department's tasks go to. Check before creating a task that will be dispatched. */
  requireLead(departmentId: string) {
    if (!this.deps.directory.department(departmentId)) {
      throw new ApiError(404, 'department_not_found', `No department with id ${departmentId}`);
    }
    const lead = this.deps.directory.leadOf(departmentId);
    if (!lead) {
      throw new ApiError(
        409,
        'department_has_no_lead',
        'This department has no lead agent to send the task to',
      );
    }
    return lead;
  }

  /** Sends a task to its department lead, on the task's own thread (waking the lead if idle). */
  async dispatch(task: TaskRow, actor: PhaseActor, actorLabel: string, note?: string): Promise<TaskRow> {
    const lead = this.requireLead(task.departmentId);
    const agent = this.agent(lead.key);
    await this.ensureTaskThread(task);
    await this.startNewWork(agent, task);
    const queued = await this.deps.tasks.transition(task.id, 'queued', actor, actorLabel, {
      patch: { leadAgentId: lead.id },
      data: { lead: lead.key },
    });
    const accepted = await this.send(
      agent,
      queued,
      { contents: briefFor(queued, note), attributes: { from: 'chief', task: `#${queued.number}` } },
      'steer',
    );
    await this.deps.tasks.note(queued.id, 'dispatched', 'system', {
      lead: lead.key,
      action: accepted.action,
      ...(accepted.runId ? { runId: accepted.runId } : {}),
    });
    return queued;
  }

  /** A message from the owner (or the chief on their behalf) to the lead working on a task. */
  async message(task: TaskRow, text: string, mode: 'steer' | 'queue', actorLabel: string): Promise<TaskRow> {
    if (TERMINAL_PHASES.has(task.phase)) {
      throw new ApiError(
        409,
        'task_closed',
        `Task #${task.number} is ${task.phase}. Reopen it first (phase "queued").`,
      );
    }
    const lead = this.leadOf(task);
    if (!lead) throw new ApiError(409, 'department_has_no_lead', 'This department has no lead agent');
    if (task.phase === 'inbox') return this.dispatch(task, 'owner', actorLabel, text);
    const agent = this.agent(lead.key);
    let current = task;
    // A waiting or reviewed task goes back to the lead as new work; a task in progress gets the message mid-run.
    if (task.phase === 'waiting' || task.phase === 'review') {
      await this.startNewWork(agent, task);
      current = await this.deps.tasks.transition(task.id, 'queued', 'owner', actorLabel, {
        data: { reason: 'owner replied' },
      });
    }
    const from = actorLabel === 'chief' ? 'chief' : 'owner';
    const contents = {
      contents: `Message from the ${from === 'chief' ? 'chief of staff' : 'owner'} about task #${current.number}:\n\n${text}`,
      attributes: { from, task: `#${current.number}` },
    };
    const accepted = await this.send(agent, current, contents, mode);
    await this.deps.tasks.note(current.id, 'message', actorLabel, {
      mode,
      text: truncate(text, 500),
      action: accepted.action,
    });
    return current;
  }

  /** Cancels a task and stops the lead's current run on it, if any. */
  async cancel(task: TaskRow, reason: string | undefined, actorLabel: string): Promise<TaskRow> {
    const cancelled = await this.deps.tasks.transition(task.id, 'cancelled', 'owner', actorLabel, {
      data: reason ? { reason } : {},
    });
    this.watched.delete(task.id);
    const lead = this.leadOf(task);
    if (lead) {
      // Also drops messages still waiting for the lead's next turn, so nothing restarts the work.
      const stopped = this.agent(lead.key).abortThreadStream({
        threadId: task.threadId,
        resourceId: task.resourceId,
        clearPendingSignals: true,
      });
      this.deps.logger.debug('Cancelled task', { taskId: task.id, stoppedRun: stopped });
    }
    return cancelled;
  }

  /** The lead's final report. Done goes to review (or straight to done when the department auto-closes). */
  async report(
    task: TaskRow,
    leadKey: string,
    report: { outcome: 'done' | 'blocked' | 'failed'; summary: string; result?: string },
  ): Promise<TaskRow> {
    const department = this.deps.directory.department(task.departmentId);
    const phase =
      report.outcome === 'done'
        ? department?.autoClose
          ? 'done'
          : 'review'
        : report.outcome === 'blocked'
          ? 'waiting'
          : 'failed';
    const updated = await this.deps.tasks.report(task.id, `agent:${leadKey}`, {
      phase,
      outcome: report.outcome,
      summary: report.summary,
      result: report.result ?? report.summary,
    });
    await this.notifyChief(
      updated,
      `task-${report.outcome}`,
      `#${updated.number} ${updated.title}: ${report.summary}`,
      report.outcome === 'done' ? 'medium' : 'high',
    );
    return updated;
  }

  /** After a restart, runs that were in flight are gone: flag their tasks for the owner. */
  async recoverInterrupted(): Promise<number> {
    const interrupted = await this.deps.tasks.openTasks(['queued', 'working']);
    for (const task of interrupted) {
      const reason = 'The server restarted while the lead was working on this task';
      const flagged = await this.deps.tasks.transition(task.id, 'waiting', 'system', 'system', {
        data: { reason },
      });
      await this.notifyChief(flagged, 'task-interrupted', `#${task.number} ${task.title}: ${reason}`, 'high');
    }
    return interrupted.length;
  }

  /**
   * Before sending new work: lets a run still wrapping up on the task's thread finish, so the work starts
   * its own run instead of landing in one that is ending, and stops earlier runs from flagging the task.
   */
  private async startNewWork(agent: Agent, task: TaskRow): Promise<void> {
    const thread = { resourceId: task.resourceId, threadId: task.threadId };
    const deadline = Date.now() + IDLE_WAIT_MS;
    while (agent.getActiveThreadRunId(thread) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
    this.watched.delete(task.id);
  }

  /**
   * A lead that is mid-run on the task gets the message in that run (steer) or its next turn (queue).
   * Otherwise the message starts a fresh run on the task's thread. Signals are not used to wake idle
   * threads: in Mastra 1.74 a wake sent just as a run ends can land in that run and never be processed.
   */
  private async send(
    agent: Agent,
    task: TaskRow,
    message: { contents: string; attributes: Record<string, string> },
    mode: 'steer' | 'queue',
  ): Promise<Accepted> {
    const thread = { resourceId: task.resourceId, threadId: task.threadId };
    if (agent.getActiveThreadRunId(thread)) {
      const target = {
        ...thread,
        ifActive: { behavior: 'deliver' as const },
        ifIdle: { behavior: 'wake' as const },
      };
      const sent =
        mode === 'queue' ? agent.queueMessage(message, target) : agent.sendMessage(message, target);
      const accepted = (await sent.accepted) as Accepted;
      if (accepted.output) this.watchRun(task.id, accepted.output);
      // Queued behind a busy run: a later run handles it, so the current run's end says nothing about it.
      else if (mode === 'queue' && accepted.action === 'deliver') this.watched.delete(task.id);
      return accepted;
    }
    const output = await agent.stream(message.contents, {
      memory: { thread: task.threadId, resource: task.resourceId },
    });
    this.watchRun(task.id, output);
    return { action: 'run', runId: output.runId };
  }

  private watchRun(taskId: string, output: NonNullable<Accepted['output']>): void {
    const token = Symbol(taskId);
    this.watched.set(taskId, token);
    void (async () => {
      let problem: string | undefined;
      try {
        await output.text;
        const finishReason = output.finishReason ? await output.finishReason : undefined;
        if (finishReason && FAILED_FINISH_REASONS.has(finishReason)) {
          problem = `The lead's run ended unexpectedly (${finishReason})`;
        }
      } catch (error) {
        problem = `The lead's run failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (this.closing) return;
      const reason = problem ?? 'The lead finished its turn without reporting a result';
      // Decided under the row lock: newer work (or a report) may have arrived while the run was ending.
      const flagged = await this.deps.tasks.transitionIf(
        taskId,
        'waiting',
        'system',
        'system',
        (task) => this.watched.get(taskId) === token && (task.phase === 'queued' || task.phase === 'working'),
        { reason },
      );
      if (this.watched.get(taskId) === token) this.watched.delete(taskId);
      if (flagged) {
        await this.notifyChief(
          flagged,
          'task-stalled',
          `#${flagged.number} ${flagged.title}: ${reason}`,
          'high',
        );
      }
    })().catch((error: unknown) => this.deps.logger.error('Watching a lead run failed', { taskId, error }));
  }

  private async notifyChief(
    task: TaskRow,
    kind: string,
    summary: string,
    priority: 'low' | 'medium' | 'high' | 'urgent',
  ): Promise<void> {
    if (this.closing) return;
    try {
      const department = this.deps.directory.department(task.departmentId);
      const result = await this.agent('chief').sendNotificationSignal(
        {
          source: `dept:${department?.slug ?? task.departmentId}`,
          kind,
          summary: truncate(summary, 500),
          priority,
          payload: { taskId: task.id, number: task.number, phase: task.phase },
          dedupeKey: `task:${task.id}:${task.revision}`,
        },
        { resourceId: OWNER_RESOURCE, threadId: CHIEF_THREAD },
      );
      await this.deps.tasks.note(task.id, 'chief_notified', 'system', {
        kind,
        priority,
        decision: (result as { decision?: { action?: string } }).decision?.action ?? null,
      });
    } catch (error) {
      this.deps.logger.warn('Could not notify the chief of staff', { taskId: task.id, error });
    }
  }

  private async ensureTaskThread(task: TaskRow): Promise<void> {
    const { memory } = this.deps;
    if (!(await memory.getThreadById({ threadId: task.threadId }))) {
      await memory.createThread({
        threadId: task.threadId,
        resourceId: task.resourceId,
        title: `#${task.number} ${task.title}`,
        metadata: { taskId: task.id, taskNumber: task.number, departmentId: task.departmentId },
      });
    }
  }

  private leadOf(task: TaskRow) {
    return (
      (task.leadAgentId ? this.deps.directory.agent(task.leadAgentId) : undefined) ??
      this.deps.directory.leadOf(task.departmentId)
    );
  }

  private agent(key: string): Agent {
    return this.deps.mastra.getAgent(key) as Agent;
  }
}
