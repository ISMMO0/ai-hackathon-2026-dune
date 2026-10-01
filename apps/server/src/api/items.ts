import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import {
  itemCreateRoute,
  itemDeleteRoute,
  itemGetRoute,
  itemProjectLinkRoute,
  itemProjectUnlinkRoute,
  itemsListRoute,
  itemUpdateRoute
} from '@app/contract/routes';
import { projectRoleAtLeast, type Principal } from '@antasphere/chassis-contract';
import type { ItemProjectRef } from '@app/contract';
import type { Item } from '@app/db';
import { requireAuth, requireNonGuest } from '@antasphere/chassis-server/middleware';
import type { ItemService } from '../items/service.js';

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (item: Item, projects: ItemProjectRef[] = []) => ({
  id: item.id,
  workspaceId: item.workspaceId,
  name: item.name,
  note: item.note,
  createdBy: item.createdBy,
  projects,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString()
});

/**
 * The items routes: what the `api.routes` slot registers. A route file only
 * translates: the contract has already validated the input (`c.req.valid`),
 * the service owns the data, and what is left here are the rules of the HTTP
 * surface.
 *
 *  - WHO: `requireAuth()` on the whole tree; every member reads and writes
 *    the workspace's items. A GUEST (an outsider who holds per-item grants
 *    and nothing else) is treated the way the chassis treats one everywhere:
 *    READS are open and show them only what they were granted, WRITES at the
 *    workspace level are refused. The template ships no per-item grant, so a
 *    guest's list is 200 and EMPTY and any id is the same 404 as a missing one
 *    (`ItemService.visibleTo`, the one place a tool adds its grant predicate),
 *    and the mutations answer 403 `guest_forbidden` (`requireNonGuest()`).
 *    The reads must not be a 403: a refusal would tell a guest the tree holds
 *    something, and the chassis expects a tool's list route to answer 200 to
 *    any principal its gates let through.
 *  - WHERE: the workspace is ALWAYS `principal.workspaceId`, the one the
 *    chassis resolved from the credential (the caller's default, or the
 *    `X-Workspace-Id` header, checked against their live memberships). It is
 *    never read from a body, a query or a path.
 *  - An item of another workspace answers the same 404 as one that does not
 *    exist: existence is not probeable across workspaces.
 *  - PROJECTS: an item's payload names the projects the caller can read and
 *    no other; `?project=` names one the caller must be able to read (404
 *    otherwise, like the project itself); the tiered answer of the chassis
 *    holds on the link and the unlink alike (404 to whoever cannot read the
 *    project, 403 to a proven reader below the editor role, 409 on an
 *    archived project). A create naming several projects answers ONE 404
 *    for the first that does not qualify, whatever the reason: a batch is
 *    not a probe.
 *  - Every mutation names its audit row (`c.set('audit', …)`): the chassis
 *    writes the row after the handler, and without the name it would only
 *    record the method and the path.
 *  - Machines pass the scope allowlist before they get here
 *    (`middleware/scopes.ts`): `items:read` for the reads, `items:write` for
 *    the mutations, the two link routes included.
 */
export function registerItemRoutes(api: OpenAPIHono, service: ItemService): void {
  api.use('/items', requireAuth());
  api.use('/items/*', requireAuth());
  // A mixed tree (reads open to a guest, mutations closed) on path-level
  // middleware: the guard skips the reads, the chassis's own idiom for a gate
  // that covers part of a path (`/invitations/:id`).
  const nonGuest = requireNonGuest();
  const mutationsRefuseGuests: MiddlewareHandler = (c, next) =>
    c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : nonGuest(c, next);
  api.use('/items', mutationsRefuseGuests);
  api.use('/items/*', mutationsRefuseGuests);

  /** An item's payload AS THIS CALLER reads it: its projects are the ones they can read. */
  const wireMany = async (principal: Principal, rows: Item[]) => {
    const projectsByItem = await service.projectsOf(
      principal,
      rows.map((r) => r.id)
    );
    return rows.map((r) => toWire(r, projectsByItem.get(r.id) ?? []));
  };
  const wire = async (principal: Principal, item: Item) => (await wireMany(principal, [item]))[0]!;

  const notFound = () => err('not_found', 'Item not found');
  const projectNotFound = () => err('project_not_found', 'Project not found');

  api.openapi(itemsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit, project } = c.req.valid('query');
    // `project` names a project the caller must be able to READ: 404
    // otherwise, like the project itself.
    if (project !== undefined && (await service.projectRoleOf(principal, project)) === null) {
      return c.json(projectNotFound(), 404);
    }
    const { page, nextCursor } = await service.list(principal, { cursor, limit, projectId: project });
    return c.json({ items: await wireMany(principal, page), nextCursor }, 200);
  });

  api.openapi(itemCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const body = c.req.valid('json');
    const result = await service.create(principal, {
      name: body.name,
      note: body.note,
      projectIds: body.projectIds
    });
    if (!result.ok) {
      // One answer for "no such project", "not yours to read" and "not yours
      // to link into": nothing about a project is probeable here.
      return c.json(
        {
          error: {
            code: 'project_not_found',
            message: 'A project named in projectIds was not found, is archived, or needs the editor role',
            details: { projectId: result.failure.projectId }
          }
        },
        404
      );
    }
    const { item } = result;
    c.set('audit', {
      action: 'item.create',
      resourceType: 'item',
      resourceId: item.id,
      metadata: { name: item.name, ...(body.projectIds?.length ? { projectIds: body.projectIds } : {}) }
    });
    return c.json({ item: await wire(principal, item) }, 201);
  });

  api.openapi(itemGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const item = await service.get(principal, id);
    if (!item) return c.json(notFound(), 404);
    return c.json(await wire(principal, item), 200);
  });

  api.openapi(itemUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const item = await service.update(principal.workspaceId, id, patch);
    if (!item) return c.json(notFound(), 404);
    c.set('audit', {
      action: 'item.update',
      resourceType: 'item',
      resourceId: item.id,
      // WHICH fields changed, never their content: a note may be long or private.
      metadata: { fields: Object.keys(patch) }
    });
    return c.json(await wire(principal, item), 200);
  });

  api.openapi(itemDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    // The final snapshot names the projects the item sat in, read BEFORE the
    // delete: the cascade takes the links with the row.
    const projects = (await service.projectsOf(principal, [id])).get(id) ?? [];
    const item = await service.delete(principal.workspaceId, id);
    if (!item) return c.json(notFound(), 404);
    c.set('audit', {
      action: 'item.delete',
      resourceType: 'item',
      resourceId: item.id,
      metadata: { name: item.name }
    });
    return c.json(toWire(item, projects), 200);
  });

  // ── Projects ───────────────────────────────────────────────────────────────
  // The chassis owns the project; these two routes are the item's side of it.
  // Both change what the project holds, so both ask the same of the project:
  // the editor role or more, and a live project. Order: the item's 404, then
  // the project's 404, 403, 409. A member who cannot read the project learns
  // nothing from either route, not even whether the item is in it.
  const projectArchived = () => err('project_archived', 'The project is archived: unarchive it to change it');

  /** The item, then the project gate: the refusal to answer when one refuses, else the item. */
  const itemAndProjectGate = async (
    principal: Principal,
    id: string,
    projectId: string
  ): Promise<{ item: Item } | { status: 403 | 404; body: ReturnType<typeof err> }> => {
    const item = await service.get(principal, id);
    if (!item) return { status: 404, body: notFound() };
    const role = await service.projectRoleOf(principal, projectId);
    if (role === null) return { status: 404, body: projectNotFound() };
    if (!projectRoleAtLeast(role, 'editor')) {
      return {
        status: 403,
        body: err('insufficient_project_role', 'This needs the editor role on the project')
      };
    }
    return { item };
  };

  api.openapi(itemProjectLinkRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, projectId } = c.req.valid('param');
    const gate = await itemAndProjectGate(principal, id, projectId);
    if (!('item' in gate)) return c.json(gate.body, gate.status);
    const outcome = await service.linkProject(gate.item, projectId, principal.userId);
    if (outcome === 'not_found') return c.json(projectNotFound(), 404);
    if (outcome === 'archived') return c.json(projectArchived(), 409);
    c.set('audit', {
      action: 'item.project_link',
      resourceType: 'item',
      resourceId: gate.item.id,
      metadata: { projectId }
    });
    return c.json(await wire(principal, gate.item), 200);
  });

  api.openapi(itemProjectUnlinkRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, projectId } = c.req.valid('param');
    const gate = await itemAndProjectGate(principal, id, projectId);
    if (!('item' in gate)) return c.json(gate.body, gate.status);
    const outcome = await service.unlinkProject(gate.item, projectId);
    if (outcome === 'not_found') return c.json(projectNotFound(), 404);
    if (outcome === 'archived') return c.json(projectArchived(), 409);
    if (outcome === 'not_linked') return c.json(err('not_linked', 'This item is not in that project'), 404);
    c.set('audit', {
      action: 'item.project_unlink',
      resourceType: 'item',
      resourceId: gate.item.id,
      metadata: { projectId }
    });
    return c.json(await wire(principal, gate.item), 200);
  });
}
