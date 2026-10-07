import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type KnowledgeDocument,
  KnowledgeDocumentListSchema,
  KnowledgeDocumentSchema,
  KnowledgeSearchResultSchema,
} from '@superagent/shared';
import type { KnowledgeDocumentRow } from '../../db/schema';
import { ApiError, problemResponse } from '../../http/problem';
import type { AppDeps, AppEnv } from '../../http/types';

/** Uploads get a larger body limit than other requests (see app.ts and the v1 router). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The one request that may carry a large body. Mastra parses only JSON bodies before auth. */
export const isUpload = (c: { req: { method: string; path: string } }) =>
  c.req.method === 'POST' && c.req.path === '/v1/knowledge';

function toDocument(d: KnowledgeDocumentRow): KnowledgeDocument {
  return {
    id: d.id,
    title: d.title,
    filename: d.filename,
    contentType: d.contentType,
    size: d.size,
    departmentId: d.departmentId,
    chunkCount: d.chunkCount,
    createdAt: d.createdAt.toISOString(),
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const tags = ['knowledge'];
const params = z.object({ id: z.uuid() });
const notFound = problemResponse('No document with this id');

const listDocuments = createRoute({
  method: 'get',
  path: '/knowledge',
  tags,
  summary: 'List uploaded documents, newest first',
  request: { query: z.object({ departmentId: z.uuid().optional() }) },
  responses: { 200: json(KnowledgeDocumentListSchema, 'Documents') },
});

const uploadDocument = createRoute({
  method: 'post',
  path: '/knowledge',
  tags,
  summary: 'Upload a document for the agents',
  description:
    'Text, markdown, CSV, JSON, HTML or PDF, up to 20 MiB. The text is split into passages that agents ' +
    'find with the knowledge_search tool. With departmentId, only that department searches it.',
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any().openapi({ type: 'string', format: 'binary', description: 'The document' }),
            title: z.string().max(200).optional(),
            departmentId: z.uuid().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(KnowledgeDocumentSchema, 'Document stored and indexed'),
    400: problemResponse('Invalid request'),
    404: problemResponse('Department not found'),
    413: problemResponse('File too large'),
    415: problemResponse('Unsupported document type'),
    422: problemResponse('No readable text in the document'),
    503: problemResponse('Document storage is not configured'),
  },
});

const searchDocuments = createRoute({
  method: 'get',
  path: '/knowledge/search',
  tags,
  summary: 'Search the documents (what knowledge_search returns to agents)',
  request: {
    query: z.object({
      q: z.string().min(1).max(400),
      departmentId: z.uuid().optional().describe("Search that department's documents and the shared ones"),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  },
  responses: { 200: json(KnowledgeSearchResultSchema, 'Best passages first') },
});

const getDocument = createRoute({
  method: 'get',
  path: '/knowledge/{id}',
  tags,
  summary: 'Get a document',
  request: { params },
  responses: { 200: json(KnowledgeDocumentSchema, 'The document'), 404: notFound },
});

const deleteDocument = createRoute({
  method: 'delete',
  path: '/knowledge/{id}',
  tags,
  summary: 'Delete a document and its passages',
  request: { params },
  responses: { 204: { description: 'Deleted' }, 404: notFound },
});

export function registerKnowledgeRoutes(v1: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { knowledge } = deps;

  v1.openapi(listDocuments, async (c) => {
    const rows = await knowledge.list({ departmentId: c.req.valid('query').departmentId });
    return c.json({ items: rows.map(toDocument) }, 200);
  });

  v1.openapi(uploadDocument, async (c) => {
    const form = c.req.valid('form');
    const file = form.file as unknown;
    if (!(file instanceof File)) {
      throw new ApiError(400, 'validation_failed', 'Send the document as a "file" form field');
    }
    const document = await knowledge.upload({
      filename: file.name || 'document',
      contentType: file.type,
      body: new Uint8Array(await file.arrayBuffer()),
      title: form.title,
      departmentId: form.departmentId,
    });
    return c.json(toDocument(document), 201);
  });

  v1.openapi(searchDocuments, async (c) => {
    const { q, departmentId, limit } = c.req.valid('query');
    return c.json({ items: await knowledge.search(q, { departmentId, limit }) }, 200);
  });

  v1.openapi(getDocument, async (c) => c.json(toDocument(await knowledge.get(c.req.valid('param').id)), 200));

  v1.openapi(deleteDocument, async (c) => {
    await knowledge.remove(c.req.valid('param').id);
    return c.body(null, 204);
  });
}
