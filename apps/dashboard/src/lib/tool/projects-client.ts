/**
 * The one seam between the items and their projects (PRDCT-2585):
 * which items a project holds, which projects an item sits in, the link and
 * the unlink. Every component reads that through this file and nothing else,
 * so the item side of projects knows the SDK by these four calls. A project
 * the caller cannot read answers 404, like the project itself.
 */
import type { Item, ItemProjectRef } from '@app/contract';
import type { Project } from '$lib/projects/types';
import { api } from '$lib/api';
import { itemsPage } from './items';

export interface ItemProjectsClient {
  /**
   * A page of items, of one project or of all of them (`null`). Each item
   * names its readable projects. An unreadable project answers 404.
   */
  itemsOf(
    projectId: string | null,
    p: { cursor?: string; limit?: number }
  ): Promise<{ items: Item[]; nextCursor: string | null }>;
  /** Put the item in the project: the editor role or more on a live project. */
  link(itemId: string, projectId: string): Promise<void>;
  /** Take the item out of the project. */
  unlink(itemId: string, projectId: string): Promise<void>;
  /** The projects a filter can offer: the reader's own, archived ones left out. */
  readableProjects(): Promise<Project[]>;
}

export { isNotFound } from '$lib/projects/errors';

export const itemProjects: ItemProjectsClient = {
  // the same call as the items page and the warm-up, with the project when there is one
  itemsOf: (projectId, p) => itemsPage(projectId ? { ...p, project: projectId } : p),
  async link(itemId, projectId) {
    await api.linkItemProject(itemId, projectId);
  },
  async unlink(itemId, projectId) {
    await api.unlinkItemProject(itemId, projectId);
  },
  // one page is the whole offer: a person is in far fewer than a hundred projects
  readableProjects: async () => (await api.projects({ archived: 'false', limit: 100 })).projects
};

// ── What a payload already says: no request ─────────────────────────────

/**
 * The projects an item's payload names, which are the ones the reader can
 * read, one left out: the project whose page the item is already shown on.
 */
export function namedProjects(item: Pick<Item, 'projects'>, except?: string): ItemProjectRef[] {
  return item.projects.filter((p) => p.id !== except);
}

/**
 * The items a project can still take: every item of the workspace that is not
 * in it yet. The reader is on the project's page, so they read the project,
 * so an item already in it names it.
 */
export function itemsToLink<I extends Pick<Item, 'projects'>>(items: I[], projectId: string): I[] {
  return items.filter((item) => !item.projects.some((p) => p.id === projectId));
}
