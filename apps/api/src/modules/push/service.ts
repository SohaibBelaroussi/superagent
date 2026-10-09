import type { IMastraLogger } from '@mastra/core/logger';
import type {
  MyPush,
  PushDevice,
  PushDeviceInput,
  PushKind,
  PushPayload,
  PushStatus,
  TaskEvent,
} from '@superagent/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { TokenService } from '../../auth/tokens';
import type { SecretBox } from '../../crypto/secret-box';
import type { Db } from '../../db/client';
import { apiTokens, type PushDeviceRow, pushConfig, pushDevices } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { approvalId } from '../dispatch/service';
import type { EventBus } from '../ledger/events';
import type { TaskService } from '../ledger/service';
import {
  accountContext,
  encryptPayload,
  type FcmSender,
  parseServiceAccount,
  type ServiceAccount,
} from './fcm';

const CONFIG_ID = 'fcm';
const tokenContext = (id: string) => `push:${id}:token`;
const keyContext = (id: string) => `push:${id}:key`;

/** Long texts are cut: a notification has a few lines, and FCM's data has a size limit. */
const clip = (text: string, max = 280) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface PushDeps {
  db: Db;
  box: SecretBox;
  bus: EventBus;
  tokens: TokenService;
  tasks: TaskService;
  sender: FcmSender;
  logger: IMastraLogger;
}

/**
 * Push notifications (D54): the API tells phones what needs the owner, straight through FCM. It follows
 * the event bus (an approval to give, a question, a result to review, a problem) and the chief's
 * answers. Each device gets what it asked for, encrypted with its own key. Registrations belong to
 * device tokens and go with them.
 */
export class PushService {
  private readonly stops: Array<() => void> = [];
  /** The service account, read once from the database (null: push isn't set up). */
  private account: Promise<ServiceAccount | null> | null = null;

  constructor(private readonly deps: PushDeps) {}

  start(): void {
    this.stops.push(this.deps.bus.subscribe((event) => void this.onEvent(event)));
    this.stops.push(this.deps.tokens.onRevoked((tokenId) => void this.forget(tokenId)));
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  // --- The Firebase project ---

  async status(): Promise<PushStatus> {
    const [config] = await this.deps.db.select().from(pushConfig).where(eq(pushConfig.id, CONFIG_ID));
    return {
      configured: Boolean(config),
      projectId: config?.projectId ?? null,
      clientEmail: config?.clientEmail ?? null,
      devices: await this.devices(),
    };
  }

  /** Keeps the service account, sealed, after checking that Google accepts it. Run under settings.lock. */
  async configure(json: string): Promise<PushStatus> {
    let account: ServiceAccount;
    try {
      account = parseServiceAccount(json);
    } catch (error) {
      throw new ApiError(400, 'invalid_service_account', (error as Error).message);
    }
    try {
      await this.deps.sender.check(account);
    } catch (error) {
      throw new ApiError(422, 'service_account_refused', (error as Error).message);
    }
    const row = {
      id: CONFIG_ID,
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      serviceAccountEnc: this.deps.box.seal(JSON.stringify(account), accountContext),
      updatedAt: new Date(),
    };
    await this.deps.db.insert(pushConfig).values(row).onConflictDoUpdate({ target: pushConfig.id, set: row });
    this.account = Promise.resolve(account);
    this.deps.logger.info('Push notifications set up', { projectId: account.projectId });
    return this.status();
  }

  /** Forgets the service account: nothing is sent any more, and registrations stay for when it's back. */
  async unconfigure(): Promise<void> {
    await this.deps.db.delete(pushConfig).where(eq(pushConfig.id, CONFIG_ID));
    this.account = Promise.resolve(null);
  }

  // --- Devices ---

  async mine(tokenId: string): Promise<MyPush> {
    const [config] = await this.deps.db.select({ id: pushConfig.id }).from(pushConfig);
    const device = (await this.devices(tokenId))[0] ?? null;
    return { configured: Boolean(config), device };
  }

  /** Registers the calling device token's phone, or updates it (a new push token, other kinds). */
  async register(tokenId: string, input: PushDeviceInput): Promise<PushDevice> {
    const [existing] = await this.deps.db.select().from(pushDevices).where(eq(pushDevices.tokenId, tokenId));
    const id = existing?.id ?? uuidv7();
    const values = {
      platform: input.platform,
      pushTokenEnc: this.deps.box.seal(input.pushToken, tokenContext(id)),
      keyEnc: this.deps.box.seal(input.key, keyContext(id)),
      kinds: [...new Set(input.kinds)],
      updatedAt: new Date(),
      lastError: null,
    };
    if (existing) await this.deps.db.update(pushDevices).set(values).where(eq(pushDevices.id, id));
    else await this.deps.db.insert(pushDevices).values({ id, tokenId, ...values });
    const device = (await this.devices(tokenId))[0];
    if (!device) throw new ApiError(404, 'device_not_found', 'This device token was revoked');
    return device;
  }

  async unregister(tokenId: string): Promise<boolean> {
    const removed = await this.deps.db
      .delete(pushDevices)
      .where(eq(pushDevices.tokenId, tokenId))
      .returning({ id: pushDevices.id });
    return removed.length > 0;
  }

  /** Sends the calling device a notification, to see that push works end to end. */
  async test(tokenId: string): Promise<void> {
    const account = await this.serviceAccount();
    if (!account) throw new ApiError(409, 'push_not_configured', 'Push isn’t set up on the server');
    const [row] = await this.rows(tokenId);
    if (!row) throw new ApiError(409, 'device_not_registered', 'This device isn’t registered for push');
    const error = await this.deliver(account, row, {
      kind: 'test',
      title: 'superagent',
      body: 'Notifications work.',
      taskId: null,
      itemId: null,
      at: new Date().toISOString(),
    });
    if (error) throw new ApiError(502, 'push_failed', error);
  }

  // --- Sending ---

  /** The chief finished an answer: the owner may have asked from the phone and gone. */
  chiefAnswered(text: string): void {
    const body = text.trim();
    if (!body) return;
    void this.notify('chief', {
      kind: 'chief',
      title: 'Chief of staff',
      body: clip(body),
      taskId: null,
      itemId: null,
      at: new Date().toISOString(),
    });
  }

  private async onEvent(event: TaskEvent): Promise<void> {
    try {
      const payload = await this.payloadFor(event);
      if (payload) await this.notify(payload.kind as PushKind, payload);
    } catch (error) {
      this.deps.logger.warn('Couldn’t send a push notification', { error, taskId: event.taskId });
    }
  }

  /** What an event tells the owner, if anything. */
  private async payloadFor(event: TaskEvent): Promise<PushPayload | null> {
    const at = event.createdAt;
    const data = event.data;
    const task = () => this.deps.tasks.get(event.taskId);
    const ref = (title: string) => `#${event.taskNumber} ${title}`;
    switch (event.type) {
      case 'approval_requested': {
        const tool = typeof data.tool === 'string' ? data.tool : 'a tool';
        const call =
          typeof data.runId === 'string' && typeof data.toolCallId === 'string'
            ? approvalId({ runId: data.runId, toolCallId: data.toolCallId })
            : null;
        return {
          kind: 'approval',
          title: `Approve ${tool}?`,
          body: clip(ref((await task()).title)),
          taskId: event.taskId,
          itemId: call,
          at,
        };
      }
      case 'reported':
        if (data.outcome !== 'blocked') return null;
        return {
          kind: 'question',
          title: `#${event.taskNumber} has a question`,
          body: clip(typeof data.summary === 'string' ? data.summary : (await task()).title),
          taskId: event.taskId,
          itemId: `task:${event.taskId}`,
          at,
        };
      case 'phase_changed':
        if (data.to === 'review') {
          return {
            kind: 'review',
            title: `#${event.taskNumber} is ready for review`,
            body: clip((await task()).title),
            taskId: event.taskId,
            itemId: `task:${event.taskId}`,
            at,
          };
        }
        if (data.to === 'failed') {
          return {
            kind: 'problem',
            title: `#${event.taskNumber} failed`,
            body: clip(typeof data.reason === 'string' ? data.reason : (await task()).title),
            taskId: event.taskId,
            itemId: `task:${event.taskId}`,
            at,
          };
        }
        return null;
      case 'not_dispatched':
        return {
          kind: 'problem',
          title: `#${event.taskNumber} wasn’t sent to a lead`,
          body: clip(typeof data.reason === 'string' ? data.reason : (await task()).title),
          taskId: event.taskId,
          itemId: `task:${event.taskId}`,
          at,
        };
      default:
        return null;
    }
  }

  /** Sends a payload to every device that asked for its kind. */
  private async notify(kind: PushKind, payload: PushPayload): Promise<void> {
    const account = await this.serviceAccount();
    if (!account) return;
    const rows = (await this.rows()).filter((row) => row.kinds.includes(kind));
    await Promise.all(rows.map((row) => this.deliver(account, row, payload)));
  }

  /** Sends one device one payload. The error, if it failed. */
  private async deliver(
    account: ServiceAccount,
    row: PushDeviceRow,
    payload: PushPayload,
  ): Promise<string | null> {
    let error: string | null;
    try {
      const pushToken = this.deps.box.open(row.pushTokenEnc, tokenContext(row.id));
      const key = this.deps.box.open(row.keyEnc, keyContext(row.id));
      const result = await this.deps.sender.send(account, pushToken, {
        v: '1',
        c: encryptPayload(key, payload),
      });
      if (!result.ok && result.gone) {
        await this.deps.db.delete(pushDevices).where(eq(pushDevices.id, row.id));
        this.deps.logger.info('A device left push: FCM no longer knows it', { deviceId: row.id });
        return result.error;
      }
      error = result.ok ? null : result.error;
    } catch (failure) {
      error = (failure as Error).message;
    }
    await this.deps.db
      .update(pushDevices)
      .set(error ? { lastError: clip(error, 500) } : { lastSentAt: new Date(), lastError: null })
      .where(eq(pushDevices.id, row.id));
    if (error) this.deps.logger.warn('A push notification wasn’t sent', { deviceId: row.id, error });
    return error;
  }

  private async forget(tokenId: string): Promise<void> {
    try {
      await this.unregister(tokenId);
    } catch (error) {
      this.deps.logger.warn('Couldn’t remove a revoked device’s push registration', { error, tokenId });
    }
  }

  private serviceAccount(): Promise<ServiceAccount | null> {
    this.account ??= (async () => {
      const [config] = await this.deps.db.select().from(pushConfig).where(eq(pushConfig.id, CONFIG_ID));
      if (!config) return null;
      try {
        return JSON.parse(this.deps.box.open(config.serviceAccountEnc, accountContext)) as ServiceAccount;
      } catch (error) {
        this.deps.logger.error('The Firebase service account can’t be opened: is the encryption key right?', {
          error,
        });
        return null;
      }
    })();
    return this.account;
  }

  /** Registrations of tokens still in use (one token's, or everyone's). */
  private rows(tokenId?: string): Promise<PushDeviceRow[]> {
    return this.deps.db
      .select({ device: pushDevices })
      .from(pushDevices)
      .innerJoin(apiTokens, eq(apiTokens.id, pushDevices.tokenId))
      .where(and(isNull(apiTokens.revokedAt), tokenId ? eq(pushDevices.tokenId, tokenId) : undefined))
      .then((found) => found.map((row) => row.device));
  }

  private async devices(tokenId?: string): Promise<PushDevice[]> {
    const found = await this.deps.db
      .select({ device: pushDevices, tokenName: apiTokens.name })
      .from(pushDevices)
      .innerJoin(apiTokens, eq(apiTokens.id, pushDevices.tokenId))
      .where(and(isNull(apiTokens.revokedAt), tokenId ? eq(pushDevices.tokenId, tokenId) : undefined))
      .orderBy(pushDevices.createdAt);
    return found.map(({ device, tokenName }) => ({
      id: device.id,
      tokenId: device.tokenId,
      tokenName,
      platform: device.platform,
      kinds: device.kinds as PushKind[],
      createdAt: device.createdAt.toISOString(),
      updatedAt: device.updatedAt.toISOString(),
      lastSentAt: device.lastSentAt?.toISOString() ?? null,
      lastError: device.lastError,
    }));
  }
}
