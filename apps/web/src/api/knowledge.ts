import { api, apiVoid, queryKeys } from '@superagent/client';
import {
  KnowledgeDocumentListSchema,
  KnowledgeDocumentSchema,
  KnowledgeSearchResultSchema,
} from '@superagent/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** The server's limit on one upload. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** What the server reads: text, markdown, CSV, JSON, HTML and PDF. */
export const UPLOAD_ACCEPT =
  '.txt,.text,.md,.markdown,.csv,.json,.html,.htm,.pdf,text/plain,text/markdown,text/csv,application/json,text/html,application/pdf';

/** Every uploaded document, newest first. */
export function useDocuments() {
  return useQuery({
    queryKey: queryKeys.knowledge,
    queryFn: ({ signal }) => api(KnowledgeDocumentListSchema, '/v1/knowledge', { signal }),
    select: (data) => data.items,
  });
}

export interface UploadInput {
  file: File;
  title?: string;
  /** Only this department searches it; shared with all when absent. */
  departmentId?: string;
}

/** Uploads one document: stored, its text read and split into passages agents search. */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, title, departmentId }: UploadInput) => {
      // A form body: the browser sets the multipart boundary and the length the server asks for.
      const form = new FormData();
      form.set('file', file, file.name);
      if (title?.trim()) form.set('title', title.trim());
      if (departmentId) form.set('departmentId', departmentId);
      return api(KnowledgeDocumentSchema, '/v1/knowledge', { method: 'POST', body: form });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.knowledge }),
    meta: { silent: true },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(`/v1/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.knowledge }),
    meta: { failure: 'Couldn’t delete the document' },
  });
}

/** What `knowledge_search` finds for `query`: the best passages first. Nothing while the query is empty. */
export function useKnowledgeSearch(query: string, departmentId?: string) {
  // The server takes up to 400 characters.
  const q = query.trim().slice(0, 400);
  return useQuery({
    queryKey: [...queryKeys.knowledge, 'search', q, departmentId ?? 'all'],
    queryFn: ({ signal }) =>
      api(KnowledgeSearchResultSchema, '/v1/knowledge/search', {
        signal,
        query: { q, departmentId, limit: 20 },
      }),
    select: (data) => data.items,
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
}
