// biome-ignore-all lint/suspicious/noTemplateCurlyInString: plugin manifests write ${VAR} placeholders as plain text
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpToolKeys } from '../../src/modules/capabilities/mcp/naming';
import { ARCHIVE_LIMITS, PluginFetcher, type PluginFile } from '../../src/modules/capabilities/plugins/fetch';
import { placeholders, planPlugin, render } from '../../src/modules/capabilities/plugins/formats';
import { writeTar } from '../../src/modules/capabilities/plugins/tar';

const FIXTURE = join(import.meta.dirname, '../fixtures/plugins/demo-kit');

function filesOf(dir: string): Map<string, PluginFile> {
  const files = new Map<string, PluginFile>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(dir, path).replaceAll('\\', '/'), { mode: 0o644, data: readFileSync(path) });
    }
  };
  walk(dir);
  return files;
}

const files = (entries: Record<string, string | object>) =>
  new Map(
    Object.entries(entries).map(([path, content]) => [
      path,
      { mode: 0o644, data: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)) },
    ]),
  );

const skill = (name: string, description = `Does ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;

describe('plugin formats', () => {
  it('reads an Agent Plugins 1.0 package: skills, a bundled stdio server, and what it skips', () => {
    const plan = planPlugin(filesOf(FIXTURE));
    expect(plan).toMatchObject({
      format: 'agent-plugins',
      name: 'demo-kit',
      version: '1.2.0',
      license: 'MIT',
    });
    expect(plan.skills.map((s) => [s.name, s.dir, s.files])).toEqual([
      ['release-notes', 'skills/release-notes', 2],
    ]);
    expect(plan.servers).toEqual([
      expect.objectContaining({
        key: 'notes',
        slug: 'demo-kit-notes',
        transport: 'stdio',
        runtime: 'bundled',
        // Only PLUGIN_ROOT and PLUGIN_DATA expand in this format: ${HOME} stays as written.
        command: ['node', '/opt/plugin/server/notes.mjs', `--home=${'$'}{HOME}`],
        env: { NOTES_GREETING: 'Hello' },
      }),
    ]);
    const skipped = plan.skipped.map((s) => s.component);
    expect(skipped).toEqual(
      expect.arrayContaining(['skill skills/broken-skill', 'MCP server legacy', 'MCP server boxed']),
    );
    expect(plan.inputs).toEqual([]);
  });

  it('reads a Claude Code plugin: npx and uvx servers pinned at install, inputs from userConfig and ${VAR}', () => {
    const plan = planPlugin(
      files({
        '.claude-plugin/plugin.json': {
          name: 'claude-kit',
          version: '0.3.0',
          userConfig: { API_KEY: { description: 'Your Acme key', sensitive: true, required: true } },
        },
        '.mcp.json': {
          mcpServers: {
            time: { command: 'uvx', args: ['mcp-server-time', '--local-timezone=${TZ:-UTC}'] },
            docs: {
              command: 'npx',
              args: ['-y', '@acme/docs-mcp@1.4.2', '--stdio'],
              env: { ACME_KEY: '${user_config.API_KEY}' },
            },
            remote: {
              type: 'http',
              url: 'https://mcp.example.com/mcp',
              headers: { Authorization: 'Bearer ${API_KEY}' },
            },
            plain: { type: 'http', url: 'http://mcp.example.com/mcp' },
            socket: { type: 'ws', url: 'wss://mcp.example.com' },
          },
        },
        'skills/notes/SKILL.md': skill('notes'),
        'commands/deploy.md': 'Deploy it.',
      }),
    );
    expect(plan.format).toBe('claude');
    const byKey = Object.fromEntries(plan.servers.map((s) => [s.key, s]));
    expect(byKey.time).toMatchObject({
      runtime: 'uv',
      package: 'mcp-server-time',
      version: 'latest',
      bin: 'mcp-server-time',
      command: ['--local-timezone=${TZ:-UTC}'],
    });
    expect(byKey.docs).toMatchObject({
      runtime: 'npm',
      package: '@acme/docs-mcp',
      version: '1.4.2',
      command: ['--stdio'],
      env: { ACME_KEY: '${API_KEY}' },
    });
    expect(byKey.remote).toMatchObject({
      transport: 'http',
      headers: { Authorization: 'Bearer ${API_KEY}' },
    });
    expect(byKey.plain).toBeUndefined();
    expect(plan.inputs).toEqual(
      expect.arrayContaining([
        { name: 'API_KEY', description: 'Your Acme key', sensitive: true, required: true },
        expect.objectContaining({ name: 'TZ', required: false }),
      ]),
    );
    expect(plan.skipped.map((s) => s.component)).toEqual(
      expect.arrayContaining(['commands', 'MCP server plain', 'MCP server socket']),
    );
  });

  it('takes Codex plugins, bare skill folders, and refuses what is not a plugin', () => {
    const codex = planPlugin(
      files({
        '.codex-plugin/plugin.json': {
          name: 'codex-kit',
          skills: './extra-skills/',
          interface: { displayName: 'Codex Kit' },
        },
        'extra-skills/lint/SKILL.md': skill('lint'),
      }),
    );
    expect(codex).toMatchObject({ format: 'codex', name: 'codex-kit', title: 'Codex Kit' });
    expect(codex.skills.map((s) => s.name)).toEqual(['lint']);
    const bare = planPlugin(files({ 'skills/a/SKILL.md': skill('a') }), { fallbackName: 'my-skills' });
    expect(bare).toMatchObject({ format: 'skills', name: 'my-skills' });
    expect(() => planPlugin(files({ 'README.md': 'hi' }))).toThrow(/No plugin here/);
    expect(() =>
      planPlugin(
        files({
          'plugin.json': { $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json', name: 'x' },
        }),
      ),
    ).toThrow(/Unsupported Agent Plugins version/);
  });

  it('fills placeholders from inputs and keeps the rest', () => {
    expect(render('Bearer ${TOKEN}', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(render('${TZ:-UTC}/${MISSING}', {})).toBe('UTC/${MISSING}');
    expect(placeholders('a ${X} b ${Y:-1}')).toEqual(['X', 'Y']);
  });

  it('names MCP tools for agents: safe characters, 64 at most, never clashing', () => {
    const keys = mcpToolKeys('github', ['search.code', 'search_code', 'x'.repeat(80), 'skill']);
    expect(keys.get('search_code')).toBe('github_search_code');
    // Sanitized to the same name: the second gets a hash.
    expect(keys.get('search.code')).toMatch(/^github_search_code_[0-9a-f]{6}$/);
    expect(keys.get('x'.repeat(80))?.length).toBe(64);
    expect([...keys.values()].every((key) => /^[A-Za-z0-9_-]{1,64}$/.test(key))).toBe(true);
    expect(new Set(keys.values()).size).toBe(4);
  });
});

/** A raw tar entry, for archives the writer would never make. */
function entry(name: string, data: Buffer, type = '0', mode = 0o644): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
}
const tarOf = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));

describe('plugin archives', () => {
  const archives = new Map<string, Buffer>();
  let server: Server;
  let base = '';
  const fetcher = new PluginFetcher();
  const unpack = (name: string, request: Partial<Parameters<PluginFetcher['unpack']>[1]> = {}) =>
    fetcher.unpack(
      `${base}/${name}`,
      { stripTop: false, root: null, keep: null, limits: ARCHIVE_LIMITS, ...request },
      { allowPrivate: true },
    );

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = archives.get((req.url ?? '').slice(1));
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/gzip' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('unpacks what the writer packs, modes included, and drops a single top folder', async () => {
    const tar = writeTar([
      { path: 'kit/plugin.json', mode: 0o644, data: Buffer.from('{}') },
      { path: 'kit/bin/run.sh', mode: 0o755, data: Buffer.from('#!/bin/sh\necho hi\n') },
      { path: `kit/deep/${'n'.repeat(120)}.md`, mode: 0o644, data: Buffer.from('long name') },
    ]);
    archives.set('ok.tgz', gzipSync(tar));
    const out = await unpack('ok.tgz');
    expect([...out.files.keys()].sort()).toEqual(['bin/run.sh', `deep/${'n'.repeat(120)}.md`, 'plugin.json']);
    expect(out.files.get('bin/run.sh')?.mode).toBe(0o755);
    expect(out.files.get(`deep/${'n'.repeat(120)}.md`)?.data.toString()).toBe('long name');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps only the plugin when asked, under a GitHub-style top folder and subfolder', async () => {
    archives.set(
      'repo.tgz',
      tarOf(
        entry('owner-repo-abc1234/plugins/kit/plugin.json', Buffer.from('{}')),
        entry('owner-repo-abc1234/plugins/kit/skills/a/SKILL.md', Buffer.from(skill('a'))),
        entry('owner-repo-abc1234/plugins/kit/node_modules/x/index.js', Buffer.from('x')),
        entry('owner-repo-abc1234/README.md', Buffer.from('elsewhere')),
      ),
    );
    const out = await unpack('repo.tgz', {
      stripTop: true,
      root: 'plugins/kit',
      keep: ['plugin.json', 'skills/'],
    });
    expect([...out.files.keys()].sort()).toEqual(['plugin.json', 'skills/a/SKILL.md']);
  });

  it('refuses paths that climb out, absolute paths and duplicate names, and skips links', async () => {
    for (const [name, bad, message] of [
      ['climb.tgz', entry('kit/../../etc/passwd', Buffer.from('x')), /Bad path/],
      ['absolute.tgz', entry('/etc/passwd', Buffer.from('x')), /Absolute path/],
      [
        'twice.tgz',
        Buffer.concat([entry('kit/A.md', Buffer.from('1')), entry('kit/a.md', Buffer.from('2'))]),
        /appears twice/,
      ],
    ] as const) {
      archives.set(name, tarOf(bad));
      await expect(unpack(name), name).rejects.toThrow(message);
    }
    archives.set(
      'link.tgz',
      tarOf(entry('kit/plugin.json', Buffer.from('{}')), entry('kit/evil', Buffer.alloc(0), '2')),
    );
    const out = await unpack('link.tgz');
    expect([...out.files.keys()]).toEqual(['plugin.json']);
    expect(out.refused).toEqual(['evil (symlink)']);
  });

  it('stops archives that are too large, as files, as a whole, or once decompressed', async () => {
    archives.set(
      'big.tgz',
      tarOf(entry('kit/a.bin', Buffer.alloc(4096, 1)), entry('kit/b.bin', Buffer.alloc(4096, 1))),
    );
    await expect(unpack('big.tgz', { limits: { ...ARCHIVE_LIMITS, file: 1024 } })).rejects.toThrow(
      /larger than/,
    );
    await expect(unpack('big.tgz', { limits: { ...ARCHIVE_LIMITS, kept: 6000 } })).rejects.toThrow(
      /too large/,
    );
    await expect(unpack('big.tgz', { limits: { ...ARCHIVE_LIMITS, files: 1 } })).rejects.toThrow(
      /too many files/,
    );
    // 64 MiB of zeros gzip to a few dozen KiB.
    archives.set('bomb.tgz', tarOf(entry('kit/zeros', Buffer.alloc(64 * 1024 * 1024))));
    await expect(
      unpack('bomb.tgz', {
        limits: { ...ARCHIVE_LIMITS, streamed: 8 * 1024 * 1024, file: 2 ** 30, kept: 2 ** 30 },
      }),
    ).rejects.toThrow(/too large once decompressed/);
    archives.set('junk.tgz', Buffer.from('not gzip at all'));
    await expect(unpack('junk.tgz')).rejects.toThrow(/Not a gzip archive/);
  });
});
