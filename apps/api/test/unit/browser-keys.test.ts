import { describe, expect, it } from 'vitest';
import { virtualKey } from '../../src/modules/browser/keys';

describe("a live view's keys", () => {
  it('name the keys that type nothing', () => {
    expect(virtualKey('Enter', 'Enter')).toBe(13);
    expect(virtualKey('Backspace', 'Backspace')).toBe(8);
    expect(virtualKey('ArrowLeft', 'ArrowLeft')).toBe(37);
    expect(virtualKey(' ', 'Space')).toBe(32);
  });

  it('give letters and digits the code a shortcut needs, by their place on the keyboard', () => {
    // Ctrl+A on any layout: the key in the A place.
    expect(virtualKey('a', 'KeyA')).toBe(65);
    expect(virtualKey('A', 'KeyA')).toBe(65);
    expect(virtualKey('q', 'KeyA')).toBe(65);
    expect(virtualKey('1', 'Digit1')).toBe(49);
    // Without a code: the character.
    expect(virtualKey('z')).toBe(90);
    expect(virtualKey('7')).toBe(55);
  });

  it('leave other keys to Chromium', () => {
    expect(virtualKey('é', 'Quote')).toBeUndefined();
    expect(virtualKey('Shift', 'ShiftLeft')).toBeUndefined();
    expect(virtualKey(undefined, undefined)).toBeUndefined();
  });
});
