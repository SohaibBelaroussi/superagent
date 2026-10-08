import type { ConversationMessage, LiveEvent } from '@superagent/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ada, api, research, server, signedInHandlers, task } from './msw';
import { renderApp } from './render';

/** A live stream the test writes to, event by event. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  return {
    response: () => {
      opened();
      return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    open,
    send: (event: LiveEvent) =>
      controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)),
  };
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const owner = (id: string, text: string, minutesAgo = 10): ConversationMessage => ({
  id,
  createdAt: at(minutesAgo),
  role: 'owner',
  author: null,
  parts: [{ type: 'text', text }],
  report: null,
});
const chief = (id: string, parts: ConversationMessage['parts'], minutesAgo = 9): ConversationMessage => ({
  id,
  createdAt: at(minutesAgo),
  role: 'agent',
  author: 'chief',
  parts,
  report: null,
});

describe('the chief of staff', () => {
  it('shows the conversation: your words, its tools in words, and reports linked to their tasks', async () => {
    const proofread = task({ title: 'Proofread the post', phase: 'review' });
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/chief/messages'), () =>
        HttpResponse.json({
          items: [
            owner('o1', 'Get the launch post proofread'),
            chief('a1', [
              {
                type: 'tool',
                callId: 'c1',
                tool: 'create_task',
                delegate: null,
                args: { department: 'writing', title: 'Proofread the post' },
                status: 'done',
                result: { task: `#${proofread.number}` },
                error: null,
              },
              { type: 'text', text: 'I asked **Writing** to do it.' },
            ]),
            {
              id: 'r1',
              createdAt: at(2),
              role: 'report',
              author: null,
              parts: [
                { type: 'text', text: `#${proofread.number} Proofread the post: Done, with a new title.` },
              ],
              report: {
                kind: 'task-done',
                source: 'dept:research',
                priority: 'medium',
                taskId: proofread.id,
                taskNumber: proofread.number,
                taskTitle: proofread.title,
              },
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get(api('/v1/chief/stream'), () => liveStream().response()),
    );
    renderApp('/chief');

    expect(await screen.findByText('Get the launch post proofread')).toBeVisible();
    expect(screen.getByText(`Created task #${proofread.number}: Proofread the post`)).toBeVisible();
    expect(screen.getByText('Writing').tagName).toBe('STRONG');
    const card = screen.getByRole('article', { name: `Report on #${proofread.number}` });
    expect(within(card).getByText('Done')).toBeVisible();
    expect(within(card).getByText(research.name)).toBeVisible();
    expect(
      within(card).getByRole('link', { name: `#${proofread.number} Proofread the post` }),
    ).toHaveAttribute('href', `/tasks/${proofread.id}`);
    expect(document.title).toBe('Chief of staff · superagent');
  });

  it('streams its answer to your message, then keeps it once', async () => {
    const stream = liveStream();
    const history = { items: [] as ConversationMessage[] };
    const sent: unknown[] = [];
    const stops: number[] = [];
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/chief/messages'), () =>
        HttpResponse.json({ items: history.items, nextCursor: null }),
      ),
      http.get(api('/v1/chief/stream'), () => stream.response()),
      http.post(api('/v1/chief/messages'), async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ delivery: 'started' }, { status: 202 });
      }),
      http.post(api('/v1/chief/stop'), () => {
        stops.push(1);
        return HttpResponse.json({ stopped: true });
      }),
    );
    renderApp('/chief');
    expect(await screen.findByText('What can I take off your plate?')).toBeVisible();
    await stream.open;
    stream.send({ type: 'ready', running: false });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message the chief of staff'), 'Draft the weekly update{Enter}');
    await waitFor(() => expect(sent).toEqual([{ message: 'Draft the weekly update' }]));
    expect(await screen.findByText('Sent')).toBeVisible();
    expect(screen.getByLabelText('Message the chief of staff')).toHaveValue('');

    // The turn streams in while the history doesn't have it yet.
    history.items = [owner('o1', 'Draft the weekly update', 0)];
    stream.send({ type: 'run-start', runId: 'run-1', agent: 'chief' });
    stream.send({ type: 'answer', runId: 'run-1', messageId: 'a1' });
    stream.send({ type: 'text', runId: 'run-1', id: 'text-1', delta: 'Asking Writing ' });
    stream.send({ type: 'text', runId: 'run-1', id: 'text-1', delta: 'now.' });
    expect(await screen.findByText('Asking Writing now.')).toBeVisible();
    expect(screen.getByText('Answering…')).toBeVisible();
    // Your message is in the history now: shown once, no longer pending.
    await waitFor(() => expect(screen.queryByText('Sent')).not.toBeInTheDocument());
    expect(screen.getAllByText('Draft the weekly update')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stops).toHaveLength(1));

    history.items = [...history.items, chief('a1', [{ type: 'text', text: 'Asking Writing now.' }], 0)];
    stream.send({ type: 'run-end', runId: 'run-1', outcome: 'finished', error: null, messageIds: ['a1'] });
    await waitFor(() => expect(screen.queryByText('Answering…')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Asking Writing now.')).toHaveLength(1));
  });

  it('says when a message didn’t go, and sends it again on retry', async () => {
    let attempts = 0;
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/chief/messages'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/chief/stream'), () => liveStream().response()),
      http.post(api('/v1/chief/messages'), () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Service Unavailable',
              status: 503,
              detail: 'The server is shutting down',
            },
            { status: 503, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return HttpResponse.json({ delivery: 'queued' }, { status: 202 });
      }),
    );
    renderApp('/chief');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Message the chief of staff'), 'Hello{Enter}');
    expect(await screen.findByText(/not sent: the server is shutting down/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Sends once the current answer is done')).toBeVisible();
    expect(screen.getAllByText('Hello')).toHaveLength(1);
  });

  it('opens with a message written on the home page', async () => {
    const sent: unknown[] = [];
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/chief/messages'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/chief/stream'), () => liveStream().response()),
      http.post(api('/v1/chief/messages'), async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ delivery: 'started' }, { status: 202 });
      }),
    );
    // StrictMode runs the page's effects twice, as development does: the message still goes once.
    const { router } = renderApp('/', { strict: true });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Ask your chief of staff'), 'What needs me today?{Enter}');
    expect(await screen.findByRole('heading', { name: 'Chief of staff' })).toBeVisible();
    await waitFor(() => expect(sent).toEqual([{ message: 'What needs me today?' }]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toHaveLength(1);
    expect(screen.getAllByText('What needs me today?')).toHaveLength(1);
    expect(router.state.location.state).toBeNull();
  });

  it('keeps the same words sent twice apart, each pending until its own copy is stored', async () => {
    const history = { items: [] as ConversationMessage[] };
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/chief/messages'), () =>
        HttpResponse.json({ items: history.items, nextCursor: null }),
      ),
      http.get(api('/v1/chief/stream'), () => liveStream().response()),
      http.post(api('/v1/chief/messages'), () => HttpResponse.json({ delivery: 'queued' }, { status: 202 })),
    );
    const { queryClient } = renderApp('/chief');
    const user = userEvent.setup();
    const box = await screen.findByLabelText('Message the chief of staff');
    await user.type(box, 'ok{Enter}');
    await user.type(box, 'ok{Enter}');
    await waitFor(() => expect(screen.getAllByText('Sends once the current answer is done')).toHaveLength(2));

    history.items = [owner('o1', 'ok', 0)];
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.getAllByText('Sends once the current answer is done')).toHaveLength(1));
    expect(screen.getAllByText('ok')).toHaveLength(2);

    history.items = [owner('o1', 'ok', 0), owner('o2', 'ok', 0)];
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(screen.queryByText('Sends once the current answer is done')).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText('ok')).toHaveLength(2);
  });

  it('shows a report that arrives while it waits, once', async () => {
    const stream = liveStream();
    const history = { items: [] as ConversationMessage[] };
    const done = task({ title: 'Proofread: the launch post', phase: 'review' });
    const report: ConversationMessage = {
      id: 'sig-1',
      createdAt: at(0),
      role: 'report',
      author: null,
      parts: [{ type: 'text', text: `#${done.number} Proofread: the launch post: Done.` }],
      report: {
        kind: 'task-done',
        source: 'dept:research',
        priority: 'medium',
        taskId: done.id,
        taskNumber: done.number,
        taskTitle: done.title,
      },
    };
    server.use(
      ...signedInHandlers(),
      http.get(api('/v1/chief/messages'), () =>
        HttpResponse.json({ items: history.items, nextCursor: null }),
      ),
      http.get(api('/v1/chief/stream'), () => stream.response()),
    );
    const { queryClient } = renderApp('/chief');
    await stream.open;
    stream.send({ type: 'ready', running: false });
    stream.send({ type: 'message', runId: 'quiet-1', message: report });
    // A title with ": " in it still links whole.
    expect(
      await screen.findByRole('link', { name: `#${done.number} Proofread: the launch post` }),
    ).toBeVisible();
    history.items = [report];
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(screen.getAllByRole('article', { name: `Report on #${done.number}` })).toHaveLength(1),
    );
  });
});

describe('a task’s transcript', () => {
  it('shows the brief, the lead’s work with its specialist’s answer, and your messages', async () => {
    const working = task({ title: 'Compare frameworks', phase: 'working' });
    server.use(
      ...signedInHandlers({ tasks: [working] }),
      http.get(api(`/v1/tasks/${working.id}`), () => HttpResponse.json(working)),
      http.get(api(`/v1/tasks/${working.id}/events`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${working.id}/artifacts`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${working.id}/transcript`), () =>
        HttpResponse.json({
          items: [
            {
              id: 'b1',
              createdAt: at(30),
              role: 'brief',
              author: null,
              parts: [{ type: 'text', text: 'Which framework fits a TypeScript stack?' }],
              report: null,
            },
            {
              id: 'l1',
              createdAt: at(29),
              role: 'agent',
              author: ada.key,
              parts: [
                {
                  type: 'tool',
                  callId: 'c1',
                  tool: 'update_task',
                  delegate: null,
                  args: { progress: 40 },
                  status: 'done',
                  result: { task: `#${working.number}` },
                  error: null,
                },
                {
                  type: 'tool',
                  callId: 'c2',
                  tool: 'agent-scout',
                  delegate: 'scout',
                  args: { prompt: 'Find three candidates with sources.' },
                  status: 'done',
                  result: 'Mastra, LangGraph and CrewAI.',
                  error: null,
                },
              ],
              report: null,
            },
            owner('o1', 'Add a source for each, please.', 5),
          ],
          nextCursor: null,
        }),
      ),
      http.get(api(`/v1/tasks/${working.id}/stream`), () => liveStream().response()),
    );
    renderApp(`/tasks/${working.id}?view=transcript`);

    const brief = await screen.findByRole('region', { name: 'Brief for Ada' });
    expect(within(brief).getByText('Brief for Ada')).toBeVisible();
    expect(screen.getByText('Updated the task (40%)')).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByText('Asked scout'));
    expect(screen.getByText('Find three candidates with sources.')).toBeVisible();
    expect(screen.getByText('Mastra, LangGraph and CrewAI.')).toBeVisible();
    expect(screen.getByText('Add a source for each, please.')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true');
  });

  it('follows a turn to its end when the task closes in the middle of it', async () => {
    const working = task({ title: 'Wrap up', phase: 'working' });
    const state = { task: working };
    const stream = liveStream();
    const transcript = { items: [] as ConversationMessage[] };
    const reporting = {
      type: 'tool' as const,
      callId: 'c1',
      tool: 'report_to_chief',
      delegate: null,
      args: { outcome: 'done' },
      status: 'pending' as const,
      error: null,
    };
    server.use(
      ...signedInHandlers({ tasks: [working] }),
      http.get(api(`/v1/tasks/${working.id}`), () => HttpResponse.json(state.task)),
      http.get(api(`/v1/tasks/${working.id}/events`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${working.id}/artifacts`), () => HttpResponse.json({ items: [] })),
      http.get(api(`/v1/tasks/${working.id}/transcript`), () =>
        HttpResponse.json({ items: transcript.items, nextCursor: null }),
      ),
      http.get(api(`/v1/tasks/${working.id}/stream`), () => stream.response()),
    );
    const { queryClient } = renderApp(`/tasks/${working.id}?view=transcript`);
    await stream.open;
    stream.send({ type: 'ready', running: true });
    stream.send({ type: 'run-start', runId: 'r1', agent: ada.key });
    stream.send({ type: 'tool', runId: 'r1', part: reporting });
    expect(await screen.findByText('Reported it done…')).toBeVisible();

    // The report closes the task (its department closes tasks itself) while the turn goes on.
    state.task = { ...working, phase: 'done', closedAt: new Date().toISOString() };
    await queryClient.invalidateQueries({ queryKey: ['task', working.id] });
    expect(await screen.findByText(/this task is closed/i)).toBeVisible();

    // Still followed: the end of the turn arrives, and the history with it.
    transcript.items = [
      {
        id: 'a1',
        createdAt: at(0),
        role: 'agent',
        author: ada.key,
        parts: [
          { ...reporting, status: 'done', result: { reported: true } },
          { type: 'text', text: 'All done.' },
        ],
        report: null,
      },
    ];
    stream.send({
      type: 'tool',
      runId: 'r1',
      part: { ...reporting, status: 'done', result: { reported: true } },
    });
    stream.send({ type: 'text', runId: 'r1', id: 'text-1', delta: 'All done.' });
    stream.send({ type: 'run-end', runId: 'r1', outcome: 'finished', error: null, messageIds: ['a1'] });
    expect(await screen.findByText('All done.')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Reported it done…')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('All done.')).toHaveLength(1));
    expect(screen.getAllByText('Reported it done')).toHaveLength(1);
  });
});
