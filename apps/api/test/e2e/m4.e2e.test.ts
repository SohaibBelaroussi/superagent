// M4 end-to-end check against a running stack (`pnpm stack:up`, then `pnpm test:e2e`).
// Knowledge uploads through the packaged API into SeaweedFS, full-text search, and delete.
import type { KnowledgeDocument, KnowledgeSearchResult } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/env';

loadDotEnv();
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4112'}`;
const auth = { Authorization: `Bearer ${process.env.SUPERAGENT_ADMIN_TOKEN ?? ''}` };

describe(`M4 against ${BASE_URL}`, () => {
  it('stores a document in object storage, finds it, and deletes it', async () => {
    const marker = `zebra${Date.now().toString(36)}`;
    const form = new FormData();
    form.append(
      'file',
      new File([`# Office notes\n\nThe ${marker} meeting room is on the third floor.`], 'office.md', {
        type: 'text/markdown',
      }),
    );
    const created = await fetch(`${BASE_URL}/v1/knowledge`, { method: 'POST', headers: auth, body: form });
    expect(created.status).toBe(201);
    const document = (await created.json()) as KnowledgeDocument;
    expect(document).toMatchObject({ filename: 'office.md', contentType: 'text/markdown', chunkCount: 1 });

    const found = (await (
      await fetch(`${BASE_URL}/v1/knowledge/search?q=${encodeURIComponent(`${marker} meeting room`)}`, {
        headers: auth,
      })
    ).json()) as KnowledgeSearchResult;
    // Best match first: the passage with the unique marker.
    expect(found.items[0]?.documentId).toBe(document.id);

    expect(
      (await fetch(`${BASE_URL}/v1/knowledge/${document.id}`, { method: 'DELETE', headers: auth })).status,
    ).toBe(204);
    const gone = (await (
      await fetch(`${BASE_URL}/v1/knowledge/search?q=${marker}`, { headers: auth })
    ).json()) as KnowledgeSearchResult;
    expect(gone.items).toEqual([]);
  });
});
