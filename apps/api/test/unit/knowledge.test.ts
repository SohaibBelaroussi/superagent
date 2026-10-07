import { describe, expect, it } from 'vitest';
import {
  chunkText,
  DEFAULT_EXTRACT_LIMITS,
  documentType,
  ExtractError,
  extractText,
  searchQuery,
} from '../../src/modules/knowledge/text';
import { minimalPdf } from '../support/pdf';

const encode = (s: string) => new TextEncoder().encode(s);

describe('knowledge text', () => {
  it('works out the document type from the upload or the file name', () => {
    expect(documentType('notes.txt', 'text/plain; charset=utf-8')).toBe('text/plain');
    expect(documentType('notes.md', 'application/octet-stream')).toBe('text/markdown');
    expect(documentType('page.HTM', '')).toBe('text/html');
    expect(documentType('report', 'application/x-pdf')).toBe('application/pdf');
    expect(documentType('data.csv', undefined)).toBe('text/csv');
    expect(documentType('program.exe', 'application/octet-stream')).toBeUndefined();
    expect(documentType('photo.png', 'image/png')).toBeUndefined();
  });

  it('extracts text from plain text, HTML and PDF in a worker', async () => {
    expect(await extractText(encode('Plain text: café.'), 'text/plain')).toBe('Plain text: café.');

    const html = await extractText(
      encode(
        '<html><head><style>p{}</style><script>alert(1)</script></head>' +
          '<body><h1>Title</h1><p>Fish &amp; chips&nbsp;cost &lt;10&gt;, r&eacute;tention d&#233;finie.</p></body></html>',
      ),
      'text/html',
    );
    expect(html).toContain('Title');
    expect(html).toContain('Fish & chips cost <10>, rétention définie.');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('p{}');

    expect(await extractText(minimalPdf('Retention is ninety days'), 'application/pdf')).toContain(
      'Retention is ninety days',
    );
  });

  it('reads UTF-16 files and drops characters Postgres text cannot hold', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Résumé du projet', 'utf16le')]);
    expect(await extractText(utf16, 'text/plain')).toBe('Résumé du projet');
    expect(await extractText(encode('before\u0000after\u0007!'), 'text/plain')).toBe('before after !');
    // Decomposed accents are composed, so they match what people type.
    expect(await extractText(encode('café crème'), 'text/plain')).toBe('café crème');
  });

  it('handles pathological HTML in linear time', async () => {
    const started = Date.now();
    const text = await extractText(encode('<'.repeat(1_000_000)), 'text/html');
    expect(text.length).toBe(1_000_000);
    const unclosed = await extractText(encode(`Before <script ${'x'.repeat(500_000)}`), 'text/html');
    expect(unclosed.trim()).toBe('Before');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses PDFs past the page limit and gives up on slow documents', async () => {
    const limits = { ...DEFAULT_EXTRACT_LIMITS, maxPages: 3 };
    await expect(extractText(minimalPdf('page', 4), 'application/pdf', limits)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(await extractText(minimalPdf('page', 3), 'application/pdf', limits)).toContain('page');

    const tooMuch = { ...DEFAULT_EXTRACT_LIMITS, maxChars: 10 };
    await expect(
      extractText(encode('more than ten characters'), 'text/plain', tooMuch),
    ).rejects.toMatchObject({
      code: 'too_large',
    });

    const impatient = { ...DEFAULT_EXTRACT_LIMITS, timeoutMs: 1 };
    const slow = extractText(minimalPdf('page', 50), 'application/pdf', impatient);
    await expect(slow).rejects.toBeInstanceOf(ExtractError);
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });
  });

  it('splits long text into overlapping passages on natural boundaries', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('One short paragraph.')).toEqual(['One short paragraph.']);

    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(40).trim()}.`);
    const chunks = chunkText(paragraphs.join('\n\n'), 600, 80);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(600 + 80);
    // Every paragraph made it into some passage, and passages overlap.
    for (let i = 0; i < 12; i++) expect(chunks.some((c) => c.includes(`Paragraph ${i}:`))).toBe(true);
    expect(chunks[1]?.startsWith('Paragraph')).toBe(false);

    const oneLongParagraph = 'This sentence is long enough. '.repeat(200);
    const split = chunkText(oneLongParagraph, 500, 50);
    expect(split.length).toBeGreaterThan(10);
    expect(split.every((c) => c.length <= 550)).toBe(true);
  });

  it('keeps the words of a search whole and drops common ones', () => {
    expect(searchQuery('How long are Customer records kept?')).toBe('long Customer records kept?');
    expect(searchQuery('mail support@acme.io about v2.4.1 of report_q3.pdf')).toBe(
      'mail support@acme.io about v2.4.1 report_q3.pdf',
    );
    expect(searchQuery('हिन्दी भाषा')).toBe('हिन्दी भाषा');
    expect(searchQuery('café')).toBe('café');
    expect(searchQuery('a I ? the of')).toBe('');
  });
});
