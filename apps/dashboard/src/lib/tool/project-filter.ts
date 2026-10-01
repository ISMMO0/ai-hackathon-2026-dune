import type { Project } from '$lib/projects/types';

/**
 * The project filter of the items page (PRDCT-2585): the page remembers the
 * project it was last narrowed to, so the choice survives a reload. Pure
 * functions, unit-tested in project-filter.test.ts; the rune half is
 * project-filter.svelte.ts. A tool with several lists gives each its own
 * page name.
 */
export type ProjectFilterPage = 'items';

/** One key per page, per person, per workspace (the shell's `filterScope`). */
export function projectFilterKey(page: ProjectFilterPage, scope: string): string {
  return `${page}.project:${scope}`;
}

/** The project the browser remembers for a page; none when nothing is remembered or storage is off. */
export function readProjectFilter(
  page: ProjectFilterPage,
  scope: string,
  storage: Pick<Storage, 'getItem'> | null = storageOrNull()
): string | null {
  try {
    return storage?.getItem(projectFilterKey(page, scope)) || null;
  } catch {
    return null;
  }
}

/** Remember the project, or forget it (`null`); a browser that refuses storage keeps the choice for the visit only. */
export function writeProjectFilter(
  page: ProjectFilterPage,
  scope: string,
  projectId: string | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = storageOrNull()
): void {
  try {
    if (projectId) storage?.setItem(projectFilterKey(page, scope), projectId);
    else storage?.removeItem(projectFilterKey(page, scope));
  } catch {
    /* not persisted, still applied */
  }
}

function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The name a filtered list is remembered under (pagedList's `remember`): one
 * per project, and the bare name with no filter, which is the name the shell
 * warms.
 */
export function rememberedListName(base: string, projectId: string | null): string {
  return projectId ? `${base}.${projectId}` : base;
}

/** A remembered project the reader no longer reads (gone, left, archived) is no filter at all. */
export function standingFilter(projectId: string | null, readable: Pick<Project, 'id'>[]): string | null {
  return projectId && readable.some((p) => p.id === projectId) ? projectId : null;
}
