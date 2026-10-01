// Client-safe entry: pure zod schemas + seam types. No Hono anywhere on this
// path — the dashboard and SDK import from here and must stay server-free.
// The generic half lives in @antasphere/chassis-contract and is imported from
// there by its consumers — never re-exported here. What IS exported here from
// the chassis is its one instantiation with the tool's scopes (./chassis.ts),
// beside the tool's identity, the one definition that names it (./identity.ts).
export { IDENTITY } from './identity.js';
export {
  scopeSchema,
  apiKeySchema,
  apiKeysListSchema,
  apiKeyCreateSchema,
  apiKeyCreatedSchema,
  cliAuthCompletedSchema,
  meResponseSchema,
  type Scope,
  type ApiKeyInfo,
  type ApiKeyCreate,
  type ApiKeyCreated,
  type CliAuthCompleted,
  type MeResponse
} from './chassis.js';
// Lane F (PRDCT-2308): the one motion, written once and mirrored by tests.
export * from './motion.js';
// The tool's own schemas: one file per resource under `./schemas/`, exported here.
export * from './schemas/items.js';
export * from './schemas/integrations.js';
export * from './schemas/voice.js';
export * from './schemas/runs.js';
