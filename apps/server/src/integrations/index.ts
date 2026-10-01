import { createGradium, type GradiumClient } from './gradium.js';
import { createH, type HClient } from './h.js';
import { IntegrationError, type IntegrationName } from './errors.js';

export * from './errors.js';
export type { GradiumClient } from './gradium.js';
export type { HClient } from './h.js';

/**
 * The integrations of the running server: each client, or null when its key
 * is not set (every route that needs it then answers 503). Built once, by the
 * `services` slot (`../tool.ts`), from the environment; a test hands its own
 * fakes through the tool's boot overrides and never reaches a provider.
 */
export interface Integrations {
  gradium: GradiumClient | null;
  h: HClient | null;
}

/** The tool's own test seams (`BootOverrides.tool`): a fake per integration, in place of the env-built client. */
export interface ToolOverrides {
  gradium?: GradiumClient;
  h?: HClient;
}

export function buildIntegrations(
  env: { GRADIUM_API_KEY?: string | undefined; HAI_API_KEY?: string | undefined },
  overrides?: ToolOverrides
): Integrations {
  return {
    gradium:
      overrides?.gradium ?? (env.GRADIUM_API_KEY ? createGradium({ apiKey: env.GRADIUM_API_KEY }) : null),
    h: overrides?.h ?? (env.HAI_API_KEY ? createH({ apiKey: env.HAI_API_KEY }) : null)
  };
}

/** One integration's line of `GET /integrations`. */
export interface IntegrationStatus {
  configured: boolean;
  ok?: boolean;
  detail?: string;
}

/**
 * Where each integration stands. Without `check`, whether its key is set.
 * With it, one cheap live call each (Gradium's credits, H's session quota),
 * in parallel: `ok` and one line of `detail`.
 */
export async function integrationStatus(
  integrations: Integrations,
  check: boolean
): Promise<Record<IntegrationName, IntegrationStatus>> {
  const failure = (err: unknown) =>
    err instanceof IntegrationError ? err.message : err instanceof Error ? err.message : String(err);

  const gradium = async (): Promise<IntegrationStatus> => {
    if (!integrations.gradium) return { configured: false };
    if (!check) return { configured: true };
    try {
      const credits = await integrations.gradium.credits();
      return { configured: true, ok: true, detail: `${credits.remaining} credits remaining` };
    } catch (err) {
      return { configured: true, ok: false, detail: failure(err) };
    }
  };

  const h = async (): Promise<IntegrationStatus> => {
    if (!integrations.h) return { configured: false };
    if (!check) return { configured: true };
    try {
      const quota = await integrations.h.quota();
      return {
        configured: true,
        ok: true,
        detail: `${quota.available} of ${quota.limit} sessions available (${quota.active} running, ${quota.scope} quota)`
      };
    } catch (err) {
      return { configured: true, ok: false, detail: failure(err) };
    }
  };

  const [g, hh] = await Promise.all([gradium(), h()]);
  return { gradium: g, h: hh };
}
