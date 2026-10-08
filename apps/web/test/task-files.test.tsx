import type { Task, WorkspaceEntry } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderEntries } from '../src/features/tasks/task-files';
import { api, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

const AT = '2026-10-08T09:00:00.000Z';
const file = (path: string, size = 10): WorkspaceEntry => ({ path, type: 'file', size, modifiedAt: AT });
const folder = (path: string): WorkspaceEntry => ({ path, type: 'directory', size: null, modifiedAt: AT });

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Problem', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/**
 * A task, its workspace (or the problem listing it answers), and the bytes of each file by path. The
 * workspace is listed as the API does with depth 1: what is directly in the folder asked for.
 */
function withFiles(
  current: Task,
  workspace: { items: WorkspaceEntry[]; truncated?: string[] } | (() => Response),
  contents: Record<string, Uint8Array | string> = {},
  seen: { listed: string[]; fetched: string[] } = { listed: [], fetched: [] },
) {
  return [
    http.get(api(`/v1/tasks/${current.id}`), () => HttpResponse.json(current)),
    http.get(api(`/v1/tasks/${current.id}/events`), () => HttpResponse.json({ items: [] })),
    http.get(api(`/v1/tasks/${current.id}/artifacts`), () => HttpResponse.json({ items: [] })),
    http.get(api(`/v1/tasks/${current.id}/files`), ({ request }) => {
      if (typeof workspace === 'function') return workspace();
      const params = new URL(request.url).searchParams;
      const path = params.get('path') ?? '';
      seen.listed.push(`${path || '.'}@${params.get('depth')}`);
      const prefix = path ? `${path}/` : '';
      const items = workspace.items.filter(
        (entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'),
      );
      return HttpResponse.json({ items, truncated: workspace.truncated?.includes(path) ?? false });
    }),
    http.get(api(`/v1/tasks/${current.id}/files/*`), ({ request }) => {
      const path = new URL(request.url).pathname
        .split('/files/')[1]
        ?.split('/')
        .map(decodeURIComponent)
        .join('/');
      seen.fetched.push(path ?? '');
      const body = path === undefined ? undefined : contents[path];
      if (body === undefined) return problem(404, 'No such file or folder in the workspace');
      return new HttpResponse(body, { headers: { 'content-type': 'application/octet-stream' } });
    }),
    ...signedInHandlers({ tasks: [current] }),
  ];
}

let objectUrls: Blob[] = [];
let downloads: Array<{ href: string; download: string }> = [];
beforeEach(() => {
  objectUrls = [];
  downloads = [];
  // jsdom has no object URLs, and doesn't follow a download link.
  URL.createObjectURL = (blob: Blob) => {
    objectUrls.push(blob);
    return `blob:http://localhost:3000/${objectUrls.length}`;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, download: this.download });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a workspace folder', () => {
  it('holds what is directly in it: folders first, in name order with numbers in order', () => {
    const entries = [
      file('b.txt'),
      file('a10.txt'),
      file('a2.txt'),
      folder('src'),
      folder('data'),
      file('./notes.md'),
      folder('.'),
      // Deeper: not in this folder.
      file('src/lib/util.ts'),
    ];
    expect(folderEntries(entries, '').map((node) => node.name)).toEqual([
      'data',
      'src',
      'a2.txt',
      'a10.txt',
      'b.txt',
      'notes.md',
    ]);
    expect(folderEntries([file('src/main.ts'), folder('src/lib'), file('src/lib/util.ts')], 'src')).toEqual([
      { name: 'lib', path: 'src/lib', type: 'directory', size: null, modifiedAt: AT },
      { name: 'main.ts', path: 'src/main.ts', type: 'file', size: 10, modifiedAt: AT },
    ]);
  });
});

describe('a task’s files', () => {
  it('lists them a folder at a time, and shows text and markdown files', async () => {
    const current = task({ title: 'Score frameworks' });
    const seen = { listed: [] as string[], fetched: [] as string[] };
    server.use(
      ...withFiles(
        current,
        {
          items: [
            file('README.md', 52),
            folder('data'),
            file('data/scores.csv', 41),
            folder('node_modules'),
            folder('node_modules/left-pad'),
          ],
        },
        {
          'README.md': '# Framework comparison\n\nScores from the **shortlist**.\n',
          'data/scores.csv': 'framework,score\nmastra,9\n',
        },
        seen,
      ),
    );
    renderApp(`/tasks/${current.id}?view=files`);
    const user = userEvent.setup();

    const list = await screen.findByRole('list', { name: 'Files' });
    // A few folders at the top start open, but not what tools installed.
    expect(await within(list).findByRole('button', { name: /^scores\.csv/ })).toBeVisible();
    expect(within(list).getByRole('button', { name: /^data/ })).toHaveAttribute('aria-expanded', 'true');
    const modules = within(list).getByRole('button', { name: /^node_modules/ });
    expect(modules).toHaveAttribute('aria-expanded', 'false');
    expect(seen.listed).toEqual(['.@1', 'data@1']);
    // Opening one lists it then.
    await user.click(modules);
    expect(await within(list).findByRole('button', { name: /^left-pad/ })).toBeVisible();
    expect(seen.listed).toContain('node_modules@1');

    await user.click(within(list).getByRole('button', { name: /^README\.md/ }));
    const dialog = await screen.findByRole('dialog', { name: 'README.md' });
    expect(await within(dialog).findByRole('heading', { name: 'Framework comparison' })).toBeVisible();
    expect(within(dialog).getByText('shortlist').tagName).toBe('STRONG');
    await user.click(within(dialog).getByRole('button', { name: 'Source' }));
    expect(dialog.querySelector('pre')).toHaveTextContent('# Framework comparison');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(list).getByRole('button', { name: /^scores\.csv/ }));
    const csv = await screen.findByRole('dialog', { name: 'scores.csv' });
    expect(csv).toHaveTextContent('data/scores.csv');
    await waitFor(() => expect(csv.querySelector('pre')).toHaveTextContent('framework,score mastra,9'));
  });

  it('keeps folders closed when there are many, and says when a folder holds more than listed', async () => {
    const current = task();
    server.use(
      ...withFiles(current, {
        items: ['a', 'b', 'c', 'd', 'e'].map((name) => folder(name)).concat([file('e/1.txt')]),
        truncated: ['e'],
      }),
    );
    renderApp(`/tasks/${current.id}?view=files`);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Files' });
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      expect(within(list).getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    }
    await user.click(within(list).getByRole('button', { name: /^e/ }));
    expect(await within(list).findByText('There’s more here than can be listed.')).toBeVisible();
    await user.click(within(list).getByRole('button', { name: /^a/ }));
    expect(await within(list).findByText('Empty')).toBeVisible();
  });

  it('shows an image, and says when a file can’t be shown here', async () => {
    const current = task();
    const seen = { listed: [] as string[], fetched: [] as string[] };
    server.use(
      ...withFiles(
        current,
        {
          items: [
            file('chart.png', 2048),
            file('archive.bin', 64),
            file('huge.log', 5 * 1024 * 1024),
            // Listed small (a link), but more than a preview takes.
            { path: 'latest.log', type: 'symlink', size: 12, modifiedAt: AT },
          ],
        },
        {
          'chart.png': new Uint8Array([137, 80, 78, 71]),
          'archive.bin': new Uint8Array([80, 75, 0, 3, 4]),
          'latest.log': 'x'.repeat(1024 * 1024 + 1),
        },
        seen,
      ),
    );
    renderApp(`/tasks/${current.id}?view=files`);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Files' });

    await user.click(within(list).getByRole('button', { name: /^chart\.png/ }));
    const image = await within(await screen.findByRole('dialog', { name: 'chart.png' })).findByRole('img', {
      name: 'chart.png',
    });
    expect(image.getAttribute('src')).toMatch(/^blob:/);
    expect(objectUrls.at(-1)?.type).toBe('image/png');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(list).getByRole('button', { name: /^archive\.bin/ }));
    expect(await screen.findByText(/There’s no preview for this kind of file/)).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Too large by its listing: not even fetched.
    await user.click(within(list).getByRole('button', { name: /^huge\.log/ }));
    expect(await screen.findByText('Too large to show here: download it.')).toBeVisible();
    expect(seen.fetched).toEqual(['chart.png', 'archive.bin']);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Too large by what came: not shown.
    await user.click(within(list).getByRole('button', { name: /^latest\.log/ }));
    expect(await screen.findByText('Too large to show here: download it.')).toBeVisible();
  });

  it('downloads a file through the browser’s own download', async () => {
    const current = task();
    server.use(
      ...withFiles(
        current,
        { items: [folder('src'), file('src/hello.js', 19)] },
        { 'src/hello.js': 'console.log(6 * 7)\n' },
      ),
    );
    renderApp(`/tasks/${current.id}?view=files`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Download hello.js' }));
    await waitFor(() =>
      expect(downloads).toEqual([{ href: 'blob:http://localhost:3000/1', download: 'hello.js' }]),
    );
    expect(await objectUrls[0]?.text()).toBe('console.log(6 * 7)\n');
  });

  it('says when no agent has written any yet, or when workspaces can’t be read', async () => {
    const empty = task();
    server.use(
      ...withFiles(empty, () =>
        problem(404, `Task #${empty.number} has no files: no agent has worked in it`),
      ),
    );
    const { unmount } = renderApp(`/tasks/${empty.id}?view=files`);
    expect(await screen.findByText('No files yet')).toBeVisible();
    unmount();

    const off = task();
    server.use(...withFiles(off, () => problem(503, 'Sandboxes are off: set RUNNER_URL and RUNNER_TOKEN')));
    renderApp(`/tasks/${off.id}?view=files`);
    expect(await screen.findByText('Workspaces can’t be read now', {}, { timeout: 8_000 })).toBeVisible();
    expect(screen.getByText('Sandboxes are off: set RUNNER_URL and RUNNER_TOKEN')).toBeVisible();
  });
});

describe('a task’s tabs', () => {
  it('open on the one the address names, and keep the one chosen in it', async () => {
    const current = task();
    server.use(...withFiles(current, { items: [file('notes.txt')] }));
    const { router } = renderApp(`/tasks/${current.id}`);
    const user = userEvent.setup();
    expect(await screen.findByRole('tab', { name: 'Activity', selected: true })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Files' }));
    await waitFor(() => expect(router.state.location.search).toBe('?view=files'));
    expect(await screen.findByRole('button', { name: /^notes\.txt/ })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});
