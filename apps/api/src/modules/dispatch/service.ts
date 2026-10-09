import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { Mastra } from '@mastra/core/mastra';
import type { DecisionRow, TaskRow } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { Mutex } from '../../util/mutex';
import { truncate } from '../../util/text';
import { type PhaseActor, TERMINAL_PHASES } from '../ledger/phases';
import type { TaskService } from '../ledger/service';
import type { MemoryProfiles } from '../memory/profiles';
import type { AgentEntry, OrgDirectory } from '../org/directory';
import type { DecisionLog } from './decisions';
import { briefFor, relayedMessage } from './wording';

/** The owner's conversation with the chief of staff. */
export const CHIEF_THREAD = 'chief:main';
export const OWNER_RESOURCE = 'owner';
const CHIEF = { resourceId: OWNER_RESOURCE, threadId: CHIEF_THREAD };

const FAILED_FINISH_REASONS = new Set(['error', 'retry', 'aborted', 'other', 'unknown']);
/** How often a supervised task thread is checked, and how long it must stay idle before deciding. */
const POLL_MS = 200;
const IDLE_CONFIRM_MS = 600;
/** Every so many busy polls (about 5 s), check whether the run on the thread waits for an approval. */
const APPROVAL_CHECK_POLLS = 25;
/** What a lead is told about a call its cancelled task was waiting for. */
const CANCELLED_REASON = 'The task was cancelled';
/** How many times the owner's queued messages to the chief are tried before they are given up. */
const CHIEF_SEND_ATTEMPTS = 5;

export interface DispatchDeps {
  mastra: Mastra;
  decisions: DecisionLog;
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
  /** Supervision was asked for while the watch was ending: start it again once it has. */
  rerun: boolean;
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
  /** The task whose thread the run is on, if any. */
  task?: TaskRow;
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
  /** The owner's messages to the chief, one turn at a time: see messageChief. */
  private readonly chiefLock = new Mutex();
  private readonly chiefQueue: string[] = [];
  private chiefDraining = false;
  private readonly chiefAnswerListeners = new Set<(text: string) => void>();
  private closing = false;

  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Shutdown: stops every agent run (leads and the chief) with its queued messages, and keeps stopping
   * runs that start meanwhile for up to `timeoutMs`, so nothing writes after the database closes. Their
   * tasks are flagged as interrupted at the next boot.
   */
  async close(timeoutMs: number): Promise<void> {
    this.closing = true;
    if (this.chiefQueue.length > 0) {
      this.deps.logger.warn("The server stopped before the chief of staff read the owner's messages", {
        count: this.chiefQueue.length,
      });
    }
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

  /**
   * The owner's message to the chief of staff. It starts the chief's next turn: right away when the
   * chief is idle, else once its current turn is over (messages sent meanwhile go out together). A
   * message isn't delivered into a running turn: one that lands just as the turn ends can be lost.
   */
  async messageChief(text: string): Promise<'started' | 'queued'> {
    return this.chiefLock.run(async () => {
      if (this.closing) throw new ApiError(503, 'shutting_down', 'The server is shutting down');
      if (this.chiefQueue.length === 0 && !this.chiefBusy()) {
        await this.startChiefTurn([text]);
        return 'started';
      }
      this.chiefQueue.push(text);
      this.drainChiefQueue();
      return 'queued';
    });
  }

  /** Stops the chief's running turn (messages waiting for it then start the next one). */
  stopChief(): boolean {
    return this.runtime().abortThreadStream({ ...CHIEF });
  }

  private chiefBusy(): boolean {
    return this.runtime().getActiveThreadRunId(CHIEF) !== undefined;
  }

  /** Hears the chief's answers to the owner's messages, once each is finished (push, D54). */
  onChiefAnswer(listener: (text: string) => void): () => void {
    this.chiefAnswerListeners.add(listener);
    return () => {
      this.chiefAnswerListeners.delete(listener);
    };
  }

  private async startChiefTurn(messages: string[]): Promise<void> {
    const output = await this.agent('chief').stream(messages, {
      memory: { thread: CHIEF_THREAD, resource: OWNER_RESOURCE },
    });
    // The owner follows the thread, where the turn ends either way. A finished answer is also told
    // to whoever listens (push), not one that was stopped or failed.
    Promise.all([output.text, output.finishReason])
      .then(([text, reason]) => {
        if (reason !== 'stop') return;
        for (const listener of this.chiefAnswerListeners) listener(text);
      })
      .catch((error: unknown) => this.deps.logger.warn("A chief of staff's turn failed", { error }));
  }

  /** Waits for the chief's thread to stay idle for a moment, then sends what is queued as one turn. */
  private drainChiefQueue(): void {
    if (this.chiefDraining) return;
    this.chiefDraining = true;
    void (async () => {
      let idleSince: number | undefined;
      let failures = 0;
      while (this.chiefQueue.length > 0 && !this.closing) {
        // After a failed send, back off: 3.2 s, then twice as long each time.
        await sleep(failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** (failures + 3), 30_000));
        if (this.chiefBusy()) {
          idleSince = undefined;
          continue;
        }
        idleSince ??= Date.now();
        if (Date.now() - idleSince < IDLE_CONFIRM_MS) continue;
        idleSince = undefined;
        try {
          await this.chiefLock.run(async () => {
            if (this.chiefBusy() || this.closing) return;
            const messages = [...this.chiefQueue];
            await this.startChiefTurn(messages);
            // Only once they went out: a turn that couldn't start leaves them queued.
            this.chiefQueue.splice(0, messages.length);
          });
          failures = 0;
        } catch (error) {
          failures += 1;
          if (failures < CHIEF_SEND_ATTEMPTS) {
            this.deps.logger.warn("Could not send the owner's messages to the chief of staff; retrying", {
              error,
            });
          } else {
            const dropped = this.chiefQueue.splice(0);
            this.deps.logger.error("Gave up sending the owner's messages to the chief of staff", {
              count: dropped.length,
              error,
            });
          }
        }
      }
    })()
      .catch((error: unknown) => {
        this.deps.logger.error("Could not send the owner's messages to the chief of staff", { error });
      })
      .finally(() => {
        this.chiefDraining = false;
        if (this.chiefQueue.length > 0 && !this.closing) this.drainChiefQueue();
      });
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
    this.requireLead(task.departmentId);
    // Checked and started under the decision lock: no decision may resume a run on the thread meanwhile.
    return this.deps.decisions.lock.run(async () =>
      this.dispatchLocked(await this.deps.tasks.get(task.id), actor, actorLabel, note),
    );
  }

  private async dispatchLocked(
    task: TaskRow,
    actor: PhaseActor,
    actorLabel: string,
    note?: string,
  ): Promise<TaskRow> {
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
    return this.deps.decisions.lock.run(async () => {
      const current = await this.deps.tasks.get(task.id);
      if (TERMINAL_PHASES.has(current.phase)) {
        throw new ApiError(
          409,
          'task_closed',
          `Task #${current.number} is ${current.phase}. Reopen it first (phase "queued").`,
        );
      }
      if (current.phase === 'inbox') return this.dispatchLocked(current, 'owner', actorLabel, text);
      return this.messageLocked(current, text, mode, actorLabel);
    });
  }

  private async messageLocked(
    task: TaskRow,
    text: string,
    mode: 'steer' | 'queue',
    actorLabel: string,
  ): Promise<TaskRow> {
    const lead = this.requireLead(task.departmentId);
    await this.refuseIfApprovalPending(task);
    const from = actorLabel === 'chief' ? 'chief' : 'owner';
    const pending: Pending = {
      message: {
        contents: relayedMessage(from, task.number, text),
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

  /**
   * Cancels a task, stopping the lead's run on it and dropping messages waiting for it. Tool calls it
   * was waiting for are declined, recorded like the owner's decisions.
   */
  async cancel(task: TaskRow, reason: string | undefined, actorLabel: string): Promise<TaskRow> {
    return this.deps.decisions.lock.run(async () => {
      const approvals = await this.pendingApprovals(task).catch((error: unknown) => {
        this.deps.logger.warn('Could not list the calls a cancelled task waits for', {
          taskId: task.id,
          error,
        });
        return [];
      });
      const cancelled = await this.deps.tasks.transition(task.id, 'cancelled', 'owner', actorLabel, {
        data: reason ? { reason } : {},
      });
      this.stopSupervision(task.id);
      this.stopRuns(task);
      for (const approval of approvals) await this.withdraw(cancelled, approval);
      return cancelled;
    });
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
      const parked = await this.deps.decisions.lock.run(async () => {
        const [approval] = await this.pendingApprovals(task);
        if (approval) await this.parkForApproval(task, this.supervision(task.id), approval);
        return Boolean(approval);
      });
      if (parked) continue;
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

  /**
   * Tool calls on one agent's suspended runs that wait for the owner: not on a run we still hold, not
   * decided already (a decided call stays listed until its resumed run ends, or for good if that run
   * was cut short), and not on a closed task.
   */
  async approvalsOf(
    agentKey: string,
    filter: { threadId?: string; resourceId?: string } = {},
  ): Promise<PendingApproval[]> {
    let agent: Agent;
    try {
      agent = this.agent(agentKey);
    } catch {
      return []; // not registered (any more): nothing of it can be decided
    }
    const { runs } = await agent.listSuspendedRuns(filter);
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
    if (calls.length === 0) return [];
    const decided = await this.deps.decisions.decided(calls.map(approvalId));
    const open = calls.filter((call) => !decided.has(approvalId(call)));
    const tasks = await this.deps.tasks.byThreads(
      open.flatMap((call) => (call.threadId ? [call.threadId] : [])),
    );
    return open.flatMap((call) => {
      const task = call.threadId ? tasks.get(call.threadId) : undefined;
      // A closed task's calls are declined when it closes; one that slipped through is never offered.
      return task && TERMINAL_PHASES.has(task.phase) ? [] : [{ ...call, task }];
    });
  }

  /** Why an agent can't be archived right now, if it can't: deciding a call needs its agent. */
  async archiveBlocker(agent: AgentEntry): Promise<{ code: string; message: string } | undefined> {
    const waiting = (await this.approvalsOf(agent.key)).length;
    if (waiting > 0) {
      return {
        code: 'approvals_pending',
        message: `${agent.name} has ${waiting === 1 ? 'a tool call' : `${waiting} tool calls`} waiting for your decision: approve or decline first (GET /v1/attention)`,
      };
    }
    if (agent.role !== 'lead') return undefined;
    // A run still going could stop for an approval that nobody could decide once the lead is gone.
    const busy = (await this.deps.tasks.openTasks(['queued', 'working', 'waiting', 'review'])).filter(
      (task) =>
        task.leadAgentId === agent.id &&
        (task.phase === 'queued' || task.phase === 'working' || this.threadBusy(task)),
    );
    if (busy.length === 0) return undefined;
    return {
      code: 'agent_busy',
      message: `${agent.name} is working on ${busy.map((task) => `#${task.number}`).join(', ')}: let it finish or cancel ${busy.length === 1 ? 'that task' : 'those tasks'} first`,
    };
  }

  /**
   * Applies the owner's decision on a tool call waiting for approval. The caller holds the decision lock
   * and has recorded the decision; this throws only when Mastra refused it, so nothing happened. The run
   * carries on (with the tool's result, or the decline and its reason) and is supervised again.
   */
  async resolveApproval(
    approval: PendingApproval,
    decision: 'approve' | 'decline',
    reason: string | undefined,
    actorLabel: string,
  ): Promise<TaskRow | undefined> {
    const agent = this.agent(approval.agentKey);
    const task =
      approval.task ?? (approval.threadId ? await this.deps.tasks.getByThread(approval.threadId) : undefined);
    if (task) this.announceWork(task.id);
    // A resumed run is a new root span: it carries the task again, or its calls lose it.
    const tracing = task ? { tracingOptions: this.tracing(task) } : {};
    const output =
      decision === 'approve'
        ? await agent.approveToolCall({ runId: approval.runId, toolCallId: approval.toolCallId, ...tracing })
        : await agent.declineToolCall({
            runId: approval.runId,
            toolCallId: approval.toolCallId,
            reason,
            ...tracing,
          });
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
    } catch (error) {
      // The decision stands: the run carries on whatever the ledger could record.
      this.deps.logger.error('Could not record a decision on its task', { taskId: task.id, error });
    }
    const supervision = this.supervision(task.id);
    supervision.parked = false;
    supervision.busyPolls = 0;
    supervision.problem = undefined;
    supervision.generation += 1;
    this.watchOutput(resumed, supervision, output, approval.agentKey);
    this.supervise(resumed, supervision);
    return resumed;
  }

  /** Refuses new work for a task while a tool call on its thread waits for the owner. */
  async refuseIfApprovalPending(task: TaskRow): Promise<void> {
    if ((await this.pendingApprovals(task)).length > 0) {
      throw new ApiError(
        409,
        'approval_pending',
        `Task #${task.number} is waiting for your approval of a tool call: approve or decline it first (GET /v1/attention)`,
      );
    }
  }

  /**
   * A run stopped for the owner's approval: the task waits, the chief is told, supervision rests. If the
   * task was closed meanwhile, the call is declined instead. The caller holds the decision lock.
   */
  private async parkForApproval(
    task: TaskRow,
    supervision: Supervision,
    approval: { agentKey: string; tool: string; args?: unknown; runId?: string; toolCallId?: string },
  ): Promise<void> {
    if (supervision.parked) return;
    const current = await this.deps.tasks.get(task.id);
    if (TERMINAL_PHASES.has(current.phase)) {
      if (approval.runId && approval.toolCallId) {
        await this.withdraw(current, {
          agentKey: approval.agentKey,
          runId: approval.runId,
          toolCallId: approval.toolCallId,
        });
      }
      return;
    }
    supervision.parked = true;
    const reason = `Waiting for the owner to approve ${approval.tool}`;
    const flagged = await this.deps.tasks.transitionIf(
      task.id,
      'waiting',
      'system',
      'system',
      (t) => t.phase === 'queued' || t.phase === 'working',
      { reason },
    );
    await this.deps.tasks.note(task.id, 'approval_requested', 'system', {
      tool: approval.tool,
      args: truncate(JSON.stringify(approval.args ?? null), 2000),
      ...(approval.runId ? { runId: approval.runId } : {}),
      ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
    });
    const parked = flagged ?? (await this.deps.tasks.get(task.id));
    await this.notifyChief(
      parked,
      'approval-needed',
      `#${parked.number} ${parked.title}: the lead wants to run ${approval.tool} and needs the owner's approval`,
      'high',
    );
  }

  /**
   * Declines a call its closed task was waiting for, recorded like the owner's decisions, and stops the
   * turn the decline resumes at once: after a restart nothing else would. The caller holds the decision
   * lock. Never throws.
   */
  private async withdraw(
    task: TaskRow,
    approval: { agentKey: string; runId: string; toolCallId: string },
  ): Promise<void> {
    let row: DecisionRow | undefined;
    try {
      row = await this.deps.decisions.begin({
        target: approvalId(approval),
        kind: 'decline',
        reason: CANCELLED_REASON,
        taskId: task.id,
      });
      // Aborted before it starts: the decline is still recorded (and the run's snapshot dropped), but the
      // turn it would resume never reaches the model.
      const stop = new AbortController();
      stop.abort();
      const output = await this.agent(approval.agentKey).declineToolCall({
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        reason: CANCELLED_REASON,
        abortSignal: stop.signal,
        tracingOptions: this.tracing(task),
      });
      this.holding.add(approval.runId);
      const release = () => this.holding.delete(approval.runId);
      Promise.resolve(output.finishReason).then(release, release);
      Promise.resolve(output.text).catch(() => {});
      await this.deps.decisions.applied(row.id, task.id);
    } catch (error) {
      if (row) await this.deps.decisions.abandon(row.id).catch(() => {});
      this.deps.logger.warn('Could not decline a call of a closed task', { taskId: task.id, error });
    }
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
    contents: string | string[],
    supervision: Supervision,
  ): Promise<void> {
    supervision.problem = undefined;
    try {
      const output = await this.agent(lead.key).stream(contents, {
        memory: { thread: task.threadId, resource: task.resourceId },
        tracingOptions: this.tracing(task),
      });
      this.watchOutput(task, supervision, output, lead.key);
    } catch (error) {
      supervision.problem = `The lead's run could not start: ${errorMessage(error)}`;
      this.deps.logger.warn('A lead run could not start', { taskId: task.id, error });
    }
  }

  /**
   * What a task's runs are traced with (decision D39). Every span of a run inherits the metadata
   * (its specialists' and memory's too), which is how model calls are counted to the task.
   */
  private tracing(task: TaskRow): { tags: string[]; metadata: Record<string, string> } {
    const department = this.deps.directory.department(task.departmentId);
    return {
      tags: [`task:${task.id}`, ...(department ? [`dept:${department.slug}`] : [])],
      metadata: {
        taskId: task.id,
        departmentId: task.departmentId,
        ...(department ? { department: department.slug } : {}),
      },
    };
  }

  /** How a run we hold ends: a problem for the supervisor, or a stop for the owner's approval. */
  private watchOutput(task: TaskRow, supervision: Supervision, output: RunOutput, agentKey: string): void {
    const runId = output.runId;
    if (runId) this.holding.add(runId);
    const release = () => {
      if (runId) this.holding.delete(runId);
    };
    Promise.resolve(output.finishReason)
      .then(
        async (reason) => {
          if (reason === 'suspended') {
            const payload = (await Promise.resolve(output.suspendPayload).catch(() => undefined)) as
              | { toolName?: string; args?: unknown; toolCallId?: string }
              | undefined;
            await this.deps.decisions.lock
              .run(async () => {
                await this.parkForApproval(task, supervision, {
                  agentKey,
                  tool: payload?.toolName ?? 'a tool',
                  args: payload?.args,
                  runId,
                  toolCallId: payload?.toolCallId,
                });
                // Let go under the lock: from now on the owner can decide the call.
                release();
              })
              .catch((error: unknown) =>
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
      .finally(release);
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
        rerun: false,
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
    if (this.closing) return;
    if (supervision.running) {
      // The watch may be on its way out (say, just parked): it starts again once it has.
      supervision.rerun = true;
      return;
    }
    supervision.running = true;
    supervision.rerun = false;
    this.watch(task, supervision)
      .catch((error: unknown) =>
        this.deps.logger.error('Supervising a task failed', { taskId: task.id, error }),
      )
      .finally(() => {
        supervision.running = false;
        if (supervision.rerun && !supervision.stopped && this.supervisions.get(task.id) === supervision) {
          this.supervise(task, supervision);
        }
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
          // A run we don't hold may have stopped for an approval. Checked under the decision lock, so
          // a decision taken meanwhile is seen and not parked for again.
          await this.deps.decisions.lock
            .run(async () => {
              const [approval] = await this.pendingApprovals(task);
              if (approval) await this.parkForApproval(task, supervision, approval);
            })
            .catch((error: unknown) =>
              this.deps.logger.warn('Could not check a task for approvals', { taskId: task.id, error }),
            );
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
    // One message each, so the transcript reads each back as it was sent.
    await this.run(
      current,
      lead,
      pending.map((p) => p.message.contents),
      supervision,
    );
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
          // Kept on the message the chief's thread stores (the model doesn't see it): reports link to tasks.
          metadata: { taskId: task.id, taskNumber: task.number, taskTitle: task.title },
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
