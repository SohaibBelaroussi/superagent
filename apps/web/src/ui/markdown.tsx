import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/cn';

/** A web address, or nothing: agents' links are clickable only when they point at a website. */
export function webUrl(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const components: Components = {
  // Links open in a new tab and send no referrer. Anything but http(s) (mailto:, relative paths that
  // would point into this app) stays plain text.
  a: ({ node: _node, href, children, ...props }) => {
    const url = webUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a {...props} href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // The CSP loads images from this origin only, so an agent's image would show broken: link to it instead.
  img: ({ src, alt }) => {
    const url = webUrl(src);
    const label = alt?.trim() || 'Image';
    if (!url) return <span>[{label}]</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        [{label}]
      </a>
    );
  },
};

/**
 * Markdown from agents and the owner. Raw HTML is dropped (`skipHtml`), and link targets go through
 * react-markdown's URL filter, which refuses `javascript:` and other unsafe protocols, then through ours.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
