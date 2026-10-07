import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
};
const ALIASES: Record<string, string> = {
  'text/x-markdown': 'text/markdown',
  'application/x-pdf': 'application/pdf',
};

/** The document's media type, or undefined when we can't read it. Generic uploads go by extension. */
export function documentType(filename: string, declared?: string): string | undefined {
  const type = declared?.split(';')[0]?.trim().toLowerCase();
  const known = type ? (ALIASES[type] ?? type) : undefined;
  if (known && (TEXT_TYPES.has(known) || known === 'text/html' || known === 'application/pdf')) return known;
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[extension];
}

/** Plain text of a document of a type `documentType` accepted. */
export async function extractText(body: Uint8Array, type: string): Promise<string> {
  if (type === 'application/pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(body));
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return text;
  }
  const decoded = new TextDecoder('utf-8').decode(body);
  return type === 'text/html' ? htmlToText(decoded) : decoded;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
}

/**
 * Splits text into passages of about `size` characters, on paragraph and then sentence boundaries.
 * Each passage starts with the end of the previous one (`overlap`), so a fact cut in two is still found.
 */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];
  const pieces = clean
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= size ? [p] : splitLong(p, size)));
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      const fromWord = tail.indexOf(' ');
      current = `${fromWord >= 0 ? tail.slice(fromWord + 1) : tail}\n\n${piece}`;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, size: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const sentence of paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph]) {
    if (sentence.length > size) {
      if (current.trim()) out.push(current.trim());
      current = '';
      for (let i = 0; i < sentence.length; i += size) out.push(sentence.slice(i, i + size).trim());
    } else if (current.length + sentence.length > size) {
      out.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** Common words that would match nearly every passage (English and French). */
const STOPWORDS = new Set(
  (
    'a an and are as at be but by do does for from has have how i if in into is it its me my of on or our so that ' +
    'the their them then there these they this to was we were what when where which who why will with you your ' +
    'au aux avec ce ces dans de des du elle en est et il je la le les leur mais ne nous on ou par pas pour qui que ' +
    'quoi sa se ses son sur ta te tu un une vos votre vous'
  ).split(' '),
);

/** The words of a search, for a full-text query in which any word may match (more matches rank higher). */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w)))].slice(0, 32);
}
