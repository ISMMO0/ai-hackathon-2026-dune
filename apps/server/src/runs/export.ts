import { asc, eq } from 'drizzle-orm';
import type { ExportEntriesFn } from '@antasphere/chassis-server';
import { runs } from '@app/db';

/**
 * The runs of a workspace, as they leave it in `GET /workspace/export`: one
 * entry, `runs` → `runs.json`, after the items' two. The item's rules
 * (`../items/export.ts`): the workspace in the WHERE, the columns SELECTED in
 * the wire shape of a run (H's own session id stays behind: it is H's handle,
 * not the workspace's data), `(created_at, id)` order, `[]` when there is
 * none.
 */
export const runExportEntries: ExportEntriesFn = async (db, workspaceId) => {
  const rows = await db
    .select({
      id: runs.id,
      workspaceId: runs.workspaceId,
      createdBy: runs.createdBy,
      instruction: runs.instruction,
      startUrl: runs.startUrl,
      state: runs.state,
      liveUrl: runs.liveUrl,
      answer: runs.answer,
      error: runs.error,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      finishedAt: runs.finishedAt
    })
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId))
    .orderBy(asc(runs.createdAt), asc(runs.id));
  return [{ name: 'runs', rows }];
};
