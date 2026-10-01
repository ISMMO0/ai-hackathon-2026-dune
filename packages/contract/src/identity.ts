import type { ToolIdentity } from '@antasphere/chassis-contract';

/**
 * The identity of this tool: every value that names it where a person, an
 * agent or an operator can see it, written ONCE. The contract, the server and
 * the CLI read it from here (the SDK and the dashboard can: they already depend
 * on this package); the chassis packages spell none of it.
 *
 * In the template the name is neutral, a made-up word that stands only where
 * an identity value belongs. `pnpm instantiate` (scripts/instantiate.mjs)
 * replaces it here and everywhere below with a tool's own name. It has no
 * rule for `apiKeyPrefix`: a tool chooses its three letters and replaces them
 * here, in the tests that pin them and in the docs.
 *
 * What cannot read a value at run time (package names, the `bin` key of the
 * CLI's package.json, the image reference in the Dockerfile and the compose
 * files, the clone URL and install path of the operator scripts, the env var
 * names in shell scripts and docs) spells it, and the instantiate script keeps
 * it in step. The workspace scope `@app/*` and the Postgres role and database
 * `app` are the same in every tool: they are not identity.
 */
export const IDENTITY = {
  slug: 'starter',
  displayName: 'Hackathon Starter',
  apiKeyPrefix: 'ytk',
  scopes: {
    read: 'items:read',
    write: 'items:write',
    dataExport: 'data:export'
  },
  cliKeyScopesLabel: 'items:read+write',
  cli: {
    bin: 'starter',
    envPrefix: 'STARTER',
    legacyConfigDir: 'starter'
  },
  mcp: {
    serverName: 'starter',
    toolPrefix: 'starter_'
  },
  otelServiceName: 'starter',
  imageName: 'ghcr.io/antasphere/starter'
} as const satisfies ToolIdentity;
