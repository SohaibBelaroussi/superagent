import { describe, expect, it } from '@jest/globals';
import type { ConversationMessage, LiveEvent, ToolCallPart } from '@superagent/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { api, liveStream, server, signedIn, signedInHandlers, task } from './msw';
import { renderApp } from './render';

let counter = 0;
const at = () => new Date(Date.UTC(2026, 9, 9, 10, 0, counter++)).toISOString();

const yours = (text: string): ConversationMessage => ({
  id: `owner-${counter}`,
  createdAt: at(),
  role: 'owner',
  author: null,
  parts: [{ type: 'text', text }],
  report: null,
});
const said = (id: string, text: string, author = 'chief'): ConversationMessage => ({
  id,
  createdAt: at(),
  role: 'agent',
  author,
  parts: [{ type: 'text', text }],
  report: null,
});
const frame = (event: LiveEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** The chief's side of the server: its history (which the test grows) and what you send it. */
function chief(history: ConversationMessage[], delivery: 'started' | 'queued' = 'started') {
  const sent: string[] = [];
  const stops: number[] = [];
  const live = liveStream('/v1/chief/stream');
  return {
    sent,
    stops,
    live,
    handlers: [
      live.handler,
      http.get(api('/v1/chief/messages'), () => HttpResponse.json({ items: history, nextCursor: null })),
      http.post(api('/v1/chief/messages'), async ({ request }) => {
        const { message } = (await request.json()) as { message: string };
        sent.push(message);
        history.push(yours(message));
        return HttpResponse.json({ delivery }, { status: 202 });
      }),
      http.post(api('/v1/chief/stop'), () => {
        stops.push(Date.now());
        return HttpResponse.json({ stopped: true });
      }),
    ],
  };
}

describe('the chief of staff', () => {
  it('streams its answer in, then shows the stored one once, without a repeat', async () => {
    signedIn();
    const history: ConversationMessage[] = [];
    const { sent, live, handlers } = chief(history);
    server.use(...handlers, ...signedInHandlers());
    await renderApp('/chief');

    expect(await screen.findByText('What can I take off your plate?')).toBeOnTheScreen();
    await waitFor(() => expect(live.connections).toHaveLength(1));
    live.connections[0]?.send(frame({ type: 'ready', running: false }));
    expect(await screen.findByText('Routes your work to the departments')).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByLabelText('Message the chief of staff'), 'What’s on the board?');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent).toEqual(['What’s on the board?']));
    expect(await screen.findByText('What’s on the board?')).toBeOnTheScreen();

    // The answer streams in…
    live.connections[0]?.send(frame({ type: 'run-start', runId: 'r1', agent: 'chief' }));
    live.connections[0]?.send(frame({ type: 'text', runId: 'r1', id: 't1', delta: 'Two tasks ' }));
    live.connections[0]?.send(frame({ type: 'text', runId: 'r1', id: 't1', delta: 'are running.' }));
    expect(await screen.findByText('Two tasks are running.')).toBeOnTheScreen();
    expect(screen.getByText('Answering…')).toBeOnTheScreen();

    // …and gives way to the stored answer: once on screen, never twice.
    history.push(said('a1', 'Two tasks are running.'));
    live.connections[0]?.send(
      frame({ type: 'run-end', runId: 'r1', outcome: 'finished', error: null, messageIds: ['a1'] }),
    );
    await waitFor(() => expect(screen.getByText('Routes your work to the departments')).toBeOnTheScreen());
    await waitFor(() => expect(screen.getAllByText('Two tasks are running.')).toHaveLength(1));
    expect(screen.getAllByText('What’s on the board?')).toHaveLength(1);
  });

  it('holds a message written while it answers until that answer is done, and can stop it', async () => {
    signedIn();
    const history: ConversationMessage[] = [yours('Plan my week'), said('a0', 'On it.')];
    const { sent, stops, live, handlers } = chief(history, 'queued');
    server.use(...handlers, ...signedInHandlers());
    await renderApp('/chief');

    await waitFor(() => expect(live.connections).toHaveLength(1));
    live.connections[0]?.send(frame({ type: 'ready', running: true }));
    live.connections[0]?.send(frame({ type: 'run-start', runId: 'r2', agent: 'chief' }));
    expect(await screen.findByText('Answering…')).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByLabelText('Message the chief of staff'), 'Also book a call');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sends once the current answer is done')).toBeOnTheScreen();
    expect(sent).toEqual(['Also book a call']);

    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stops).toHaveLength(1));
  });

  it('takes a question from home and opens with it sent', async () => {
    signedIn();
    const history: ConversationMessage[] = [];
    const { sent, handlers } = chief(history);
    server.use(...handlers, ...signedInHandlers());
    await renderApp('/');

    await fireEvent.changeText(await screen.findByLabelText('Ask your chief of staff'), 'Anything urgent?');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(sent).toEqual(['Anything urgent?']));
    expect(await screen.findByText('Anything urgent?')).toBeOnTheScreen();
  });
});

describe('a task’s transcript', () => {
  it('shows the brief the lead got and what it did, its tools in words', async () => {
    signedIn();
    const working = task({ phase: 'working', title: 'Find the papers' });
    const search: ToolCallPart = {
      type: 'tool',
      callId: 'c1',
      tool: 'web_search',
      delegate: null,
      args: { query: 'agent memory' },
      status: 'done',
      result: { results: 3 },
      error: null,
    };
    const transcript: ConversationMessage[] = [
      {
        id: 'brief-1',
        createdAt: at(),
        role: 'brief',
        author: null,
        parts: [{ type: 'text', text: 'Find three recent papers on agent memory.' }],
        report: null,
      },
      {
        ...said('m1', 'Found three.', 'research-lead'),
        parts: [search, { type: 'text', text: 'Found three.' }],
      },
    ];
    const live = liveStream(`/v1/tasks/${working.id}/stream`);
    server.use(
      live.handler,
      http.get(api('/v1/tasks/:id/transcript'), () =>
        HttpResponse.json({ items: transcript, nextCursor: null }),
      ),
      ...signedInHandlers({ tasks: [working] }),
    );
    await renderApp(`/tasks/${working.id}`);

    await fireEvent.press(await screen.findByRole('tab', { name: 'Transcript' }));
    expect(await screen.findByText('Find three recent papers on agent memory.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Brief for Ada')).toBeOnTheScreen();
    expect(screen.getByText('Found three.')).toBeOnTheScreen();

    // A tool call in words; its details a tap away.
    const row = screen.getByRole('button', { name: 'Searched the web for “agent memory”' });
    await fireEvent.press(row);
    expect(screen.getByText(/"query": "agent memory"/)).toBeOnTheScreen();
    // Live while the task is with its lead.
    await waitFor(() => expect(live.connections).toHaveLength(1));
  });
});
