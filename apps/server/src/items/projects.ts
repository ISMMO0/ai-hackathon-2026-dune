import { sql, type SQL } from 'drizzle-orm';
import type { Principal } from '@antasphere/chassis-contract';
import type { DbConn } from '@antasphere/chassis-db';
import { projectGrantPredicate } from '@antasphere/chassis-server/projects';

/**
 * The item's side of the workspace's PROJECTS: the one place the tool asks
 * the chassis its project question. A project is a chassis concept
 * (`@antasphere/chassis-server/projects` exports the predicate, the role
 * expression and `projectRole`); what a project HOLDS is the tool's, through
 * its own link table (`item_projects`, `@app/db`).
 *
 * Every question here is `projectGrantPredicate`, never a rule written
 * beside it, so the guest refusal, the live membership, the one workspace,
 * the role ladder, the operator view and the archived-write rule are the
 * chassis's and cannot drift in the tool.
 *
 * What the template's item asks, and where a tool with a PRIVATE resource
 * asks more:
 *
 *  - `canLinkIntoProject`: who may put a resource of their own in a project.
 *    The editor role or more on a live project (`access: 'write'`): the
 *    ruling is "an editor adds a resource of their own", and an archived
 *    project takes nothing.
 *  - the payload's `projects` (`ItemService.projectsOf`) and the list's
 *    `?project=` filter (`ItemService.projectRoleOf`) are read questions,
 *    asked with `atLeast: 'viewer'` and `access: 'read'`: a project the
 *    caller cannot read is left out of the one and answers 404 to the other.
 *  - The template's item is read and written by every member of the
 *    workspace, so its READ rule (`ItemService.visibleTo`) has no project
 *    branch: a grant on a project opens nothing a member did not have. A tool
 *    whose resource is private to its author adds the branch THERE, in the
 *    list's WHERE and in `blobReadScope` at once (three homes, changed
 *    together), as `EXISTS (SELECT 1 FROM <link table> l WHERE l.<resource_id>
 *    = <the resource's qualified id> AND ${projectGrantPredicate(principal,
 *    sql\`l.project_id\`, { atLeast: 'viewer', access: 'read' })})`, and the
 *    write rule's editor branch the same way with `atLeast: 'editor', access:
 *    'write'`. Pass a QUALIFIED id (`ITEMS_ID`, never the column object): see
 *    the select-list trap on the chassis builder.
 */

type AccessPrincipal = Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>;

/** `items.id`, always qualified: safe wherever drizzle would drop the table name. */
export const ITEMS_ID: SQL = sql.raw('"items"."id"');

/**
 * True when the principal may LINK a resource of their own to this project:
 * the editor role or more, the project not archived. False for a project
 * that does not exist here, one the caller cannot read, and one they read
 * below editor: a caller learns nothing about a project from a refused link.
 */
export async function canLinkIntoProject(
  conn: DbConn,
  principal: AccessPrincipal,
  projectId: string
): Promise<boolean> {
  const { rows } = await conn.execute(
    sql`SELECT ${projectGrantPredicate(principal, sql`${projectId}::uuid`, { atLeast: 'editor', access: 'write' })} AS ok`
  );
  return (rows[0] as { ok: boolean } | undefined)?.ok === true;
}
