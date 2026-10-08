import { describe, expect, it } from 'vitest';
import { virtualKey } from '../../src/modules/browser/keys';

describe("a live view's keys", () => {
  it('name the keys that type nothing', () => {
    expect(virtualKey('Enter', 'Enter')).toBe(13);
    expect(virtualKey('Backspace', 'Backspace')).toBe(8);
    expect(virtualKey('ArrowLeft', 'ArrowLeft')).toBe(37);
    expect(virtualKey(' ', 'Space')).toBe(32);
  });

  it('give letters and digits the code of what they are on the layout in use', () => {
    // US: the A key types "a".
    expect(virtualKey('a', 'KeyA')).toBe(65);
    expect(virtualKey('A', 'KeyA')).toBe(65);
    // AZERTY: the key in the Q place types "a", so Ctrl with it selects all; QWERTZ's Z undoes.
    expect(virtualKey('a', 'KeyQ')).toBe(65);
    expect(virtualKey('q', 'KeyA')).toBe(81);
    expect(virtualKey('z', 'KeyY')).toBe(90);
    expect(virtualKey('1', 'Digit1')).toBe(49);
    expect(virtualKey('z')).toBe(90);
  });

  it('fall back to the key’s place on a layout without Latin letters', () => {
    // Cyrillic: Ctrl with the key in the A place selects all, as on Windows.
    expect(virtualKey('ф', 'KeyA')).toBe(65);
    // AltGr+à on AZERTY types "@" with the 0 key.
    expect(virtualKey('@', 'Digit0')).toBe(48);
  });

  it('leave other keys to Chromium', () => {
    expect(virtualKey('é', 'Quote')).toBeUndefined();
    expect(virtualKey('Shift', 'ShiftLeft')).toBeUndefined();
    expect(virtualKey(undefined, undefined)).toBeUndefined();
    // Names an object has of its own aren't keys.
    expect(virtualKey('constructor')).toBeUndefined();
    expect(virtualKey('__proto__')).toBeUndefined();
  });
});
