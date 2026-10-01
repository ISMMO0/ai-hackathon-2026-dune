import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { runCreateRoute, runGetRoute, runsListRoute } from '@app/contract/routes';
import type { Run } from '@app/db';
import { requireAuth, requireNonGuest } from '@antasphere/chassis-server/middleware';
import type { RunService } from '../runs/service.js';
import { notConfigured, providerFailed } from './integrations.js';

const toWire = (run: Run) => ({
  id: run.id,
  workspaceId: run.workspaceId,
  createdBy: run.createdBy,
  instruction: run.instruction,
  startUrl: run.startUrl,
  state: run.state,
  liveUrl: run.liveUrl,
  answer: run.answer,
  error: run.error,
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
  finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null
});

/**
 * The runs routes: the item's rules (`./items.ts`), and H behind them.
 *
 *  - WHO: signed in; a member reads and starts the workspace's runs; a guest
 *    lists none, reads the 404 of a missing id, and is refused the create
 *    (403 `guest_forbidden`). Machines: the read scope for the two reads,
 *    the write scope for the create (`middleware/scopes.ts`).
 *  - WHERE: the workspace is `principal.workspaceId`, never a request value;
 *    a run of another workspace is the 404 of a missing one.
 *  - H: the create asks H first (a refusal is a 502 and writes nothing); the
 *    read of ONE running run asks H where it is before answering (so a
 *    client polls `GET /runs/{id}`); the list asks H nothing. Without
 *    `HAI_API_KEY`, the create and the read of a running run answer 503.
 *  - Audit: `run.create`, resource type `run`, the id; the instruction is
 *    content and stays out of the row.
 */
export function registerRunRoutes(api: OpenAPIHono, service: RunService): void {
  api.use('/runs', requireAuth());
  api.use('/runs/*', requireAuth());
  const nonGuest = requireNonGuest();
  const mutationsRefuseGuests: MiddlewareHandler = (c, next) =>
    c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : nonGuest(c, next);
  api.use('/runs', mutationsRefuseGuests);
  api.use('/runs/*', mutationsRefuseGuests);

  api.openapi(runsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const { page, nextCursor } = await service.list(principal, { cursor, limit });
    return c.json({ runs: page.map(toWire), nextCursor }, 200);
  });

  api.openapi(runCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const body = c.req.valid('json');
    if (!service.configured) return notConfigured(c, 'h');
    let run: Run;
    try {
      run = await service.create(principal, { instruction: body.instruction, startUrl: body.startUrl });
    } catch (err) {
      return providerFailed(c, err);
    }
    c.set('audit', {
      action: 'run.create',
      resourceType: 'run',
      resourceId: run.id,
      metadata: { withStartUrl: run.startUrl !== null }
    });
    return c.json({ run: toWire(run) }, 201);
  });

  api.openapi(runGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const run = await service.get(principal, id);
    if (!run) return c.json({ error: { code: 'not_found', message: 'Run not found' } }, 404);
    if (run.state !== 'running') return c.json(toWire(run), 200);
    if (!service.configured) return notConfigured(c, 'h');
    try {
      return c.json(toWire(await service.refresh(run)), 200);
    } catch (err) {
      return providerFailed(c, err);
    }
  });
}
