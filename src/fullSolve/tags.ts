import type { SolveRecord, Process } from './types';

// Pure helpers for the solve-tagging feature: normalization, the tag
// corpus (with usage counts), sort/filter for the editor dialog, the
// include/exclude graph filter, and recent-set management. Kept DOM-
// free so it's straightforward to unit-test.
//
// Process names (cfop/roux/f3ul/beginner) are treated as VIRTUAL
// auto-tags: they appear in the corpus + filter UI alongside real
// user tags, and applyTagFilter matches them via record.process.
// They can't be added as literal tags — the editor disables Add when
// the typed value matches one of these.

export const PROCESS_NAMES: readonly Process[] = ['cfop', 'roux', 'f3ul', 'beginner'];
const PROCESS_NAME_SET: ReadonlySet<string> = new Set(PROCESS_NAMES);

// True iff `s` (already-normalized) is one of the reserved process
// names. Used by the tag editor to disable Add for these strings.
export function isProcessName(s: string): boolean {
  return PROCESS_NAME_SET.has(s);
}

// Lowercase, trim, collapse internal whitespace. Returns null for
// inputs that are empty after trimming (the editor uses null to
// reject the would-be tag without inserting it).
export function normalizeTag(s: string): string | null {
  const trimmed = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? null : trimmed;
}

// Count occurrences of every tag across the history. Tags are assumed
// to already be normalized (they're normalized on write at the editor
// boundary; older imports may not be — those are coerced via
// normalizeTag here as a defensive measure).
//
// Each record's `process` is also counted as a virtual auto-tag, so
// process names show up in the same corpus used by the filter dialog
// and the editor's autocomplete list.
export function allTagsWithCounts(history: SolveRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of history) {
    if (r.process) counts.set(r.process, (counts.get(r.process) ?? 0) + 1);
    if (!r.tags) continue;
    for (const raw of r.tags) {
      const t = normalizeTag(raw);
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}

// Sort tags for display in the editor list. Filter is a normalized
// prefix; when empty, the whole corpus is returned. Order: usage
// count descending, then alphabetical. The first entry is the
// "most-used match" used by the auto-fill behavior.
export function sortedTagsForDialog(
  counts: Map<string, number>,
  filter: string,
): string[] {
  const f = filter.trim().toLowerCase();
  const matched: string[] = [];
  for (const tag of counts.keys()) {
    if (!f || tag.startsWith(f)) matched.push(tag);
  }
  matched.sort((a, b) => {
    const ca = counts.get(a) ?? 0;
    const cb = counts.get(b) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.localeCompare(b);
  });
  return matched;
}

export interface TagFilter {
  include: string[];
  exclude: string[];
}

// The effective tag set a record contributes for filtering purposes:
// its real tags plus its process name as a virtual auto-tag.
function effectiveTags(r: SolveRecord): string[] {
  if (r.process) return [...(r.tags ?? []), r.process];
  return r.tags ?? [];
}

// Apply include/exclude filter to a history slice. Semantics:
//   - empty include AND empty exclude → all records pass
//   - exclude wins: any record having ANY excluded tag is dropped,
//     even if it also has an included tag
//   - non-empty include: at least one included tag must be present
//   - empty include + non-empty exclude: pass everything except
//     records with excluded tags
//
// Process names count as virtual tags on every record (see
// effectiveTags), so e.g. `include: ['cfop']` matches every record
// with process === 'cfop'.
export function applyTagFilter(
  records: SolveRecord[],
  filter: TagFilter,
): SolveRecord[] {
  const inc = filter.include;
  const exc = filter.exclude;
  if (inc.length === 0 && exc.length === 0) return records.slice();
  return records.filter(r => {
    const tags = effectiveTags(r);
    if (exc.length > 0) {
      for (const t of tags) if (exc.includes(t)) return false;
    }
    if (inc.length === 0) return true;
    for (const t of tags) if (inc.includes(t)) return true;
    return false;
  });
}

// LRU-ish recents: prepend the new set, drop any prior equal set,
// cap to `max` entries. Equality is structural (same tags in same
// order on both sides). The caller normalizes filter sides before
// passing them in.
export function pushRecentTagSet(
  recents: TagFilter[],
  next: TagFilter,
  max = 5,
): TagFilter[] {
  // Don't record the empty filter — "All Solves" is a permanent
  // first-class menu option, not a recent.
  if (next.include.length === 0 && next.exclude.length === 0) return recents.slice();
  const key = JSON.stringify(next);
  const filtered = recents.filter(r => JSON.stringify(r) !== key);
  filtered.unshift({ include: next.include.slice(), exclude: next.exclude.slice() });
  return filtered.slice(0, max);
}

// Compact human-readable label for a tag filter, used as the option
// text in the filter dropdown. Empty sides are omitted; both empty
// returns 'All Solves'.
export function tagFilterLabel(filter: TagFilter): string {
  const inc = filter.include;
  const exc = filter.exclude;
  if (inc.length === 0 && exc.length === 0) return 'All Solves';
  const parts: string[] = [];
  if (inc.length > 0) parts.push(`+${inc.join(', ')}`);
  if (exc.length > 0) parts.push(`-${exc.join(', ')}`);
  return parts.join(' | ');
}
