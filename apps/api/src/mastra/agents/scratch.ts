import { Agent } from '@mastra/core/agent';
import type { SettingsService } from '../../modules/settings/service';

/**
 * A plain chat agent on the `default` model role, for trying providers through Mastra's own routes
 * (/api/agents/scratch/generate, /stream) and in Studio. The chief of staff arrives in M2.
 */
export function createScratchAgent(settings: SettingsService): Agent {
  return new Agent({
    id: 'scratch',
    name: 'Scratch',
    description: 'Playground agent on the default model role, for testing providers.',
    instructions: 'You are a concise, helpful assistant.',
    // Resolved per request, so changing the default role applies immediately.
    model: () => settings.modelRouterId('default'),
  });
}
