// Stand-in for SearXNG (GET /search?format=json) and Crawl4AI (POST /md) on one port.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeWeb {
  url: string;
  searches: string[];
  fetches: Array<{ url: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

export async function startFakeWeb(): Promise<FakeWeb> {
  const searches: string[] = [];
  const fetches: FakeWeb['fetches'] = [];

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && url.pathname === '/search') {
      const query = url.searchParams.get('q') ?? '';
      searches.push(query);
      return send(200, {
        query,
        results: [
          {
            title: 'Mastra docs',
            url: 'https://mastra.ai/docs',
            content: 'Mastra is a TypeScript agent framework.',
            engine: 'fake',
          },
          {
            title: 'Mastra on GitHub',
            url: 'https://github.com/mastra-ai/mastra',
            content: 'Source code.',
            engine: 'fake',
          },
          { title: 'No URL result', content: 'should be dropped' },
        ],
      });
    }

    if (req.method === 'POST' && url.pathname === '/md') {
      const body = JSON.parse(raw || '{}') as { url?: string };
      fetches.push({ url: body.url ?? '', authorization: req.headers.authorization });
      return send(200, {
        url: body.url,
        filter: 'fit',
        markdown: `# Fetched\n\nContent of ${body.url}`,
        success: true,
      });
    }

    send(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    searches,
    fetches,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
