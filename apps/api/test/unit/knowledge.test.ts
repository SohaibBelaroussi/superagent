import { describe, expect, it } from 'vitest';
import { chunkText, documentType, extractText, searchTerms } from '../../src/modules/knowledge/text';

/** A one-page PDF showing `text` (ASCII only, so byte offsets equal string offsets). */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

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

  it('extracts text from plain text, HTML and PDF', async () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(await extractText(encode('Plain text: café.'), 'text/plain')).toBe('Plain text: café.');

    const html = await extractText(
      encode(
        '<html><head><style>p{}</style><script>alert(1)</script></head>' +
          '<body><h1>Title</h1><p>Fish &amp; chips&nbsp;cost &lt;10&gt;.</p></body></html>',
      ),
      'text/html',
    );
    expect(html).toContain('Title');
    expect(html).toContain('Fish & chips cost <10>.');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('p{}');

    expect(await extractText(minimalPdf('Retention is ninety days'), 'application/pdf')).toContain(
      'Retention is ninety days',
    );
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

  it('turns a question into search words', () => {
    expect(searchTerms('How long are Customer records kept?')).toEqual([
      'long',
      'customer',
      'records',
      'kept',
    ]);
    expect(searchTerms('Quelle est la durée de rétention des données ?')).toEqual([
      'quelle',
      'durée',
      'rétention',
      'données',
    ]);
    expect(searchTerms('a I ? the of')).toEqual([]);
    expect(searchTerms('retention retention RETENTION')).toEqual(['retention']);
  });
});
