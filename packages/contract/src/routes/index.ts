import { createRoute } from '@hono/zod-openapi';
import {
  apiErrorSchema,
  auditedSizeBytes,
  declareRouteEntitlements,
  declaredContentLength,
  type EntitlementRequest
} from '@antasphere/chassis-contract';
import {
  defineChassisRoutes,
  errorResponses,
  fileUploadRoute,
  jsonBody,
  jsonRequestBody,
  uuidParams
} from '@antasphere/chassis-contract/routes';
import { chassisContract } from '../chassis.js';
import { IDENTITY } from '../identity.js';
import {
  itemCreatedSchema,
  itemCreateSchema,
  itemProjectParamsSchema,
  itemSchema,
  itemsListQuerySchema,
  itemsListSchema,
  itemUpdateSchema
} from '../schemas/items.js';
import { integrationsQuerySchema, integrationsSchema } from '../schemas/integrations.js';
import {
  savedVoiceSchema,
  voiceCandidateSchema,
  voiceDesignSchema,
  voiceSaveSchema,
  voiceSpeakSchema,
  voiceSpeechSchema,
  voiceTranscribeSchema,
  voiceTranscriptSchema
} from '../schemas/voice.js';
import {
  runCreatedSchema,
  runCreateSchema,
  runSchema,
  runsListQuerySchema,
  runsListSchema
} from '../schemas/runs.js';
/**
 * Server-only entry: route contracts for @hono/zod-openapi. Importing this
 * path pulls Hono — the dashboard and SDK must import the package root
 * instead. The OpenAPI document at /api/v1/openapi.json is generated from
 * these definitions; they are the single source of truth for the API shape.
 */

/**
 * The generic routes that carry something of the tool, instantiated ONCE with
 * the tool's scopes (../chassis.ts), its identity (../identity.ts) and the
 * tool's wording of the one OpenAPI sentence that names its domain. Every
 * other generic route contract is a static export of
 * `@antasphere/chassis-contract/routes`.
 */
export const {
  meRoute,
  apiKeysListRoute,
  apiKeyCreateRoute,
  apiKeyRevokeRoute,
  cliAuthCompleteRoute,
  ssoCliConnectRoute,
  workspaceExportRoute,
  fileDeleteRoute
} = defineChassisRoutes(chassisContract, IDENTITY, {
  // Items reference no blob today, so no 409 is ever sent; a resource that binds files names itself here.
  fileInUseOpenApi: 'file_in_use: referenced by a resource of the workspace'
});

// ── Items ────────────────────────────────────────────────────────────────────
// The tool's own route contracts follow the chassis head, one block per
// resource. They are built from the chassis's own pieces (`errorResponses`,
// `jsonRequestBody`, `uuidParams`, `cursorPageQuerySchema`) so a tool route
// reads, validates and documents itself exactly like a generic one.
//
// Items belong to the WORKSPACE the request runs in (the caller's default, or
// the one `X-Workspace-Id` names): every member reads and writes them, a guest
// has none (403). An item of another workspace answers the same 404 as one
// that does not exist. Machines: `items:read` for the two reads, `items:write`
// for the mutations (the allowlist of the server's `middleware/scopes.ts`).
//
// An item sits in the workspace's PROJECTS (the chassis concept) through the
// tool's own link: `projectIds` on a create, `?project=` on the list, and the
// two link routes below. A project the caller cannot read answers 404, never
// 403, like the project itself.

export const itemsListRoute = createRoute({
  method: 'get',
  path: '/items',
  tags: ['items'],
  summary: 'List the items of the workspace (cursor-paginated, newest first), or of one project',
  request: { query: itemsListQuerySchema },
  responses: {
    200: jsonBody(itemsListSchema, 'Items, newest first'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: jsonBody(
      apiErrorSchema,
      'project_not_found: the `project` filter names a project the caller cannot read'
    )
  }
});

export const itemCreateRoute = createRoute({
  method: 'post',
  path: '/items',
  tags: ['items'],
  summary: 'Create an item in the workspace, linked to the projects it names',
  request: {
    body: jsonRequestBody(itemCreateSchema, 'The name, the optional note, the optional projects')
  },
  responses: {
    201: jsonBody(itemCreatedSchema, 'Created item'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: jsonBody(
      apiErrorSchema,
      'project_not_found: a project of projectIds is unknown, unreadable, archived, or needs the editor role'
    )
  }
});

export const itemGetRoute = createRoute({
  method: 'get',
  path: '/items/{id}',
  tags: ['items'],
  summary: 'One item (404 when it is not in this workspace)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(itemSchema, 'Item'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const itemUpdateRoute = createRoute({
  method: 'patch',
  path: '/items/{id}',
  tags: ['items'],
  summary: 'Change the name and/or the note of an item',
  request: {
    params: uuidParams,
    body: jsonRequestBody(itemUpdateSchema, 'Fields to change (at least one)')
  },
  responses: {
    200: jsonBody(itemSchema, 'Updated item'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const itemDeleteRoute = createRoute({
  method: 'delete',
  path: '/items/{id}',
  tags: ['items'],
  summary: 'Delete an item',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(itemSchema, 'Deleted item (final snapshot)'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

// ── Items in projects ────────────────────────────────────────────────────────
// The chassis owns the project; the link is the tool's. Both routes change
// what the project holds, so both ask the editor role or more on a live
// project, with the chassis's tiers: 404 to whoever cannot read the project,
// 403 below the role, 409 on an archived one.

export const itemProjectLinkRoute = createRoute({
  method: 'put',
  path: '/items/{id}/projects/{projectId}',
  tags: ['items', 'projects'],
  summary: 'Put an item in a project (the editor role or more on the project)',
  request: { params: itemProjectParamsSchema },
  responses: {
    200: jsonBody(itemSchema, 'The item, with the project among its projects'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: jsonBody(apiErrorSchema, 'guest_forbidden, or insufficient_project_role'),
    404: jsonBody(apiErrorSchema, 'Item not found, or project_not_found'),
    409: jsonBody(apiErrorSchema, 'The project is archived (project_archived)')
  }
});

export const itemProjectUnlinkRoute = createRoute({
  method: 'delete',
  path: '/items/{id}/projects/{projectId}',
  tags: ['items', 'projects'],
  summary: 'Take an item out of a project (the editor role or more on the project)',
  request: { params: itemProjectParamsSchema },
  responses: {
    200: jsonBody(itemSchema, 'The item, without the project'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: jsonBody(apiErrorSchema, 'guest_forbidden, or insufficient_project_role'),
    404: jsonBody(apiErrorSchema, 'Item not found, project_not_found, or not_linked'),
    409: jsonBody(apiErrorSchema, 'The project is archived (project_archived)')
  }
});

// ── Integrations ─────────────────────────────────────────────────────────────
// The starter's two third-party services: Gradium (the voice) and H (the agent
// in a cloud browser). A route that needs one whose key is not set answers 503
// `integration_not_configured` with `details: { integration, envKey }`; a
// provider that refuses or does not answer is 502 `integration_failed` with its
// status in `details`. Machines: the read scope.

/** The 503 and the 502 every route that calls a provider may answer. */
export const integrationErrorResponses = {
  502: jsonBody(apiErrorSchema, 'integration_failed: the provider refused or did not answer'),
  503: jsonBody(
    apiErrorSchema,
    'integration_not_configured: the key is not set (details: integration, envKey)'
  )
} as const;

export const integrationsRoute = createRoute({
  method: 'get',
  path: '/integrations',
  tags: ['integrations'],
  summary: 'Whether Gradium and H are configured; with check=true, one cheap live call to each',
  request: { query: integrationsQuerySchema },
  responses: {
    200: jsonBody(integrationsSchema, 'One line per integration'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

// ── Voice ────────────────────────────────────────────────────────────────────
// Gradium's text to speech and speech to text. Both are writes: they spend the
// workspace's Gradium credits, so a guest is refused (403 guest_forbidden) and
// a machine needs the write scope. Nothing is stored.

export const voiceSpeakRoute = createRoute({
  method: 'post',
  path: '/voice/speak',
  tags: ['voice'],
  summary: 'Speak a text: the wav file, base64 encoded',
  request: { body: jsonRequestBody(voiceSpeakSchema, 'The text to speak (1 to 2000 characters)') },
  responses: {
    200: jsonBody(voiceSpeechSchema, 'The audio'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    ...integrationErrorResponses
  }
});

export const voiceDesignRoute = createRoute({
  method: 'post',
  path: '/voice/design',
  tags: ['voice'],
  summary: 'Design and audition one temporary Gradium voice candidate',
  request: { body: jsonRequestBody(voiceDesignSchema, 'The voice description and preview line') },
  responses: {
    200: jsonBody(voiceCandidateSchema, 'The temporary candidate and its preview audio'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    ...integrationErrorResponses
  }
});

export const voiceSaveRoute = createRoute({
  method: 'post',
  path: '/voice/save',
  tags: ['voice'],
  summary: 'Convert a temporary Gradium voice candidate into a reusable voice',
  request: { body: jsonRequestBody(voiceSaveSchema, 'The candidate and tutor identity') },
  responses: {
    200: jsonBody(savedVoiceSchema, 'The permanent Gradium voice id'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    ...integrationErrorResponses
  }
});

export const voiceTranscribeRoute = createRoute({
  method: 'post',
  path: '/voice/transcribe',
  tags: ['voice'],
  summary: 'Transcribe a wav file (base64, at most 5 MiB decoded)',
  request: {
    body: jsonRequestBody(voiceTranscribeSchema, 'The audio, its type, and the optional language')
  },
  responses: {
    200: jsonBody(voiceTranscriptSchema, 'The transcript'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    413: jsonBody(apiErrorSchema, 'payload_too_large: the body is over 8 MiB'),
    ...integrationErrorResponses
  }
});

// ── Runs ─────────────────────────────────────────────────────────────────────
// A web task carried out by H's agent in a cloud browser. The create asks H
// first and answers at once, the run `running`; the read of one run asks H
// where it is (so a client polls `GET /runs/{id}`), the list asks nothing.
// A member sees the workspace's runs, a guest none (the list is empty, an id
// is the 404 of a missing one) and is refused the create. Machines: the read
// scope for the reads, the write scope for the create.

export const runsListRoute = createRoute({
  method: 'get',
  path: '/runs',
  tags: ['runs'],
  summary: 'List the runs of the workspace (cursor-paginated, newest first), as last seen',
  request: { query: runsListQuerySchema },
  responses: {
    200: jsonBody(runsListSchema, 'Runs, newest first'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

export const runCreateRoute = createRoute({
  method: 'post',
  path: '/runs',
  tags: ['runs'],
  summary: 'Start a run: H opens a cloud browser and carries out the instruction',
  request: { body: jsonRequestBody(runCreateSchema, 'The instruction, and the optional https start URL') },
  responses: {
    201: jsonBody(runCreatedSchema, 'The run, running'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    ...integrationErrorResponses
  }
});

export const runGetRoute = createRoute({
  method: 'get',
  path: '/runs/{id}',
  tags: ['runs'],
  summary: 'One run, refreshed from H while it is running (404 when it is not in this workspace)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(runSchema, 'Run'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    ...integrationErrorResponses
  }
});

// ── The prices, the limits and the feature ──────────────────────────────────
// The billing rail's declaration layer (the pay-per-use billing rail spec, §7
// and §8b): a route says ONCE, beside its contract, what it meters, which limit
// it checks and which feature it needs, and the chassis's one gate enforces it
// for the dashboard, the CLI and the MCP tools alike, emitting the usage event
// after a 2xx. No handler checks or emits by hand. The credits, the per-tier
// values and the feature switches are the `entitlements` slot's
// (`apps/server/src/tool.ts`), which reads the keys below; the boot refuses a
// route that meters an action the slot does not price, checks a limit no tier
// values, or needs a feature the slot does not declare. The chassis names none
// of these keys: the generic upload route is priced HERE, by the tool.

/** The priced actions, namespaced by the tool's own price book. */
export const TOOL_ACTIONS = {
  /** One item created, priced per call. */
  itemCreate: 'items.create',
  /** Bytes kept by the generic upload, priced per mebibyte. */
  fileUpload: 'files.upload'
} as const;

/**
 * The limits a tier values. A SIZE limit (`files.maxBytes`) is checked on the
 * declared Content-Length before a byte is read. A COUNT limit
 * (`items.perWorkspace`) is checked through a hook the server supplies
 * (`ToolEntitlementHooks`): the count AFTER this action, read from the tool's
 * own tables at request time. `workspace.members` is declared and wired on
 * NO route of the tool: the hub enforces the member cap at ITS invitation
 * doors for every tool that declares it (the smallest numeric value among
 * them), and on every hub-projected workspace the tool's own invitation
 * doors answer `hub_managed` before any plan could be judged, so a
 * declaration on them could never refuse. A tool that opens a door of its
 * own into a workspace (a per-resource invitation, a claim) wires the key on
 * that door with a seats hook, as Slideless does.
 */
export const TOOL_LIMITS = {
  fileBytes: 'files.maxBytes',
  itemsPerWorkspace: 'items.perWorkspace',
  workspaceMembers: 'workspace.members'
} as const;

/**
 * The features a tier switches: declared in the slot, wired on NO route in the
 * template. The hub sells the `pro` plan, so a route that carries a feature
 * opens to a `pro` account and answers 403 `plan_required` with the upgrade
 * link to a `free` one. A feature is sold on the ACT, not on the route: the
 * declaration is `feature: { key: TOOL_FEATURES.premium, when: premiumRequested }`
 * with `when` reading the parsed body (`await ctx.body()`) for the option the
 * feature sells, judged BEFORE the plan is read so a request without the
 * option costs no hub read (Slideless's `sharePasswordSet` on the share link's
 * password is the model). The item's body has no such option, and a template
 * that invented one would close a field of every tool born from it; the
 * placeholder therefore shows the declaration and leaves the wiring to the
 * first route that sells an act.
 */
export const TOOL_FEATURES = {
  premium: 'items.premium'
} as const;

/** A count limit's hook: the count AFTER this action, or null when there is nothing to judge. */
export type CountHook = (ctx: EntitlementRequest) => Promise<number | null>;

/**
 * The hooks the server supplies to the declarations: each reads the tool's
 * own tables at request time, so the contract names them and
 * `apps/server/src/tool.ts` fills them in. A hook that resolves nothing
 * (null) leaves the route to its own handling: the gate judges no limit and
 * the handler answers as it would have.
 *
 * A route on a PUBLIC door (no principal: a form response through a share
 * link, an invitation accepted) would name its payer here too, as an
 * `ActorHook` (`meter.actor` on a metered route, the entry's `actor` on a
 * limit-only one): the token resolved to the resource, the resource to its
 * owner, the owner to the workspace's central account; null on anything
 * unresolved. The template has no public door, so it declares no actor and
 * no per-address wall in front of one; CLAUDE.md ("Adding your domain") says
 * what a tool that opens one adds.
 */
export interface ToolEntitlementHooks {
  /**
   * The item create: the workspace's items plus this one, for a caller the
   * handler would let create (not a guest; an editor or more on every live
   * project the body names); null for anyone else, so the handler's own 403
   * or 404 answers and a plan refusal never says more than the handler
   * would.
   */
  itemsOfWorkspace: CountHook;
}

/**
 * The route declarations, with the hooks the server supplies. The server
 * builds its own with the hooks of `apps/server/src/items/items-of-workspace.ts`;
 * `TOOL_ROUTE_ENTITLEMENTS` is the same list with hooks that resolve nothing,
 * for a reader outside the server (a client that wants to know which routes
 * are priced or capped; the template has none today, Slideless's shape kept
 * so a tool that adds one reads it here).
 */
export function toolRouteEntitlements(hooks: ToolEntitlementHooks) {
  return declareRouteEntitlements([
    // The tool's own route: one call, one event, the item it created on the
    // event (the handler's audit row names it, and the gate reads that row).
    // The count limit reads the workspace's items through the hook: on the
    // free plan the hundred-and-first is refused 403 plan_required with the
    // upgrade link, and a deleted item frees its slot. The gate's order on
    // the cloud edition is feature, then limit, then the credit check, so a
    // refused create costs nothing and posts nothing. A count limit on a JSON
    // route demands no Content-Length: only a size limit does.
    {
      route: itemCreateRoute,
      meter: { key: TOOL_ACTIONS.itemCreate, unit: 'call' },
      limit: { key: TOOL_LIMITS.itemsPerWorkspace, value: hooks.itemsOfWorkspace }
    },
    // The chassis's upload route: the declared Content-Length is checked against
    // the cap before a byte is read (the limit), and the size the handler
    // recorded in its audit metadata (`sizeBytes`, the stored blob's size) is
    // what is metered. On a content-addressed re-upload of bytes the workspace
    // already holds the handler records the existing blob's size beside
    // `deduplicated: true`, and that size is billed: a tool that prices new
    // bytes only reads `ctx.audit.metadata.deduplicated` in its own `quantity`.
    // On a metered account an upload with no Content-Length is refused 411
    // before the handler: a size limit judged on a body that declares nothing
    // would pass at 0 bytes.
    {
      route: fileUploadRoute,
      meter: { key: TOOL_ACTIONS.fileUpload, unit: 'bytes', quantity: auditedSizeBytes },
      limit: { key: TOOL_LIMITS.fileBytes, value: declaredContentLength }
    }
  ]);
}

/** The declarations with hooks that resolve nothing, for a reader outside the server; the server always builds its own with `toolRouteEntitlements`. */
export const TOOL_ROUTE_ENTITLEMENTS = toolRouteEntitlements({
  itemsOfWorkspace: async () => null
});
