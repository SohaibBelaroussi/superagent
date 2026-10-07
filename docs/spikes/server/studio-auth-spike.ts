import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { MastraAuthProvider, SimpleAuth } from '@mastra/core/server';
import { MastraServer } from '@mastra/hono';
import { scripted } from './mock.ts';

type User = { id: string; name: string };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const db = new Map<string, User>([[sha256('sa_api_token'), { id: 'owner', name: 'Owner' }]]);

class TokenAuth extends MastraAuthProvider<User> {
  constructor() { super({ name: 'token-auth', mapUserToResourceId: (u: User) => u.id }); }
  async authenticateToken(token: string) { return db.get(sha256(token)) ?? null; }
  authorizeUser(u: User) { return !!u?.id; }
  // IUserProvider (only consulted by Studio capabilities when dev/licensed)
  async getCurrentUser(req: Request) {
    const h = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    return h ? db.get(sha256(h)) ?? null : null;
  }
}

const mastra = new Mastra({
  agents: { a: new Agent({ id: 'a', name: 'A', instructions: 'x', model: scripted([{ text: 'x' }]) }) },
  logger: false as any,
  server: { auth: new TokenAuth() },
  studio: { auth: new SimpleAuth<User>({ tokens: { 'studio-secret': { id: 'owner', name: 'Owner (studio)' } } }) },
});
const app = new Hono();
await new MastraServer({ app, mastra }).init();

const show = async (label: string, path: string, headers: Record<string, string>) => {
  const r = await app.request(path, { headers });
  const body = await r.text();
  console.log(label.padEnd(64), r.status, body.slice(0, 150));
};
console.log('NODE_ENV =', process.env.NODE_ENV);
await show('capabilities, API token, no studio header', '/api/auth/capabilities', { authorization: 'Bearer sa_api_token' });
await show('capabilities, studio header + studio token', '/api/auth/capabilities', { 'x-mastra-client-type': 'studio', authorization: 'Bearer studio-secret' });
await show('capabilities, studio header, no token', '/api/auth/capabilities', { 'x-mastra-client-type': 'studio' });
await show('GET /api/agents studio header + studio token', '/api/agents', { 'x-mastra-client-type': 'studio', authorization: 'Bearer studio-secret' });
await show('GET /api/agents studio header + API token', '/api/agents', { 'x-mastra-client-type': 'studio', authorization: 'Bearer sa_api_token' });
await show('GET /api/agents API token (no studio header)', '/api/agents', { authorization: 'Bearer sa_api_token' });
await show('GET /api/agents studio token without studio header', '/api/agents', { authorization: 'Bearer studio-secret' });
process.exit(0);
