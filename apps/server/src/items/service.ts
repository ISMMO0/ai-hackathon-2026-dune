import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Principal, ProjectRole } from '@antasphere/chassis-contract';
import { projects, type Db } from '@antasphere/chassis-db';
import type { ItemProjectRef } from '@app/contract';
import { itemProjects, items, type Item } from '@app/db';
import { cursorRowId, keysetBefore, pageOf } from '@antasphere/chassis-server/util';
import { PROJECTS_ID, projectGrantPredicate, projectRole } from '@antasphere/chassis-server/projects';
import { ITEMS_ID, canLinkIntoProject } from './projects.js';

/**
 * The items of a workspace: the data half of the resource, no HTTP in it.
 *
 * THE rule of a tool service: every method takes the `workspaceId` and every
 * statement carries it in its WHERE. The caller (a route, an MCP tool, a job)
 * hands over the workspace the principal resolved to, never one a client
 * named in a body. A row of another workspace is therefore not found, the same
 * answer as a row that does not exist: `get`, `update` and `delete` return
 * `null` for both and the route turns that into one 404.
 *
 * The reads take the PRINCIPAL rather than a bare workspace id, because what a
 * caller may see is a second predicate beside the workspace (`visibleTo`).
 */

/** What `create` answers: the row, or the one refusal the project side has. */
export type ItemCreateResult =
  { ok: true; item: Item } | { ok: false; failure: { code: 'project_not_found'; projectId: string } };

export class ItemService {
  constructor(private readonly db: Db) {}

  /**
   * WHICH items of their workspace a principal sees, as a WHERE predicate used
   * by `list` AND `get` (one rule, so the list and the read by id can never
   * disagree). A member sees them all: `undefined`, no extra predicate. A
   * guest (`principal.origin === 'guest'`, the field `requireNonGuest` reads)
   * is an outsider who holds a per-item grant and nothing else, and the
   * template ships NO per-item grant: a guest sees nothing, so their list is
   * empty and any id is not found, exactly like a missing one.
   *
   * This is where a tool with per-item grants puts its grant predicate:
   * `EXISTS (SELECT 1 FROM item_grants g WHERE g.item_id = items.id AND
   * g.user_id = <principal.userId>)` instead of `false`. The predicate lives
   * in the service, never as an `if guest` in a handler: an MCP tool or a job
   * that reads items then obeys it too.
   *
   * A PROJECT grant is one such predicate, and the chassis states it once
   * (`projectGrantPredicate`, over the tool's link table: `./projects.ts` says
   * how). The template's item needs no branch here, because every member
   * already sees every item; a tool whose resource is private adds it here,
   * in `blobReadScope` and in nothing else, so the list, the read by id and
   * the files surface keep one rule.
   */
  private visibleTo(principal: Principal): SQL | undefined {
    return principal.origin === 'guest' ? sql`false` : undefined;
  }

  /**
   * One page, newest first: the chassis's keyset idiom. The cursor is the id
   * of the last row of the previous page; its position is resolved SQL-side
   * and inside this workspace, so a cursor from another workspace positions
   * nothing. `limit + 1` rows are fetched so `pageOf` knows whether a next
   * page exists. `projectId` keeps the items linked to that project; the
   * route read-checked the project already (404 otherwise), and `visibleTo`
   * still applies to each item.
   */
  async list(
    principal: Principal,
    opts: { cursor?: string | undefined; limit: number; projectId?: string | undefined }
  ): Promise<{ page: Item[]; nextCursor: string | null }> {
    const workspaceId = principal.workspaceId;
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(items)
      .where(
        and(
          eq(items.workspaceId, workspaceId),
          this.visibleTo(principal),
          ...(opts.projectId
            ? [
                sql`EXISTS (SELECT 1 FROM item_projects ip_f WHERE ip_f.item_id = ${ITEMS_ID} AND ip_f.project_id = ${opts.projectId})`
              ]
            : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: items,
                  id: items.id,
                  createdAt: items.createdAt,
                  workspaceId: items.workspaceId,
                  cursorId,
                  workspace: workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(opts.limit + 1);
    return pageOf(rows, opts.limit);
  }

  /**
   * Create an item, linked to `projectIds` in the same transaction. The
   * caller is asked the project side only (`canLinkIntoProject`: the editor
   * role or more, none archived); one project that does not qualify refuses
   * the whole create, uniformly, as `project_not_found`: a project the caller
   * cannot read and one they may not link into look the same. The project
   * rows are read FOR SHARE first, like `linkProject`, so an archive landing
   * between the check and the insert waits here or is seen by the check.
   */
  async create(
    principal: Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>,
    input: { name: string; note: string; projectIds?: readonly string[] | undefined }
  ): Promise<ItemCreateResult> {
    const workspaceId = principal.workspaceId;
    const projectIds = [...new Set(input.projectIds ?? [])];
    return this.db.transaction(async (tx) => {
      if (projectIds.length > 0) {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(inArray(projects.id, projectIds), eq(projects.workspaceId, workspaceId)))
          .for('share');
      }
      for (const projectId of projectIds) {
        if (!(await canLinkIntoProject(tx, principal, projectId))) {
          return { ok: false, failure: { code: 'project_not_found', projectId } };
        }
      }
      const [row] = await tx
        .insert(items)
        .values({ workspaceId, name: input.name, note: input.note, createdBy: principal.userId })
        .returning();
      if (projectIds.length > 0) {
        await tx.insert(itemProjects).values(
          projectIds.map((projectId) => ({
            itemId: row!.id,
            projectId,
            workspaceId,
            addedBy: principal.userId
          }))
        );
      }
      return { ok: true, item: row! };
    });
  }

  /**
   * How many items the workspace holds, for the `items.perWorkspace` plan
   * limit (`./items-of-workspace.ts`): every item, whoever created it, since
   * the limit is the WORKSPACE's. Read outside any lock, like every count
   * hook: concurrent creates at the cap may overshoot it by the concurrency,
   * and the next create re-reads.
   */
  async count(workspaceId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(items).where(eq(items.workspaceId, workspaceId));
    return row?.n ?? 0;
  }

  /**
   * Whether `create` would let this caller create an item in these projects:
   * the same question `create` asks of each project (`canLinkIntoProject`, the
   * editor role or more on a live project), asked BEFORE the handler by the
   * plan limit's hook so a caller the handler would refuse is never judged on
   * the cap. Outside the create's transaction, so a project archived between
   * this read and the create is the create's own refusal.
   */
  async mayCreate(
    principal: Pick<Principal, 'userId' | 'workspaceId' | 'role' | 'origin'>,
    projectIds: readonly string[]
  ): Promise<boolean> {
    for (const projectId of new Set(projectIds)) {
      if (!(await canLinkIntoProject(this.db, principal, projectId))) return false;
    }
    return true;
  }

  async get(principal: Principal, id: string): Promise<Item | null> {
    const [row] = await this.db
      .select()
      .from(items)
      .where(and(eq(items.id, id), eq(items.workspaceId, principal.workspaceId), this.visibleTo(principal)))
      .limit(1);
    return row ?? null;
  }

  /** The patch carries at least one field (the contract refuses an empty one); `updated_at` moves with it. */
  async update(
    workspaceId: string,
    id: string,
    patch: { name?: string | undefined; note?: string | undefined }
  ): Promise<Item | null> {
    const [row] = await this.db
      .update(items)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        updatedAt: sql`now()`
      })
      .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId)))
      .returning();
    return row ?? null;
  }

  /** Returns the deleted row (the route answers it as the final snapshot), or null when there was none here. */
  async delete(workspaceId: string, id: string): Promise<Item | null> {
    const [row] = await this.db
      .delete(items)
      .where(and(eq(items.id, id), eq(items.workspaceId, workspaceId)))
      .returning();
    return row ?? null;
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  /**
   * The projects each item is linked to THAT THE PRINCIPAL CAN READ, for the
   * payload. A link to a project the caller is not a member of is left out:
   * its existence is not theirs to learn from an item they read another way.
   * One query for a whole page: the map is keyed by item id, and an item
   * with no readable project is absent from it.
   */
  async projectsOf(principal: Principal, itemIds: readonly string[]): Promise<Map<string, ItemProjectRef[]>> {
    const byItem = new Map<string, ItemProjectRef[]>();
    if (itemIds.length === 0) return byItem;
    const rows = await this.db
      .select({ itemId: itemProjects.itemId, id: projects.id, name: projects.name })
      .from(itemProjects)
      .innerJoin(projects, eq(itemProjects.projectId, projects.id))
      .where(
        and(
          inArray(itemProjects.itemId, [...itemIds]),
          eq(projects.workspaceId, principal.workspaceId),
          projectGrantPredicate(principal, PROJECTS_ID, { atLeast: 'viewer', access: 'read' })
        )
      )
      .orderBy(projects.name, projects.id);
    for (const row of rows) {
      const list = byItem.get(row.itemId) ?? [];
      list.push({ id: row.id, name: row.name });
      byItem.set(row.itemId, list);
    }
    return byItem;
  }

  /** The caller's effective role on a project of their workspace, or null (= 404). The chassis's own answer. */
  projectRoleOf(principal: Principal, projectId: string): Promise<ProjectRole | null> {
    return projectRole(this.db, principal, projectId);
  }

  /**
   * Put an item in a project. Idempotent: an existing link is left as it is.
   * WHO may is the handler's; the project row is read FOR SHARE so an archive
   * landing between the handler's gate and this insert waits, or is seen here.
   * `not_found` is the race where the project left the workspace between the
   * handler's read and this one: the handler answers it as it answered the
   * read, never as an archive.
   */
  async linkProject(
    item: Item,
    projectId: string,
    addedBy: string
  ): Promise<'linked' | 'archived' | 'not_found'> {
    return this.db.transaction(async (tx) => {
      const live = await this.liveProject(tx, item.workspaceId, projectId);
      if (live !== 'live') return live;
      await tx
        .insert(itemProjects)
        .values({ itemId: item.id, projectId, workspaceId: item.workspaceId, addedBy })
        .onConflictDoNothing();
      return 'linked';
    });
  }

  /**
   * Take an item out of a project: the same gate as the link (the handler's
   * role check, then the archived-write rule here, on the project row read
   * FOR SHARE), because an archived project takes no change to what it holds.
   */
  async unlinkProject(
    item: Item,
    projectId: string
  ): Promise<'unlinked' | 'not_linked' | 'archived' | 'not_found'> {
    return this.db.transaction(async (tx) => {
      const live = await this.liveProject(tx, item.workspaceId, projectId);
      if (live !== 'live') return live;
      const removed = await tx
        .delete(itemProjects)
        .where(
          and(
            eq(itemProjects.workspaceId, item.workspaceId),
            eq(itemProjects.itemId, item.id),
            eq(itemProjects.projectId, projectId)
          )
        )
        .returning({ projectId: itemProjects.projectId });
      return removed.length > 0 ? 'unlinked' : 'not_linked';
    });
  }

  /** The project row of this workspace, read FOR SHARE inside the caller's transaction: live, archived, or gone. */
  private async liveProject(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    workspaceId: string,
    projectId: string
  ): Promise<'live' | 'archived' | 'not_found'> {
    const [project] = await tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .for('share')
      .limit(1);
    if (!project) return 'not_found';
    return project.archivedAt === null ? 'live' : 'archived';
  }
}
