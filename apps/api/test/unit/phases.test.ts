import { describe, expect, it } from 'vitest';
import { BOARD_PHASES, canTransition, OPEN_PHASES, TERMINAL_PHASES } from '../../src/modules/ledger/phases';

describe('task phases', () => {
  it('splits phases into open and closed, all on the board', () => {
    expect([...OPEN_PHASES, ...TERMINAL_PHASES]).toEqual(BOARD_PHASES);
  });

  it('lets the owner send work to the lead, accept it, reopen it and cancel it', () => {
    expect(canTransition('owner', 'inbox', 'queued')).toBe(true);
    expect(canTransition('owner', 'review', 'done')).toBe(true);
    expect(canTransition('owner', 'review', 'queued')).toBe(true);
    expect(canTransition('owner', 'waiting', 'queued')).toBe(true);
    expect(canTransition('owner', 'done', 'queued')).toBe(true);
    expect(canTransition('owner', 'failed', 'queued')).toBe(true);
    for (const phase of ['inbox', 'queued', 'working', 'waiting', 'review', 'failed'] as const) {
      expect(canTransition('owner', phase, 'cancelled'), phase).toBe(true);
    }
  });

  it("doesn't let the owner skip review or touch work in progress beyond cancelling", () => {
    expect(canTransition('owner', 'working', 'done')).toBe(false);
    expect(canTransition('owner', 'queued', 'queued')).toBe(false);
    expect(canTransition('owner', 'working', 'queued')).toBe(false);
    expect(canTransition('owner', 'done', 'done')).toBe(false);
    expect(canTransition('owner', 'done', 'cancelled')).toBe(false);
    expect(canTransition('owner', 'cancelled', 'cancelled')).toBe(false);
    expect(canTransition('owner', 'cancelled', 'queued')).toBe(false);
  });

  it('lets the lead report only while the task is with it', () => {
    for (const from of ['queued', 'working', 'waiting'] as const) {
      for (const to of ['working', 'waiting', 'review', 'done', 'failed'] as const) {
        expect(canTransition('lead', from, to), `${from} -> ${to}`).toBe(true);
      }
    }
    for (const from of ['inbox', 'review', 'done', 'failed', 'cancelled'] as const) {
      expect(canTransition('lead', from, 'working'), from).toBe(false);
      expect(canTransition('lead', from, 'review'), from).toBe(false);
    }
    expect(canTransition('lead', 'working', 'cancelled')).toBe(false);
    expect(canTransition('lead', 'working', 'queued')).toBe(false);
  });

  it('lets the server dispatch and flag stalled work, but never close it', () => {
    expect(canTransition('system', 'inbox', 'queued')).toBe(true);
    expect(canTransition('system', 'queued', 'waiting')).toBe(true);
    expect(canTransition('system', 'working', 'waiting')).toBe(true);
    for (const to of ['done', 'cancelled', 'review'] as const) {
      for (const from of OPEN_PHASES) {
        expect(canTransition('system', from, to), `${from} -> ${to}`).toBe(false);
      }
    }
    expect(canTransition('system', 'review', 'queued')).toBe(false);
  });
});
