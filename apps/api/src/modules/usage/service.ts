import type { IMastraLogger } from '@mastra/core/logger';
import { type AnyExportedSpan, type ModelInferenceAttributes, SpanType } from '@mastra/core/observability';
import type { ModelPrice, UsageGroup, UsageQuery, UsageReport, UsageTotals } from '@superagent/shared';
import { and, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { departments, tasks, usageEvents } from '../../db/schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A lead's task thread, and its specialists' (`task:<id>-<uuid>`). */
const TASK_THREAD = /^task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** One model call, as recorded. */
export interface UsageCall {
  traceId: string;
  spanId: string;
  occurredAt: Date;
  taskId: string | null;
  departmentId: string | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const NO_USAGE: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
};

/**
 * The model request a MODEL_INFERENCE span records (one per step of a generation, so a turn that calls
 * tools makes several), or undefined (another span, or no tokens). It is
 * attributed by the metadata the run was started with (inherited by every span of its trace,
 * specialists' and memory's included), else by a task thread.
 */
export function callFromSpan(span: AnyExportedSpan): UsageCall | undefined {
  if (span.type !== SpanType.MODEL_INFERENCE) return undefined;
  const attributes = span.attributes as ModelInferenceAttributes | undefined;
  const usage = attributes?.usage;
  const inputTokens = Math.max(0, Math.round(usage?.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.round(usage?.outputTokens ?? 0));
  if (!inputTokens && !outputTokens) return undefined;
  const metadata = (span.metadata ?? {}) as Record<string, unknown>;
  const uuid = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);
  const text = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 200) : null);
  return {
    traceId: span.traceId,
    spanId: span.id,
    occurredAt: span.endTime ?? new Date(),
    taskId: uuid(metadata.taskId) ?? TASK_THREAD.exec(String(metadata.threadId ?? ''))?.[1] ?? null,
    departmentId: uuid(metadata.departmentId),
    agent: text(span.entityId) ?? text(metadata.agentId),
    // Our gateway's models report "<provider slug>.chat".
    provider: text(attributes?.provider?.replace(/\.chat$/, '')),
    model: text(attributes?.model),
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, Math.max(0, usage?.inputDetails?.cacheRead ?? 0)),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, Math.max(0, usage?.outputDetails?.reasoning ?? 0)),
  };
}

/** What a call cost in USD, or null when its model had no price. Cached input is part of the input. */
export function costOf(call: UsageCall, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const cached = Math.min(call.cachedInputTokens, call.inputTokens);
  return (
    ((call.inputTokens - cached) * price.inputUsd +
      cached * (price.cachedInputUsd ?? price.inputUsd) +
      call.outputTokens * price.outputUsd) /
    1_000_000
  );
}

export interface UsageDeps {
  db: Db;
  /** The price of a provider's model now (the owner sets them). */
  priceOf: (provider: string | null, model: string | null) => ModelPrice | undefined;
  /** The owner's timezone, for days. */
  timezone: () => string;
  logger: IMastraLogger;
}

/**
 * Tokens and cost (decision D40): a row per model call, written as its span ends and priced then,
 * and the rollups task cards and the usage report read.
 */
export class UsageService {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: UsageDeps) {}

  /** Records a call. Never throws: accounting must not break a run. */
  record(call: UsageCall): void {
    const write: Promise<unknown> = this.deps.db
      .insert(usageEvents)
      .values({ ...call, costUsd: costOf(call, this.deps.priceOf(call.provider, call.model)) })
      .onConflictDoNothing()
      .catch((error: unknown) =>
        this.deps.logger.warn('A usage row was not written', { error: String(error) }),
      )
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  /** Waits for rows being written (shutdown and tests). */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Totals per task (task cards). Tasks without calls are absent. */
  async forTasks(ids: string[]): Promise<Map<string, UsageTotals>> {
    if (ids.length === 0) return new Map();
    const rows = await this.deps.db
      .select({ key: usageEvents.taskId, ...this.totalsColumns() })
      .from(usageEvents)
      .where(inArray(usageEvents.taskId, [...new Set(ids)]))
      .groupBy(usageEvents.taskId);
    return new Map(rows.map((row) => [row.key as string, totals(row)]));
  }

  /** Totals grouped by department, task, agent, model or day, over a period. */
  async report(query: UsageQuery): Promise<UsageReport> {
    const group = query.group;
    const department = sql`coalesce(${usageEvents.departmentId}, ${tasks.departmentId})`;
    const keys: Record<UsageGroup, SQL<string | null>> = {
      department: sql`${department}::text`,
      task: sql`${usageEvents.taskId}::text`,
      agent: sql`${usageEvents.agent}`,
      model: sql`case when ${usageEvents.model} is null then null else coalesce(${usageEvents.provider}, '?') || '/' || ${usageEvents.model} end`,
      day: sql`to_char(${usageEvents.occurredAt} at time zone ${this.deps.timezone()}, 'YYYY-MM-DD')`,
    };
    const labels: Partial<Record<UsageGroup, SQL<string | null>>> = {
      department: sql`max(${departments.name})`,
      task: sql`max('#' || ${tasks.number} || ' ' || ${tasks.title})`,
    };
    const conditions: SQL[] = [];
    if (query.from) conditions.push(gte(usageEvents.occurredAt, new Date(query.from)));
    if (query.to) conditions.push(lt(usageEvents.occurredAt, new Date(query.to)));
    if (query.departmentId) conditions.push(sql`${department} = ${query.departmentId}`);
    const rows = await this.deps.db
      .select({ key: keys[group], label: labels[group] ?? sql<null>`null`, ...this.totalsColumns() })
      .from(usageEvents)
      .leftJoin(tasks, eq(tasks.id, usageEvents.taskId))
      .leftJoin(departments, sql`${departments.id} = ${department}`)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      // By position: the key's expression may hold a parameter (the timezone).
      .groupBy(sql`1`)
      // An output name can be ordered by only on its own, not inside an expression: sum again.
      .orderBy(
        group === 'day'
          ? sql`1`
          : sql`cost_usd desc, coalesce(sum(${usageEvents.inputTokens}) + sum(${usageEvents.outputTokens}), 0) desc`,
      );
    const items = rows.map((row) => ({
      key: row.key,
      label:
        row.label ?? row.key ?? (group === 'department' || group === 'task' ? 'Outside tasks' : 'Unknown'),
      ...totals(row),
    }));
    return {
      group,
      from: query.from ?? null,
      to: query.to ?? null,
      items,
      total: items.reduce<UsageTotals>((sum, item) => add(sum, item), NO_USAGE),
    };
  }

  private totalsColumns() {
    return {
      calls: sql<number>`count(*)::int`.as('calls'),
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::float8`.as('input_tokens'),
      cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::float8`.as(
        'cached_input_tokens',
      ),
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::float8`.as('output_tokens'),
      reasoningTokens: sql<number>`coalesce(sum(${usageEvents.reasoningTokens}), 0)::float8`.as(
        'reasoning_tokens',
      ),
      costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`.as('cost_usd'),
      unpricedCalls: sql<number>`(count(*) filter (where ${usageEvents.costUsd} is null))::int`.as(
        'unpriced_calls',
      ),
    };
  }
}

const usd = (value: number) => Math.round(value * 1e8) / 1e8;

function totals(row: {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpricedCalls: number;
}): UsageTotals {
  return {
    calls: row.calls,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.inputTokens + row.outputTokens,
    costUsd: usd(row.costUsd),
    unpricedCalls: row.unpricedCalls,
  };
}

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: usd(a.costUsd + b.costUsd),
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  };
}
