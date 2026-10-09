import { describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { HttpResponse, http } from 'msw';
import { AppState, type AppStateStatus } from 'react-native';
import { api, event, liveStream, server, signedIn, signedInHandlers, task } from './msw';
import { renderApp } from './render';

describe('live updates', () => {
  it('show a task made elsewhere without a refresh', async () => {
    signedIn();
    const tasks = [task({ phase: 'working', title: 'Already here' })];
    const live = liveStream();
    server.use(
      live.handler,
      http.get(api('/v1/board'), () =>
        HttpResponse.json({
          columns: ['inbox', 'queued', 'working', 'waiting', 'review', 'done', 'failed', 'cancelled'].map(
            (phase) => ({ phase, tasks: tasks.filter((item) => item.phase === phase) }),
          ),
        }),
      ),
      ...signedInHandlers({ tasks }),
    );
    await renderApp('/');
    expect(await screen.findByText(/Already here/)).toBeOnTheScreen();
    await waitFor(() => expect(live.connections).toHaveLength(1));

    const made = task({ phase: 'queued', title: 'Made on the web' });
    tasks.push(made);
    live.connections[0]?.send('id: 5\nevent: ready\ndata: {"lastEventId":5}\n\n');
    live.connections[0]?.send(
      `id: 6\nevent: task\ndata: ${JSON.stringify(event({ type: 'created', taskId: made.id, taskNumber: made.number }))}\n\n`,
    );
    expect(await screen.findByText(/Made on the web/)).toBeOnTheScreen();
  });

  it('close in the background and resume from the last event when the app comes back', async () => {
    signedIn();
    const listeners: Array<(state: AppStateStatus) => void> = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'change') listeners.push(listener as (state: AppStateStatus) => void);
      return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
    });
    const live = liveStream();
    server.use(live.handler, ...signedInHandlers());
    // Settings shows the connection's state.
    await renderApp('/settings');
    await waitFor(() => expect(live.connections).toHaveLength(1));
    live.connections[0]?.send('id: 41\nevent: ready\ndata: {"lastEventId":41}\n\n');
    expect(await screen.findByText('Live')).toBeOnTheScreen();

    await act(async () => {
      for (const listener of listeners) listener('background');
    });
    await waitFor(() => expect(live.connections[0]?.closed).toBe(true));

    await act(async () => {
      for (const listener of listeners) listener('active');
    });
    await waitFor(() => expect(live.connections).toHaveLength(2));
    expect(live.connections[1]?.lastEventId).toBe('41');
    spy.mockRestore();
  });
});
