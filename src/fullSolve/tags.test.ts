import { describe, expect, it } from 'vitest';
import {
  normalizeTag, allTagsWithCounts, sortedTagsForDialog,
  applyTagFilter, pushRecentTagSet, tagFilterLabel,
  isProcessName, PROCESS_NAMES,
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

  it('counts process names even when no real tags are set', () => {
    // Tag-free history still produces process counts (every record
    // has a process, treated as a virtual auto-tag).
    const c = allTagsWithCounts([rec(), rec()]);
    expect(c.get('cfop')).toBe(2);
    expect(c.size).toBe(1);   // just the process; no real tags
  });

  it('defensively normalizes stored tags', () => {
    // A legacy / corrupt import shouldn't double-count "Speed" vs "speed".
    const h = [rec(['Speed', 'SPEED', '  speed  '])];
    const c = allTagsWithCounts(h);
    expect(c.get('speed')).toBe(3);
    // Map also contains the record's process name (cfop) as a
    // virtual auto-tag, so size is 2 not 1.
    expect(c.size).toBe(2);
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
      .toBe('+speed, oll');
  });

  it('shows exclude-only', () => {
    expect(tagFilterLabel({ include: [], exclude: ['paused'] }))
      .toBe('-paused');
  });

  it('shows both with a pipe separator', () => {
    expect(tagFilterLabel({ include: ['speed'], exclude: ['paused'] }))
      .toBe('+speed | -paused');
  });
});

describe('process names as virtual tags', () => {
  it('isProcessName recognizes all reserved process names', () => {
    for (const p of PROCESS_NAMES) expect(isProcessName(p)).toBe(true);
    expect(isProcessName('speed')).toBe(false);
    expect(isProcessName('')).toBe(false);
    expect(isProcessName('CFOP')).toBe(false);  // already-normalized check, lowercase only
  });

  it('PROCESS_NAMES contains every known process (incl. the record pseudo-process)', () => {
    expect([...PROCESS_NAMES].sort())
      .toEqual(['beginner', 'cfop', 'f3ul', 'record', 'roux']);
  });

  it('record is reserved (so users can\'t add it as a literal tag) but is NOT exposed as a virtual tag', () => {
    // Reserved → tag editor blocks literal "record":
    expect(isProcessName('record')).toBe(true);
    // But NOT virtual → a recording's process doesn't enter the
    // include/exclude tag-filter universe:
    const h = [
      rec(['note'], { process: 'record' }),
      rec(['note'], { process: 'cfop' }),
    ];
    const c = allTagsWithCounts(h);
    expect(c.get('record')).toBeUndefined();  // record is NOT a virtual tag
    expect(c.get('cfop')).toBe(1);
    expect(c.get('note')).toBe(2);
  });

  it('applyTagFilter — including "record" matches nothing (record records don\'t expose the virtual tag)', () => {
    const recording = rec([], { process: 'record' });
    const cfop = rec([], { process: 'cfop' });
    const filter: TagFilter = { include: ['record'], exclude: [] };
    expect(applyTagFilter([recording, cfop], filter)).toEqual([]);
  });

  it('applyTagFilter — excluding "record" leaves real solves untouched (no-op for them)', () => {
    const recording = rec([], { process: 'record' });
    const cfop = rec([], { process: 'cfop' });
    const filter: TagFilter = { include: [], exclude: ['record'] };
    // Recording is NOT dropped by the exclude — it has no 'record'
    // virtual tag to match against. Filtering recordings out of the
    // graph is the caller's job (filteredHistory()), not the tag-filter
    // engine's.
    expect(applyTagFilter([recording, cfop], filter)).toEqual([recording, cfop]);
  });

  it('allTagsWithCounts includes each record\'s process as a virtual tag', () => {
    const h = [
      rec(['speed'], { process: 'cfop' }),
      rec([], { process: 'cfop' }),
      rec(['speed'], { process: 'roux' }),
    ];
    const c = allTagsWithCounts(h);
    expect(c.get('cfop')).toBe(2);
    expect(c.get('roux')).toBe(1);
    expect(c.get('speed')).toBe(2);
  });

  it('applyTagFilter — including a process name filters by record.process', () => {
    const cfop = rec(['speed'], { process: 'cfop' });
    const roux = rec(['speed'], { process: 'roux' });
    const f3ul = rec([], { process: 'f3ul' });
    const r = applyTagFilter([cfop, roux, f3ul], { include: ['roux'], exclude: [] });
    expect(r).toEqual([roux]);
  });

  it('applyTagFilter — excluding a process name hides that method\'s records', () => {
    const cfop = rec(['speed'], { process: 'cfop' });
    const roux = rec(['speed'], { process: 'roux' });
    const r = applyTagFilter([cfop, roux], { include: [], exclude: ['cfop'] });
    expect(r).toEqual([roux]);
  });

  it('applyTagFilter — process names interact with tags as expected', () => {
    const cfopSpeed = rec(['speed'], { process: 'cfop' });
    const cfopWarm  = rec(['warmup'], { process: 'cfop' });
    const rouxSpeed = rec(['speed'], { process: 'roux' });
    const history = [cfopSpeed, cfopWarm, rouxSpeed];
    // Include "speed OR roux" → cfopSpeed (speed), cfopWarm (no), rouxSpeed (both).
    const r1 = applyTagFilter(history, { include: ['speed', 'roux'], exclude: [] });
    expect(r1).toEqual([cfopSpeed, rouxSpeed]);
    // Exclude cfop overrides include of speed: cfopSpeed is dropped.
    const r2 = applyTagFilter(history, { include: ['speed'], exclude: ['cfop'] });
    expect(r2).toEqual([rouxSpeed]);
  });
});
