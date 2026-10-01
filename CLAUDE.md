# Hackathon briefing (read this first)

This is one team's repository for the **Malt × Antasphere AI Hackathon**, Friday 2 October 2026 at WAT
Brussels. The team builds until **18:00**; the last push to `main` before the freeze is what counts. The
server's clock is the truth, not yours: `hackathon event status` gives the phase and the deadlines.
**Push early, push often, to `main`.**

## What this codebase is

A working tool to build on: one API, four faces over it.

- **Server**: Hono API under `/api/v1` (`apps/server/src`), Postgres, jobs, the MCP endpoint at `/mcp`
  (`apps/server/src/mcp/tools.ts`).
- **Dashboard**: SvelteKit (`apps/dashboard`); the **Try it** page is
  `apps/dashboard/src/routes/(app)/(tool)/try/+page.svelte`.
- **CLI**: `starter` (`packages/cli`, verbs in `packages/cli/src/commands/`).
- **Two integrations already wired**:
  - **Gradium** (voice, TTS/STT): client `apps/server/src/integrations/gradium.ts`, routes
    `apps/server/src/api/voice.ts`, CLI `starter speak` / `starter transcribe`.
  - **H Company** (an agent in a cloud browser): client `apps/server/src/integrations/h.ts`, routes
    `apps/server/src/api/runs.ts`, service and jobs `apps/server/src/runs/`, CLI `starter run` / `starter runs`.
  - Request/response shapes: `packages/contract/src/schemas/{voice,runs}.ts`.

## Run it

1. `.env` at the repo root (git-ignored, never commit it): `./scripts/env.sh` creates it from `.env.example`
   with a random `POSTGRES_PASSWORD` (required) and `AUTH_SECRET`. Then fill `GRADIUM_API_KEY` and
   `HAI_API_KEY`. A missing provider key does not stop the app: its routes answer `503` naming the key.
2. Start: `hackathon setup --directory .` (what the CLI ran when it cloned this), or
   `docker compose up -d --build --wait`. The app is on **http://127.0.0.1:3000** (`/readyz` = ready).
3. First boot: the dashboard asks for an owner account and a setup token. The token is in the log:
   `docker compose -p hackathon-<team> logs app | grep 'claim the instance'` (drop `-p ...` if you started
   it with plain `docker compose`).
4. Optional: `DEMO_SIGN_IN=true` in `.env` (then restart) lets the owner mint **demo links** that sign a
   teammate in without a password (`starter demo`, docs/self-hosting/demo-links.md). It does not skip
   step 3, and it only opens accounts on example/test domains.

After changing code, rebuild: `docker compose -p hackathon-<team> up -d --build --wait`.

## Drive the tool through the `starter` CLI

Agents should use the CLI (or `/mcp`) rather than poking the database or hand-writing HTTP.

```bash
./scripts/link-cli.sh          # installs deps, builds the CLI, links `starter` on PATH (or prints an alias)
# dashboard → API keys → create a key with items:write ticked (the dialog defaults to read only)
starter login --api-url http://127.0.0.1:3000 --api-key ytk_...
starter whoami
starter speak "Bonjour"                       # writes speech.wav
starter transcribe speech.wav
starter run "What is the main heading of example.com?" --wait
starter --help                                # everything else (items, runs, files, projects, ...)
```

## Add a feature

Follow the worked examples: `items` (the placeholder resource), the voice and the runs. The
`add-resource` skill (`plugin/skills/add-resource/SKILL.md`) walks a new resource through every layer:
table, API, SDK, CLI, MCP tools, dashboard page. "Adding your domain" in the manual below names each slot
and its file. Never edit `packages/chassis-*` (copies, checked by `pnpm chassis:check`).
Hackathon pace: one small working slice end to end beats a large half-built one. Commit and push each slice.

## The hackathon CLI

- `hackathon doctor --directory .`: machine, instance, credential, roster, clone, app. Follow each `fix`.
- `hackathon event status`: phase and deadlines by the server clock.
- `hackathon submissions list`: what your team pushed and what the platform received.
- `hackathon decks link`: register your three presentations, pitch, vote and demo (Slideless share links).

The hackathon skills (installed with `npx skills add antasphere-hackathon/plugin`, Claude Code shows them as
`/antasphere:<name>`): `hackathon-setup` (from zero to the app running), `hackathon-doctor` (the checks and the
clock), `hackathon-deck-pitch`, `hackathon-deck-vote` and `hackathon-deck-demo` (the three presentations, from the
organizers' layouts in the event's Slideless workspace, published and registered on the platform).
- `hackathon requests open`: ask the coaches for help (or write in your team chat on the hackathon app).

---

Below: the template's full manual.

# The tool template

This repository is the template every Antasphere tool starts from. It has two halves.

The chassis is what every tool shares: the dashboard shell, members and invitations, workspaces, API keys,
the audit log, file storage, the MCP endpoint (`/mcp`), the built-in OAuth 2.1 authorization server, and
sign-in through the Antasphere hub on the cloud edition. It lives in `packages/chassis-*`. Those folders are
copies and are never edited here.

The tool half is what a tool writes. In the template it holds one placeholder resource, `items`: a name and
a note per workspace. `items` goes through every slot a tool fills, so it is the worked example to follow.

The template ships the way a tool ships: one Docker image plus a Postgres container. It has one branch,
`main`.

## The hackathon's participant skills

A team working in this repository during the hackathon gets its skills from the hackathon's Claude Code plugin
(`antasphere-hackathon/plugin`: `/plugin marketplace add antasphere-hackathon/plugin`, then
`/plugin install plugin@antasphere-hackathon`): `/plugin:join` (the setup from zero), `/plugin:check` (the
doctor and the clock) and `/plugin:demo` (the demo deck on Slideless, its link set with `hackathon decks link`).
This repository ships no participant skill of its own; `plugin/` here is the tool template's chassis plugin.

## Identity

The identity is slug `starter`, display name `Hackathon Starter`. In the template that name is neutral: a made-up
word that stands only where an identity value belongs, so `pnpm instantiate <slug> --name "<Display name>"`
(`scripts/instantiate.mjs`) replaces it with a tool's own name and touches nothing else. Do not rename one
value by hand, and do not use the word for anything that is not the identity: a sentence that says "your
tool" in a file the script writes is a defect.

- **One definition**: `packages/contract/src/identity.ts` (`IDENTITY`, typed by `ToolIdentity` of
  `@antasphere/chassis-contract`) spells the slug, the display name, the key prefix, the three
  scopes, the CLI's binary and env prefix, the MCP server name and tool prefix, the OTel service
  name and the image name ONCE. It feeds the three existing inputs: `defineChassisContract`
  (`packages/contract/src/chassis.ts`) and `defineChassisRoutes` (`packages/contract/src/routes/index.ts`),
  the `identity` slot of `theTool` (`apps/server/src/tool.ts`; the three chassis refusals that
  name a tool's domain sit in its `copy` slot, in the tool's words) and `cliIdentity(IDENTITY)` in
  `packages/cli/src/cli.ts`. No `packages/chassis-*` file names the tool
  (`git grep -i starter -- 'packages/chassis-*'` returns nothing), and
  `apps/server/test/integration/identity-pins.test.ts` pins every visible value by its literal
  (never make that file read `IDENTITY`). No identifier in the code carries the name (`theTool`,
  `toolMcp`, `ToolDomain`): code that needs a value reads `IDENTITY`.
- What cannot read the definition at run time spells the value, and the instantiate script rewrites it:
  the package names and the `bin` key, the image reference in the Dockerfile and the compose files, the
  clone URL and the install path of the operator scripts, the env var names in shell scripts and docs,
  the literals the tests pin on purpose, the commands in the docs. The workspace scope `@app/*` and the
  Postgres role and database `app` are the same in every tool: they are not identity.
- The CLI package is `@antasphere/starter` and its binary is `starter`. Env var prefix `STARTER_`: the
  CLI reads `STARTER_URL` and `STARTER_API_KEY`.
- API key prefix `ytk` (`IDENTITY.apiKeyPrefix`; `ApiKeyService` in
  `packages/chassis-server/src/apikeys/service.ts` takes it as a required constructor value, with
  no chassis default). The instantiate script derives nothing for it: a tool chooses its own three
  letters and replaces `ytk` with them.
- Scopes: `items:read`, `items:write`, `data:export` (export stays opt-in). They are stated in
  `IDENTITY.scopes`; `apps/server/src/middleware/scopes.ts` reads them for the OAuth list, the CLI
  key's grant and the allowlist.
- License: fair-code under the Sustainable Use License 1.0, licensor Antasphere (`LICENSE`; every
  `package.json` says `SEE LICENSE IN LICENSE`, the CLI included). Say fair-code or source-available,
  never open source (PRDCT-1350).
- Compose image name `ghcr.io/antasphere/starter`; Postgres role/db `app`; port 3000. The compose file passes no `EDITION`: `oss` is the
  server's default, and a cloud instance sets the key itself.
  The template publishes no image, so nothing answers to that name on the registry: build the image from
  the checkout.
- `chassis-source.json` names `antasphere/slideless`, the repository the chassis copies come from, and
  LESSONS.md names Slideless where it tells what happened there. Both are records, not identity.

## Layout

| Path                                | What                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/server`                       | The single deployable: the entry, the tool's server code, the chassis composition                                 |
| `apps/server/src/tool.ts`           | The tool definition: what the tool plugs into the chassis' named slots                                            |
| `apps/server/src/items/projects.ts` | The item's side of the chassis's projects: where the tool states its rules for a link, on the chassis's predicate |
| `apps/dashboard`                    | SvelteKit SPA, built into and served by the server image. The shell, plus the tool's half under `src/lib/tool`    |
| `packages/chassis-db`               | COPY. The generic tables, the generated `auth-schema.ts`, the migration runner                                    |
| `packages/chassis-contract`         | COPY. The generic zod schemas + route contracts                                                                   |
| `packages/chassis-server`           | COPY. The generic server: identity, federation, middleware, routers, jobs, MCP kit; entry `createPlatform`        |
| `packages/chassis-sdk`              | COPY. The generic typed client (`ChassisClient`); `PlatformClient` extends it                                     |
| `packages/chassis-cli`              | COPY. The generic CLI: profiles, context, `safe-write.ts`, generic commands; entry `defineCli(definition)`        |
| `packages/db`                       | The tool's tables (`src/schema.ts`) and the migrations (`drizzle/`), see below                                    |
| `packages/contract`                 | The tool's zod schemas + route contracts, and the chassis contract instantiated with the tool's scopes            |
| `packages/sdk`                      | `PlatformClient`, the typed client over the contract (hand-written)                                               |
| `packages/cli`                      | The `starter` binary: the tool's commands over `packages/chassis-cli`, one bundle (docs/agents/cli.md)            |
| `chassis-source.json`               | The record of the chassis copies: the source repository, its commit, one sha256 per file                          |
| `scripts/check-chassis-copies.mjs`  | The guard that compares `packages/chassis-*` with that record                                                     |
| `Dockerfile` + `docker-compose.yml` | The image and the operator stack                                                                                  |
| `deploy/`                           | The Hostinger self-hosting files                                                                                  |
| `docs/`                             | PUBLIC docs only; subfolders = sidebar groups, `docs/nav.yml` is the contract                                     |

`packages/db/drizzle` holds one chassis baseline, `0000_chassis_baseline.sql`, then the migrations that came
after it, the tool's and the chassis's alike, in one chain. The baseline creates every chassis table of the day
the template was cut, the `enforce_last_active_owner()` function and its trigger; `0001_items.sql` is the tool's
example; `0002_projects.sql` is the chassis's two project tables, added after the baseline; `0003_item_projects.sql` is the
tool's link table; `0004_teams_and_demo_passes.sql` is the chassis's three team tables and two demo-pass tables, one
entry for the copy at slideless@7714374. A chassis table
that arrives with a later copy lands the same way, as its own additive entry generated from the chassis schema
(`pnpm --filter @antasphere/chassis-db build && pnpm --filter @app/db db:generate --name <table>`), and the
baseline is never edited: the migration status is hash-based (`packages/db/test/migration-status.test.ts`), so an
instance that booted on the baseline would read an edited one as a downgrade and refuse to start. Every `.sql`
file in that folder is a journal entry: `packages/db/test/migrations-journal.test.ts` fails on any other file.

## The chassis packages are copies

- Never edit a file under `packages/chassis-*`. Never add one and never delete one.
- A change the tool needs there is a chassis change. Make it at the source named in `chassis-source.json`,
  then copy the folders again.
- The guard is `pnpm chassis:check` (`node scripts/check-chassis-copies.mjs`). It compares every file under
  `packages/chassis-*` with `chassis-source.json`, one sha256 per file. A changed, added or removed file fails
  it. It is the first step of CI's `checks` job.
- After a fresh copy of the folders, record it:
  `node scripts/check-chassis-copies.mjs --write --repo <owner/name> --sha <sha>`.
- Code under `packages/chassis-*` never imports `@app/*`.
- A copy that adds a chassis TABLE lands its migration as the next entry of `packages/db/drizzle`, generated
  from the chassis schema (the Layout section says how); the baseline is never edited.

## The dashboard shell is a copy

The dashboard has two halves (`apps/dashboard/src/lib/boundary.test.ts`): the tool's own, under `lib/tool/` and
`routes/(app)/(tool)/`, and the shell, everything else under `apps/dashboard/src`. The shell is Slideless's
dashboard shell with the identity words changed, and it is never edited here either: a change the tool needs in
the shell is made in Slideless's `apps/dashboard` and copied again.

- The guard is `pnpm shell:check` (`node scripts/check-shell-copies.mjs`), the second step of CI's `checks` job,
  with its test (`scripts/check-shell-copies.test.mjs`). It compares every shell file with `shell-source.json`,
  one sha256 per file. The file set is the shell as the boundary test defines it: `apps/dashboard/src/**` minus
  `TOOL_PATHS`, read from that test, never a second list.
- The shell cannot be held byte for byte: its identity words are the tool's, `pnpm instantiate` rewrites them
  again in every tool born from the template, and prettier may reflow a line after the rename. So the sha is
  taken on a NORMALISED form: the comments stripped (block, HTML, whole-line `//`), the identity words replaced
  by placeholders (the slug in its three casings, the display name, the key prefix, the resource of the scopes,
  all read from `packages/contract/src/identity.ts`), the white space collapsed and dropped beside brackets.
  A born tool passes the guard unchanged; any edit to the code of a shell file fails it.
- `shell-source.json` names the Slideless commit the shell was ported to (7714374, Slideless 0.13.0), the
  rewrite the source needs on top of the identity (`@slideless/` to `@app/`, `presentations:` to `items:`,
  `/decks` to `/items`), and under `differs` the shell files that still differ from Slideless after the
  normalisation, fourteen files where Slideless's shell still speaks of decks (the account page's note, the
  docs module, the download module `lib/download.ts`, two brand components, the two catalogs' deck
  vocabulary, the boundary test's extra route groups, and six tests: `billing-refusal`, `audit-filters`,
  `code-block/tint`, `docs`, `download` and `sso`). That list is
  the debt the "de-deck the shell" pass on Slideless pays; until it lands, those files are compared with the
  template's own copy, like the rest.
- After a fresh copy, record it with the source beside it, so `differs` is written again:
  `node scripts/check-shell-copies.mjs --write --repo antasphere/slideless --sha <sha> --source <slideless checkout>`.
  Before a copy, read the debt as a diff: `node scripts/check-shell-copies.mjs --diff --source <slideless checkout>`
  prints `same`, `differs`, `only here` and `only there` per file.

## Invariants — never regress these

- **Fail-closed scope allowlist** (`packages/chassis-server/src/middleware/scopes.ts`, the tool's rules in `apps/server/src/middleware/scopes.ts`): machine principals (API
  keys, OAuth tokens) reach ONLY allowlisted routes; anything unlisted 403s. New endpoints stay
  unreachable to machines until consciously opened.
- **Closed sign-up needs three switches**: the `/sign-up` hook, `disableSignUp` on the emailOTP
  plugin, and `disableSignUp` on each social provider. Removing any one reopens sign-up.
  **Cloud edition, the deliberate fourth switch**: the `antasphere` genericOAuth provider's
  `disableSignUp` stays UNSET — hub SSO IS the sanctioned account entrance there (JIT,
  internal/federation.md). Setting it bricks every first cloud login; it exists only on
  `EDITION=cloud` boots, so oss stays a three-switch closure.
- **Migrations run under a session-scoped `pg_advisory_lock` on a dedicated client** — multi-replica
  safe. Never switch to a transaction-scoped lock.
- **Auth schema drift guard**: any Better Auth config change that alters the schema must regenerate
  `packages/chassis-db/src/auth-schema.ts` + the snapshot via the pinned CLI, plus an additive drizzle
  migration. CI's `drift:check` gates it.
  In the template that file is inside a chassis copy, so this regeneration is a chassis change: it is made
  at the chassis source and the folders are copied again (see "The chassis packages are copies").
- **The CLI writes a path someone else chose through `packages/chassis-cli/src/safe-write.ts` only
  (PRDCT-1353)**: lexical containment + a `realpath` parent check + `O_NOFOLLOW` + a forced 0644 (an
  `O_TRUNC` write PRESERVES an existing file's mode). `files download` uses the BASENAME of the
  server-chosen name inside a chosen directory. Every non-`--json` sink goes through
  `sanitizeForTty` (`packages/chassis-cli/src/context.ts`) — `--json` stays byte-exact and must
  never be routed through it.
- **A tombstone the boot cannot replay closes the service (PRDCT-1809)**: the erasure replay in
  `packages/chassis-server/src/boot.ts` runs under `withAllLastOwnerGuards` (nothing touched on a refusal — Better Auth's
  cascade drops account rows before the user row, so an unguarded refusal half-erases), and a
  refused tombstone sets `state.closed`, which answers 503 `service_closed` on every route but
  `/healthz`, `/readyz`, `/metrics`, plus a `user.erasure_replay_refused` audit row. Never
  downgrade the closure to a readiness flag alone: only `/readyz` reads `state.ready` and the
  compose healthcheck watches `/healthz`, so the API would keep serving the resurrected
  subject. The erasure fingerprint is an HMAC under the auth secret (PRDCT-1811) — never a plain
  hash, since `erasures.jsonl` rides in the UNENCRYPTED data tarball.
- **Never render user content on the app origin** — files are served `attachment` + `nosniff`
  (docs/security/security.md).
- **The BLOB surface carries a read policy (SL-B1)**: the generic `/files` routes — list,
  `GET /files/{id}`, `GET|HEAD /files/{id}/content`, DELETE — apply `blobReadScope`
  (`apps/server/src/files/blob-read-scope.ts`): blobs you uploaded; workspace admins/owners keep the
  whole-workspace operator view. 404, never 403. **Never authorize a blob read on `workspace_id`
  alone** — that was a whole-tenant content channel open to every plain member and every
  `items:read` key. Possession lives in `file_uploaders`, NOT `files.created_by`:
  content-addressed dedupe means the second uploader of identical bytes lands on the first
  uploader's row, so every upload path must record its uploader or it locks people out of their own
  bytes.
- **Guest origin is a capability boundary (D2, internal/federation.md "Guests")**: a
  `workspace_members.origin='guest'` row exists for principal resolution only. Guests are refused
  the generic `/files` surface (reads included — the host tenant's file cabinet is a workspace-level
  surface), the member roster, and the workspace export on BOTH editions (`requireNonGuest`, 403
  `guest_forbidden`), across sessions, API keys, and OAuth bearers alike. Guest roles are locked
  (`guest_role_locked`); the hub reconcile never touches them.
- **Cloud closes the local password-reset surface (P8, ADR 017)**: on `EDITION=cloud`, every
  reset-shaped route — `/request-password-reset`, `/reset-password` (POST + tokened GET), the
  emailOTP reset trio — answers 403 (before-hook in `packages/chassis-server/src/identity/better-auth.ts`;
  `sendResetPassword` never wired there), and the admin `/members/{id}/reset-link` mint refuses
  `password_reset_disabled`. A hub-JIT user must never be able to SET a local password and
  sidestep SSO. `/sign-in/email` stays WIRED on both editions (the break-glass operator door,
  which never needs a reset); oss keeps the full reset surface unchanged. Re-verify the route
  enumeration (`isPasswordResetPath`) on any Better Auth bump.
- **Cloud closes the OTP MINTING entrances too (D1 hub-only credentials, ADR 017 §7 charter
  call taken 2026-07-13)**: on `EDITION=cloud`, the emailOTP session surface —
  `/sign-in/email-otp`, `/email-otp/verify-email` (config insurance), the send leg — answers
  403 `otp_signin_disabled` (`isOtpSignInPath`, same before-hook; re-verify on any Better Auth
  bump), and the tool's own CLI OTP mint (`/cli/auth/request` + `/cli/auth/complete`) answers
  403 `cli_otp_disabled` steering to `antasphere login`. Every cloud credential — human session
  AND CLI key — must trace through the hub so its audit log is the complete access record.
  `DELETE /cli/auth/key` (the logout SELF-revoke: a presenting key kills exactly itself) stays
  OPEN on both editions and is the one deliberate `/cli/auth` opening in the machine scope
  allowlist (`items:write`, method-keyed) — never close it, and never widen it to a
  named-key revoke. `/sso/cli-connect` (the sanctioned cloud CLI mint) and `/sign-in/email`
  are untouched; oss keeps OTP login + CLI mint unchanged. **The Google social provider is the
  third non-SSO session entrance and is closed the same way**: `socialProviders.google` is
  registered only when NOT cloud (`!hubSso` in `packages/chassis-server/src/identity/better-auth.ts`), so a cloud instance
  with `GOOGLE_CLIENT_ID`/`SECRET` set still leaves `/sign-in/social` unregistered (404
  `PROVIDER_NOT_FOUND`) — by construction, not by leaving the env unset. Rule: no non-SSO
  session entrance on cloud except the break-glass `/sign-in/email`; oss keeps Google social
  when configured.
- **No route ever hands a caller a PROVIDER GRANT, on either edition (PRDCT-1354, AUTH-3/AUTH-7)**:
  Better Auth's own `/get-access-token` and `/refresh-token` answer 403 `provider_grant_forbidden`
  from the same before-hook (`isProviderGrantPath` in `packages/chassis-server/src/identity/better-auth.ts` — re-verify the
  enumeration on ANY Better Auth bump). Both returned the caller's stored grant in PLAINTEXT, which
  makes `encryptOAuthTokens: true` pointless, and the `/auth/*` mount is registered BEFORE
  `authContext` (`packages/chassis-server/src/api/create-api.ts`), so neither saw the scope allowlist, the per-principal quota, the
  idempotency claim, or the audit log. On cloud that grant IS the hub grant (ADR 019), and
  `/refresh-token` rotated it OUTSIDE the `pg_advisory_lock(7432004, hashtext(userId))`
  single-flight, which the hub's RFC 9700 reuse detection turns into a grant-family-killing event
  any logged-in user could trigger from a browser tab. Pure subtraction: nothing in the server, SDK,
  CLI, dashboard, or MCP calls either route (the hub grant refreshes via `HubGrantService.postRefresh`,
  which posts to the hub token endpoint directly). Never reopen them; a new provider-token read
  surface needs an explicit charter call.
- **Minting another user's credential is an OWNER act with a cross-tenant refusal (PRDCT-1354,
  AUTH-1/2/8)**: `POST /members/{id}/reset-link` and `/members/{id}/change-email-link` both mint
  a SIGN-IN-EQUIVALENT bearer for a target (LESSONS.md M6), and a `user` row is instance-GLOBAL —
  so the mint's blast radius is every workspace the target belongs to. Both are `requireRole('owner')`,
  both run `mintRefusal` (`packages/chassis-server/src/accounts/mint-refusal.ts`, shared with the demo pass mint),
  and both refuse an `origin='guest'` target (`guest_target` — a guest of the workspace is an outsider, whose
  account is not the host tenant's to recover, D2) and any
  target holding a membership in ANOTHER workspace (`cross_workspace_target`). Both also carry the
  cloud closure (`password_reset_disabled` / `email_change_disabled`) and both are idempotency
  targets. Any new mint route under `/members` must call `mintRefusal` too.
- **Cloud federation is USER-scoped and live (ADR 019, internal/federation.md "Live reconcile +
  grant")**: every hub read between logins is `GET <hub>/orgs` AS THE USER with that user's own
  stored grant (encrypted on the `account` row) — there is NO service key, no cross-tenant
  surface, and no target-user parameter anywhere; never reintroduce one (the master-key drill's
  lesson). A credential identifies a USER: `ytk_` keys and OAuth grants are unpinned by default
  (the org is a per-request `X-Workspace-Id`/tool-argument parameter; a key's `workspace_id` is
  an optional least-privilege PIN), org claims are never read from any token (login = id_token
  identity + fail-closed reconcile; connect = the same), and grant refreshes MUST stay
  single-flighted per user (in-process + `pg_advisory_lock(7432004, hashtext(userId))`,
  re-read-after-lock) — the hub's RFC 9700 reuse detection makes an unserialized double-refresh
  a grant-family-killing event. **An unanswered refresh is never re-presented blindly
  (PRDCT-1370)**: the hub rotates before it answers, so a timed-out presentation may already be
  rotated out; `HubGrantService` records every presentation (`hub_grant_presentations`) before
  the fetch and, while the record survives, PROBES the token through the hub's RFC 7662
  introspection (read-only) — `active:false` marks the grant dead without presenting, so the
  family (the CLI grant included) survives. Never remove the record write or the probe. Gate verdicts: dead grant → 401 `hub_grant_expired` (immediate;
  a browser SSO re-login heals), stale-beyond-15-min + failing hub → 403 `hub_unavailable`,
  swept membership → 401 `membership_revoked`, `hub_status='suspended'` → 403
  `account_suspended` (GET /me exempt — visible-but-blocked). **Orphan-purge HARD CONSTRAINT**
  (`packages/chassis-server/src/jobs/pgboss.ts`): never delete an `antasphere` account row while leaving an `origin='hub'`
  membership row — whole-user delete or nothing, else the reconciler's fail-open `no_link`
  branch becomes reachable for hub-origin principals.
- **Cloud sign-in requests `orgs:create`, and THE HUB DEPLOYS FIRST (PRDCT-2443)**: the scope list
  is stated once (`HUB_SSO_SCOPES`, `packages/chassis-server/src/identity/hub-sso.ts`): `openid profile email offline_access
account:read orgs:create`. The hub's authorize endpoint refuses an unknown requested scope with
  `invalid_scope`, which fails the WHOLE sign-in for every user, so a scope is added here only
  AFTER the hub lists it for the tool client. `orgs:create` is the hub's dedicated scope for
  `POST /orgs`; `account:write` does not open it and is never requested. A grant without the scope
  (minted before this shipped, or replaced by a CLI connect, whose hub-minted grant carries no
  `orgs:create`) gets 403 `insufficient_scope` from the hub, mapped to 401 `hub_reauth_required`:
  a browser sign-in heals it. `/me.canCreateWorkspace` stays true for such a person, on purpose.
- **Projects are the chassis's, and a tool links its resource through the one exported predicate**:
  `projects` and `project_members` (`packages/chassis-db`), the `/projects` routes, the eleven project MCP tools and
  the two team reads, and the CLI group are the chassis's, registered by `createPlatform`, `buildMcpServer` and the CLI program before
  the tool's own. What a project HOLDS is the tool's, through a link table of its own (`item_projects`) and
  ONE question asked of the chassis: `projectGrantPredicate` (`packages/chassis-server/src/projects/access.ts`:
  the guest refused on the principal and on the row, the live membership, one workspace, the role ladder, the
  operator view, the archived-write rule). The tool never writes a project rule beside it: a link and an
  unlink need `atLeast: 'editor', access: 'write'`, a read `atLeast: 'viewer', access: 'read'`, and the payload
  names the projects the CALLER can read and no other. The tiers hold on every route the tool adds that acts
  on ONE project: 404, never 403, to whoever cannot read it (a guest excepted: the whole projects tree answers
  a flat 403 `guest_forbidden` to a guest, a real id and an unknown one alike) (so whether an item is in it is not probeable
  either); 403 `insufficient_project_role` to a proven reader below the role; 409 `project_archived` on a
  change through an archived project. A create naming SEVERAL projects answers one 404 `project_not_found`
  for the first that does not qualify, whatever the reason: a batch is not a probe. Project membership is LOCAL on both editions
  (never under `hub_managed`), a guest is never a project member, and a grant dies with the workspace
  membership it rides on (the foreign key's cascade; the hub sweep deletes the grants itself since it only
  deactivates). Nothing under `packages/chassis-*` names an item. A resource that is PRIVATE to its author
  adds the read branch in its three homes at once (the read rule, the list's WHERE, `blobReadScope`), as
  `apps/server/src/items/projects.ts` says; the template's item is workspace-wide and needs none.
- **Hub-origin workspaces are hub-managed (P7, internal/federation.md)**: on `EDITION=cloud`, every
  local membership MUTATION on a projected workspace (`centralAccountId IS NOT NULL`) — invitation
  create/accept/revoke, member role-change/deactivate/reactivate/delete, reset-link,
  change-email-link — answers 403 `hub_managed` + `details.manageUrl`
  (`packages/chassis-server/src/middleware/hub-managed.ts`, keyed on `principal.accountRef`, method-keyed non-GET). READS stay
  (`GET /members`, invitation list/lookup); cloud-LOCAL workspaces (operator's) and oss are untouched. The
  dashboard adapts off `/me`'s `workspace.hubOrigin`/`origin`/`hubManageUrl`, never
  edition-sniffing.

- **A price is a declaration on the route, and the chassis names no key (the pay-per-use billing rail
  spec §7; ported from Slideless PRDCT-2626 and PRDCT-2629 to 2637)**: a route that meters an action,
  checks a limit or needs a feature says so ONCE in `TOOL_ROUTE_ENTITLEMENTS`
  (`packages/contract/src/routes/index.ts`, built from the route objects; a duplicate throws) and the
  tool's `entitlements` slot (`apps/server/src/tool.ts`) carries the credits, the per-tier limits and
  the features, shown on `GET /instance`. ONE gate (`packages/chassis-server/src/entitlements/gate.ts`,
  registered in `create-api.ts` after the scope gate, the idempotency claim and the audit middleware,
  before every handler) enforces it for the dashboard, the CLI and the MCP tools alike and emits the
  usage event after a 2xx; no handler checks or emits by hand, and
  `git grep -i 'files.maxBytes\|items.create\|starter' -- ':(glob)packages/chassis-*/src/**'` stays empty.
  **The chassis's own upload route is priced by the tool**: `packages/chassis-server/src/api/files.ts`
  checks no declared size and emits nothing since Slideless 12ef2f8, so a template that drops `files.upload`
  from its declaration loses the declared-size refusal of `POST /files` (the hard cap still cuts the
  stream). Cloud order: feature → limit (403 `plan_required` + `details: { key, plan, requiredPlan,
upgradeUrl }`, the hub's organization page) → the credit check; oss: the credit check first (413
  `entitlement_denied`, the message byte for byte), then the `oss` value, and NO event (unmetered by
  construction). The event's `userId` is the hub's `sub`, never the local id, and **the event never
  names the tool**: the hub takes the tool from the machine token's registry entry (`starter-cloud`,
  not `IDENTITY.slug`) and refuses a body slug that differs as `tool_mismatch`; the fake hub
  (`testing/fake-hub.ts`) judges every element with the hub's schema (the contract's copy,
  `usageEventSchema`, checked by the wire check). The poster (`entitlements/poster.ts`, cloud only)
  posts whole batches to `POST <hub>/api/v1/usage/events` with a `client_credentials` token
  (`scope=usage:write`, `resource=<hub>/mcp`) minted single-flight on `HUB_CLIENT_ID`/`SECRET`; a 404
  from an older hub, a 5xx, a 403 (logged at error level) or a 2xx that is not the hub's answer is an
  outage the queue retries for about eight hours (`DEFAULT_USAGE_RETRY`), and the budget's END is a
  hold in `usage-events-held` (the queue's dead letter, set by the worker boot, never named on a
  send), logged at error level, counted (`usage_events_held_total`), re-driven hourly, never a loss;
  the per-event and per-batch outcomes are on `/metrics` (`usage_poster_events_total`,
  `usage_poster_batches_total`). A mint the hub refuses as a configuration error (`invalid_client` and
  its kin) is held five minutes, a transient failure five seconds (PRDCT-2637: the hub's token wall is
  the one people's sign-ins share). The plan read (`GET <hub>/api/v1/usage/entitlements`,
  `entitlements/profiles.ts`) is OFF the request path (PRDCT-2633): a cached plan is served at once and
  refreshed behind the request, a cold account waits at most 1.5 s, and the last known plan is kept
  fifteen minutes on failure, then `free`; a boolean limit from the hub is unlimited (`true`) or nothing
  (`false`) (PRDCT-2636). A plan limit is judged BEFORE any body cap refuses the declared size
  (PRDCT-2632): the tool's `bodyLimit` slot declares data (`BodyCap`), the chassis builds the
  middleware, and on a route whose gate judges a limit (`isDeferringGate`) a Content-Length over the
  cap is parked (`bodyRefusal`) with the request's body DROPPED, so nothing downstream can read it,
  and fired by the gate after the plan check: a metered account meets 403 `plan_required` at any
  size and the instance-cap 413 only when the plan allows the size; oss and a request no plan applies
  to meet the cap first, once the credential has resolved (a key without the scope meets the scope
  gate's 403 before the cap's 413). `apps/server/test/integration/items-metering.test.ts`
  pins the tool's declaration on both editions; the chassis suite pins the poster, the hold and the
  fake hub's judgement. A feature is declared in the template and wired on no route. The hub sells the `pro` plan since
  billing phase 3 (Slideless PRDCT-2702), so a wired feature opens its route to a `pro` account and
  answers 403 `plan_required` with the upgrade link to a `free` one; the phase-1 premise (every cloud
  account free, a wired feature closing its route) no longer holds.
- **Demo sign-in is a switch, and a pass opens a demonstration address only (the demo pass spec,
  27 September 2026)**: `DEMO_SIGN_IN` off means NO demo route is registered (the three owner
  routes, the redeem endpoint, its wall, the `demoSignIn` discovery key): every demo path answers
  the unknown-path 404 byte for byte, signed in or not. On, the boot refuses unless the host of
  `PUBLIC_BASE_URL` is loopback (`isLoopbackHost`, never a second copy) or listed in
  `DEMO_SIGN_IN_HOSTS`, and a malformed entry in either list refuses too. Minting, listing and
  revoking are an OWNER act from a SESSION only (`requireRole('owner')` + `sessions_only`); the
  paths are in nothing in the scope allowlist, ever, so no API key or OAuth bearer reaches them,
  and the CLI's `demo` commands sign in as the owner (`chassis-cli/src/owner-session.ts`) rather
  than open that door. A pass opens only an address `isDemoAddress` accepts (the reserved example
  and test domains, or `DEMO_SIGN_IN_EMAIL_DOMAINS`), never another owner, never an account with a
  second factor, and it runs the SAME `mintRefusal` as the reset link
  (`packages/chassis-server/src/accounts/mint-refusal.ts`: `guest_target`,
  `cross_workspace_target`). Every dead pass (unknown, expired, revoked, the person gone or no
  longer a member, the address no longer a demonstration one, a second factor since) answers ONE
  401 `invalid_demo_pass`, same body. The redeem is an endpoint of the sign-in library itself
  (`identity/demo-pass-plugin.ts`), so its own cookie and hooks apply; never re-home it on the API
  router. A session a pass opened lives only while its pass does: the revoke deletes it in its own
  transaction, and the credential resolver's judge (`judgeSession`, handed to `authContext` and to
  the library's mount only while the switch is on) deletes it once the pass has expired or was
  revoked. A session a pass opened is a VISIT: the library's mount refuses it every path of
  `DEMO_SESSION_REFUSED_AUTH_PATHS` (the OAuth authorize included: a pass lands in no tool here),
  the API routes that mint a credential for anyone or make something the person keeps refuse it
  with 403 `demo_session` from ONE list mounted once, right after the credential resolver
  (`DEMO_SESSION_REFUSED_API_ROUTES` in `packages/chassis-server/src/identity/demo-pass-rules.ts`,
  the mount in `packages/chassis-server/src/api/create-api.ts`), to which the tool appends its own
  through the `demoSessionRefusedRoutes` slot (`apps/server/src/tool.ts`: the template leaves it
  out, since no item route answers a credential; a resource whose route does, an invite whose claim
  link seats an outsider for one, declares it there), the invitation accept refusing it in its
  handler; two contract walks (`packages/chassis-server/test/integration/demo-pass-rules.test.ts`
  over the chassis routes, `apps/server/test/unit/demo-pass-rules.test.ts` over the tool's and the
  chassis's with `claimUrl` among the keys) fail on any route whose success answer carries a
  credential and is on neither list nor named as excluded, a pass's end (`endSessions`) takes the
  OAuth tokens and the `demo_pass_sessions` rows tied to its sessions BEFORE the sessions, and the
  redeem judges the mint's refusals again; a pass session's sign-out and a person's own revoke of
  one end it the pass's way (`passSessionsRevokedBy`). A new sign-in-library plugin is reviewed
  against that list. Never on cloud: on `EDITION=cloud` the chassis registers no demo route and
  mints nothing, whatever the switch says (the hub owns identity).
- **A concept lives on both editions with the same tables, routes and screens; only its SOURCE
  differs (Romain's rule of 27 September 2026: a self-hosted tool behaves exactly like the cloud
  one connected to the hub, billing aside). Teams are the model (PRDCT-2813, PRDCT-2794)**:
  `workspace_teams` (`hub_team_id` NULL = the tool's own team, set = the hub's projection),
  `workspace_team_members` (the seat rides on the membership row, cascade) and `project_teams` (a
  team's place on a project, with a role) exist on both editions; `api/teams.ts` serves the same
  routes on both, the People > Teams pages, the `teams` CLI family and the two MCP reads read the
  same. On self-hosted, and in a cloud-LOCAL workspace, owners and admins create, rename, delete
  and seat (writes carry `hub_team_id IS NULL`, the second lock). In a hub-origin workspace the
  members' gate (`hubManagedMembershipGate`, `HUB_MANAGED_TEAMS_MESSAGE`) refuses every write with
  403 `hub_managed` + `manageUrl`, and the reconciler alone writes: the person's own seats from
  `GET /orgs` (`projectTeamSeats`), and since PRDCT-2813 the organization's WHOLE team list read
  `GET <hub>/teams` AS THE PERSON with `X-Workspace-Id` (`orgTeams`, `projectOrgTeams`: upsert by
  hub id, delete the projected teams the list no longer names, never a local one), at login and
  then at most every `orgTeamsTtlMs` (5 min) per org per replica, a failure keeping the previous
  list. Rosters on cloud are the seats of the people who signed in here; the whole roster is the
  account site's. **A team is a project member like a person, on both editions**: the ONE access
  rule (`projectGrantPredicate`) holds a grant through `project_members` OR through `project_teams`
  joined to the caller's seat, on the same live non-guest membership row and the same workspace,
  the effective role the highest of the two; workspace owners and admins always pass. Every read
  home of the tool inherits it unchanged (the chassis's `projects.test.ts` pins the grant through a
  seat; a resource private to its author pins a team per read home of its own, the three homes
  `apps/server/src/items/projects.ts` names). A removed seat, a deleted team or a swept membership
  ends the access on the next request. Tool access per team stays the hub's (one self-hosted
  instance is one tool). `denied` on `GET /orgs` is remembered in the reconciler's memory per
  replica and handed to the refusal page through `/me` (`hubDenied`, `hubNoAccessUrl`); it is a
  hint for the copy, never an access input.
- **Taking a person out has three acts, and a removal is the same on both editions (PRDCT-2816)**:
  a PAUSE (`PATCH /members/{id}` `isActive: false`) keeps everything; a REMOVAL switches the
  membership row off, never deletes it, and in the same transaction deletes the person's project
  grants and team seats, revokes the open workspace invitations that name them or that they issued,
  revokes the live demo passes minted for them or by them with the sessions those opened, and ends
  what the tool hangs on them in that workspace; the caller runs that BEFORE it switches the row
  off, the lock order of an invitation's accept (round 3, F2); the ERASURE
  (`DELETE /members/{id}`) deletes the account. What a removal takes is stated ONCE,
  `deleteMembershipGrants` (`packages/chassis-server/src/members/removal.ts`), called by the hub
  reconcile's sweep (cloud, a hub organization) and by `POST /members/{id}/remove` (a workspace
  managed here: admin and above, an owner by an owner only, never oneself, the last-owner guard,
  `hub_managed` on a hub-origin workspace, deliberately UNLISTED in the machine scope allowlist like
  the erasure). The tool's half is the `membershipRemoval` slot (slot 23): what the tool hangs on a
  person in that workspace, an invite waiting for them or a grant on one of its resources, matched
  by account or by address, is ended there; items hang nothing on a person, so the template leaves
  the slot out. **A removed person never comes back by themselves, and never at the role they
  held**: the route leaves the row at `member`; every invitation open at the removal is revoked,
  because accepting a workspace invitation switches an inactive membership back on
  (`invitations/service.ts`), and so does any door of the tool that seats a person (a claim link,
  for one), which then brings a paused or removed person back as `member` whatever the row held.
  Only an act of the workspace made AFTER the removal brings a person back: an admin's Reactivate,
  a workspace invitation (which names its role), a door of the tool opened after it. On cloud, in a
  hub organization, the way back is the account site alone: a tool's own door opened after the
  hub's removal switches the row on until the next reconcile pass sweeps it again, the grant with
  it (verifier round 2, N3; the follow-up is PRDCT-2831). A new table or a new door that hangs a
  right on a person in a workspace joins the function or the slot. A removal against a concurrent
  add: every add of something a removal takes (a project grant, a team seat, a demo pass, the
  creator's grant under `POST /projects`) re-reads the membership inside its own transaction under
  a share lock (`holdLiveMembership`, `members/removal.ts`), so a removal's update waits for an add
  in flight and an add after it sees the row off; the route runs `deleteMembershipGrants` a SECOND
  time after the row is off, taking what an add in flight wrote; and a grant or seat add reads the
  existing row before it inserts, answering the repeat without an insert, so a duplicate add never
  waits on the removal's uncommitted delete (the deadlock of the verifier's round 1, F4).
  `member-removal-race.test.ts` pins each arm. What a removal does NOT end: the person's own API
  keys (a key is the person's credential; one pinned to the workspace reaches nothing while the
  membership is off and works again once they are back), and what they created, which stays with
  the workspace.
- **The default workspace is the person's setting on both editions; only its writer differs
  (PRDCT-2815)**: on cloud the hub reconcile clears and sets `workspace_members.is_default` at every
  pass, so `PUT /me/default-workspace` answers 403 `hub_managed` + `manageUrl` there on EVERY
  workspace (a local write would be undone within minutes); on self-hosted the route is the writer,
  clear-then-set in one transaction (the partial unique index forbids two trues even transiently), on
  an ACTIVE membership of the caller or 404. It reads `principal.userId`, never the request's
  workspace, writes NO audit row (a workspace never learns what its members do elsewhere: the path is
  exempt in `audit/service.ts`, the one machine-reachable exemption, and the change is on the server
  log), is open to machines under the write scope (the CLI's `workspace default`), and refuses a key
  pinned to one workspace (`key_pinned`) and a session a demo link opened (`demo_session`). The
  dashboard decides between the in-place action and the link to the account site on discovery's
  sign-in methods, never on the edition's name.
- **An invitation is accepted on the person's own act, never on the address of a page (PRDCT-2817)**:
  on cloud the workspace invitation page offers Sign in with Antasphere, and the return from the
  sign-in accepts without a second click ONLY when that browser tab holds the mark the click left
  for that invitation (`apps/dashboard/src/lib/invite-return.ts`: session storage, one invitation,
  ten minutes, taken once). Never put the intent in the URL: a link carrying it joined whoever opened
  it while signed in, on both editions (verifier round 1, F2). After an acceptance the page opens the
  workspace the invitation names, not the person's default.
- **On cloud the email address is the hub's, and the tool refuses to change it (PRDCT-2818)**:
  `/change-email` and the emailOTP pair answer 403 `email_change_disabled` naming the account site
  (`isEmailChangePath`, the same before-hook as the reset closure; re-verify the enumeration on any
  Better Auth bump), beside the owner's change-email link already closed there. The tokened
  `GET /verify-email` stays open: it also lands the address verification.
- **The hub owns the wire, the chassis's copies are checked against it (PRDCT-2677)**: the shapes the tools
  exchange with the hub live in the hub's contract and are published as its wire snapshot
  (`packages/contract/wire/hub-tool-messages.json` of the hub); `packages/chassis-contract/src/entitlements.ts`
  copies them, `packages/chassis-contract/src/wire.ts` carries the hub's snapshot builder verbatim, and
  `pnpm --filter @antasphere/chassis-contract wire:check` (the `hub-wire` CI job, against the hub's `dev`)
  fails on any difference. One way only: the hub changes first, the check goes red, the chassis follows at
  its source; never patch the copy here. The check's `unpriceable` reason (a price past
  `Number.MAX_SAFE_INTEGER` credits) is a 413 `entitlement_denied` refusal with the price and the balance
  and no top-up link (a link would draw the dashboard's and the CLI's top-up card), never an outage.
- **The chassis asks the hub before a priced action, and refuses on its answer (billing phase 2, ported
  from Slideless PRDCT-2664)**: on a metered account (cloud, a hub-projected workspace) the gate's step
  after the plan is `HubCreditCheck` (`packages/chassis-server/src/entitlements/check.ts`), one
  `POST <hub>/api/v1/usage/check` with the machine token, the price of THIS quantity against the
  organization's balance, the answer read with the contract's copy (`usageCheckSchema`). The LOCAL credit
  service (`AllowAllEntitlements`, the env cap) is never consulted on a metered account: the plan limit
  is its cap there, and the local env cap is never re-presented to it. A denial is **402
  `entitlement_denied`** with `details: { credits, balance, topUpUrl }` read straight off the hub's
  answer and the message `This needs N credits and the organization holds M; top up at <url>`, the same
  on the dashboard's session, the CLI's key and the MCP tool's text; `account_suspended` from the check
  is 403 `account_suspended` (the live gate's code); an unpriced action (no price row) is allowed at 0
  credits, nothing debited. The cache is per account per action and sound although the price depends on
  the quantity, because the price never decreases with it: an allowed answer is reused thirty seconds
  for any smaller or equal quantity, a denial five seconds (a top-up is felt quickly) for any larger or
  equal one, every other case asks the hub, so a per-call action (`items.create`, always 1) asks the hub
  once per window: a drill that wants the hub asked again uses a LARGER upload. A hub that does not
  answer (network, timeout, 5xx, 403, a 404 that is not `unknown_account`, no machine token) FAILS OPEN
  for fifteen minutes from the first failure, then answers 403 `hub_unavailable` (the federation gate's
  posture and code); a success heals the posture. A 404 `unknown_account` and a 400 are the hub's
  judgement, not an outage: allowed, logged (error level for the 400, a bug a retry never heals),
  nothing charged. The posture, the first failure's second and the cache size are on `/metrics`
  (`usage_check_posture` 0/1/2, `usage_check_failing_since_seconds`, `usage_check_cache_entries`,
  `usage_check_total{outcome}`). Never cache a fail-open answer, and never make the closure a readiness
  flag. The dashboard shows the TOP-UP card on a 402 and the UPGRADE card on a 403 `plan_required`
  (`apps/dashboard/src/lib/billing-refusal.ts`, two distinct cards, the decision on the details, never on
  the edition), the CLI prints the price, the balance and the link, the MCP tool result carries them as
  text; a self-hosted 413 `entitlement_denied` without details keeps its sentence everywhere.
  `items-metering.test.ts` ("the check goes live") pins the 402 on the three surfaces, the debit on the
  ledger, the unpriced 0 and the fail-open; the drill's Phase 8b second leg proves it on a real hub.
- **The poster never posts what the hub would refuse on its date (PRDCT-2644)**: the hub's window
  (`USAGE_EVENT_MAX_PAST_MS` seven days, `USAGE_EVENT_MAX_FUTURE_MS` five minutes,
  `usageEventOccurrenceIssue`, copied with the hub's names and messages in `chassis-contract`, checked
  against the hub by the wire check) is judged before posting; an event outside it is named in the batch
  outcome, sent to `usage-events-held` by the usage worker with the `occurred_at_window:<id>` marker key
  (so the held worker never counts or logs it as a retry-budget hold), and re-driven after the hold
  forever: a future-dated event lands once its time comes, a stale one waits for an operator.
  `usage_events_held_total` carries `{reason}` (`retry_budget`, `occurred_at_window`). The cloud boot logs
  a warning when the hub's `Date` header disagrees with the instance clock by more than the forward bound
  (`packages/chassis-server/src/entitlements/clock-skew.ts`). `usage-window.test.ts` (the chassis's unit
  and integration suites) pins it.
- **A metered upload declares its size, a count demands none (PRDCT-2652)**: on a metered account a
  POST/PUT/PATCH with no `Content-Length` on a route whose limit reads the declared length
  (`declaredContentLength`) or whose meter is in bytes answers 411 `length_required` before the handler
  (a body judged as 0 bytes passed the plan limit whatever its size, and a stored blob is
  content-addressed); every first-party client declares it (Node's fetch and the browser do for a buffer,
  a blob or a form; the template's MCP tools upload nothing, and a tool whose MCP tool uploads through an
  in-process call encodes the form first, as Slideless's does); the operator's cloud-local workspace
  and oss accept the same upload. A COUNT
  limit on a JSON route (`items.perWorkspace` on `POST /items`) never demands a size, and only a SIZE
  limit defers the body cap: a count limit meets the cap's 413 at once.
- **A count a plan limits is a hook the server supplies, judged only for a caller the handler would
  let act (billing phase 3, ported from Slideless PRDCT-2702)**: the declarations are built by
  `toolRouteEntitlements(hooks)` (`packages/contract/src/routes/index.ts`; `TOOL_ROUTE_ENTITLEMENTS` is
  the hookless copy a client reads, the server always builds its own in `apps/server/src/tool.ts`),
  and `items.perWorkspace { oss: null, free: 100, pro: null }` on the item create route reads its
  value through `apps/server/src/items/items-of-workspace.ts`: the workspace's items plus this one
  (`observed > max` refuses the hundred-and-first; a deleted item frees its slot), and **null** for a
  guest, for a caller who may not create into the projects the body names (`ItemService.mayCreate`,
  the same predicate the handler asks) and for a body the create's own schema refuses
  (`itemCreateSchema`, the whole body parsed BEFORE any lookup: the name, the note, at most twenty
  project uuids, so an unbounded list never costs a query per element and a create the validator
  refuses is never judged on the cap), so the gate judges nothing and the handler's own 403
  `guest_forbidden`, 404 `project_not_found` or 400 answers: a refusal of the gate never says more
  than the handler would (a project's existence is not probeable through the cap, and a guest never
  reads the host's plan or balance). The gate runs the hook once, before it reads the plan; a null
  ends its judgement of the request (no plan, no feature, no credit check, nothing metered, the hub
  never asked), otherwise it judges the feature, then the limit, then the price, so a refused create
  costs nothing and posts nothing; a hook that throws is logged at warn and judges nothing, the price
  and the event included (a gap owed upstream, TEMPLATE-FEEDBACK.md); `oss: null`
  costs the hook no lookup on a self-hosted instance; the count is read outside any lock (concurrent
  creates at the cap may overshoot it by the concurrency). The refusal is 403 `plan_required` with
  `details: { key, plan, requiredPlan, upgradeUrl }` on the three surfaces. `items-metering.test.ts`
  ("the check goes live") pins the null at an empty balance: a guest reads 403 `guest_forbidden` and a
  member probing a project 404 `project_not_found`, neither carrying the balance, the hub not asked (the chassis at
  slideless@326d5ff). `plan-limits.test.ts` pins the rest on both editions (the 101st refused, nothing
  posted, the slot freed, pro passing, a second workspace under its own cap unaffected, a hub override
  of the cap, the guest's and the member's refusals at the cap, the bodies the validator refuses, oss
  unlimited), and `test/unit/items-of-workspace.test.ts` names each branch of the hook against a
  fake domain. Never move the count into the handler, and never let the hook judge a caller the
  handler refuses.
- **`workspace.members` is declared by the template and enforced by the hub at ITS doors**: the slot
  declares `{ oss: null, free: 3, pro: null }`, the hub seeds it from discovery and caps invitations
  for the tool at the smallest numeric value among the tools that declare it, and its refusal names
  the tool (`tool=starter-cloud` on the upgrade page). The tool's own invitation doors carry NO
  declaration: on every hub-projected workspace they answer `hub_managed` before any plan could be
  judged, and a declaration that could never refuse is a false guarantee. A tool that opens a door of
  its own into a workspace (a per-resource invitation, a claim) wires the key on that door with a
  seats hook counting the seats AFTER the act, as Slideless's collaborator doors do.
- **A feature is sold on the act, not on the route**: `items.premium { free: false, pro: true }` stays
  declared and wired on no route, and the shape a route wires it in is `feature: { key, when }` with
  `when` reading the parsed body (`await ctx.body()`) for the option the feature sells, judged before
  the plan is read so a request without the option costs no hub read. The item's body has no such
  option, and a template that invented one would close a field of every tool born from it.
- **A public door names its payer through an `actor` hook and gets a per-address wall; the template
  has none**: a route reached with no principal (a form response through a share link, an invitation
  accepted) declares `meter.actor` (metered) or the entry's `actor` (limit-only), resolving the token
  to the resource, the resource to its owner, the owner to `workspaces.centralAccountId`, null on
  anything unresolved; the viewer reads one neutral sentence with no details. A route that declares
  an `actor` hook is a viewer's surface whatever the credential: a person signed in to any workspace who
  holds the link is a viewer there, the hook alone names the payer, and a null or throwing hook leaves
  the route with nothing metered, never a fallback to the signed-in person (`actorOf`,
  `packages/chassis-server/src/entitlements/gate.ts`). A wall in the `api.rateLimits` slot, cloud only
  (`if (hubSso)`, never on oss, where the gate asks nothing), keyed on the ADDRESS and never on the
  secret, bounds what one holder can make the instance ask the hub; and `packages/sdk/test/route-coverage.test.ts`
  filters the door's path out. The template declares neither, because a hook with no public door to
  exercise it is untestable dead code; Slideless's `presentations/form-owner-actor.ts`,
  `test/unit/rate-limits-slot.test.ts` and `metering.test.ts` ("an anonymous surface pays through the
  deck's owner") are the model for a tool that opens one.
- **The federation pair lives under one parent domain, and the drill proves the billing legs on it
  (PRDCT-2825, PRDCT-2863)**: `docker-compose.federation.yml` serves the hub at `hub.ant.localhost` and
  the tool at `starter.ant.localhost` with `SSO_HINT_COOKIE_DOMAIN=ant.localhost` on the hub and
  `HUB_HINT_COOKIE_DOMAIN=ant.localhost` on the tool, never plain `hub.localhost` beside
  `starter.localhost`: the hub's SSO hint cookie needs a Domain both apps share, `localhost` is one
  browsers refuse, so the hub set no hint cookie and the dashboard's hint-watch signed a fresh session
  out within a second (headless scripts never noticed). The drill overlay pins the hop on the same
  name and carries `METRICS_TOKEN` on the tool and `SUPERADMIN_EMAILS` on the hub; the drill's Phase
  8b is the three billing legs of Slideless's Phase 8 retargeted to items (one metered action per
  surface landed once and the replay duplicate; the price book seeded from discovery, the 402 on the
  three surfaces, the debit, the fail-open on a larger upload and the heal; the workspace filled to
  its cap, the 101st refused on the three surfaces with nothing queued, the hub's fourth invitation
  refused, the staff overrides felt and removed). The legs count DELTAS from a drained queue: earlier
  phases already metered items.

## Adding your domain

A tool plugs into the chassis through named slots. The server slots are the fields of `ToolDefinition`
(`packages/chassis-server/src/tool-definition.ts`), and `apps/server/src/tool.ts` fills them. The chassis owns
every order: the boot sequence, the middleware and route registration of the API app, the mounts of the root
app. A tool never reorders anything.

Follow the `items` commits (`items 1/8` to `items 8/8`, one slot per commit; steps 9 and 10 landed as the
squashes f821e95 and 7e95c2f). Each step below names the slot and the path where the
`items` slice lives. Work in this order, and keep the gates green after each step.

1. **The table and its migration** (slots `db` and `runtime.findMigrationsDir`). Add the table to
   `packages/db/src/schema.ts`. Generate the migration with
   `pnpm --filter @antasphere/chassis-db build && pnpm --filter @app/db db:generate --name items`
   (`--name` is the migration file's name: `0001_items.sql`). The new file lands
   after the chassis baseline in `packages/db/drizzle`. `packages/db/test/migrations-journal.test.ts` pins the
   chain, so update its list.
2. **The contract.** The schemas go in `packages/contract/src/schemas/items.ts` and the route contracts in
   `packages/contract/src/routes/index.ts`, beside the `defineChassisContract` call in
   `packages/contract/src/chassis.ts` that carries the tool's scope names.
3. **The server** (slots `services`, `api.routes`, `scopes`, `api.filePolicy`).
   - `services` builds the domain once, in `apps/server/src/items/service.ts`. What it returns is
     `BootResult.tool`.
   - `api.routes` registers the routes, in `apps/server/src/api/items.ts`. The hook runs after the files
     routes and before the OpenAPI document and the JSON 404.
   - `scopes` holds the scope names and `requiredScopeFor`, in `apps/server/src/middleware/scopes.ts`. The
     allowlist is fail-closed. The chassis rules run first, then the tool's, and a path that no rule matches
     answers 403 to every API key and OAuth token. A new route stays closed to machines until a rule opens
     it. `items` opens `/items` with `items:read` for reads and `items:write` for mutations.
   - The same commit sets the audit rows the routes write.
   - `api.filePolicy` is REQUIRED. The chassis has no default, because a blob read is never authorized on
     `workspace_id` alone (SL-B1). The tool states what references a blob and who may read one. In the
     template, `blobInUse` returns `false`: items reference no blob, so the files surface may always delete
     one. `blobReadScope` (`apps/server/src/files/blob-read-scope.ts`) returns `undefined` for an owner or an
     admin, which means every blob of the workspace. For anyone else it returns a predicate that keeps the
     blobs this user uploaded, read from `file_uploaders`. A blob the caller may not read answers 404. When
     your resource binds files, add "or it is referenced by a row this principal can read" to that function,
     and use the same predicate to guard the bind.
4. **The SDK.** Add one method per route to `PlatformClient` in `packages/sdk/src/index.ts`.
   `packages/sdk/test/route-coverage.test.ts` walks every route contract and fails on a route without a
   method.
5. **The CLI.** Add the command group in `packages/cli/src/commands/items.ts` and register it from
   `registerTool` in `packages/cli/src/index.ts`. `packages/cli/test/docs-coverage.test.ts` fails until
   `docs/agents/cli.md` names every command and every long flag.
6. **The MCP tools** (slot `mcp`). Register them in `registerTools`, in `apps/server/src/mcp/tools.ts`. The
   chassis registers its own tools first: `get_me`, `list_files`, `<toolPrefix>whoami` under the prefix of
   the identity (never register a whoami of your own), then the eleven project tools and the two team reads under
   the same prefix (`list_projects` to `remove_project_team`, `list_teams`, `list_team_members`; never register one
   of those either; 23 tools in all with the item tools). A tool is a thin shim over the
   resource's own `/api/v1` routes (`callApi`), never over a service, and its name is built from the one
   `MCP_TOOL_PREFIX` (`IDENTITY.mcp.toolPrefix`). `apps/server/test/unit/mcp-docs-coverage.test.ts` fails until the table of
   `docs/agents/mcp-connector.md` names every tool.
7. **The dashboard.** The tool gives the shell ONE contribution, the object `tool` exported by
   `apps/dashboard/src/lib/tool/index.ts`. Its type, `ToolContribution`, is in
   `apps/dashboard/src/lib/contribution.ts`: the menu entries (`nav` before the shell's Projects entry,
   `navAfter` after it), the phone tabs, the signed-out routes, the lists to warm, the audit vocabulary, the
   overview pieces, and `project.Resources`, the piece the shell renders on a project's page under its
   members: what a project holds in this tool (the template's `ProjectItems`). The Projects section itself
   (the list, the project page, the members and their roles, the archive) is the shell's, under
   `lib/projects/`, `lib/components/projects/` and `routes/(app)/projects/`, and names no tool. The pages live in
   `apps/dashboard/src/routes/(app)/(tool)/items/` and everything else of the tool under
   `apps/dashboard/src/lib/tool/`. The shell reaches the tool through two doors only: `$lib/tool` for any
   shell file, and `$lib/tool/i18n` (the tool's words in `en.ts` and `fr.ts`) for `lib/i18n/index.ts` alone.
   `apps/dashboard/src/lib/boundary.test.ts` fails on any other import from the shell into the tool's paths.
   A tool that adds a route group of its own outside `(app)/(tool)/` (a signed-out page, a full-screen page)
   lists it in that test's `TOOL_PATHS` and names it in `NAMES_THE_TOOL`. Change those two lists and nothing
   else in that test.
8. **The workspace export** (slot `api.exportEntries`). The query lives in `apps/server/src/items/export.ts`
   and `apps/server/src/tool.ts` hands it to the slot. The function receives the handle the route reads with
   and the workspace id the principal resolved to, and returns the tool's entries. `items` returns two,
   `items` and `item_projects`, written as `items.json` and `item_projects.json` after `files.json` and
   before the blobs (the projects themselves are the chassis's `projects.json` and `project_members.json`,
   written before the tool's entries); a workspace without items gets `[]` in each. The rules:
   - The chassis does not filter for the tool. The statement carries the workspace id in its WHERE.
   - SELECT the columns. A secret left in a row leaves the instance, and a column added to the table later
     must not leave by itself. `items` exports its seven columns (the wire's per-caller `projects` is not one:
     the links are their own entry), in `(created_at, id)`
     order.
   - A name of `RESERVED_EXPORT_ENTRY_NAMES` (`packages/chassis-server/src/api/export.ts`: `manifest`,
     `workspace`, `members`, `invitations`, `api-keys`, `audit-log`, `files`, `skipped-blobs`, and the
     chassis's own `projects`, `project_members`, `teams`, `team_members`, `project_teams`) or the same
     name twice answers 500. So does a throw. Every entry is computed before the first byte, so the answer is
     never a truncated zip. The entries are held in memory: bounded tables only.
   - Who may export is the chassis's rule and stays so: an owner or an admin, never a guest, a machine only
     with `data:export`. Add no rule; test them on your entry.

   `apps/server/test/integration/items-export.test.ts` pins it: the other workspace's items are absent, the
   key set of a row is exactly the selected one, the entry's place, the refusals.

9. **Projects: linking your resource.** The chassis gives every tool the projects (the tables, the routes,
   the CLI group, the eleven project MCP tools, the dashboard's Projects section); what a project HOLDS is the
   tool's, and `items` shows the seam end to end (the squash f821e95, PR #24, both halves in one commit):
   - the link table (`item_projects`: both ends cascading, `workspace_id` carried, an index on the project;
     migration `0003_item_projects`);
   - the contract (`projects: [{ id, name }]` on the wire shape, `projectIds` on the create, `?project=` on
     the list, `PUT|DELETE /items/{id}/projects/{projectId}`) and the SDK methods;
   - the server: `apps/server/src/items/projects.ts` (`canLinkIntoProject`, `ITEMS_ID`), the service's
     `projectsOf` (the payload, the caller's readable projects only), `projectRoleOf` (the filter's 404), the
     create linking in its own transaction, `linkProject` and `unlinkProject` (the project row FOR SHARE, the
     archived-write rule inside), the two routes behind one gate (the item's 404, the project's 404, 403 below
     editor, 409 archived) and their audit rows (`item.project_link`, `item.project_unlink`);
     the machine allowlist needs no new rule when the link rides the resource's own tree;
   - the export entry `item_projects`;
   - the CLI: `--project` on `items list` (the project refusal as a sentence) and on `items create`
     (repeatable), the `projects:` line of `items show`, and `projects link|unlink` hung off the chassis's
     `projects` group (`packages/cli/src/commands/projects.ts`);
   - the MCP tools: `projectId` on the list, `projectIds` on the create, `link_item_to_project` and
     `unlink_item_from_project`, and the hints the item side adds over the chassis's project table;
   - the dashboard door `project.Resources` and the project chips and filter of the items page.

   `apps/server/test/integration/items-projects.test.ts` pins it on a real Postgres: the payload per caller,
   the filter, the tiers on the link and the unlink, the atomic create, the grant dying with the membership,
   the machine scopes, the audit rows. A resource private to its author adds the read branch too, in its
   three homes at once; the header of `items/projects.ts` says how.

10. **The prices, the limits and the feature** (slot `entitlements`). The keys and the route declarations
    live beside the route contracts in `packages/contract/src/routes/index.ts` (`TOOL_ACTIONS`,
    `TOOL_LIMITS`, `TOOL_FEATURES`, and `toolRouteEntitlements(hooks)`: one entry per route carrying
    `meter`, `limit` or `feature`, built from the route objects so a typo throws at module load;
    `TOOL_ROUTE_ENTITLEMENTS` is the same list with hooks that resolve nothing, what a client reads),
    and the slot in `apps/server/src/tool.ts` prices the actions (`creditsPerUnit` per `unit`, `per`
    when the price is per mebibyte of a meter in bytes), values every limit per tier (`oss`, `free`,
    `pro`; `null` = unlimited) and switches every feature (`free`, `pro`), as a function of the
    environment so an `oss` value can be the operator's own cap, and builds the declarations with the
    hooks that read the domain at request time (`getTool` of the slot's `EntitlementsContext`). The boot's
    `assertToolEntitlements` parses the slot through the contract's `toolEntitlementsSchema` (a limit
    missing a tier stops the boot, naming the first issue's path) and refuses any tier value, or unlimited,
    above a numeric `oss` ceiling. The
    template declares two actions (`items.create` on the item create route, per call; `files.upload` on
    the chassis's upload route, in bytes priced per MB), three limits and one feature:
    - `files.maxBytes`, a SIZE limit: the operator's cap as the `oss` value; the cap is the instance's
      hard ceiling and the boot refuses a tier advertised above it, so the `pro` value IS the cap and
      `free` is 100 MB or the cap when the cap is smaller (what discovery advertises is what the
      instance serves; a paid tier above the free one exists only on an instance capped above 100 MB;
      PRDCT-2653 is the chassis's part). `apps/server/test/unit/entitlements-declaration.test.ts` pins
      the three values at caps of 50, 100 and 500 MB.
    - `items.perWorkspace { oss: null, free: 100, pro: null }`, a COUNT limit on the item create route,
      the worked example of a count a plan limits. Its value is the hook of
      `apps/server/src/items/items-of-workspace.ts`: the workspace's items plus this one, for a caller
      the handler would let create; **null** for a guest and for a caller who may not create into the
      projects the body names (`ItemService.mayCreate`, the handler's own predicate), so the handler's
      403 or 404 answers and the cap never says more than the handler would. A count hook reads the
      body through `ctx.body()` (the parse Hono keeps for the validator) and its own tables through the
      domain, never a lock; `oss: null` means a self-hosted instance knows no cap and the hook costs
      it nothing.
    - `workspace.members { oss: null, free: 3, pro: null }`, declared and wired on no route: the hub
      enforces it at its invitation doors (the smallest value among the tools that declare it); the
      tool's own invitation doors answer `hub_managed` on every hub-projected workspace. A door of the
      tool's own into a workspace wires it with a seats hook.
    - `items.premium { free: false, pro: true }`, wired on no route: the comment beside `TOOL_FEATURES`
      says why, and shows the `feature: { key, when }` shape a route sells an act with.

    A route reached with no principal (a public door) names its payer with an `actor` hook
    (`meter.actor` on a metered route, the entry's `actor` on a limit-only one: the token to the
    resource, the resource to its owner, the owner to the workspace's central account, null on
    anything unresolved), reads one neutral refusal, and gets a per-address wall in the
    `api.rateLimits` slot, cloud only, never keyed on the secret; the template has no such door and
    documents the shape in the invariants above. Keep `files.upload` on the upload route: the chassis
    route checks and emits nothing by hand. The handler's audit row is what the emit reads
    (`resourceType`, `resourceId`, `metadata.sizeBytes`), so a metered route sets it.
    `apps/server/test/integration/items-metering.test.ts` pins the metering on both editions
    (discovery, the oss no-op, the cloud post against the fake hub per surface, the check that goes
    live with the 402 and the fail-open, the 411, the plan refusal on the upload) and
    `apps/server/test/integration/plan-limits.test.ts` the count limit (the 101st refused on the three
    surfaces with nothing posted, the slot freed, pro passing, the guest's and the member's refusals at
    the cap, oss unlimited); `tool-slots.test.ts` pins the hand-over; the federation drill's Phase 8b
    proves the three legs on a real hub.

The placeholder leaves these optional slots EMPTY. A tool fills one when it has something to put there.

- `env`: the tool's own environment keys. The extension is wired in `apps/server/src/env.ts` and has no key.
- `jobs`: pg-boss job declarations, for example a nightly purge of the tool's rows. A handler reads the
  domain through `getTool()` at run time.
- `rateLimiters`: extra named buckets. A tool bucket cannot take a chassis bucket's name.
- `api.untrustedOrigins`: origins that are never trusted, for example a separate origin that serves user
  content.
- `api.csrfExempt`: paths the cross-site guard lets through. Token-authed, cookie-less surfaces only.
- `api.auditExempt`: paths that skip the generic audit row, because the handler writes its own.
- `api.idempotencyTargets`: the tool's POST paths that honour an `Idempotency-Key`.
- `api.early`: a hook right after `noStoreAuthenticated()` and before the body caps, for example the CORS of
  a public token-authed surface.
- `api.bodyLimit`: body-size caps for the tool's paths, where the 1 MiB default does not fit. The verdict is
  DATA (`BodyCap`: the ceiling and the refusal), never a middleware: the chassis builds it, and defers the
  declared-size refusal behind the plan gate on a route that checks a limit.
- `api.jsonDepthExempt`: paths whose body is never parsed, so the JSON nesting cap does not apply.
- `api.rateLimits`: rate walls on the tool's routes, placed between the `/invitations/*` walls and the
  `/admin/break-glass/*` wall.
- `membershipRemoval` (slot 23): the tool's half of a member's removal, run in the removal's transaction
  on both editions (`POST /members/{id}/remove` and the hub sweep). The chassis ends the person's project
  grants and team seats; what the TOOL hangs on a person (an invite waiting for them, a grant on one of
  its resources) is ended here. Items hang nothing on a person, so the placeholder leaves it out.
- `demoSessionRefusedRoutes` (slot 24): the tool's own API routes a session a demo link opened is refused
  (403 `demo_session`), appended to the chassis's list at the one mount. A pass's session is a visit: a
  route that answers a credential (an invite link, a claim link, a key) joins the list, and
  `apps/server/test/unit/demo-pass-rules.test.ts` walks the tool's contract with the chassis's and fails
  on one that does not. No item route answers a credential, so the walk passes on an empty slot.
- `app.rootMiddleware`: one middleware on the root app, before every mount, for example a host gate.
- `app.cspFrameSrc`: extra `frame-src` origins for the dashboard CSP.
- `app.cspImgSrc`: extra `img-src` sources for the dashboard CSP (`blob:` for a dashboard that shows
  images it fetched through the API).
- `app.publicRoutes`: a public Hono app outside `/api/v1`, mounted after well-known and before the static
  files and the SPA fallback.

## Mail

`pnpm --filter @app/server preview:emails` renders every mail to a local review wall in `.tmp/email-previews/`
(`apps/server/scripts/previewEmails.ts`). It is the same wall as the hub's and the sibling templates': one family,
so a change to one is a change to consider on the others. It renders every builder with fixture data, several
shapes for the mails that have them, and nothing is ever sent. A new mail means a new `TemplateSpec` in its
`catalogue()`, with reader-facing `when` copy; the builders stay env-free (urls, names and dates arrive as
parameters), which is what lets `tsx` render them standalone.

The mails' layout is `packages/chassis-server/src/email/shell.ts`, carried BYTE-IDENTICAL by the hub's
`apps/server/src/email/shell.ts` (`cmp` the two before closing a mail task). The five account mails are the
chassis's `email/templates.ts`: they spell no product, the name comes from `identity.displayName` and the three
phrases that are a tool's own from the `copy.mail` slot (`apps/server/src/email/brand.ts`). A mail of the tool's
own domain goes beside that file, on the same shell. The grain band and the mark are hosted images,
`apps/dashboard/static/email/band.jpg` and `mark.png`, because Gmail strips SVG and data URIs; the chassis boot
hands their urls to the shell from `PUBLIC_BASE_URL`, and the shell falls back to a CSS gradient without them.
Integration tests read links and codes out of the TEXT part: the first url in it must be the action link
(`linkOf` in `apps/server/test/integration/identity-pins.test.ts`).

Local dev mail: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` runs Mailpit and points
the SMTP driver at it (internal/dev-mailpit.md).

## Gates

Node 22 (`engines` in `package.json`) and pnpm 10.34.4 (the `packageManager` pin). CI
(`.github/workflows/ci.yml`) runs these commands.

```bash
pnpm install --frozen-lockfile
node scripts/check-chassis-copies.mjs        # checks job, first step; same as `pnpm chassis:check`
node scripts/check-shell-copies.mjs          # checks job, second step; same as `pnpm shell:check`
node --test scripts/check-shell-copies.test.mjs  # checks job, same step: the shell guard's own test
pnpm turbo lint typecheck test build         # checks job
pnpm format:check                            # checks job; `pnpm format` fixes
pnpm --filter @app/server drift:check  # checks job: the auth-schema drift guard
# checks job, last step: the compose files read without the optional services' variables
POSTGRES_PASSWORD=ci docker compose -f docker-compose.yml config --quiet
POSTGRES_PASSWORD=ci docker compose -f docker-compose.yml -f docker-compose.dev.yml config --quiet
# hub-wire job (its own job, below): the chassis's copies against the hub's wire snapshot
pnpm --filter @antasphere/chassis-contract build
HUB_WIRE_SNAPSHOT=<hub>/packages/contract/wire/hub-tool-messages.json pnpm --filter @antasphere/chassis-contract wire:check
pnpm turbo build --filter=@app/db --filter=@app/server --filter=@antasphere/starter
pnpm turbo test:integration                  # integration job: real Postgres via testcontainers; needs Docker
```

**A gate run that is a PROOF runs with `--force`**: `pnpm turbo lint typecheck test build --force` and
`pnpm turbo test:integration --force`. Turbo's local cache is keyed on file content and shared by every
checkout and worktree on a machine, so a `45 successful` whose `Cached:` line says 44 replayed another
tree's result and proves nothing about this one. Read the `Cached:` line before you believe a green run.
The first gate of a new tool, a verifier's baseline and any figure written in a report are proofs. The same
trap has a second form: `@app/contract`, `@app/db` and the chassis packages are consumed through their `dist`
folder, so a test run after a source edit there reads the OLD code until the package is rebuilt. Rebuild
before you believe a green test, above all when the edit was meant to turn it red. CI starts
from an empty cache, so its commands carry no flag.

The last step of the `checks` job reads the compose files with nothing set but `POSTGRES_PASSWORD`: an optional
service's required variable once made every compose command fail for every self-hoster (Slideless PRDCT-2725).
`hub-wire` is a job of its own beside `checks`: it checks out the hub's `dev` (the snapshot file only) and runs
the wire check with `HUB_WIRE_SNAPSHOT` pointing at it (the chassis's copies of the hub's message schemas against
the hub's own snapshot; "The hub owns the wire" above). Locally, set `HUB_WIRE_SNAPSHOT` to the hub's
`packages/contract/wire/hub-tool-messages.json`: the check's fallback, a hub checkout five levels up from the
package, is right for a tool cut from the template and one level off from the template's own place in the workspace.
Four more CI jobs build the image and run a rehearsal on it: `hostinger`
(`node --test scripts/hostinger-template.test.mjs`, then `node scripts/hostinger-smoke.mjs`), `scale-drill`
(`./scripts/scale-drill.sh`), `federation-drill` (`./scripts/federation-drill.sh`, which also checks out
`antasphere/hub`) and `instantiate-proof` (a throwaway tool born from the tree, its gate, its image booted).

The Playwright suite (`apps/dashboard/e2e`) runs in no CI job. Run `pnpm test:e2e` before you ship a change
to a page it covers.

Nothing publishes, deploys or dispatches from the template. README.md, "CI and releases in the template",
says what is switched off and how to switch it back on.

## Before you change things

No `internal/` folder is in this repository. Every `internal/...` path in this file and in the code comments
reads at `labs/products/antasphere/tools/slideless/slideless-os/knowledge/internal/` in the workspace
(`decisions/` for the ADRs, `security-runbooks.md`, `federation.md`, `production-readiness.md`,
`backup-and-data-sovereignty.md`, `dev-mailpit.md`, `dashboard-shell-and-tool.md`). Keep that record out of
this repository.

- **LESSONS.md**: read it before you touch auth, MCP, Docker packaging or the chassis boundary. It records
  the traps already hit and why the current shapes exist.
- **TEMPLATE-FEEDBACK.md**: what a tool built from this template sends back. Never fix the template from
  inside a tool. Add an entry there.
- **The Better Auth trio is exact-pinned** (`better-auth`, `@better-auth/oauth-provider`,
  `@better-auth/cli`; ADR 001 in `internal/decisions/`). Bump all three together or none. Today `better-auth` and
  the provider are at 1.6.22 and the CLI at 1.4.21: the pins are exact, the versions are not one.
- **internal/decisions/**: the ADRs. Version pins (001, the exact-pinned Better Auth trio), MCP transport (002),
  OIDC client deferral (003), pgvector (004), auth surface and metrics defaults (005).
- **internal/production-readiness.md**: the honest gap list and roadmap.
- **internal/backup-and-data-sovereignty.md**: the deferred design note on why durable backups must stay
  EU-sovereign (the database in the instance plus encrypted offsite copies to European object storage), the
  AUTH_SECRET-in-/data recovery trap, and the open decisions. Read it before you build a backup system. The
  operator runbook for today's scripts is `docs/operations/backup-restore.md`.
