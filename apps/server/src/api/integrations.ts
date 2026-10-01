import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { integrationsRoute } from '@app/contract/routes';
import { requireAuth } from '@antasphere/chassis-server/middleware';
import {
  IntegrationError,
  failedBody,
  integrationStatus,
  notConfiguredBody,
  type IntegrationName,
  type Integrations
} from '../integrations/index.js';

/**
 * `GET /integrations`: whether the server holds the Gradium and H keys, and
 * with `?check=true` one cheap live call to each. Any signed-in member reads
 * it (a guest too: it says nothing about the workspace); machines need the
 * read scope. It never answers the key, and a live check that fails is a 200
 * with `ok: false` and the reason, not an error: the page shows it.
 */
export function registerIntegrationRoutes(api: OpenAPIHono, integrations: Integrations): void {
  api.use('/integrations', requireAuth());

  api.openapi(integrationsRoute, async (c) => {
    const { check } = c.req.valid('query');
    return c.json(await integrationStatus(integrations, check === 'true'), 200);
  });
}

/** The 503 of a route whose integration has no key. */
export function notConfigured(c: Context, integration: IntegrationName) {
  return c.json(notConfiguredBody(integration), 503);
}

/**
 * The 502 of a provider failure. Anything that is not an IntegrationError is
 * a bug of ours, not the provider's: it is thrown on, to the chassis's 500.
 */
export function providerFailed(c: Context, err: unknown) {
  if (err instanceof IntegrationError) return c.json(failedBody(err), 502);
  throw err;
}
