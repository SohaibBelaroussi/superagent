import type { IMastraLogger } from '@mastra/core/logger';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';
import { mcpToolKeys, RESERVED_SLUGS } from '../../src/modules/capabilities/mcp/naming';
import { lostSession, redacting } from '../../src/modules/capabilities/mcp/service';
import { createChiefTools, createLeadTools, type LedgerToolDeps } from '../../src/modules/ledger/tools';
import { ToolCatalog, type ToolContext } from '../../src/modules/tools/catalog';

describe('MCP tool names', () => {
  it("reserves the first word of every built-in tool's name, so no MCP tool can take one", () => {
    const names = [
      ...new ToolCatalog({} as ToolContext)
        .list()
        // These grants give tools under other names (below).
        .filter((tool) => !['browser', 'files', 'shell'].includes(tool.key))
        .map((tool) => tool.key),
      ...Object.keys(createLeadTools({} as LedgerToolDeps)),
      ...Object.keys(createChiefTools({} as LedgerToolDeps)),
      ...Object.values(WORKSPACE_TOOLS).flatMap((group) => Object.values(group)),
      'skill',
      'skill_read',
      'skill_search',
      'browser_goto',
    ];
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(RESERVED_SLUGS.has(name.split('_')[0] as string), name).toBe(true);
    // A key is "<slug>_<tool>" and slugs have no underscore: a reserved first word can't be a slug's.
    expect(mcpToolKeys('webby', ['search']).get('search')).toBe('webby_search');
  });
});

describe('lost MCP sessions', () => {
  const http = (status: number, message = 'Error POSTing to endpoint') =>
    Object.assign(new Error(message), { status });

  it('retries only when the transport answered 404 (the call never reached the server)', () => {
    expect(lostSession(http(404))).toBe(true);
    expect(lostSession(new Error('The call failed', { cause: http(404) }))).toBe(true);
    expect(lostSession(Object.assign(new Error('x'), { statusCode: 404 }))).toBe(true);
  });

  it("never retries a tool's own error, a protocol error or a message that says 404", () => {
    const toolError = Object.assign(new Error('Payment API answered 404 Not Found'), {
      id: 'MCP_CLIENT_TOOL_EXECUTION_FAILED',
      cause: http(404),
    });
    expect(lostSession(toolError)).toBe(false);
    expect(lostSession(new Error('GitHub API error: 404'))).toBe(false);
    expect(lostSession(new Error('No valid session'))).toBe(false);
    expect(lostSession(http(502))).toBe(false);
    expect(lostSession(Object.assign(new Error('Method not found'), { code: 404 }))).toBe(false);
  });
});

describe('the redacting MCP logger', () => {
  /** Like Pino's logger: private fields, getters and a child. */
  class PrivateLogger {
    #lines: Array<[string, unknown]> = [];
    #level = 'debug';
    debug(message: string, data?: unknown) {
      this.#lines.push([message, data]);
    }
    info(message: string, data?: unknown) {
      this.#lines.push([message, data]);
    }
    warn(message: string, data?: unknown) {
      this.#lines.push([message, data]);
    }
    error(message: string, data?: unknown) {
      this.#lines.push([message, data]);
    }
    get level() {
      return this.#level;
    }
    trackException() {
      return this.#lines.length;
    }
    child() {
      return this;
    }
    get lines() {
      return this.#lines;
    }
  }

  it('drops arguments and results, and works with private fields and children', () => {
    const inner = new PrivateLogger();
    const logger = redacting(inner as unknown as IMastraLogger) as unknown as PrivateLogger;
    logger.debug('Executing tool', { toolArgs: { token: 'abc' }, tool: 'greet', result: 'secret' });
    expect(inner.lines).toEqual([['Executing tool', { tool: 'greet' }]]);
    expect(logger.level).toBe('debug');
    expect(logger.trackException()).toBe(1);
    logger.child().error('Failed', { arguments: { token: 'abc' }, server: 'docs' });
    expect(inner.lines[1]).toEqual(['Failed', { server: 'docs' }]);
  });
});
