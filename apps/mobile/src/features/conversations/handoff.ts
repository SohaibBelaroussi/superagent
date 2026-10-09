import { randomId } from '@superagent/client';

/*
 * Home's quick ask hands its words to the chief's screen in memory, never in the route: the route
 * carries only a one-time id, so a link (`superagent://chief?...`) can't make the app send anything.
 */

const waiting = new Map<string, string>();

/** Keeps `text` for the chief's screen, and returns the id to pass it. */
export function handOff(text: string): string {
  const id = randomId();
  waiting.set(id, text);
  return id;
}

/** The text handed off under `id`, once: null if there's none (a link made it up, or it was taken). */
export function takeHandoff(id: string): string | null {
  const text = waiting.get(id) ?? null;
  waiting.delete(id);
  return text;
}
