import { z } from 'zod';
import {
  blankToUndefined,
  buildEnvSchema,
  parseEnv as parseChassisEnv,
  type EnvExtension,
  type EnvOptions,
  type ToolEnv
} from '@antasphere/chassis-server/env';
import { INTRINSIC_VERSION } from './version.js';

export { hubConfig, type HubConfig } from '@antasphere/chassis-server/env';

/**
 * The tool's environment: the chassis schema (every generic key, declared in
 * `@antasphere/chassis-server/env`) plus the tool's own keys below. The docs
 * env reference is generated from the MERGED schema, so each tool key also
 * says which chassis key it follows.
 *
 * Two keys of its own, both optional: the voice (Gradium) and the agent in a
 * cloud browser (H). A key left unset keeps the server booting; every route
 * that needs it answers 503 `integration_not_configured` naming it
 * (`./integrations/errors.ts`). To add another: declare it here with its doc
 * comment (the zod helpers `numeric`, `httpUrl`, `blankToUndefined` come from
 * `@antasphere/chassis-server/env`), place it with `after`, add a `refine` for
 * a cross-key check, then run `pnpm --filter @app/server docs:env`.
 */
const toolEnvShape = {
  /** Gradium API key: the voice (text to speech, speech to text). Create one in the Gradium console, https://gradium.ai. Unset = the voice routes answer 503 integration_not_configured. */
  GRADIUM_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  /** H Company API key: the agent that carries out a web task in a cloud browser (the runs). Create one at https://platform.hcompany.ai/settings/api-keys. Unset = the run routes answer 503 integration_not_configured. */
  HAI_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional())
};

export type ToolEnvShape = typeof toolEnvShape;

/** The env slot of the tool definition (tool.ts): the tool's keys, their placement, their cross-key check. */
export const toolEnvExtension: EnvExtension<ToolEnvShape> = {
  shape: toolEnvShape,
  // Where each tool key sits in the merged schema (and so in the reference).
  after: { GRADIUM_API_KEY: 'NODE_ENV', HAI_API_KEY: 'NODE_ENV' }
};

const envOptions: EnvOptions<ToolEnvShape> = {
  version: INTRINSIC_VERSION,
  extension: toolEnvExtension
};

export const envSchema = buildEnvSchema(envOptions);

export type Env = ToolEnv<ToolEnvShape>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseChassisEnv(source, envOptions);
}
