import { useEffect } from 'react';

/** The tab's title for this page: "Board · superagent". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · superagent` : 'superagent';
  }, [title]);
}
