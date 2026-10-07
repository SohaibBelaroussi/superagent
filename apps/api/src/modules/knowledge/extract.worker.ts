// Reads an uploaded document's text in a worker thread, so a hostile or huge file can only exhaust
// the worker (the caller sets a memory limit and a timeout), never the API. Self-contained on purpose:
// no imports from the app, so Node runs it straight from source (type stripping) and from the bundle.
import { parentPort, workerData } from 'node:worker_threads';
import { decodeHTML } from 'entities';
import { getDocumentProxy } from 'unpdf';

export interface ExtractRequest {
  body: Uint8Array;
  type: string;
  maxChars: number;
  maxPages: number;
}

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; code: 'too_large' | 'unreadable'; message: string };

const BLOCK_TAGS = ['script', 'style', 'noscript', 'template'];

/** UTF-8 unless a byte-order mark says UTF-16 (Notepad "Unicode", PowerShell 5.1 Out-File). */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}

/** Drops script, style, noscript and template elements in one linear pass (an unclosed one ends the text). */
function stripBlocks(html: string): string {
  const lower = html.toLowerCase();
  const next = new Map<string, number>();
  const find = (tag: string, from: number) => {
    let at = next.get(tag) ?? -2;
    if (at !== -1 && at < from) {
      at = lower.indexOf(`<${tag}`, from);
      next.set(tag, at);
    }
    return at;
  };
  let out = '';
  let i = 0;
  for (;;) {
    let tag: string | undefined;
    let start = -1;
    for (const candidate of BLOCK_TAGS) {
      const at = find(candidate, i);
      if (at >= 0 && (start < 0 || at < start)) {
        start = at;
        tag = candidate;
      }
    }
    if (!tag) return out + html.slice(i);
    out += `${html.slice(i, start)} `;
    const close = lower.indexOf(`</${tag}`, start);
    if (close < 0) return out;
    const end = lower.indexOf('>', close);
    i = end < 0 ? html.length : end + 1;
  }
}

function htmlToText(html: string): string {
  // [^<>] keeps the tag pattern linear on input full of "<" without ">".
  const text = stripBlocks(html)
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^<>]*>/g, ' ');
  return decodeHTML(text);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Postgres text can't hold NUL; other control characters are noise. NFC so accents match queries. */
function finish(text: string, maxChars: number): ExtractResult {
  const clean = text.replace(CONTROL_CHARACTERS, ' ').normalize('NFC');
  if (clean.length > maxChars) {
    return {
      ok: false,
      code: 'too_large',
      message: `The document has more than ${maxChars} characters of text`,
    };
  }
  return { ok: true, text: clean };
}

async function pdfText(bytes: Uint8Array, maxChars: number, maxPages: number): Promise<ExtractResult> {
  const pdf = await getDocumentProxy(bytes);
  try {
    if (pdf.numPages > maxPages) {
      return {
        ok: false,
        code: 'too_large',
        message: `PDFs are limited to ${maxPages} pages (this one has ${pdf.numPages})`,
      };
    }
    const pages: string[] = [];
    let total = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      page.cleanup();
      pages.push(text);
      total += text.length;
      if (total > maxChars) {
        return {
          ok: false,
          code: 'too_large',
          message: `The document has more than ${maxChars} characters of text`,
        };
      }
    }
    return { ok: true, text: pages.join('\n\n') };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function extract(request: ExtractRequest): Promise<ExtractResult> {
  try {
    if (request.type === 'application/pdf') {
      const result = await pdfText(request.body, request.maxChars, request.maxPages);
      return result.ok ? finish(result.text, request.maxChars) : result;
    }
    const text = decodeText(request.body);
    return finish(request.type === 'text/html' ? htmlToText(text) : text, request.maxChars);
  } catch (error) {
    return { ok: false, code: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort) parentPort.postMessage(await extract(workerData as ExtractRequest));
