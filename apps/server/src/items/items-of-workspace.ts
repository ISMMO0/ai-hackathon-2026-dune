import type { EntitlementRequest } from '@antasphere/chassis-contract';
import { itemCreateSchema } from '@app/contract';
import type { CountHook } from '@app/contract/routes';
import type { ToolDomain } from '../tool.js';

/**
 * The `items.perWorkspace` count of an item create: the workspace's items
 * plus the one being created, so the gate's `observed > max` refuses the
 * hundred-and-first on a free workspace and lets the hundredth through, and
 * a deleted item frees its slot. Read at request time through the late-bound
 * domain (the `entitlements` slot runs before `services`), and ONLY for a
 * caller the handler would let create: not a guest (the mutations refuse
 * one 403 `guest_forbidden`), and an editor or more on every live project
 * the body names (`ItemService.create` refuses the whole create 404
 * `project_not_found` otherwise). Anyone else gets null, so the route answers
 * on its own and a plan refusal never says more than the handler would: a
 * project's existence is not probeable through the cap either. No principal
 * or no domain: null, the route answers on its own; a lookup that throws is
 * caught and logged by the gate, which then judges nothing.
 *
 * The body is read through `ctx.body()`, the parse Hono keeps and the
 * handler's own validator reads after this. The body is held to the create's
 * WHOLE schema BEFORE any lookup (`itemCreateSchema`: the name, the note, at
 * most twenty project uuids): a body the validator will refuse is null here,
 * so the hook never runs a query per element of an unbounded list nor throws
 * on a value that is not a uuid (the verifier's round 1), never judges the
 * cap on a create the validator refuses for its name (round 2), and the
 * validator's 400 follows. A body that names no project counts as a create
 * with no project.
 */
export function itemsOfWorkspace(getTool: () => ToolDomain | null): CountHook {
  return async (ctx: EntitlementRequest) => {
    const domain = getTool();
    const principal = ctx.principal;
    if (!domain || !principal) return null;
    if (principal.origin === 'guest') return null;
    const parsed = itemCreateSchema.safeParse(await ctx.body());
    if (!parsed.success) return null;
    const projectIds = parsed.data.projectIds ?? [];
    if (!(await domain.items.mayCreate(principal, projectIds))) return null;
    return (await domain.items.count(principal.workspaceId)) + 1;
  };
}
