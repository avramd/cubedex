import { describe, expect, it } from 'vitest';
import {
  normalizeTag, allTagsWithCounts, sortedTagsForDialog,
  applyTagFilter, pushRecentTagSet, tagFilterLabel,
  type TagFilter,
} from './tags';
import type { SolveRecord } from './types';

function rec(tags?: string[], extras: Partial<SolveRecord> = {}): SolveRecord {
  return {
    ts: 1, totalMs: 1000, scramble: '', solution: '',
    phases: { cross: 0 }, process: 'cfop',
    twoLookOll: false, twoLookPll: false,
    ...(tags ? { tags } : {}),
    ...extras,
  };
}

describe('normalizeTag', () => {
  it('lowercases and trims', () => {
    expect(normalizeTag('  Speed  ')).toBe('speed');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeTag('Two   Look  PLL')).toBe('two look pll');
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('\t\n')).toBeNull();
  });

  it('preserves single internal spaces', () => {
    expect(normalizeTag('warm up')).toBe('warm up');
  });
});

describe('allTagsWithCounts', () => {
  it('counts tags across all records', () => {
    const h = [
      rec(['speed', 'warmup']),
      rec(['speed']),
      rec(['warmup', 'oll']),
    ];
    const c = allTagsWithCounts(h);
    expect(c.get('speed')).toBe(2);
    expect(c.get('warmup')).toBe(2);
    expect(c.get('oll')).toBe(1);
  });

  it('returns empty for tag-free history', () => {
    expect(allTagsWithCounts([rec(), rec()]).size).toBe(0);
  });

  it('defensively normalizes stored tags', () => {
    // A legacy / corrupt import shouldn't double-count "Speed" vs "speed".
    const h = [rec(['Speed', 'SPEED', '  speed  '])];
    const c = allTagsWithCounts(h);
    expect(c.get('speed')).toBe(3);
    expect(c.size).toBe(1);
  });
});

describe('sortedTagsForDialog', () => {
  const counts = new Map([
    ['speed', 5],
    ['warmup', 3],
    ['oll', 3],
    ['spam', 1],
  ]);

  it('returns all tags sorted by count desc, then alpha, when filter is empty', () => {
    expect(sortedTagsForDialog(counts, '')).toEqual(['speed', 'oll', 'warmup', 'spam']);
  });

  it('prefix-filters', () => {
    expect(sortedTagsForDialog(counts, 's')).toEqual(['speed', 'spam']);
    expect(sortedTagsForDialog(counts, 'spe')).toEqual(['speed']);
  });

  it('filter is case-insensitive', () => {
    expect(sortedTagsForDialog(counts, 'SP')).toEqual(['speed', 'spam']);
  });

  it('places the most-used match first (used by the auto-fill behavior)', () => {
    const c = new Map([['speed', 1], ['speedrun', 10]]);
    expect(sortedTagsForDialog(c, 'sp')[0]).toBe('speedrun');
  });
});

describe('applyTagFilter', () => {
  const speed = rec(['speed']);
  const warmup = rec(['warmup']);
  const both = rec(['speed', 'warmup']);
  const paused = rec(['paused']);
  const speedPaused = rec(['speed', 'paused']);
  const untagged = rec();
  const history = [speed, warmup, both, paused, speedPaused, untagged];

  it('passes every record when both sides are empty', () => {
    expect(applyTagFilter(history, { include: [], exclude: [] })).toEqual(history);
  });

  it('include filters to records with at least one included tag', () => {
    expect(applyTagFilter(history, { include: ['speed'], exclude: [] }))
      .toEqual([speed, both, speedPaused]);
  });

  it('exclude drops records with any excluded tag', () => {
    expect(applyTagFilter(history, { include: [], exclude: ['paused'] }))
      .toEqual([speed, warmup, both, untagged]);
  });

  it('exclude WINS over include when a record has both', () => {
    // speedPaused has speed (matches include) AND paused (matches exclude).
    // Exclude wins → drop.
    expect(applyTagFilter(history, { include: ['speed'], exclude: ['paused'] }))
      .toEqual([speed, both]);
  });

  it('does not mutate the input array', () => {
    const snapshot = history.slice();
    applyTagFilter(history, { include: ['speed'], exclude: [] });
    expect(history).toEqual(snapshot);
  });
});

describe('pushRecentTagSet', () => {
  const a: TagFilter = { include: ['speed'], exclude: [] };
  const b: TagFilter = { include: ['oll'], exclude: ['paused'] };

  it('prepends newest', () => {
    const r1 = pushRecentTagSet([], a);
    const r2 = pushRecentTagSet(r1, b);
    expect(r2[0]).toEqual(b);
    expect(r2[1]).toEqual(a);
  });

  it('dedupes — re-pushing the same set moves it to the front', () => {
    const r = pushRecentTagSet(pushRecentTagSet(pushRecentTagSet([], a), b), a);
    expect(r).toEqual([a, b]);
  });

  it('caps to max entries (default 5)', () => {
    let r: TagFilter[] = [];
    for (let i = 0; i < 8; i++) {
      r = pushRecentTagSet(r, { include: [`t${i}`], exclude: [] });
    }
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual({ include: ['t7'], exclude: [] });
    expect(r[4]).toEqual({ include: ['t3'], exclude: [] });
  });

  it('ignores the empty filter — that\'s the permanent "All Solves" option', () => {
    expect(pushRecentTagSet([a], { include: [], exclude: [] })).toEqual([a]);
  });

  it('respects a custom max', () => {
    let r: TagFilter[] = [];
    for (let i = 0; i < 5; i++) {
      r = pushRecentTagSet(r, { include: [`t${i}`], exclude: [] }, 2);
    }
    expect(r).toHaveLength(2);
  });
});

describe('tagFilterLabel', () => {
  it('returns "All Solves" when empty', () => {
    expect(tagFilterLabel({ include: [], exclude: [] })).toBe('All Solves');
  });

  it('shows include-only', () => {
    expect(tagFilterLabel({ include: ['speed', 'oll'], exclude: [] }))
      .toBe('include: speed, oll');
  });

  it('shows exclude-only', () => {
    expect(tagFilterLabel({ include: [], exclude: ['paused'] }))
      .toBe('exclude: paused');
  });

  it('shows both with a pipe separator', () => {
    expect(tagFilterLabel({ include: ['speed'], exclude: ['paused'] }))
      .toBe('include: speed | exclude: paused');
  });
});
