import { describe, expect, it } from 'vitest';
import { formatCost, formatDuration, formatList, formatRelative, formatTokens, plural } from '../src/format';
import { departmentTone } from '../src/tones';

describe('formatCost', () => {
  it('keeps small costs readable and large ones round', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.00004)).toBe('<$0.0001');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.04321)).toBe('$0.04');
    expect(formatCost(12.5)).toBe('$12.50');
    expect(formatCost(1234.4)).toBe('$1,234');
  });
});

describe('formatTokens', () => {
  it('is compact', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.23k');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(1_250_000)).toBe('1.25M');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('says how long ago, then the date', () => {
    expect(formatRelative(ago(10_000), now)).toBe('just now');
    expect(formatRelative(ago(5 * 60_000), now)).toBe('5m ago');
    expect(formatRelative(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(formatRelative(ago(2 * 86_400_000), now)).toBe('2d ago');
    expect(formatRelative(ago(30 * 86_400_000), now)).toBe('Sep 8');
    expect(formatRelative('2025-01-02T12:00:00Z', now)).toBe('Jan 2, 2025');
  });
  it('says how far ahead', () => {
    expect(formatRelative(new Date(now + 3 * 3_600_000).toISOString(), now)).toBe('in 3h');
  });
});

describe('the rest', () => {
  it('formats durations, lists and counts', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(formatDuration(2 * 86_400_000)).toBe('2d');
    expect(formatList(['a', 'b', 'c'])).toBe('a, b and c');
    expect(plural(1, 'task')).toBe('1 task');
    expect(plural(3, 'thing needs you', 'things need you')).toBe('3 things need you');
  });

  it('gives a department the same colour every time', () => {
    expect(departmentTone('research')).toBe(departmentTone('research'));
    expect(
      new Set(['research', 'writing', 'operations', 'finance', 'sales'].map(departmentTone)).size,
    ).toBeGreaterThan(1);
  });
});
