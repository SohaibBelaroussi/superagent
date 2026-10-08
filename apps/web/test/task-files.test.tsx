import type { Task, WorkspaceEntry } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileTree } from '../src/features/tasks/task-files';
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

/** A task, its files (or the problem listing them answers), and the bytes of each file by path. */
function withFiles(
  current: Task,
  listing: { items: WorkspaceEntry[]; truncated?: boolean } | (() => Response),
  contents: Record<string, Uint8Array | string> = {},
  fetched: string[] = [],
) {
  return [
    http.get(api(`/v1/tasks/${current.id}`), () => HttpResponse.json(current)),
    http.get(api(`/v1/tasks/${current.id}/events`), () => HttpResponse.json({ items: [] })),
    http.get(api(`/v1/tasks/${current.id}/artifacts`), () => HttpResponse.json({ items: [] })),
    http.get(api(`/v1/tasks/${current.id}/files`), () =>
      typeof listing === 'function' ? listing() : HttpResponse.json({ truncated: false, ...listing }),
    ),
    http.get(api(`/v1/tasks/${current.id}/files/*`), ({ request }) => {
      const path = new URL(request.url).pathname
        .split('/files/')[1]
        ?.split('/')
        .map(decodeURIComponent)
        .join('/');
      fetched.push(path ?? '');
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

describe('a workspace as a tree', () => {
  it('puts folders first, in name order with numbers in order, and fills in folders left out', () => {
    const tree = fileTree([
      file('b.txt'),
      file('a10.txt'),
      file('a2.txt'),
      file('src/lib/util.ts'),
      folder('src'),
      folder('data'),
      file('./notes.md'),
      folder('.'),
    ]);
    expect(tree.map((node) => node.name)).toEqual(['data', 'src', 'a2.txt', 'a10.txt', 'b.txt', 'notes.md']);
    const src = tree[1];
    expect(src?.modifiedAt).toBe(AT);
    // "src/lib" wasn't listed: it is there, with its file.
    expect(src?.children.map((node) => `${node.type}:${node.path}`)).toEqual(['directory:src/lib']);
    expect(src?.children[0]?.children.map((node) => node.path)).toEqual(['src/lib/util.ts']);
  });
});

describe('a task’s files', () => {
  it('lists them, and shows text and markdown files', async () => {
    const current = task({ title: 'Score frameworks' });
    server.use(
      ...withFiles(
        current,
        {
          items: [
            file('README.md', 52),
            folder('data'),
            file('data/scores.csv', 41),
            file('src/hello.js', 19),
          ],
        },
        {
          'README.md': '# Framework comparison\n\nScores from the **shortlist**.\n',
          'data/scores.csv': 'framework,score\nmastra,9\n',
        },
      ),
    );
    renderApp(`/tasks/${current.id}?view=files`);
    const user = userEvent.setup();

    expect(await screen.findByText('3 files')).toBeVisible();
    const list = screen.getByRole('list', { name: 'Files' });
    const names = within(list)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((text) => text.length > 0);
    expect(names[0]).toMatch(/^data/);
    expect(names[1]).toMatch(/^scores\.csv/);
    expect(within(list).getByRole('button', { name: /^data/ })).toHaveAttribute('aria-expanded', 'true');

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

  it('shows an image, and says when a file can’t be shown here', async () => {
    const current = task();
    const fetched: string[] = [];
    server.use(
      ...withFiles(
        current,
        { items: [file('chart.png', 2048), file('archive.bin', 64), file('huge.log', 5 * 1024 * 1024)] },
        { 'chart.png': new Uint8Array([137, 80, 78, 71]), 'archive.bin': new Uint8Array([80, 75, 0, 3, 4]) },
        fetched,
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

    // Too large to show: it isn't even fetched.
    await user.click(within(list).getByRole('button', { name: /^huge\.log/ }));
    expect(await screen.findByText('Too large to show here: download it.')).toBeVisible();
    expect(fetched).toEqual(['chart.png', 'archive.bin']);
  });

  it('downloads a file through the browser’s own download', async () => {
    const current = task();
    server.use(
      ...withFiles(
        current,
        { items: [file('src/hello.js', 19)] },
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

  it('says when there are more files than listed', async () => {
    const current = task();
    server.use(...withFiles(current, { items: [file('a.txt')], truncated: true }));
    renderApp(`/tasks/${current.id}?view=files`);
    expect(await screen.findByText('There are more files than shown here.')).toBeVisible();
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
    expect(await screen.findByText('1 file')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});
