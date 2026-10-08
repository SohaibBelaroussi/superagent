import type { KnowledgeDocument } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, research, server, signedInHandlers } from './msw';
import { renderApp } from './render';

const guide: KnowledgeDocument = {
  id: '0199d000-0000-7000-8000-000000000001',
  title: 'Style guide',
  filename: 'style-guide.md',
  contentType: 'text/markdown',
  size: 2048,
  departmentId: null,
  chunkCount: 4,
  createdAt: '2026-10-07T09:00:00.000Z',
};

describe('knowledge', () => {
  it('uploads a document for one department, and says how it went', async () => {
    const documents: KnowledgeDocument[] = [];
    const sent: Array<{ name: string; text: string; departmentId: string | null }> = [];
    server.use(
      http.get(api('/v1/knowledge'), () => HttpResponse.json({ items: documents })),
      http.post(api('/v1/knowledge'), async ({ request }) => {
        expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        const form = await request.formData();
        const file = form.get('file') as File;
        sent.push({
          name: file.name,
          text: await file.text(),
          departmentId: form.get('departmentId') as string | null,
        });
        const document = {
          ...guide,
          title: file.name,
          filename: file.name,
          departmentId: research.id,
          chunkCount: 3,
        };
        documents.push(document);
        return HttpResponse.json(document, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Who can search them' }));
    await user.click(await screen.findByRole('option', { name: 'Only Research' }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('no file input');
    await user.upload(
      input,
      new File(['# Notes\n\nCite every claim.'], 'research-notes.md', { type: 'text/markdown' }),
    );

    const uploads = await screen.findByRole('list', { name: 'Uploads' });
    expect(await within(uploads).findByText(/3 passages to search/)).toBeVisible();
    expect(sent).toEqual([
      { name: 'research-notes.md', text: '# Notes\n\nCite every claim.', departmentId: research.id },
    ]);
    const list = await screen.findByRole('list', { name: 'Documents' });
    expect(within(list).getByText('research-notes.md')).toBeVisible();
    expect(within(list).getByText('Only Research')).toBeVisible();
  });

  it('turns a file away before sending it when it’s too large', async () => {
    let posted = false;
    server.use(
      http.post(api('/v1/knowledge'), () => {
        posted = true;
        return HttpResponse.json(guide, { status: 201 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/knowledge');
    const input = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!found) throw new Error('no file input yet');
      return found;
    });
    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await userEvent.setup().upload(input, big);
    expect(await screen.findByText(/Larger than 20 MB/)).toBeVisible();
    expect(posted).toBe(false);
  });

  it('finds passages as an agent would, and deletes a document', async () => {
    const deleted: string[] = [];
    server.use(
      http.get(api('/v1/knowledge'), () => HttpResponse.json({ items: deleted.length ? [] : [guide] })),
      http.get(api('/v1/knowledge/search'), ({ request }) =>
        HttpResponse.json({
          items:
            new URL(request.url).searchParams.get('q') === 'sources'
              ? [
                  {
                    documentId: guide.id,
                    title: guide.title,
                    departmentId: null,
                    passage: 1,
                    content: 'Prefer primary sources over summaries.',
                    score: 0.8,
                  },
                ]
              : [],
        }),
      ),
      http.delete(api(`/v1/knowledge/${guide.id}`), () => {
        deleted.push(guide.id);
        return new HttpResponse(null, { status: 204 });
      }),
      ...signedInHandlers(),
    );
    renderApp('/knowledge');
    const user = userEvent.setup();
    expect(await screen.findByText('Style guide')).toBeVisible();

    await user.type(screen.getByRole('searchbox', { name: 'Search the documents' }), 'sources');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(within(results).getByText('passage 2')).toBeVisible();
    expect(within(results).getByText('sources', { selector: 'mark' })).toBeVisible();

    await user.clear(screen.getByRole('searchbox', { name: 'Search the documents' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Style guide' }));
    await user.click(await screen.findByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(deleted).toEqual([guide.id]));
    expect(await screen.findByText('No documents yet')).toBeVisible();
  });
});

describe('your profile', () => {
  it('corrects what your agents know about you', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get(api('/v1/profile'), () =>
        HttpResponse.json({ name: 'Sohaib', language: 'French', preferences: ['cite sources'] }),
      ),
      http.patch(api('/v1/profile'), async ({ request }) => {
        const patch = await request.json();
        patches.push(patch);
        return HttpResponse.json({ name: 'Sohaib', preferences: ['cite sources', 'no meetings before 10'] });
      }),
      ...signedInHandlers(),
    );
    renderApp('/settings/profile');
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Language'));
    await user.click(screen.getByRole('button', { name: 'Add a preference' }));
    await user.type(screen.getByLabelText('Preference 2'), 'no meetings before 10');
    await user.click(
      within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() =>
      expect(patches).toEqual([{ language: null, preferences: ['cite sources', 'no meetings before 10'] }]),
    );
    expect(await screen.findByText('Profile saved')).toBeVisible();
  });
});
