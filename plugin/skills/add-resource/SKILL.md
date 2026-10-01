---
name: add-resource
description: Add a new resource to a tool made from the Antasphere tool template, slot by slot, in the order the placeholder resource `items` was added. Use it when someone says "add a resource", "add an entity", "add a table with its API, CLI, MCP tools and page", "how was items added", or "which slots does a tool fill". Each step names the files, the tests that pin them, the gate to run, the traps, and the `items` commit to read as the worked example.
---

# Add a resource to a tool

A tool plugs into the chassis through named slots. The template holds one placeholder resource, `items`. It
was added in eight commits, one slot per commit, the gate green after each. This skill walks the same eight
steps for a new resource.

Examples use an invented resource: `notes`, a title and a body, per workspace. The worked example is always
`items`.

## How to use the worked example

Each step names one commit. Read it before you write anything.

```bash
git show --stat <sha>
git show <sha>
```

The commit message lists the files, the rules a tool respects in that slot, and the tests. The diff is the
pattern to copy. Work the way the series was built: one commit per slot, the gate green after each step.
The gate, wherever a step says "the gate":

```bash
pnpm turbo lint typecheck test build
pnpm format:check
```

`pnpm format` fixes what the second command reports. CI also runs `pnpm --filter @app/server drift:check`,
which a resource does not touch. One message in the series is out of date: `b087963` spells the migration
command with the package name of before the generic scope. The command in step 1 of this file is the right
one.

| Step | Commit                   | Slot                                               |
| ---- | ------------------------ | -------------------------------------------------- |
| 1    | `b087963`                | `db`, and the migrations folder of `runtime`       |
| 2    | `d9de350`                | the tool's contract, and the SDK methods           |
| 3    | `517b9d0`                | `services`, `api.routes`, `scopes`, the audit rows |
| 4    | `7ae80fc`                | `PlatformClient`, the SDK tests                    |
| 5    | `4ea0732`                | the CLI `registerTool`                             |
| 6    | `4821670`                | `mcp.registerTools`                                |
| 7    | `3e79d43`                | the dashboard contribution and its two doors       |
| 8    | `items 8/8` in `git log` | `api.exportEntries`, the workspace export          |

## Before you start

- [ ] The tool has been instantiated from the template. The identity literals in this file, in the commands and in the
      prose (the MCP tool prefix from `MCP_TOOL_PREFIX`, the CLI package), are the template's. Use the ones
      your tool carries. The workspace scope `@app/*` is the same in every tool.
- [ ] You have read `CLAUDE.md`, sections "The chassis packages are copies", "Invariants" and "Adding your
      domain".
- [ ] You have read the header of `apps/server/src/tool.ts`. It lists what `items` fills and every slot it
      leaves empty.
- [ ] The gate is green before your first change.

Never edit a file under `packages/chassis-*`. Those folders are copies. A need inside them is a chassis
change. Make it at the source named in `chassis-source.json`, then copy the folders again. The guard is
`pnpm chassis:check`.

The gate, after every step:

```bash
pnpm turbo lint typecheck test build
```

Where a step adds integration tests, also run this one. It needs Docker.

```bash
pnpm turbo test:integration
```

## 1. The table and its migration

Example: `b087963`. Slots: `db`, and the folder that `runtime.findMigrationsDir` points at. Gate: the turbo
gate.

- `packages/db/src/schema.ts`: declare the `notes` table and its row types, as `items` does (`Item`,
  `NewItem`). This is the ONE module for the tool's tables. `client.ts` and `drizzle.config.ts` already read
  it.
- `packages/db/drizzle/`: the migration, its snapshot under `meta/` and the journal entry. Generate them. Do
  not write them by hand.

```bash
pnpm --filter @antasphere/chassis-db build
pnpm --filter @app/db db:generate --name notes
```

A second generate must answer that there is nothing to migrate: it prints "No schema changes, nothing to
migrate" and exits 0.

Rules and traps, from the commit:

- `workspace_id` is NOT NULL and cascades. Every query carries it.
- `created_by` is nullable and SET NULL. A row is workspace data. It survives the erasure of its author's
  account.
- One index on `(workspace_id, created_at, id)`. It serves the keyset list, the chassis's pagination idiom.
- A committed migration is never edited. The baseline is never renumbered. A change to a table is a new
  generated file, appended to the pins.
- Every `.sql` file in `packages/db/drizzle` is a journal entry. The journal test fails on any other file.

Tests that pin it: `packages/db/test/migrations-journal.test.ts` pins the chain of journal entries.
`packages/db/test/migration-status.test.ts` pins the on-disk hash of each file. Append your new entry to
both.

## 2. The contract, with the SDK methods

Example: `d9de350`. Slot: the tool's contract, beside `defineChassisContract`. Gate: the turbo gate.

- `packages/contract/src/schemas/notes.ts` (new): the wire schema, the list schema, the create and update
  schemas, the limits as constants, the inferred types. Pure zod. Copy the shape of `schemas/items.ts`.
- `packages/contract/src/index.ts`: export that file from the root entry.
- `packages/contract/src/routes/index.ts`: one `createRoute` per endpoint, BELOW the `defineChassisRoutes`
  head. Build them from the chassis's pieces: `errorResponses`, `jsonRequestBody`, `uuidParams`,
  `cursorPageQuerySchema`.
- `packages/sdk/src/index.ts`: one method per route on `PlatformClient`.
- `packages/sdk/test/route-coverage.test.ts`: one coverage entry per route.

Tests that pin it: `packages/contract/test/items.test.ts` is the model for your
`packages/contract/test/notes.test.ts`. `route-coverage.test.ts` hits each route with its method.

Traps:

- **The SDK methods land HERE, not in step 4.** `route-coverage.test.ts` fails, by name, on a contract route
  with no SDK method. It has no way to name a temporary absence. Do not give it one.
- Every free-text field goes through the chassis helpers `plainText` and `noControlChars`. A NUL in a text
  column would come back as a 500. The contract refuses it as a 400.
- Every length is bounded. A name is trimmed BEFORE it is measured.
- A PATCH whose fields are all optional refuses the empty body in the schema.
- An `{id}` is `uuidParams`. A malformed id is a 400 and never reaches Postgres.
- A list answers under the resource's own plural, with `nextCursor`. `items` answers `{ items, nextCursor }`
  because the resource is called items, as the chassis answers `{ files, ... }` and `{ members, ... }`. A
  list of notes answers `{ notes, nextCursor }`. A delete answers 200 with the final snapshot.
- When you copy the schema tests, look at the "unknown key" case. `items` uses the word `title` as a key the
  schema does not know. For `notes`, `title` is a real field: pick a word your schema does not have, or the
  test passes for the wrong reason or fails.
- Routes carry no per-route scope annotation. The machine allowlist lives in the server (step 3).

## 3. The server

Example: `517b9d0`. Slots: `services`, `api.routes`, `scopes`. The audit rows land here too. Gate: the turbo
gate, then the integration suite.

- `apps/server/src/notes/service.ts` (new): the service, as `ItemService(db)`. No HTTP in it. It owns the
  ONE predicate that says which rows a caller sees, as `visibleTo(principal)` does.
- `apps/server/src/api/notes.ts` (new): one `api.openapi(route, handler)` per route, inside a
  `registerNoteRoutes(api, service)` modelled on `registerItemRoutes`.
- `apps/server/src/tool.ts`: `ToolDomain` gains the service, `services` builds it, `routes` hands it over.
- `apps/server/src/middleware/scopes.ts`: the scope rule for the new path. See the warning below.

**A machine principal reaches a new route ONLY if a rule opens it.** The allowlist in
`apps/server/src/middleware/scopes.ts` is fail-closed. The chassis rules run first, then the tool's. A path
that no rule matches answers 403 to every API key and every OAuth token. Add a rule for `/api/v1/notes`
beside the `items` rule: reads need the read scope, mutations the write scope. `517b9d0` left this file
unchanged, because the `items` rule was already there. A new resource has no rule yet.

**Which scope names: the tool's one pair.** The scope pair belongs to the TOOL, not to a resource.
`createScopeAllowlist` takes one `read` and one `write` name, and the chassis applies the same pair to
`/me` and `/files`. The template's pair is `items:read` and `items:write` because `items` is its whole
domain; a tool names its pair after its own domain, once, in the three places the file's comment lists
(this file, the `defineChassisContract` call in `packages/contract/src/chassis.ts`, the consent page copy),
and the MCP helper `run()` is typed on the same pair (`ITEM_MCP_SCOPES`). A second resource of the same
tool goes under that pair: its rule names the same two scopes. A pair of scope names per resource is NOT
something the series shows. It would also touch `OAUTH_SCOPES` and `CLI_KEY_SCOPES`, and it is a design
decision for the person, not a step of this skill.

Rules, from the commit and the header of `apps/server/src/api/items.ts`:

- The workspace is ALWAYS `principal.workspaceId`. Never a body, a query or a path.
- **404, never 403, on a read.** A row of another workspace answers the same `not_found` as a missing one.
  Existence is not probeable.
- The guest rule. READS show a guest nothing: the list answers 200 and empty, a get answers the 404 of a
  missing id. WRITES refuse a guest with 403 `guest_forbidden` (`requireNonGuest`). The guard covers the
  mutations only, through a path-level `api.use` that lets GET and HEAD through.
- The visibility rule is a predicate in the service, not an `if` in a handler. An MCP tool or a job then
  obeys it too. A tool with per-row grants puts its clause there.
- Every mutation sets `c.set('audit', ...)`. For `items`: `item.create`, `item.update`, `item.delete`,
  resource type `item`, the id. The update row names WHICH fields changed, never the content.

Tests that pin it, all under `apps/server/test/`:

- `integration/items.test.ts` is the model for your `integration/notes.test.ts`: the routes and the wire
  shape, the paged list, the 400s that write nothing, workspace isolation, the guest rule, machine scopes (a
  read key, a write key, a key with neither, and a lookalike path that stays `endpoint_not_allowed`), the
  audit rows read back through `GET /audit`.
- `integration/tool-slots.test.ts`: the services hand-over, and the served OpenAPI document lists the
  routes.
- `unit/scopes.test.ts`: the allowlist rules.
- The commit also restored chassis cases aimed at the resource, in `minted-credentials`,
  `workspace-create-isolation`, `guest-capabilities`, `input-robustness` and `hub-managed-membership-mcp`.
  Read them for the postures your resource must hold.

Trap: a test case whose slot stays empty is deleted with the reason in the commit message. It is never left
as `it.todo`.

## 4. The SDK tests

Example: `7ae80fc`. Slot: `PlatformClient`. Gate: the turbo gate.

The methods arrived in step 2. This step pins what route coverage does not prove: the rest of each call.

Files: `packages/sdk/test/notes.test.ts` (new), modelled on `packages/sdk/test/items.test.ts`. It uses a
recording fake fetch. `packages/sdk/src/index.ts` should need no change.

Rule, from the commit: a method is `this.request(METHOD, path, body?)`. The credential, the workspace
header, the deadline and the error mapping are the chassis's. A method that calls `fetch` itself loses all
four. An id goes into a path through `encodeURIComponent`, always.

Trap: `packages/sdk/test/exports.types.ts` stays unchanged. The SDK re-exports no wire type. A consumer
imports them from `@app/contract`. Add a name there only when the SDK declares a type of its own.

## 5. The CLI command group

Example: `4ea0732`. Slot: `registerTool`. Gate: the turbo gate.

- `packages/cli/src/commands/notes.ts` (new): `registerNoteCommands(program, io)`, one command per SDK
  method. The header of `commands/items.ts` lists the idioms to copy.
- `packages/cli/src/index.ts`: `registerTool` calls it, after `registerItemCommands`.
- `docs/agents/cli.md`: a section for the group. Every command and every long flag.

Tests that pin it:

- `packages/cli/test/items-cli.test.ts` is the model for your `notes-cli.test.ts`: the request of each
  command, the human output, the `--json` output equal to the wire shape, the refusals sent with no request,
  a name full of terminal control characters printed clean.
- The commit also touched three things its slot list does not name. `packages/cli/package.json` gained the
  `@app/contract` dependency (with the lockfile): that happens once per tool, a second resource does not
  repeat it. `packages/cli/src/cli.ts` holds the `errorHint` slot the group's hints go through. The command
  list of `packages/cli/test/docs-coverage.test.ts` gained the group's commands, `'items update'` among
  them: add yours.
- **`packages/cli/test/identity.test.ts` pins the order of the top-level commands.** A new command group
  edits the `COMMANDS` list there (line 136). Add `notes` under the comment "the tool's own groups, in the
  order `registerTool` registers them", after `items` (line 149) and before `instance`. The same list pins
  `--help` and the bash completion.
- `packages/cli/test/docs-coverage.test.ts` reads the built tree. It fails by name on a command or a long
  flag that `docs/agents/cli.md` does not document. It also holds a flag floor that the commit raised.

Rules, from the commit: the context is the kit's (`resolveContext`, then `requireApiKey`). A command never
redeclares a global option and never builds a client. `--json` prints the wire shape through `printJson` and
never goes through `sanitizeForTty`. Human output goes through `io.out` and the kit's `table`, free text in
the LAST column.

## 6. The MCP tools

Example: `4821670`. Slot: `mcp.registerTools`. Gate: the turbo gate, then the integration suite.

**An MCP tool re-enters the tool's own HTTP routes, in-process. It never calls a service.** Each tool is a
thin shim over the resource's `/api/v1` route, called through `callApi` with the caller's bearer forwarded.
See the header of `apps/server/src/mcp/tools.ts` (lines 18 to 28) and every `callApi` call below it (for
example line 132). `callApi` itself is `packages/chassis-server/src/mcp/tool-kit.ts` line 110: it calls
`ctx.fetchApi`. The chassis hands `registerTools` a principal and an in-process fetch, and no domain, on
purpose. So the contract's validation, the scope allowlist, the workspace check, the guest rule and the
audit rows apply to an agent exactly as to any client. New behaviour lands in the API first.

- `apps/server/src/mcp/tools.ts`: register your tools in `registerTools`, after the item tools. For `notes`,
  by the pattern of `items`: `list_notes`, `get_note`, `create_note`, `update_note`, `delete_note`. Build
  every name with the `tool(name)` helper, so the prefix is read from ONE place, `MCP_TOOL_PREFIX` (the
  `mcp.toolPrefix` of the identity, `packages/contract/src/identity.ts`). Add the
  domain's hint for `not_found` the way `ITEM_ERROR_HINTS` does.
- `apps/server/src/mcp/index.ts`: the server instructions name the new tools. Extend the literal list there
  (line 25).
- `docs/agents/mcp-connector.md`: the tool table, with scopes. `docs/index.md` and
  `docs/getting-started/connect-an-agent.md` announce the tool count.

Rules, from the commit: the chassis registers `<prefix>whoami` itself, before your tools, so never register a
`whoami` of your own.
A read tool has `readOnlyHint` and a pre-check on the read scope. A write tool has a description ending
"Always confirm with the user before calling." and a pre-check on the write scope. A delete adds
`destructiveHint`. The pre-check is UX only: the API enforces. Every tool takes the optional `workspace`
argument and threads it through `forWorkspace`.

Tests that pin it, under `apps/server/test/`:

- `integration/mcp-items.test.ts` is the model for your `mcp-notes.test.ts`. It speaks raw JSON-RPC to
  `/mcp` through the real boot. It pins `tools/list` EXACTLY, names as literals: extend that pin.
- `unit/mcp-docs-coverage.test.ts`: the docs table names every registered tool and no other, and the
  announced count is the registered count.
- `integration/hub-managed-membership-mcp.test.ts` also pins the tool list.
- `integration/cli.test.ts`: one case runs the CLI group of step 5 against a listening instance.

## 7. The dashboard

Example: `3e79d43`. Slot: the ONE contribution, and its two doors. Gate: the turbo gate.

The shell takes the tool's half as one typed object, `tool`, exported by
`apps/dashboard/src/lib/tool/index.ts`. Its shape is in `apps/dashboard/src/lib/contribution.ts`. The tool's
words come through `$lib/tool/i18n`. The shell imports the tool's half through those two doors only. The
tool's half imports the shell freely.

All paths below are under `apps/dashboard`.

- `src/lib/tool/index.ts`: the `nav` entry, `phoneTabs`, `warm()`, the `audit` actions and resource type,
  the `overview` pieces.
- `src/lib/tool/notes.ts` (new, as `items.ts`): what the page, the overview and the warm-up share. The page
  and `warm()` must agree on the list's remembered name and its ONE call.
- `src/lib/tool/components/`: the form dialog and any overview component.
- `src/routes/(app)/(tool)/notes/+page.svelte` (new): the page, built from the shell's own parts. No new
  generic UI.
- `src/lib/tool/i18n/en.ts` and `fr.ts`: every word, the same keys in both.
- `e2e/notes.spec.ts` (new) and its project in `playwright.config.ts`, before `workspaces`, which stays
  last.

**`src/lib/boundary.test.ts`, `TOOL_PATHS` (line 25, its comment from line 19), is the tool's own
declaration of where its half lives.** Today it lists `lib/tool/` and `routes/(app)/(tool)/`. A page under
`(app)/(tool)/` needs no edit. A tool that adds a route group of its own outside `(app)/(tool)` (a
signed-out page, a full-screen page) lists it there, and names it in `NAMES_THE_TOOL`. If it does not, the
boundary guard goes red at its first component. Change nothing else in that test.

Rules, from the commit: no user-facing string in a component, and no key that is also the shell's. The audit
actions in the contribution are the server's LITERALS from step 3. A guest gets the menu entry and the page,
with the empty state and none of the controls. A title and a body are user-authored: text interpolation
only, never `{@html}`.

Tests that pin it: `src/lib/tool/contribution.test.ts`, `src/lib/tool/items.test.ts` (the model for
`notes.test.ts`), `src/lib/tool/i18n/i18n.test.ts`, `src/lib/boundary.test.ts`, and the e2e spec. The series
ran `e2e/items.spec.ts` against the compose stack, together with `smoke`.

## 8. The workspace export

Example: the commit `items 8/8` (`git log --grep "items 8/8"`). Slot: `api.exportEntries`. Gate: the turbo
gate, then `pnpm turbo test:integration`.

- `apps/server/src/notes/export.ts` (new, as `items/export.ts`): one function that takes the handle and the
  workspace id the chassis gives it, and returns `[{ name: 'notes', rows }]`.
- `apps/server/src/tool.ts`: add the entries to what `api.exportEntries` returns, after `items`' while it is
  still there.

Rules, from the commit: the chassis does not filter for you, so the statement carries the workspace id in its
WHERE. Select the columns: a secret in a row leaves the instance. Keep a stable order. A name of
`RESERVED_EXPORT_ENTRY_NAMES`, the same name twice or a throw answers 500. Who may export is the chassis's
rule: add none.

Tests that pin it: `apps/server/test/integration/items-export.test.ts` (the model for
`notes-export.test.ts`): the other workspace's rows are absent, the key set of a row is pinned, the refusals
stand. The export bucket is 5 per user per 10 minutes: count your exports.

## 9. The resource in the workspace's projects

Example: the two commits `git log --grep "items in projects"` (the server half) and `git log --grep "the
project door"` (the dashboard half). Slots: none new; the seam is the chassis's one exported predicate.
Gate: the turbo gate, then `pnpm turbo test:integration`.

Every tool gets projects from the chassis: the tables, the `/projects` routes, the `projects` CLI group,
the nine MCP tools and the dashboard's Projects section. What a project HOLDS is the resource's own link,
and the resource is not done until it has one. Read the header of `apps/server/src/items/projects.ts` first:
it is the one place the tool asks the chassis its project question, and it says where a resource that is
PRIVATE to its author adds the read branch (`items` is workspace-wide and needs none).

- `packages/db/src/schema.ts`: the link table, as `itemProjects` (`note_projects`: both ends cascading,
  `workspace_id` carried, an index on `project_id`), and its generated migration.
- `packages/contract/src/schemas/notes.ts`: `projects: [{ id, name }]` on the wire shape, `projectIds` on
  the create (bounded), `project` on the list query; the two link routes in `routes/index.ts`, built on
  `itemProjectParamsSchema`'s shape. The SDK: the list param, `linkNoteProject`, `unlinkNoteProject`.
- `apps/server/src/notes/service.ts`: `projectsOf` (the payload, through `projectGrantPredicate` with
  `atLeast: 'viewer', access: 'read'`: the caller's readable projects and no other), `projectRoleOf`, the
  create linking in its own transaction (`canLinkIntoProject`, the project rows FOR SHARE first),
  `linkProject`, `unlinkProject`. `apps/server/src/api/notes.ts`: the filter's 404, the create's 404
  `project_not_found` with `details.projectId`, the link and the unlink behind ONE gate with the tiers in
  this order (the resource's 404, the project's 404, 403 `insufficient_project_role`, 409 `project_archived`;
  an unlink that asked nothing of the project would let a member on no project probe it and empty it), the
  audit rows `note.project_link` and `note.project_unlink`.
- `apps/server/src/notes/export.ts`: the `note_projects` entry after `notes`.
- The CLI: `--project` on `list` (through `withProjectRefusal`, so a project the caller cannot read is a
  sentence and not an empty page) and on `create` (repeatable), the `projects:` line of `show`, and the two
  verbs on the chassis's `projects` group (`packages/cli/src/commands/projects.ts`; a resource that is not
  the tool's main one names itself in the verb, `projects link-note`).
- The MCP tools: `projectId` on the list, `projectIds` on the create, `link_note_to_project` and
  `unlink_note_from_project`; the hints the resource adds (`project_not_found`, `not_linked`) over the
  chassis's project table, which already carries `project_archived` and `insufficient_project_role`.
- The dashboard: the door `tool.project.Resources` shows what a project holds; a second resource shares it
  (one piece, two lists) or the tool decides how the page reads. The project chips and the project filter of
  the resource's page follow `ItemProjectTags` and `ProjectFilter`.

Tests that pin it: `apps/server/test/integration/items-projects.test.ts` (the model for
`notes-projects.test.ts`), the export test's entry, `packages/cli/test/projects-cli.test.ts`, the MCP
round-trip in `mcp-items.test.ts`, and the pins that go red on a new route or tool by name: the SDK
route-coverage, the docs guards, the identity pins, the tool-list pins.

Traps: a fixture whose resource owner is the WORKSPACE owner cannot pin a 404 to a non-member (a workspace
owner manages every project); the chassis's write tools say `confirm with the user first`, the tool's say
`Always confirm with the user before calling.`, so a test over write tools scopes to the tool's own; the
machine allowlist sees the path without its query string.

## Slots this example leaves empty

From the header of `apps/server/src/tool.ts`. Fill one only when the resource has something to put there,
with the test that pins the hand-over in `test/integration/tool-slots.test.ts`.

- `env` (kept, empty, in `./env.ts`): the tool's own environment keys.
- `jobs`: its pg-boss queues, nightly purges and their handlers.
- `rateLimiters`: its own named rate-limit buckets.
- `api.untrustedOrigins`: a second origin that serves user content and must never be trusted.
- `api.csrfExempt`: its token-authed, cookie-less paths the cross-site guard lets through.
- `api.auditExempt`: its public paths that must land no generic audit row.
- `api.idempotencyTargets`: its POST routes that honour `Idempotency-Key`.
- `api.early`: a middleware that must run before the body caps.
- `api.bodyLimit`: a body-size cap of its own (an upload route).
- `api.jsonDepthExempt`: its paths whose body is never parsed as JSON.
- `api.rateLimits`: the walls that spend its buckets.
- `app.*` (`rootMiddleware`, `cspFrameSrc`, `publicRoutes`): a public, unauthenticated surface outside
  `/api/v1`.

One REQUIRED slot is already filled and stays as it is while the resource binds no file: `api.filePolicy`.
When a resource references a blob, read "Adding your domain" in `CLAUDE.md` before you touch it.

## Proof

The resource is done when the same three things the series' tests observe are true for `notes`:

- [ ] From the dashboard: sign in, open Notes from the menu, add one, see the row and the count, edit it,
      delete it. This is what `e2e/items.spec.ts` does.
- [ ] From the CLI: create a note, then list it, against a listening instance. This is the case in
      `apps/server/test/integration/cli.test.ts`.
- [ ] From an MCP tool: create, list, get, update and delete one note through `/mcp`, then read the three
      audit rows of the HTTP routes. This is what `mcp-items.test.ts` does.
- [ ] In a project: create one, add a member, put a note in it from the project page, see it under the
      project and on the note's row, and see the member find it there. `e2e/projects.spec.ts` and
      `items-projects.test.ts` do this for `items`.
- [ ] A read-scope key is refused the writes. A key with neither scope is refused the tree. A guest lists
      none and is refused the writes.
- [ ] `pnpm chassis:check`, the gate and the integration suite are green. The history holds one commit per
      slot.
