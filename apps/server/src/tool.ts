import { createDb } from '@app/db';
import { IDENTITY } from '@app/contract';
import {
  apiKeyCreateRoute,
  apiKeyRevokeRoute,
  apiKeysListRoute,
  cliAuthCompleteRoute,
  fileDeleteRoute,
  meRoute,
  ssoCliConnectRoute,
  TOOL_ACTIONS,
  TOOL_FEATURES,
  TOOL_LIMITS,
  toolRouteEntitlements,
  workspaceExportRoute
} from '@app/contract/routes';
import type { BootOverrides, BootResult, ToolDefinition } from '@antasphere/chassis-server';
import { MAIL_COPY } from './email/brand.js';
import { toolEnvExtension, type ToolEnvShape } from './env.js';
import { INTRINSIC_VERSION } from './version.js';
import { findMigrationsFolder, publicDir } from './runtime.js';
import { CLI_KEY_SCOPES, OAUTH_SCOPES, requiredScopeFor } from './middleware/scopes.js';
import { toolMcp } from './mcp/index.js';
import { registerItemRoutes } from './api/items.js';
import { ItemService } from './items/service.js';
import { itemExportEntries } from './items/export.js';
import { itemsOfWorkspace } from './items/items-of-workspace.js';
import { blobReadScope } from './files/blob-read-scope.js';
import { buildIntegrations, type Integrations, type ToolOverrides } from './integrations/index.js';
import { registerIntegrationRoutes } from './api/integrations.js';
import { VOICE_TRANSCRIBE_PATH, registerVoiceRoutes, voiceTranscribeBodyCap } from './api/voice.js';
import { registerRunRoutes } from './api/runs.js';
import { RunService } from './runs/service.js';
import { runExportEntries } from './runs/export.js';
import { runJobs } from './runs/jobs.js';

/**
 * The tool definition: what the domain plugs into the chassis composition
 * (`createPlatform`, `@antasphere/chassis-server`). Every ORDER — the boot
 * sequence, the API app's middleware and route registration, the root app's
 * mounts — belongs to the chassis; this file only fills its named slots.
 *
 * What the placeholder resource (items) fills: `runtime` (the migrations folder
 * holds `0001_items`), `db` (the handle carries the `items` table), `scopes`
 * (`items:read` / `items:write` and the rule over `/api/v1/items`), `services`
 * (the `ItemService`, which also owns WHO sees an item: a member all of the
 * workspace's, a guest none, since the template ships no per-item grant; and
 * the item's side of the chassis's PROJECTS, through the tool's own link
 * table and the one predicate the chassis exports: `./items/projects.ts`),
 * `api.filePolicy` (items reference no blob),
 * `api.exportEntries` (the workspace's items and their project links leave
 * in its export, as `items.json` and `item_projects.json`: `./items/export.ts`),
 * `api.routes` (the five item routes and the two link routes) and `mcp` (the
 * seven item tools, thin shims over those routes: `./mcp/tools.ts`; the
 * chassis registers `<toolPrefix>whoami`, the eleven project tools and the
 * two team reads itself, before them), and `entitlements` (the billing rail: the two priced actions,
 * the upload cap and the item count per tier, the member cap the hub
 * enforces, one feature, over the route declarations of
 * `@app/contract/routes` built with the count hook of
 * `./items/items-of-workspace.ts`; below). `identity` is the ONE definition
 * that names the tool (`@app/contract`, `identity.ts`), and `copy` its wording
 * of the three chassis refusals that name a domain.
 *
 * The optional slots it leaves EMPTY, and what a tool puts there (each is
 * described at its declaration in `ToolDefinition`):
 *
 *  - `env` (`./env.ts`): filled by the starter, its two integration keys
 *    (`GRADIUM_API_KEY`, `HAI_API_KEY`), both optional.
 *  - `jobs`: filled by the starter, the `runs-sweep` queue every minute
 *    (`./runs/jobs.ts`).
 *  - `rateLimiters`: its own named rate-limit buckets.
 *  - `api.untrustedOrigins`: a second origin that serves user content and must
 *    never be trusted as the app's.
 *  - `api.csrfExempt`: its token-authed, cookie-less paths the cross-site
 *    guard lets through.
 *  - `api.auditExempt`: its public paths that must land no generic audit row.
 *  - `api.idempotencyTargets`: its POST routes that honour `Idempotency-Key`.
 *  - `api.early`: a middleware that must run before the body caps.
 *  - `api.bodyLimit`: filled by the starter, 8 MiB on the transcribe route
 *    (`./api/voice.ts`).
 *  - `api.jsonDepthExempt`: its paths whose body is never parsed as JSON.
 *  - `api.rateLimits`: the walls that spend its buckets.
 *  - `app.*` (`rootMiddleware`, `cspFrameSrc`, `publicRoutes`): a public,
 *    unauthenticated surface outside `/api/v1`.
 *  - `app.cspImgSrc`: extra `img-src` sources of the dashboard CSP (`blob:`
 *    for a dashboard that shows images it fetched through the API). The item
 *    pages show none.
 *  - `membershipRemoval` (slot 23): the tool's half of a member's removal,
 *    run in the removal's transaction on both editions. Items hang nothing on
 *    a person in a workspace (no invite, no per-person grant: an item's grant
 *    rides on the chassis's projects, which the chassis ends itself), so
 *    there is nothing to end here.
 *  - `demoSessionRefusedRoutes` (slot 24): the tool's own routes a session a
 *    demo link opened is refused (a visit mints no credential). No item route
 *    answers a credential (an invite link, a claim link, a key);
 *    `test/unit/demo-pass-rules.test.ts` walks the contract and fails on the
 *    first that does without joining this list.
 *
 * A slot is added when the domain has something to put there, with the test
 * that pins the hand-over in `test/integration/tool-slots.test.ts`.
 */

/** The domain's services: what `services` builds and `BootResult.tool` exposes. */
export interface ToolDomain {
  items: ItemService;
  /** Gradium and H, each null when its key is not set (`./integrations/index.ts`). */
  integrations: Integrations;
  /** The runs: H sessions in a cloud browser (`./runs/service.ts`). */
  runs: RunService;
}

export type { ToolOverrides };
export type ToolBootOverrides = BootOverrides<ToolOverrides>;
export type ToolBootResult = BootResult<ToolEnvShape, ToolDomain>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const theTool: ToolDefinition<ToolEnvShape, ToolDomain, never, {}, ToolOverrides> = {
  identity: IDENTITY,
  runtime: {
    version: INTRINSIC_VERSION,
    findMigrationsDir: findMigrationsFolder,
    publicDir
  },
  db: createDb,
  env: toolEnvExtension,
  scopes: {
    oauth: OAUTH_SCOPES,
    cliKey: CLI_KEY_SCOPES,
    requiredScopeFor,
    contractRoutes: {
      meRoute,
      apiKeysListRoute,
      apiKeyCreateRoute,
      apiKeyRevokeRoute,
      cliAuthCompleteRoute,
      ssoCliConnectRoute,
      workspaceExportRoute,
      fileDeleteRoute
    }
  },

  // Built once at boot from the generic core (db, storage, email, events…);
  // the routes, and later the MCP tools and the jobs, all receive THIS object.
  // The integrations are built from their keys (`GRADIUM_API_KEY`,
  // `HAI_API_KEY`), or taken from the boot overrides a test passes: no test
  // ever reaches a provider.
  services: ({ db, env, overrides }) => {
    const integrations = buildIntegrations(env, overrides);
    return { items: new ItemService(db), integrations, runs: new RunService(db, integrations.h) };
  },

  // One job: the runs sweep, every minute (`./runs/jobs.ts`). The slot runs
  // before the services exist, so the handler reads the domain at run time.
  jobs: ({ getTool, logger }) => runJobs(() => getTool()?.runs ?? null, logger),

  api: {
    filePolicy: () => ({
      // Items own no files: nothing in the domain references a blob, so the
      // generic files surface may always delete one.
      blobInUse: async () => false,
      // Who may read a blob: the uploader, and the workspace's admins/owners.
      blobReadScope
    }),

    // The tool's half of `GET /workspace/export`: two entries, `items.json`
    // and `item_projects.json`. The query needs nothing of the domain, only
    // the handle and the workspace id the chassis hands over per export.
    exportEntries: () => async (db, workspaceId) => [
      ...(await itemExportEntries(db, workspaceId)),
      ...(await runExportEntries(db, workspaceId))
    ],

    routes: (api, _ctx, tool) => {
      registerItemRoutes(api, tool.items);
      registerIntegrationRoutes(api, tool.integrations);
      registerVoiceRoutes(api, tool.integrations);
      registerRunRoutes(api, tool.runs);
    },

    // One path takes a body over the 1 MiB default: the transcribe route,
    // a wav of up to 5 MiB in base64 (8 MiB with its envelope). Every other
    // path keeps the default.
    bodyLimit: () => (path) => (path === VOICE_TRANSCRIBE_PATH ? voiceTranscribeBodyCap : undefined)
    // Nothing of the chassis's projects is wired here: the tables, the routes
    // and the MCP tools are the chassis's own, registered by `createPlatform`
    // before the tool's. The tool's side is the link (`./items/projects.ts`).
  },

  mcp: toolMcp,

  // The billing rail (the pay-per-use billing rail spec, §7 and §8b): what the
  // tool prices, the limits and the features per tier, and the routes that
  // carry a meter, a limit or a feature (declared ONCE beside the route
  // contracts, `toolRouteEntitlements`). Shown on `GET /instance` (the hub
  // seeds its price book and its plan entitlements from it, a client reads
  // the limit it is held to) and enforced by the chassis's one gate, after the
  // scope gate and before the handler. On the self-hosted edition nothing is
  // metered: the gate compares a limit against its `oss` value and emits no
  // event. On the cloud edition every metered action of a hub organization is
  // checked at the hub before it runs (402 `entitlement_denied` with the
  // top-up link on an empty balance) and posted after it, and a limit or a
  // feature the account's plan does not allow answers 403 `plan_required`
  // with the upgrade link, before the credit check. A function of the
  // environment so an `oss` value can be the operator's own cap. The slot
  // also receives the chassis's `EntitlementsContext` (the database and the
  // late-bound domain, `getTool()`): the count hook reads the domain through
  // it at request time. An `actor` hook of a public door would read it the
  // same way; the template has no such door.
  //
  // The upload cap is the instance's HARD ceiling (the handler cuts the
  // stream at it), and the boot refuses a tier advertised above it: a plan
  // value the instance cannot serve must not be shown. So the `pro` value IS
  // `MAX_FILE_SIZE_MB`, and `free` is 100 MB or the cap when the cap is
  // smaller (Slideless's values, PRDCT-2653): what discovery advertises is
  // what the instance serves, on a 50 MB self-hosted instance as on a
  // 500 MB cloud one, and a self-hosted instance and a free cloud account
  // refuse an upload at the same size up to 100 MB. The item count is the
  // template's count example: a hundred items per workspace on the free
  // plan, unlimited on pro and on a self-hosted instance (`oss: null`: a
  // self-hosted instance knows no plan, and a null ceiling costs the hook no
  // lookup). The member cap is Slideless's (three seats on free) and is the
  // hub's to enforce (see `TOOL_LIMITS`). The credits are the template's
  // placeholders (a tool sets its own before its price book is seeded);
  // null = unlimited.
  entitlements: (env, { getTool }) => {
    const MB = 1024 * 1024;
    const capBytes = env.MAX_FILE_SIZE_MB * MB;
    const freeUploadBytes = Math.min(100 * MB, capBytes);
    return {
      actions: [
        { key: TOOL_ACTIONS.itemCreate, creditsPerUnit: 1, unit: 'call', label: 'Create an item' },
        // Metered in exact bytes, priced per mebibyte: 5 credits buy 1,048,576
        // bytes. The boot refuses a route whose meter unit differs from this
        // one, and items-metering.test.ts pins the credits of a 20 MB upload.
        {
          key: TOOL_ACTIONS.fileUpload,
          creditsPerUnit: 5,
          unit: 'bytes',
          per: MB,
          label: 'Upload a file (5 credits per MB)'
        }
      ],
      limits: {
        [TOOL_LIMITS.fileBytes]: { oss: capBytes, free: freeUploadBytes, pro: capBytes },
        [TOOL_LIMITS.itemsPerWorkspace]: { oss: null, free: 100, pro: null },
        [TOOL_LIMITS.workspaceMembers]: { oss: null, free: 3, pro: null }
      },
      // Declared for the paid tier, wired on no route: see TOOL_FEATURES.
      features: {
        [TOOL_FEATURES.premium]: { free: false, pro: true }
      },
      // The hook the declarations need: the workspace's items, read from the
      // domain at request time.
      routes: toolRouteEntitlements({ itemsOfWorkspace: itemsOfWorkspace(getTool) })
    };
  },

  // The chassis refusals that name a tool's domain, in this tool's words. The
  // template ships no per-item grant and items reference no blob, so the three
  // sentences stay general; a tool whose guests reach a resource, or whose
  // resource binds files, names that resource here.
  copy: {
    guestForbidden: 'Guest access is limited to what you were invited to',
    guestTarget: 'This member is an external guest — their account is not this workspace’s to recover',
    // Its OpenAPI twin is in @app/contract/routes, where the delete route is instantiated.
    fileInUse: 'This file is referenced by a resource of the workspace — delete that resource first',
    // The account mails' words that are the tool's own (email/brand.ts).
    mail: MAIL_COPY
  }
};
