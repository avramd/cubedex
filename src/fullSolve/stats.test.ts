import { describe, expect, it } from 'vitest';
import { meanAndSd, rollingAverage } from './stats';

describe('rollingAverage (WCA-style trim mean)', () => {
  it('returns null for the first n-1 entries (insufficient window)', () => {
    expect(rollingAverage([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it('Ao5 of 5 values drops best+worst, averages the middle 3', () => {
    // sorted: [10, 12, 13, 14, 20] → trimmed [12, 13, 14] → 13
    expect(rollingAverage([10, 14, 20, 12, 13], 5)).toEqual([null, null, null, null, 13]);
  });

  it('rolls forward — value i depends on entries [i-n+1 .. i]', () => {
    // 6 values, n=5:
    //   i=4: window = [10, 14, 20, 12, 13] → trim → 13
    //   i=5: window = [14, 20, 12, 13, 30] → sorted [12,13,14,20,30] → trim [13,14,20] → 47/3
    const out = rollingAverage([10, 14, 20, 12, 13, 30], 5);
    expect(out[4]).toBe(13);
    expect(out[5]).toBeCloseTo(47 / 3, 10);
  });

  it('returns null when n < 3 (trimmed window would be empty)', () => {
    expect(rollingAverage([1, 2, 3], 2)).toEqual([null, null, null]);
    expect(rollingAverage([1], 1)).toEqual([null]);
  });

  it('handles an empty input', () => {
    expect(rollingAverage([], 5)).toEqual([]);
  });

  it('does not mutate the input array (sort is on a slice)', () => {
    const xs = [10, 5, 20, 1, 7];
    rollingAverage(xs, 5);
    expect(xs).toEqual([10, 5, 20, 1, 7]);
  });
});

describe('meanAndSd', () => {
  it('returns mean=0, sd=0 for an empty input', () => {
    expect(meanAndSd([])).toEqual({ mean: 0, sd: 0 });
  });

  it('singleton has sd 0', () => {
    expect(meanAndSd([42])).toEqual({ mean: 42, sd: 0 });
  });

  it('computes population mean and sd', () => {
    // Mean of [2, 4, 4, 4, 5, 5, 7, 9] = 5; population variance = 4; sd = 2.
    const { mean, sd } = meanAndSd([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBe(5);
    expect(sd).toBeCloseTo(2, 10);
  });

  it('handles negative values', () => {
    const { mean, sd } = meanAndSd([-1, 1]);
    expect(mean).toBe(0);
    expect(sd).toBe(1);
  });
});
