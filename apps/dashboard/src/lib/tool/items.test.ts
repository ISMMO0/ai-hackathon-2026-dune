import { describe, expect, it, vi } from 'vitest';
import type { Item } from '@app/contract';

vi.mock('$lib/api', () => ({ api: {} }));
const { latestItems, noteExcerpt } = await import('./items');

describe('noteExcerpt', () => {
  it('leaves a short note as it is, on one line', () => {
    expect(noteExcerpt('')).toBe('');
    expect(noteExcerpt('  a note\n\ton two lines ')).toBe('a note on two lines');
  });

  it('cuts a long note at a word and says so', () => {
    const excerpt = noteExcerpt('one two three four five six', 12);
    expect(excerpt).toBe('one two…');
    expect(noteExcerpt('word '.repeat(40)).length).toBeLessThanOrEqual(81);
  });

  it('cuts a long word where the room ends', () => {
    expect(noteExcerpt('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}…`);
  });
});

describe('latestItems', () => {
  it('keeps the n last changed, the latest first, and leaves the list alone', () => {
    const items = ['2026-09-01', '2026-09-04', '2026-09-02'].map(
      (day, i) => ({ id: String(i), updatedAt: `${day}T00:00:00Z` }) as Item
    );
    expect(latestItems(items, 2).map((i) => i.id)).toEqual(['1', '2']);
    expect(items.map((i) => i.id)).toEqual(['0', '1', '2']);
  });
});
