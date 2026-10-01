import { api } from '$lib/api';
import type { Item } from '@app/contract';

/**
 * What the items page, the overview and the warm-up share: the name the list
 * is remembered under, and its one call. The page and `tool.warm()` must make
 * the SAME call under the SAME name (stores/warmLists.ts says why). `project`
 * keeps the list to one project (the page's filter, the project's page); the
 * bare call, with no project, is the one the shell warms.
 */
export const ITEMS_LIST = 'items';

export async function itemsPage(p: { cursor?: string; limit?: number; project?: string }) {
  const { items, nextCursor } = await api.items(p);
  return { items, nextCursor };
}

/** How much of a note a row shows. */
export const NOTE_EXCERPT_MAX = 80;

/**
 * A note as one line of a table: its whitespace folded (a note keeps its
 * newlines), cut at a word when it is long, an ellipsis saying so.
 */
export function noteExcerpt(note: string, max = NOTE_EXCERPT_MAX): string {
  const line = note.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The latest first, by last change. */
export function latestItems(items: Item[], n: number): Item[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, n);
}
