import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { decisions, type TaskRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { truncate } from '../../util/text';
import { type PhaseActor, TERMINAL_PHASES } from '../ledger/phases';
import type { TaskService } from '../ledger/service';
import type { MemoryProfiles } from '../memory/profiles';
import type { AgentEntry, OrgDirectory } from '../org/directory';

/** The owner's conversation with the chief of staff. */
export const CHIEF_THREAD = 'chief:main';
export const OWNER_RESOURCE = 'owner';

const FAILED_FINISH_REASONS = new Set(['error', 'retry', 'aborted', 'other', 'unknown']);
/** How often a supervised task thread is checked, and how long it must stay idle before deciding. */
const POLL_MS = 200;
const IDLE_CONFIRM_MS = 600;
/** Every so many busy polls (about 5 s), check whether the run on the thread waits for an approval. */
const APPROVAL_CHECK_POLLS = 25;

export interface DispatchDeps {
  mastra: Mastra;
  db: Db;
  tasks: TaskService;
  directory: OrgDirectory;
  memory: MemoryProfiles;
  logger: IMastraLogger;
}

type Message = { contents: string; attributes: Record<string, string> };
type Pending = { message: Message; actorLabel: string };

/**
 * While the lead has a task, one supervisor watches the task's thread. It decides when the thread has
 * gone idle, not when one run ends, so every way a turn carries on (steered messages, follow-up runs
 * Mastra starts itself) is covered, and nothing the lead was sent can be dropped silently.
 */
interface Supervision {
  /** Bumped whenever new work is sent, so a decision made for older work is dropped. */
  generation: number;
  /** Work that waits for the lead's current turn to end, then goes out as a fresh run. */
  queued: Pending[];
  /** Messages delivered into a running turn. Mastra can strand one that lands just as a run ends. */
  steers: Array<Pending & { signalId: string }>;
  /** Why the last run we started ended badly, if it did. */
  problem?: string;
  /** A run stopped for the owner's approval: supervision rests until the decision. */
  parked: boolean;
  /** Polls the thread has been busy, to look for approvals on runs we don't hold. */
  busyPolls: number;
  running: boolean;
  stopped: boolean;
}

/** A tool call waiting for the owner, on one of a lead's suspended runs. */
export interface PendingApproval {
  agentKey: string;
  runId: string;
  toolCallId: string;
  tool: string;
  args: unknown;
  threadId?: string;
  /** When the run stopped for it. */
  since: Date;
}

/** The attention id of a tool call waiting for approval (decision D32). */
export const approvalId = (call: { runId: string; toolCallId: string }) =>
  `approval:${call.runId}:${call.toolCallId}`;

type RunOutput = {
  text: PromiseLike<string>;
  finishReason: PromiseLike<string | undefined>;
  suspendPayload?: PromiseLike<unknown>;
  runId?: string;
};

function briefFor(task: TaskRow, note?: string): string {
  return [
    `Task #${task.number}: ${task.title}`,
    '',
    task.brief,
    ...(note ? ['', `Note from the owner: ${note}`] : []),
    '',
    'Work on it with your team: mark progress with update_task (a checklist and a percentage), delegate to your specialists, and finish with report_to_chief: outcome "done" with the result, "blocked" with your question when you need the owner, or "failed".',
  ].join('\n');
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chief-to-department messaging (decisions D15, D27). The only module that calls Mastra's experimental
 * signal APIs (sendMessage, sendNotificationSignal, cancelQueuedMessages), per decision D22.
 */
export class DispatchService {
  private readonly supervisions = new Map<string, Supervision>();
  /**
   * Runs we hold that are still going. Mastra lists a run as suspended from the moment it suspends until
   * a resumed run ends, so a run's tool calls wait for the owner only once we have let go of it.
   */
  private readonly holding = new Set<string>();
  /** Approval ids decided in this process (the decisions table has the others). */
  private readonly decided = new Set<string>();
  private closing = false;

  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Shutdown: stops every agent run (leads and the chief) with its queued messages, and keeps stopping
   * runs that start meanwhile for up to `timeoutMs`, so nothing writes after the database closes. Their
   * tasks are flagged as interrupted at the next boot.
   */
  async close(timeoutMs: number): Promise<void> {
    this.closing = true;
    for (const supervision of this.supervisions.values()) supervision.stopped = true;
    this.supervisions.clear();
    const runtime = this.runtime();
    // Runs waiting for an approval count as active but never end on their own; they resume after a
    // restart (aborting one would spoil it), so they are left alone.
    const suspended = new Set<string>();
    for (const agent of Object.values(this.deps.mastra.listAgents()) as Agent[]) {
      try {
        for (const run of (await agent.listSuspendedRuns()).runs) {
          // A run we hold is going (carrying out an approval, say) and is stopped like any other.
          if (!this.holding.has(run.runId)) suspended.add(run.runId);
        }
      } catch {
        // an agent without memory has none
      }
    }
    const stopAll = () => {
      const runs = runtime.listActiveThreadRuns().filter((run) => !suspended.has(run.runId));
      for (const run of runs) {
        runtime.abortThreadStream({
          resourceId: run.resourceId,
          threadId: run.threadId,
          clearPendingSignals: true,
        });
      }
      return runs.length;
    };
    const deadline = Date.now() + timeoutMs;
    while (stopAll() > 0 && Date.now() < deadline) await sleep(POLL_MS / 4);
  }

  async ensureChiefThread(): Promise<void> {
    const memory = this.deps.memory.chief;
    if (!(await memory.getThreadById({ threadId: CHIEF_THREAD }))) {
      await memory.createThread({
        threadId: CHIEF_THREAD,
        resourceId: OWNER_RESOURCE,
        title: 'Chief of staff',
      });
    }
  }

  /** The lead a department's tasks go to. Check before creating a task that will be dispatched. */
  requireLead(departmentId: string): AgentEntry {
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

  /** Sends a task to its department's lead, on the task's own thread. */
  async dispatch(task: TaskRow, actor: PhaseActor, actorLabel: string, note?: string): Promise<TaskRow> {
    const lead = this.requireLead(task.departmentId);
    if (task.phase !== 'inbox') await this.refuseIfApprovalPending(task);
    await this.ensureTaskThread(task);
    this.announceWork(task.id);
    const queued = await this.deps.tasks.transition(task.id, 'queued', actor, actorLabel, {
      patch: { leadAgentId: lead.id },
      data: { lead: lead.key },
    });
    // A lead that was replaced may still be on the thread.
    if (task.leadAgentId && task.leadAgentId !== lead.id) this.stopRuns(task);
    const brief = {
      contents: briefFor(queued, note),
      attributes: { from: 'chief', task: `#${queued.number}` },
    };
    const action = await this.startWork(queued, lead, { message: brief, actorLabel });
    await this.deps.tasks.note(queued.id, 'dispatched', 'system', { lead: lead.key, action });
    return queued;
  }

  /**
   * A message from the owner (or the chief on their behalf). A task in progress gets it in the lead's
   * running turn (steer) or as its next turn (queue); a waiting or reviewed task goes back to the lead.
   */
  async message(task: TaskRow, text: string, mode: 'steer' | 'queue', actorLabel: string): Promise<TaskRow> {
    if (TERMINAL_PHASES.has(task.phase)) {
      throw new ApiError(
        409,
        'task_closed',
        `Task #${task.number} is ${task.phase}. Reopen it first (phase "queued").`,
      );
    }
    if (task.phase === 'inbox') return this.dispatch(task, 'owner', actorLabel, text);
    const lead = this.requireLead(task.departmentId);
    await this.refuseIfApprovalPending(task);
    const from = actorLabel === 'chief' ? 'chief' : 'owner';
    const pending: Pending = {
      message: {
        contents: `Message from the ${from === 'chief' ? 'chief of staff' : 'owner'} about task #${task.number}:\n\n${text}`,
        attributes: { from, task: `#${task.number}` },
      },
      actorLabel,
    };
    this.announceWork(task.id);
    let current = task;
    if (current.leadAgentId !== lead.id) {
      // The department has a new lead: stop the old one and hand the task over.
      this.stopRuns(current);
      current = await this.deps.tasks.reassign(current.id, lead, actorLabel);
    }
    let action: string;
    if (current.phase === 'waiting' || current.phase === 'review') {
      current = await this.deps.tasks.transition(current.id, 'queued', 'owner', actorLabel, {
        data: { reason: `${from} replied` },
      });
      action = await this.startWork(current, lead, pending);
    } else {
      action = await this.deliver(current, lead, pending, mode);
    }
    await this.deps.tasks.note(current.id, 'message', actorLabel, {
      mode,
      text: truncate(text, 500),
      action,
    });
    return current;
  }

  /** Cancels a task, stopping the lead's run on it and dropping messages waiting for it. */
  async cancel(task: TaskRow, reason: string | undefined, actorLabel: string): Promise<TaskRow> {
    const approvals = await this.pendingApprovals(task);
    const cancelled = await this.deps.tasks.transition(task.id, 'cancelled', 'owner', actorLabel, {
      data: reason ? { reason } : {},
    });
    this.stopSupervision(task.id);
    this.stopRuns(task);
    // Declining a stopped run ends it for good, so it no longer waits in attention.
    for (const approval of approvals) {
      try {
        const output = await this.agent(approval.agentKey).declineToolCall({
          runId: approval.runId,
          toolCallId: approval.toolCallId,
          reason: 'The task was cancelled',
        });
        Promise.resolve(output.text).catch(() => {});
      } catch (error) {
        this.deps.logger.warn('Could not decline an approval of a cancelled task', {
          taskId: task.id,
          error,
        });
      }
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

  /**
   * True while a message the owner steered into the lead's running turn is outstanding. The lead may
   * then take its task back from review or waiting: the message can arrive just after it reported.
   */
  mayResume(taskId: string): boolean {
    return (this.supervisions.get(taskId)?.steers.length ?? 0) > 0;
  }

  /** After a restart, runs that were in flight are gone: flag their tasks for the owner. */
  async recoverInterrupted(): Promise<number> {
    const interrupted = await this.deps.tasks.openTasks(['queued', 'working']);
    for (const task of interrupted) {
      const [approval] = await this.pendingApprovals(task);
      if (approval) {
        await this.parkForApproval(task, this.supervision(task.id), approval);
        continue;
      }
      const reason = 'The server restarted while the lead was working on this task';
      const flagged = await this.deps.tasks.transition(task.id, 'waiting', 'system', 'system', {
        data: { reason },
      });
      await this.notifyChief(flagged, 'task-interrupted', `#${task.number} ${task.title}: ${reason}`, 'high');
    }
    return interrupted.length;
  }

  /** Tool calls on the task's thread waiting for the owner (from its lead's suspended runs). */
  async pendingApprovals(task: TaskRow): Promise<PendingApproval[]> {
    const lead =
      (task.leadAgentId ? this.deps.directory.agent(task.leadAgentId) : undefined) ??
      this.deps.directory.leadOf(task.departmentId);
    if (!lead) return [];
    return this.approvalsOf(lead.key, { threadId: task.threadId, resourceId: task.resourceId });
  }

  /** Every tool call waiting for the owner. A specialist's gated call surfaces on its lead's run. */
  async listApprovals(): Promise<PendingApproval[]> {
    const approvals: PendingApproval[] = [];
    for (const lead of this.deps.directory.agents({ role: 'lead' })) {
      approvals.push(...(await this.approvalsOf(lead.key)));
    }
    return approvals;
  }

  /** Tool calls on one agent's suspended runs that wait for the owner. */
  async approvalsOf(
    agentKey: string,
    filter: { threadId?: string; resourceId?: string } = {},
  ): Promise<PendingApproval[]> {
    let runs: Awaited<ReturnType<Agent['listSuspendedRuns']>>['runs'];
    try {
      runs = (await this.agent(agentKey).listSuspendedRuns(filter)).runs;
    } catch {
      return []; // the agent is not registered (any more)
    }
    const calls = runs.flatMap((run) =>
      this.holding.has(run.runId)
        ? []
        : run.toolCalls.flatMap((call) =>
            call.toolCallId
              ? [
                  {
                    agentKey,
                    runId: run.runId,
                    toolCallId: call.toolCallId,
                    tool: call.toolName ?? 'a tool',
                    args: call.args,
                    threadId: run.threadId,
                    since: run.suspendedAt ? new Date(run.suspendedAt) : new Date(),
                  },
                ]
              : [],
          ),
    );
    // A decided call stays listed until its resumed run ends, or for good if that run was cut short.
    const open = calls.filter((call) => !this.decided.has(approvalId(call)));
    if (open.length === 0) return open;
    const rows = await this.deps.db
      .select({ target: decisions.target })
      .from(decisions)
      .where(and(inArray(decisions.target, open.map(approvalId)), eq(decisions.status, 'applied')));
    const done = new Set(rows.map((row) => row.target));
    return open.filter((call) => !done.has(approvalId(call)));
  }

  /**
   * The owner's decision on a tool call waiting for approval. The run carries on (with the tool's
   * result, or the decline and its reason) and is supervised again.
   */
  async resolveApproval(
    approval: PendingApproval,
    decision: 'approve' | 'decline',
    reason: string | undefined,
    actorLabel: string,
  ): Promise<TaskRow | undefined> {
    const agent = this.agent(approval.agentKey);
    const task = approval.threadId ? await this.deps.tasks.getByThread(approval.threadId) : undefined;
    if (task) this.announceWork(task.id);
    // Resuming the same call twice would run the tool twice.
    const id = approvalId(approval);
    this.decided.add(id);
    let output: RunOutput;
    try {
      output =
        decision === 'approve'
          ? await agent.approveToolCall({ runId: approval.runId, toolCallId: approval.toolCallId })
          : await agent.declineToolCall({ runId: approval.runId, toolCallId: approval.toolCallId, reason });
    } catch (error) {
      this.decided.delete(id);
      throw error;
    }
    this.holding.add(approval.runId);
    if (!task) {
      const release = () => this.holding.delete(approval.runId);
      Promise.resolve(output.finishReason).then(release, release);
      Promise.resolve(output.text).catch(() => {});
      return undefined;
    }
    let resumed = task;
    try {
      await this.deps.tasks.note(task.id, 'approval_decided', actorLabel, {
        decision,
        tool: approval.tool,
        toolCallId: approval.toolCallId,
        ...(reason ? { reason } : {}),
      });
      resumed =
        (await this.deps.tasks.transitionIf(
          task.id,
          'working',
          'system',
          actorLabel,
          (t) => t.phase === 'waiting',
          {
            reason:
              decision === 'approve'
                ? `The owner approved ${approval.tool}`
                : `The owner declined ${approval.tool}`,
          },
        )) ?? (await this.deps.tasks.get(task.id));
    } finally {
      // The run carries on whatever the ledger said: watch it, and let go of it when it ends.
      const supervision = this.supervision(task.id);
      supervision.parked = false;
      supervision.busyPolls = 0;
      supervision.problem = undefined;
      supervision.generation += 1;
      this.watchOutput(resumed, supervision, output);
      this.supervise(resumed, supervision);
    }
    return resumed;
  }

  private async refuseIfApprovalPending(task: TaskRow): Promise<void> {
    if ((await this.pendingApprovals(task)).length > 0) {
      throw new ApiError(
        409,
        'approval_pending',
        `Task #${task.number} is waiting for your approval of a tool call: approve or decline it first (GET /v1/attention)`,
      );
    }
  }

  /** A run stopped for the owner's approval: the task waits, the chief is told, supervision rests. */
  private async parkForApproval(
    task: TaskRow,
    supervision: Supervision,
    approval: { tool: string; args?: unknown; runId?: string; toolCallId?: string },
  ): Promise<void> {
    if (supervision.parked) return;
    supervision.parked = true;
    const reason = `Waiting for the owner to approve ${approval.tool}`;
    const flagged = await this.deps.tasks.transitionIf(
      task.id,
      'waiting',
      'system',
      'system',
      (current) => current.phase === 'queued' || current.phase === 'working',
      { reason },
    );
    await this.deps.tasks.note(task.id, 'approval_requested', 'system', {
      tool: approval.tool,
      args: truncate(JSON.stringify(approval.args ?? null), 2000),
      ...(approval.runId ? { runId: approval.runId } : {}),
      ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
    });
    const current = flagged ?? (await this.deps.tasks.get(task.id));
    await this.notifyChief(
      current,
      'approval-needed',
      `#${current.number} ${current.title}: the lead wants to run ${approval.tool} and needs the owner's approval`,
      'high',
    );
  }

  /** New work for a task the lead now has (phase queued): a fresh run, or after the current turn. */
  private async startWork(task: TaskRow, lead: AgentEntry, pending: Pending): Promise<string> {
    const supervision = this.supervision(task.id);
    supervision.generation += 1;
    let action = 'queued';
    // A turn still running on the thread (say, wrapping up a report) finishes first.
    if (this.threadBusy(task)) supervision.queued.push(pending);
    else {
      await this.run(task, lead, pending.message.contents, supervision);
      action = 'run';
    }
    this.supervise(task, supervision);
    return action;
  }

  /** A message for a task in progress (queued or working). */
  private async deliver(
    task: TaskRow,
    lead: AgentEntry,
    pending: Pending,
    mode: 'steer' | 'queue',
  ): Promise<string> {
    if (!this.threadBusy(task) || mode === 'queue') return this.startWork(task, lead, pending);
    const supervision = this.supervision(task.id);
    // Into the running turn at its next step. If the turn ends first, it goes out as the next turn.
    const sent = this.agent(lead.key).sendMessage(pending.message, {
      resourceId: task.resourceId,
      threadId: task.threadId,
      ifActive: { behavior: 'deliver' },
      ifIdle: { behavior: 'discard' },
    });
    const accepted = (await sent.accepted) as { action: string };
    if (accepted.action !== 'deliver') return this.startWork(task, lead, pending);
    supervision.steers.push({ ...pending, signalId: sent.signal.id });
    this.supervise(task, supervision);
    return 'deliver';
  }

  /** Starts a fresh lead run on the task's thread; problems surface when the supervisor decides. */
  private async run(
    task: TaskRow,
    lead: AgentEntry,
    contents: string,
    supervision: Supervision,
  ): Promise<void> {
    supervision.problem = undefined;
    try {
      const output = await this.agent(lead.key).stream(contents, {
        memory: { thread: task.threadId, resource: task.resourceId },
      });
      this.watchOutput(task, supervision, output);
    } catch (error) {
      supervision.problem = `The lead's run could not start: ${errorMessage(error)}`;
      this.deps.logger.warn('A lead run could not start', { taskId: task.id, error });
    }
  }

  /** How a run we hold ends: a problem for the supervisor, or a stop for the owner's approval. */
  private watchOutput(task: TaskRow, supervision: Supervision, output: RunOutput): void {
    const runId = output.runId;
    if (runId) this.holding.add(runId);
    Promise.resolve(output.finishReason)
      .then(
        async (reason) => {
          if (reason === 'suspended') {
            const payload = (await Promise.resolve(output.suspendPayload).catch(() => undefined)) as
              | { toolName?: string; args?: unknown; toolCallId?: string }
              | undefined;
            await this.parkForApproval(task, supervision, {
              tool: payload?.toolName ?? 'a tool',
              args: payload?.args,
              runId: output.runId,
              toolCallId: payload?.toolCallId,
            }).catch((error: unknown) =>
              this.deps.logger.error('Could not park a task for approval', { taskId: task.id, error }),
            );
          } else if (reason && FAILED_FINISH_REASONS.has(reason)) {
            supervision.problem = `The lead's run ended unexpectedly (${reason})`;
          }
        },
        (error: unknown) => {
          supervision.problem = `The lead's run failed: ${errorMessage(error)}`;
        },
      )
      .catch((error: unknown) =>
        this.deps.logger.error('Watching a lead run failed', { taskId: task.id, error }),
      )
      .finally(() => {
        // Parked by now if it stopped for an approval, which the owner can now decide.
        if (runId) this.holding.delete(runId);
      });
    Promise.resolve(output.text).catch(() => {});
  }

  /**
   * New work is coming for this task. Called before its phase changes, so a stall decision already in
   * flight for older work sees the change under the row lock and is dropped.
   */
  private announceWork(taskId: string): void {
    const supervision = this.supervisions.get(taskId);
    if (supervision) supervision.generation += 1;
  }

  private supervision(taskId: string): Supervision {
    let supervision = this.supervisions.get(taskId);
    if (!supervision) {
      supervision = {
        generation: 0,
        queued: [],
        steers: [],
        parked: false,
        busyPolls: 0,
        running: false,
        stopped: false,
      };
      this.supervisions.set(taskId, supervision);
    }
    return supervision;
  }

  private stopSupervision(taskId: string): void {
    const supervision = this.supervisions.get(taskId);
    if (supervision) supervision.stopped = true;
    this.supervisions.delete(taskId);
  }

  private supervise(task: TaskRow, supervision: Supervision): void {
    if (supervision.running || this.closing) return;
    supervision.running = true;
    this.watch(task, supervision)
      .catch((error: unknown) =>
        this.deps.logger.error('Supervising a task failed', { taskId: task.id, error }),
      )
      .finally(() => {
        supervision.running = false;
      });
  }

  private async watch(task: TaskRow, supervision: Supervision): Promise<void> {
    let idleSince: number | undefined;
    while (!this.closing && !supervision.stopped) {
      await sleep(POLL_MS);
      if (supervision.parked) return;
      if (this.threadBusy(task)) {
        idleSince = undefined;
        supervision.busyPolls += 1;
        if (supervision.busyPolls % APPROVAL_CHECK_POLLS === 0) {
          const [approval] = await this.pendingApprovals(task);
          if (approval) {
            await this.parkForApproval(task, supervision, approval);
            return;
          }
        }
        continue;
      }
      idleSince ??= Date.now();
      if (Date.now() - idleSince < IDLE_CONFIRM_MS) continue;

      // The lead's turn is over. What it hasn't seen yet goes out as its next turn.
      const pending = [...this.reclaimStranded(task, supervision), ...supervision.queued.splice(0)];
      if (pending.length > 0 && (await this.sendPending(task, supervision, pending))) {
        idleSince = undefined;
        continue;
      }

      // Nothing left for the lead, so it should have reported. Decided under the row lock.
      const generation = supervision.generation;
      const reason = supervision.problem ?? 'The lead finished its turn without reporting a result';
      const flagged = await this.deps.tasks.transitionIf(
        task.id,
        'waiting',
        'system',
        'system',
        (current) =>
          supervision.generation === generation &&
          !supervision.stopped &&
          (current.phase === 'queued' || current.phase === 'working'),
        { reason },
      );
      if (supervision.generation !== generation || supervision.stopped) {
        idleSince = undefined;
        continue;
      }
      if (this.supervisions.get(task.id) === supervision) this.supervisions.delete(task.id);
      if (flagged) {
        await this.notifyChief(
          flagged,
          'task-stalled',
          `#${flagged.number} ${flagged.title}: ${reason}`,
          'high',
        );
      }
      return;
    }
  }

  /** Steered messages no run picked up. Cancelling them here also keeps them out of a later run. */
  private reclaimStranded(task: TaskRow, supervision: Supervision): Pending[] {
    const steers = supervision.steers.splice(0);
    if (steers.length === 0) return [];
    const { cancelledSignalIds } = this.runtime().cancelQueuedMessages({
      resourceId: task.resourceId,
      threadId: task.threadId,
      signalIds: steers.map((steer) => steer.signalId),
    });
    const stranded = new Set(cancelledSignalIds);
    return steers.filter((steer) => stranded.has(steer.signalId));
  }

  /** Sends what the lead hasn't seen as one turn, reopening the task if the lead reported meanwhile. */
  private async sendPending(task: TaskRow, supervision: Supervision, pending: Pending[]): Promise<boolean> {
    let current = await this.deps.tasks.get(task.id);
    if (TERMINAL_PHASES.has(current.phase)) return false;
    const lead = this.deps.directory.leadOf(current.departmentId);
    if (!lead) {
      supervision.problem = 'Messages are waiting for the lead, but the department has no lead';
      return false;
    }
    const actorLabel = pending[0]?.actorLabel ?? 'owner';
    if (current.leadAgentId !== lead.id)
      current = await this.deps.tasks.reassign(current.id, lead, actorLabel);
    if (current.phase === 'waiting' || current.phase === 'review') {
      current = await this.deps.tasks.transition(current.id, 'queued', 'owner', actorLabel, {
        data: { reason: 'Messages arrived after the report' },
      });
    }
    supervision.generation += 1;
    await this.run(current, lead, pending.map((p) => p.message.contents).join('\n\n'), supervision);
    return true;
  }

  /** Stops whatever run is on the task's thread, with its queued messages. Never throws. */
  private stopRuns(task: TaskRow): void {
    try {
      this.runtime().abortThreadStream({
        resourceId: task.resourceId,
        threadId: task.threadId,
        clearPendingSignals: true,
      });
    } catch (error) {
      this.deps.logger.warn('Could not stop the run on a task thread', { taskId: task.id, error });
    }
  }

  private threadBusy(task: TaskRow): boolean {
    return (
      this.runtime().getActiveThreadRunId({ resourceId: task.resourceId, threadId: task.threadId }) !==
      undefined
    );
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
    const memory = this.deps.memory.lead;
    if (!(await memory.getThreadById({ threadId: task.threadId }))) {
      await memory.createThread({
        threadId: task.threadId,
        resourceId: task.resourceId,
        title: `#${task.number} ${task.title}`,
        metadata: { taskId: task.id, taskNumber: task.number, departmentId: task.departmentId },
      });
    }
  }

  /** Mastra's thread runtime is shared by all agents; the chief is always registered. */
  private runtime(): Agent {
    return this.agent('chief');
  }

  private agent(key: string): Agent {
    return this.deps.mastra.getAgent(key) as Agent;
  }
}
