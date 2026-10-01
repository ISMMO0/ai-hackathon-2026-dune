import { asc, eq } from 'drizzle-orm';
import type { ExportEntriesFn } from '@antasphere/chassis-server';
import { itemProjects, items } from '@app/db';

/**
 * The items of a workspace, as they leave it in `GET /workspace/export`: the
 * tool's half of the bundle (slot `api.exportEntries`).
 *
 * The chassis owns WHO may export (an owner or an admin, never a guest, a
 * machine only with `data:export`) and hands over the workspace the principal
 * resolved to, never a request value. What is the tool's to hold:
 *
 *  - the statement carries `workspaceId` in its WHERE, the rule of every items
 *    statement (`./service.ts`): the chassis does not filter for the tool;
 *  - it reads through the handle it is GIVEN, the one the route reads its own
 *    sections with;
 *  - the columns are SELECTED, in the wire shape of an item. A column added to
 *    the table later does not leave the instance until it is added here, and
 *    `test/integration/items-export.test.ts` pins the key set;
 *  - the order is stable, `(created_at, id)`, oldest first: two exports of the
 *    same rows are the same bytes.
 *
 * Two entries: `items` → `items.json`, written after `files.json`, then
 * `item_projects` → `item_projects.json`, the links to the workspace's
 * projects (the projects themselves are the chassis's `projects.json` and
 * `project_members.json`, written before the tool's entries). An empty
 * workspace gets `[]` in each, so a file says "none" rather than being
 * absent. A name must not be one of the chassis's
 * (`RESERVED_EXPORT_ENTRY_NAMES`): the export would answer 500.
 */
export const itemExportEntries: ExportEntriesFn = async (db, workspaceId) => {
  const links = await db
    .select({
      itemId: itemProjects.itemId,
      projectId: itemProjects.projectId,
      workspaceId: itemProjects.workspaceId,
      addedBy: itemProjects.addedBy,
      createdAt: itemProjects.createdAt
    })
    .from(itemProjects)
    .where(eq(itemProjects.workspaceId, workspaceId))
    .orderBy(asc(itemProjects.createdAt), asc(itemProjects.itemId), asc(itemProjects.projectId));
  const rows = await db
    .select({
      id: items.id,
      workspaceId: items.workspaceId,
      name: items.name,
      note: items.note,
      createdBy: items.createdBy,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt
    })
    .from(items)
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(asc(items.createdAt), asc(items.id));
  return [
    { name: 'items', rows },
    { name: 'item_projects', rows: links }
  ];
};
