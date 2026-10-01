import { INTEGRATION_ENV_KEYS, type IntegrationName } from '@app/contract';

/**
 * The two third-party services the starter calls (Gradium for the voice, H for
 * an agent in a cloud browser) fail in two ways, and the API answers each the
 * same way on every route that needs one:
 *
 *  - the key is not set: 503 `integration_not_configured`, naming the env key
 *    and the `.env` file, with `details: { integration, envKey }`;
 *  - the provider refused or did not answer: 502 `integration_failed`, with
 *    the provider's HTTP status in `details` when there was one. The message
 *    carries at most 200 characters of what the provider said, and never the
 *    key.
 */

export { INTEGRATION_ENV_KEYS, type IntegrationName };

export const INTEGRATION_LABELS: Record<IntegrationName, string> = {
  gradium: 'Gradium',
  h: 'H'
};

/** How much of a provider's answer a message may carry. */
export const PROVIDER_DETAIL_MAX = 200;

/** One line, at most `PROVIDER_DETAIL_MAX` characters, the key (when known) replaced. */
export function clipDetail(text: string, secret?: string): string {
  let line = text.replace(/\s+/g, ' ').trim();
  if (secret) line = line.split(secret).join('***');
  return line.length > PROVIDER_DETAIL_MAX ? `${line.slice(0, PROVIDER_DETAIL_MAX - 1)}…` : line;
}

/** A call to a provider that did not give the answer asked for. */
export class IntegrationError extends Error {
  constructor(
    readonly integration: IntegrationName,
    message: string,
    /** The provider's HTTP status, when it answered one. */
    readonly providerStatus?: number
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, string | number> };
}

/** The 503 body of a route whose integration has no key. */
export function notConfiguredBody(integration: IntegrationName): ApiErrorBody {
  const envKey = INTEGRATION_ENV_KEYS[integration];
  return {
    error: {
      code: 'integration_not_configured',
      message: `${INTEGRATION_LABELS[integration]} is not configured: set ${envKey} in the .env file and restart the server`,
      details: { integration, envKey }
    }
  };
}

/** The 502 body of a provider failure. */
export function failedBody(err: IntegrationError): ApiErrorBody {
  return {
    error: {
      code: 'integration_failed',
      message: err.message,
      details: {
        integration: err.integration,
        ...(err.providerStatus !== undefined ? { status: err.providerStatus } : {})
      }
    }
  };
}
