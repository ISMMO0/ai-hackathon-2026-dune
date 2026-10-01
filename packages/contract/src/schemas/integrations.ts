import { z } from 'zod';

/**
 * The starter's two integrations, Gradium (the voice) and H (the agent in a
 * cloud browser), as `GET /integrations` reports them. Client-safe (pure zod).
 *
 * `configured` says whether the server holds the key. `ok` and `detail` are
 * there only when the caller asked for the live check (`?check=true`): one
 * cheap call to each provider, `ok` its outcome and `detail` one line (the
 * credits left, the session quota, or what went wrong).
 */

export const INTEGRATION_NAMES = ['gradium', 'h'] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

/** The env key each integration reads. */
export const INTEGRATION_ENV_KEYS = {
  gradium: 'GRADIUM_API_KEY',
  h: 'HAI_API_KEY'
} as const satisfies Record<IntegrationName, string>;

export const integrationStatusSchema = z.object({
  configured: z.boolean(),
  ok: z.boolean().optional(),
  detail: z.string().optional()
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const integrationsSchema = z.object({
  gradium: integrationStatusSchema,
  h: integrationStatusSchema
});
export type Integrations = z.infer<typeof integrationsSchema>;

export const integrationsQuerySchema = z.object({
  /** `true` makes the two live calls; anything else reports the keys only. */
  check: z.enum(['true', 'false']).optional()
});
export type IntegrationsQuery = z.infer<typeof integrationsQuerySchema>;
