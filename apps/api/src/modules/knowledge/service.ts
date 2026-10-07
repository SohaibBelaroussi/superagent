import type { IMastraLogger } from '@mastra/core/logger';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import { type KnowledgeDocumentRow, knowledgeChunks, knowledgeDocuments } from '../../db/schema';
import { ApiError } from '../../http/problem';
import type { OrgDirectory } from '../org/directory';
import type { BlobStore } from './blobs';
import {
  chunkText,
  DEFAULT_EXTRACT_LIMITS,
  documentType,
  ExtractError,
  type ExtractLimits,
  extractText,
  searchQuery,
} from './text';

const CHUNK_BATCH = 500;

export interface KnowledgeHit {
  documentId: string;
  title: string;
  departmentId: string | null;
  passage: number;
  content: string;
  score: number;
}

/**
 * Documents the owner uploads for the agents. The file goes to object storage; its text is split into
 * passages and indexed for full-text search (semantic search joins once an embedding model exists, D29).
 */
export class KnowledgeService {
  constructor(
    private readonly db: Db,
    private readonly directory: OrgDirectory,
    private readonly blobs: BlobStore | undefined,
    private readonly logger: IMastraLogger,
    private readonly limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
  ) {}

  async upload(input: {
    filename: string;
    contentType?: string;
    body: Uint8Array;
    title?: string;
    departmentId?: string;
  }): Promise<KnowledgeDocumentRow> {
    const blobs = this.storage();
    if (input.departmentId) {
      const department = this.directory.department(input.departmentId);
      if (!department)
        throw new ApiError(404, 'department_not_found', `No department with id ${input.departmentId}`);
      if (department.archivedAt)
        throw new ApiError(409, 'department_archived', 'This department is archived');
    }
    const type = documentType(input.filename, input.contentType);
    if (!type) {
      throw new ApiError(
        415,
        'unsupported_document',
        'Upload text, markdown, CSV, JSON, HTML or PDF documents',
      );
    }
    let text: string;
    try {
      text = await extractText(input.body, type, this.limits);
    } catch (error) {
      this.logger.warn('Could not read an uploaded document', { filename: input.filename, error });
      if (error instanceof ExtractError && error.code === 'too_large') {
        throw new ApiError(422, 'document_too_large', error.message);
      }
      const why =
        error instanceof ExtractError && error.code === 'timeout' ? ': reading it took too long' : '';
      throw new ApiError(422, 'unreadable_document', `Could not read the text of ${input.filename}${why}`);
    }
    const passages = chunkText(text);
    if (passages.length === 0)
      throw new ApiError(422, 'empty_document', `${input.filename} has no text to index`);

    const id = uuidv7();
    const objectKey = `documents/${id}/${input.filename.replace(/[^\w.-]+/g, '_').slice(-120)}`;
    await blobs.put(objectKey, input.body, type);
    try {
      return await this.db.transaction(async (tx) => {
        const [document] = await tx
          .insert(knowledgeDocuments)
          .values({
            id,
            title: input.title?.trim() || input.filename,
            filename: input.filename,
            contentType: type,
            size: input.body.byteLength,
            departmentId: input.departmentId,
            objectKey,
            chunkCount: passages.length,
          })
          .returning();
        if (!document) throw new Error('Document insert returned no row');
        for (let start = 0; start < passages.length; start += CHUNK_BATCH) {
          await tx
            .insert(knowledgeChunks)
            .values(
              passages
                .slice(start, start + CHUNK_BATCH)
                .map((content, i) => ({ documentId: id, seq: start + i, content })),
            );
        }
        return document;
      });
    } catch (error) {
      await blobs.delete(objectKey).catch(() => {});
      throw error;
    }
  }

  list(filter: { departmentId?: string } = {}): Promise<KnowledgeDocumentRow[]> {
    return this.db
      .select()
      .from(knowledgeDocuments)
      .where(filter.departmentId ? eq(knowledgeDocuments.departmentId, filter.departmentId) : undefined)
      .orderBy(desc(knowledgeDocuments.createdAt));
  }

  async get(id: string): Promise<KnowledgeDocumentRow> {
    const [document] = await this.db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
    if (!document) throw new ApiError(404, 'document_not_found', `No document with id ${id}`);
    return document;
  }

  async remove(id: string): Promise<void> {
    const document = await this.get(id);
    await this.db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
    await this.blobs?.delete(document.objectKey).catch((error: unknown) => {
      this.logger.warn('Could not delete a document file', { documentId: id, error });
    });
  }

  /**
   * Passages matching any word of the query, best first. With a department, only its documents and the
   * shared ones are searched.
   */
  async search(query: string, options: { departmentId?: string; limit: number }): Promise<KnowledgeHit[]> {
    const words = searchQuery(query);
    if (!words) return [];
    // Postgres tokenises the words like the indexed text; any of them may match (more rank higher).
    const tsquery = sql`replace(plainto_tsquery('simple', ${words})::text, ' & ', ' | ')::tsquery`;
    const score = sql<number>`ts_rank_cd(${knowledgeChunks.search}, ${tsquery})`.mapWith(Number);
    return this.db
      .select({
        documentId: knowledgeChunks.documentId,
        title: knowledgeDocuments.title,
        departmentId: knowledgeDocuments.departmentId,
        passage: knowledgeChunks.seq,
        content: knowledgeChunks.content,
        score,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .where(
        and(
          sql`${knowledgeChunks.search} @@ ${tsquery}`,
          options.departmentId
            ? or(
                isNull(knowledgeDocuments.departmentId),
                eq(knowledgeDocuments.departmentId, options.departmentId),
              )
            : undefined,
        ),
      )
      .orderBy(desc(score), knowledgeChunks.documentId, knowledgeChunks.seq)
      .limit(options.limit);
  }

  private storage(): BlobStore {
    if (!this.blobs) {
      throw new ApiError(503, 'storage_not_configured', 'Document storage is not configured (S3_* settings)');
    }
    return this.blobs;
  }
}
