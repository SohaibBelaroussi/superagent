import type { Agent } from '@mastra/core/agent';
import type { MastraModelGatewayInterface } from '@mastra/core/llm';
import type { IMastraLogger } from '@mastra/core/logger';
import { Mastra } from '@mastra/core/mastra';
import { SimpleAuth } from '@mastra/core/server';
import type { ApiTokenAuth } from '../auth/provider';

type MastraConfig = NonNullable<ConstructorParameters<typeof Mastra>[0]>;

export interface CreateMastraOptions {
  storage: NonNullable<MastraConfig['storage']>;
  logger: IMastraLogger;
  auth: ApiTokenAuth;
  /** Enables Mastra Studio login with this token. Studio requests use only this provider. */
  studioToken?: string;
  agents?: Record<string, Agent>;
  /** Model gateways, keyed by id (our `sa` gateway resolves provider rows). */
  gateways?: Record<string, MastraModelGatewayInterface>;
}

export function createMastra(options: CreateMastraOptions): Mastra {
  const mastra = new Mastra({
    storage: options.storage,
    logger: options.logger,
    agents: options.agents ?? {},
    gateways: options.gateways ?? {},
    server: { auth: options.auth },
    ...(options.studioToken
      ? {
          studio: {
            auth: new SimpleAuth({
              tokens: { [options.studioToken]: { id: 'owner', name: 'Owner (Studio)' } },
            }),
          },
        }
      : {}),
  });
  // Without an auth provider Mastra lets every request through, including our /v1 routes.
  if (!mastra.getServer()?.auth) throw new Error('Mastra has no auth provider; refusing to start');
  return mastra;
}
