# Lessons

Corrections and confirmed approaches, with why they mattered. Update in place;
delete entries that later prove wrong.

## Confirmed approaches

- **Session-scoped `pg_advisory_lock` on a dedicated `pg.Client` around
  `migrate()`** survives a two-replica race (verified: exactly one applies,
  both healthy). A transaction-scoped lock would release at drizzle's first
  internal commit.
- **`ctx.request` distinguishes HTTP from server-side Better Auth calls.**
  The before-hook that closes public sign-up checks `ctx.path.startsWith('/sign-up') && ctx.request`;
  server-side `auth.api.signUpEmail` (setup, invitation accept) carries no
  request and passes.
- **Better Auth CLI generate output is snake_case columns / camelCase
  properties / singular tables / TEXT ids** on the 1.6.x line — friendlier
  than older reports suggested. FKs from domain tables to `user.id` must be
  `text`.
- **`pnpm deploy` + a `"files": ["dist", "public"]` allowlist** produces the
  runtime layout; never bundle pino/pg/pg-boss (dynamic requires + transport
  workers break).
- **The oauth-provider consent dance is signed-query round-tripping** (1.6.15):
  `GET /oauth2/authorize` with a session but no stored consent answers a
  redirect to `consentPage?<signed query>` (all original authorize params +
  `exp` + issued-at + `sig`, HMAC'd with the auth secret). The consent page
  posts that query string back VERBATIM as `oauth_query` to
  `POST /oauth2/consent` `{ accept, oauth_query, scope? }` (session cookie
  required); the plugin verifies `sig` server-side, records the consent, and
  returns the client redirect (with the authorization code). No custom
  validation endpoint needed — the signature IS the API-side validation.
- **`customAccessTokenClaims` gates JWT issuance on BOTH grants**
  (authorization_code and refresh_token) — throwing `APIError('FORBIDDEN')`
  there when the live `workspace_members` row is missing/inactive aborts JWT
  minting. It is NOT the revocation mechanism, though: a refresh without the
  RFC 8707 `resource` param still mints an OPAQUE token that never passes
  through the claims callback (verified live, M9). The real enforcement is
  resource-side — the live membership re-check on every request, plus the
  bearer gate's `looksLikeJwt` rejecting opaque tokens outright.
- **Stateless `@hono/mcp`: one McpServer + `StreamableHTTPTransport({
enableJsonResponse: true })` per request** — no session ids, POST responses
  are complete JSON, GET is 405, and the official SDK client is happy. Omit
  `sessionIdGenerator` entirely; passing an explicit `undefined` trips
  `exactOptionalPropertyTypes`.
- **The MCP SDK Client needs a real listening server** — it dials a URL, so
  the dance test serves the booted Hono app on an ephemeral port with
  `@hono/node-server` (pick a free port first: PUBLIC_BASE_URL must equal the
  real origin because it is issuer, discovery root, and `/mcp` aud at once).
  `app.request()` stays fine for everything that isn't the SDK client.
- **The oauth-provider plugin's per-grant value seam is `postLogin.consentReferenceId`**
  (1.6.15, ADR 014): the callback (`{ user, session, scopes }` — no request
  body, no headers) runs on every authorize AND on the consent POST; its
  return value is stored on the consent row (consents are keyed
  client+user+referenceId), embedded in the authorization-code verification
  value, persisted on the refresh-token row, and handed to
  `customAccessTokenClaims({ referenceId })` on BOTH grants — refresh
  re-mints receive the STORED value with no extra plumbing. The generated
  auth schema already has the `reference_id` columns (plugin-static), so no
  drift. `postLogin` requires `page` + `shouldRedirect` too; a constant
  `() => false` keeps the picker on the consent page itself. Because the
  callback sees only the session, a user CHOICE must be parked
  session-visibly first (we use a verification-table row keyed to the
  session id, written by `POST /oauth/consent-workspace`). Throwing an
  APIError inside the callback fails the authorize with a 403 RFC-error
  body (not a redirect) — the fail-closed path for stale selections.
  Re-verify all of this on ANY Better Auth bump.
- **The drift guard absorbed the plugin tables cleanly**: adding jwt +
  oauthProvider to `scripts/auth-schema-config.ts` makes the pinned CLI emit
  `jwks` + 4 `oauth_*` tables (snake_case tables, camelCase index names);
  regenerate snapshot + `packages/db/src/auth-schema.ts` together and let
  drizzle-kit produce the additive migration. Same shape for `twoFactor`
  (I5): one `two_factor` table + `user.two_factor_enabled`, the migration that added them,
  zero drift surprises.

- **`fs.promises.writeFile` is not a safe way to write a path someone else
  chose.** It follows a pre-existing symlink at the target, and its
  `O_TRUNC` write PRESERVES the existing file's mode — a `-rwxr-xr-x` file
  stayed executable across both `writeFileSync` and `fs.promises.writeFile`
  (re-proved during PRDCT-1353). `open(target, O_WRONLY|O_CREAT|O_TRUNC|
O_NOFOLLOW, 0o644)` + an explicit `fchmod` is the shape; the parent
  directory needs its own `realpath` check, because `mkdir -p` walks
  straight through an existing symlinked directory.
- **`fetch` has no default timeout** — not in Node, not in the browser. A
  peer that accepts the connection and then says nothing parks the caller
  forever. Every SDK call carries `AbortSignal.timeout` (30 s for JSON,
  10 min for the byte-streaming ones, both overridable, `0` disables).
- **`fetch` silently DROPS a `Host` header** (forbidden header name), so a
  Host-validation test has to go through `node:http` directly. Same trap
  for any other forbidden header.
- **A lexical `resolve()` + `startsWith()` is not a traversal guard.** It
  cannot see a symlink. `slideless dev` shipped one and served `/etc/passwd`
  through a link inside the deck folder; the fix is `realpath` plus a second
  containment check on the resolved path.

## Corrections

- **Setup must claim + create workspace + membership in ONE transaction.**
  The first implementation could persist the singleton claim and then fail,
  leaving `setupRequired=false` with no owner — a bricked instance (proven by
  the M1 verifier). The Better Auth user is created outside the transaction
  (it cannot join); a losing racer leaves an orphaned user who can sign in
  but gets 401 everywhere. Setup retries reuse an existing owner account only
  after the presented credentials sign in successfully.
- **`VAR=` (empty string) in compose must mean "unset"** for optional env
  vars; zod `.optional()` alone rejects it. Every optional var goes through
  the empty-string preprocessor — which must **trim**: `VAR=' '` (whitespace)
  is `Number(' ') === 0`, so an untrimmed blank silently flips a `min(0)`
  numeric knob (e.g. the API rate limit) to its 0/disabled meaning instead of
  the default. `blankToUndefined` in `env.ts` trims; enum vars fail loudly on
  whitespace anyway, only meaningful-zero numerics were silently affected.
- **The Better Auth CLI silently writes nothing when the output file already
  exists** — hand it a fresh path in a temp dir, never a `mktemp`-created file.
- **The standalone `@better-auth/cli` version line (1.4.x) differs from
  better-auth (1.6.x)**, its bin is `better-auth`, and it vendors its own
  better-auth — so pnpm overrides for `@better-auth/core` must be scoped to
  the 1.6.15 parents or they poison the CLI's tree.
- **Drift-diff normalization needs the repo prettier config passed
  explicitly** — a temp file outside the repo gets prettier defaults and the
  diff false-positives.
- **`api.use('/thing/:id', gate)` also gates `/thing/lookup` and
  `/thing/accept`** — sibling literal segments under a param pattern need an
  explicit skip in the middleware, and the skip must be METHOD-exact or a
  DELETE /thing/lookup walks past the gate into a null-principal 500.
- **Never trust x-forwarded-for by default.** Rate-limit buckets and audit
  IPs derive from the socket address unless TRUST_PROXY opts into XFF
  (behind Caddy). Trusting XFF unconditionally let anyone rotate buckets
  (nullifying every per-IP limit) or fill a victim's bucket; the constant
  fallback also collapsed all direct clients into one shared bucket.
- **"Sign-up closed" needs three switches, not one**: the /sign-up hook,
  `disableSignUp` on the emailOTP plugin (OTP to an unknown email otherwise
  MINTS a user), and `disableSignUp` on each social provider (the OAuth
  callback otherwise creates users).
- **Machine-principal READS must be audited** — API keys mostly read, so
  auditing only mutations made "the key's identity lands in the audit log"
  (exit criterion 4) unsatisfiable.
- **Better Auth 1.6.15 wire quirks the clients must tolerate**: dynamic client
  registration answers **200**, not RFC 7591's 201; and `authorize`/`consent`
  return `{ redirect: true, url }` as JSON (HTTP 200) whenever
  `sec-fetch-mode: cors` is on the request (Node fetch sends it too) or
  `accept: application/json` — a 302 Location only for real browser
  navigations. The SPA consent page and any scripted client must handle the
  JSON shape.
- **Tokens minted without the RFC 8707 `resource` param are opaque, not
  JWTs** — they fail `looksLikeJwt` and die at the bearer gate. Correct MCP
  clients always send `resource`; the failure mode is a clean 401, not a
  confusing verification error.

## M8 (security review + final sweep)

- **The base image's bundled npm was the only vuln source.** After pruning
  esbuild/drizzle-kit, the last two HIGH CVEs (picomatch, sigstore) were in
  `/usr/local/lib/node_modules/npm` — npm's own vendored deps, not ours. The
  runtime runs `node dist/index.js` and never invokes npm, so
  `rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm*` in the runtime
  stage clears them AND trims the image. Trivy's Node scanner reads nested
  bundled package.json manifests, so a clean `/app/node_modules` isn't enough.
- **`pnpm deploy --prod --legacy` re-resolves independently of the frozen
  lockfile** and drags better-auth's peer-resolved `drizzle-kit` (→ esbuild
  Go binaries, the bulk of the CVEs) into the prod tree. Prune it in the
  Dockerfile — but NOT `kysely`, which better-auth statically imports at
  module load (`db/get-migration.mjs`); removing it dangles a symlink Node
  DOES follow → boot crash. "Verify each prune target isn't in a static
  import graph" is now enforced mechanically at build time by
  `scripts/prune-runtime-deps.mjs` (see the I1 entry below).
- **Never split a base64url credential on `_`.** Two flaky tests derived a
  key's secret/keyId via `key.split('_')[n]`, but base64url contains `_`, so
  the fragments were wrong ~1/7 of the time (a short fragment collided with a
  UUID; a truncated keyId failed the format check and skipped the rate-limit
  wall). Capture `keyId` from the mint response; assert the full key never
  reappears.
- **Open-redirect: a single leading slash is not enough.** `//evil.com` and
  `/\evil.com` are browser-resolved to external origins. `safeNext()` rejects
  those and requires exactly one leading slash.
- **Image size is 440MB vs the ~300MB soft target** — the batteries-included
  single image ships the aws-sdk v3 s3 driver (~100MB), OpenTelemetry, the
  MCP SDK, and the OAuth server. Trimming would mean a lazy/optional s3
  driver or two image variants; deferred as not worth the complexity for a
  template. Recorded as a known deviation.

## Post-M8 (account recovery + hardening pass, 2026-07-04)

- **Better Auth 1.6.15's core `hooks.before` is the only seam to scheme-check
  DCR client metadata.** The oauth-provider plugin validates only
  `redirect_uris`; `client_uri`/`logo_uri` accept any string, so a stored
  `javascript:` URI could reach a render site. The hook must cover
  `/oauth2/register` AND `/oauth2/create-client` AND `/oauth2/update-client`,
  and update-client nests the fields under `update`.
- **The admin reset link mints into Better Auth's own `verification` table**:
  `auth.$context.internalAdapter.createVerificationValue({ identifier:
'reset-password:<token>', value: userId })` is the exact shape
  `POST /reset-password` consumes. No schema change, no drift.
- **Better Auth-native routes bypass the /api/v1 audit middleware.** A
  `hooks.after` matching `/change-password` reads
  `ctx.context.session.user.id` (populated because the route is
  session-gated), and `emailAndPassword.onPasswordReset` covers reset; both
  fire an injected `onAccountEvent`.
- **The 3-segment `/members/:id/reset-link` is NOT covered by the 2-segment
  `api.use('/members/:id', requireRole('admin'))` gate.** Every extra path
  segment needs its own explicit gate.
- **Caddy ≥2.5 discards client-supplied `X-Forwarded-*` by default.** The app
  reads the RIGHTMOST hop, which is correct under both overwrite and append
  proxies; the leftmost hop is client-claimed whenever a proxy appends.
- **The nightly audit purge must delete in bounded batches.** One unbatched
  DELETE seq-scans and blows the pool's `statement_timeout` on a large table,
  so retention silently never runs; the `created_at` index (the migration that added it)
  keeps each batch fast.
- **A Node consumer of the SDK (the CLI) typechecks without a DOM lib only
  because the browser-only `cache` and body fields are cast to
  `RequestInit`.** Keep those casts when touching the SDK's fetch calls.

## M6 (email change, 2026-07-06)

- **The admin change-email link couples to `createEmailVerificationToken`
  from `'better-auth/api'`** (1.6.15: `(secret, email, updateTo?, expiresIn
= 3600, extraPayload?)`). It signs the exact HS256 JWT `GET /verify-email`
  consumes — payload `{email, updateTo, requestType}`, signed with the auth
  secret, requestType `'change-email-verification'` for the direct-change
  branch. Never hand-roll the jose call; re-verify the payload shape and the
  export on ANY Better Auth bump.
- **Change-email tokens are STATELESS JWTs — never stored in the
  `verification` table** (unlike reset-password tokens, which tests fish out
  of the DB). The only observation seam is the outbound mail, hence
  `RecordingEmailDriver` behind the `BootOverrides.email` seam. They also
  cannot be revoked; the 1 h expiry is the whole mitigation.
- **Template users are `emailVerified = false`, so the SINGLE-LEG flow is the
  common case**: `POST /change-email` mails exactly one verification link to
  the NEW address via top-level `emailVerification.sendVerificationEmail`
  (mandatory wiring — without it the endpoint 400s before any email lookup).
  The confirmation-to-the-OLD-address leg
  (`changeEmail.sendChangeEmailConfirmation`) only runs for verified users.
- **Consuming a change-email JWT while logged out CREATES a session for the
  target user** — the link is sign-in-equivalent. A different signed-in user
  is rejected (INVALID_USER), but logged-out consumption signs the target in
  and sets the cookie. The admin copy-link dialog must say "hand this to the
  member only", and the mint route stays session-only (deliberately unlisted
  in the machine scope allowlist).

## M9 (adversarial-campaign fixes, 2026-07-07)

- **The stateless MCP transport does NOT 405 a non-POST on its own.** A GET
  reaching `StreamableHTTPTransport.handleRequest` opens a long-lived
  server-initiated SSE stream and DELETE answers a session teardown, even
  with no `sessionIdGenerator` — the "GET is 405 by design" claim was
  aspirational. Reject non-POST explicitly in `src/mcp/http.ts` (405 +
  `Allow: POST`, JSON-RPC envelope) BEFORE invoking the transport, and
  convert the transport's thrown `HTTPException` (malformed / non-JSON-RPC
  POST body) into its own JSON-RPC 400 response so it never surfaces as a
  generic 500.
- **Every `{id}` path param needs `z.uuid()` (or an in-handler `isUuid`
  check for the plain-Hono routes).** A bare `z.string()` param lets a
  non-UUID id reach Postgres' uuid cast → `invalid input syntax for type
uuid` → sanitized 500. Validate at the contract (`uuidParams` in
  `routes/index.ts`) so it is a clean 400 validation_error. This generalizes
  the literal-segment trap: `DELETE /invitations/lookup` now fails the uuid
  param check (400) rather than walking into a 500.
- **A JSON 404 terminator (`api.all('*', …)`) must be mounted LAST on the
  `/api/v1` sub-app**, or unmatched API paths fall through to the SPA
  catch-all and a browser session gets the dashboard HTML at 200. Machine
  principals never reach it — the fail-closed scope gate 403s first.
- **Audit cursors need `Number.isSafeInteger`, not just `Number.isFinite`.**
  `Number('99999999999999999999')` is finite but past bigint precision;
  feeding it to `lt(id, …)` overflows Postgres → 500. Treat out-of-range
  like NaN (ignore, serve page 1).
- **The sdk/contract/cli `exports` must point at built `dist` JS, not
  `./src/index.ts`.** The CLI ships as built JS; when `@app/sdk` (and
  `@app/contract`) resolved to raw TS, `node dist/bin.js` loaded
  TypeScript with parameter-property constructors and threw
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Any package a built binary loads at
  runtime needs a `dist`-pointing `exports` (+ a real build step) so it runs
  without tsx.
- **Last-owner delete is race-free via a DB trigger + app-level advisory
  lock** — see ADR 006. The trigger takes a per-workspace
  `pg_advisory_xact_lock` before its survivor check (READ COMMITTED alone
  lets two concurrent deletes each see the other's row); the app surfaces
  hold a per-workspace SESSION advisory lock on a dedicated client (the
  migration-lock pattern) across their guard + cascade so the race loser
  gets 400, not the trigger's 500. Session lock namespace (7432003) is
  distinct from the migration lock (7432001) and the trigger's xact lock
  (7432002): the session lock wraps the cascade while the trigger lock is
  taken inside it, so a shared key would self-deadlock.

## I1 (Docker prune hardening, 2026-07-07)

- **A blind `rm -rf` on `.pnpm` store dirs is a time bomb, not a prune.** It
  leaves dangling symlinks that only "work" because nothing follows them at
  runtime; a pnpm layout change or a dependency bump that makes a pruned
  package statically reachable (the kysely class of trap, M8) would pass
  every local gate and crash at container boot. The fix keeps the explicit
  deny-list (drizzle-kit / esbuild / @esbuild/\* / @esbuild-kit/\* /
  typescript) but moves prune AND proof into ONE build-stage script,
  `scripts/prune-runtime-deps.mjs`, so removal and verification share the
  list and cannot drift. It fails the image build on: a dangling symlink not
  attributable to the deny-list, a deny-listed package surviving anywhere
  (store rename, vendored nested copy), a declared server dependency that no
  longer resolves (covers the four lazily imported drivers a graph load
  never touches: ioredis, nodemailer, resend, the OTLP exporter), and
  `node dist/index.js --boot-check` failing.
- **`--boot-check` is a 3-line early exit in `src/index.ts`, and it is a
  full-graph proof for free**: `dist/index.js` is one tsup bundle whose bare
  imports stay external, and `import { boot }` is static — so by the time
  the flag check runs, Node has already resolved and initialized the entire
  static runtime graph (better-auth → kysely, pg, pino, pg-boss, drizzle-orm,
  aws-sdk, MCP SDK, …) with no env, DB, or listener needed. Pruning anything
  statically reachable = ERR_MODULE_NOT_FOUND = the docker build fails
  (validated: adding kysely to the deny-list kills the build at this step,
  and it is the ONLY step that catches it — kysely is transitive, so the
  declared-deps check alone would miss it). Every image build runs it, so
  the guard is a CI gate, not a local ritual: at Slideless the image is built by
  release.yml on every push; in the template release.yml is disabled (every job
  `if: ${{ false }}`), and the image is built by the `hostinger`,
  `scale-drill`, `federation-drill` and `instantiate-proof` jobs of ci.yml.

- **`@types/yazl` types `zip.outputStream` as the legacy
  `NodeJS.ReadableStream`** — but at runtime it is a real `Readable` (a
  PassThrough). `destroy()` and `Readable.toWeb()` need the concrete type, so
  cast once at the top (`zip.outputStream as Readable`) and thread that; don't
  scatter the cast (`api/export.ts`).
- **A zod-openapi `responses` entry with NO `content` key is what lets an
  `api.openapi` handler return a plain streamed `Response`.** The 200 for
  `GET /workspace/export` is `{ description: '...' }` only; add a `content`
  schema and @hono/zod-openapi's conditional types then demand a matching
  validated body and `c.body(stream)` stops typechecking.
- **yazl sequential-blob discipline is two separate facts.** (1) `await
finished(sourceStream)` after each `addReadStream` gives natural
  one-at-a-time backpressure, so descriptors / S3 sockets never pile up on a
  multi-blob export. (2) yazl's `errored` latch only trips on errors emitted
  by the ZipFile itself — destroying `outputStream` does NOT stop the pump, so
  entries queued after an abort are still opened and fully drained. A long
  pump needs an explicit `signal.aborted` check inside the loop or a cancelled
  multi-GB export keeps consuming bandwidth (`api/export.ts` blob loop).
- **Better Auth `/delete-user`'s `beforeDelete` / `afterDelete` are ROUTE-level
  hooks** — they fire only for the self-service HTTP endpoint. The admin
  surface deletes via `internalAdapter.deleteUser` (the same path, adapter
  hooks kept, cascade + SET NULL applied) which fires NEITHER, so
  `DELETE /members/{id}` must write its own `member.delete` audit row; the
  self-service path gets its `user.account_delete` system-actor row from
  `afterDelete`.
- **Re-verify FK on-delete semantics from `schema.ts`, never from a planning
  doc.** The GDPR plan claimed `invitations.invited_by` was `set null`; the
  schema has it `notNull()` + `onDelete: 'cascade'` (so a deleted user's
  invitations vanish with them, tokens stop resolving). The set-null
  anonymization applies to `audit_log.actor_user_id`,
  `workspace_members.invited_by`, and `files.created_by`; `api_keys.created_by`
  cascades. Grep every `created_by`/`invited_by` reader before assuming.
- **The dashboard vitest run needs SvelteKit's path aliases declared by hand.**
  Plain vitest doesn't know `$lib`; `apps/dashboard/vitest.config.ts` adds
  `resolve.alias.$lib` (alongside the svelte plugin + `browser` condition that
  compile the `.svelte.ts` runes modules) or the i18n catalog tests fail to
  resolve their imports.

## I5 (2FA + invite verification, 2026-07-07)

- **Better Auth 1.6.15's twoFactor sign-in hook covers ONLY
  `/sign-in/email|username|phone-number` — `/sign-in/email-otp` walks
  straight past the second factor.** An enrolled user could be signed in by
  anyone controlling the mailbox. The closure lives in the config-level
  `hooks.after` (`identity/better-auth.ts`): user hooks run BEFORE plugin
  hooks in `api/dispatch.mjs`, and a returned `ctx.json(...)` replaces the
  response (`context.context.returned`), so mirroring the plugin's dance
  (delete the minted session via `internalAdapter`, `deleteSessionCookie`,
  `setNewSession(null)`, park a `2fa-<rand>` verification value behind the
  signed `two_factor` cookie) hands the email-OTP path the exact same
  `{ twoFactorRedirect: true }` step that `/two-factor/verify-totp`
  completes. `deleteSessionCookie` imports from 'better-auth/cookies',
  `generateRandomString` from 'better-auth/crypto'. Re-verify the mirror
  against the plugin's index.mjs on ANY Better Auth bump. Google social
  sign-in has no equivalent seam (redirect flow) — documented as IdP-trust
  in ADR 009, not silently ignored.
- **Invite-token possession never proves the invitee's email** — the create
  response always returns the copyable `acceptUrl`, so even an "emailed"
  invitation's token is admin-visible. Making acceptance set `emailVerified`
  honestly required a SECOND token that only the email carries
  (`invitations.email_token_hash`, the migration that added it); which hash matched tells
  the accept route whether mailbox control was demonstrated.
- **2FA verify/activate rotates the session** — after `/two-factor/verify-totp`
  (activation) and `/two-factor/disable`, the old cookie's session row is
  deleted; tests and UI must adopt the fresh set-cookie or every subsequent
  session call 401s.
- **The 2FA enable/disable password gate holds ONLY because `allowPasswordless`
  is unset.** Better Auth's `shouldRequirePassword` short-circuits to `true`
  when `allowPasswordless` is falsy — that is the entire reason a hijacked
  session can't toggle 2FA without re-auth. A product that sets
  `twoFactor({ allowPasswordless: true })` silently drops the re-auth
  requirement for any user without a credential account. Do NOT set it without
  re-auditing the disable gate.

## I2 (multi-replica scale drill, 2026-07-07)

- **pg-boss serializes its schema install internally but NOT `createQueue`
  — wrap the whole install section in the app's own advisory lock.**
  (Verified in pg-boss 10.4.2 source: the `locked()` xact-advisory wrapper
  covers only migrations; `createQueue` executes `pgboss.create_queue(text,
json)` — queue-row insert + per-queue partition CREATE TABLE/attach — bare.)
  Concurrent fresh-DB boots of 2+ all|worker replicas reliably deadlocked
  there (Postgres `DeadLockReport`) and crash-looped until a docker restart
  found the rows in place (`ON CONFLICT DO NOTHING`). Fix (`jobs/pgboss.ts`):
  `start()` + `createQueue` + nightly schedules run under a session-scoped
  `pg_advisory_lock` on a dedicated client (the migrate.ts pattern), key
  **7432004** (distinct from 7432001 migration / 7432002 trigger xact /
  7432003 last-owner session). Boot-setup only: `work()` registration and
  steady-state `send()` stay outside the lock, and `SERVICE_ROLE=api`
  (migrate:false, no queue creation, no DDL rights) never acquires it — its
  documented fresh-DB crash-loop on 'pg-boss is not installed' is unchanged.
  The drill now hard-fails any restart during the 3-replica fresh boot and
  greps the Postgres log for `deadlock detected` (must be 0).
- **A cross-replica read of a local-storage blob died mid-stream after a
  200, not with a 404** — the replica trusted the shared metadata row, sent
  full headers, then the body stream hit the missing file (curl exit 18,
  truncated transfer): silent corruption, not an error. Two-layer fix: the
  content route checks `storage.exists(key)` before committing any status
  line (GET, HEAD, and Range all 404 `not_found` when the row exists but the
  bytes are unreachable on this replica), and `LocalStorageDriver.getStream`
  opens eagerly (`fsPromises.open` + `handle.createReadStream`) so a missing
  blob rejects at the await — matching the s3 driver's eager GetObject —
  instead of erroring after headers. The 404 is a safety net: Profile B
  requires `STORAGE_DRIVER=s3`; local storage is single-replica only.
- **A compose `tmpfs` mount is root-owned; the image runs as `node`.** Mount
  `/data` as an anonymous volume instead (ownership copied from the image
  dir, removed by `down -v`) — tmpfs at `/data` makes every replica crash
  with `EACCES: mkdir /data/storage` under `read_only: true`.
- **`pgboss.version.cron_on` is a clean scheduler observable.** Any instance
  running the timekeeper (`schedule: true`) bumps it every ≤30 s
  (cronMonitorIntervalSeconds); with only `SERVICE_ROLE=api` replicas alive
  it freezes — the drill's proof that the api role runs no scheduler without
  waiting for a 03:00 cron.

## I6 (break-glass + orphan GC, 2026-07-07)

- **A membershipless account in `SUPERADMIN_EMAILS` is itself an orphan-GC
  candidate.** Break-glass recovery deliberately works from a `principal:null`
  (no-membership) session so it can rescue a workspace that lost its owners —
  but the orphaned-user purge deletes exactly those no-membership users past
  `ORPHAN_USER_RETENTION_HOURS` (72h). So the two features interact: arm the
  allowlist and run `claim-ownership` promptly; once the operator account has a
  membership it is out of GC scope. Documented in the security.md runbook.
- **Break-glass endpoints skip `requireAuth`/`requireRole` but must still
  validate a real session.** They resolve the caller via `auth.api.getSession`
  (validates the cookie against the session store) and RE-READ email +
  `emailVerified` from the DB by user id — never from a claim/header/body — so
  a membershipless session can reach them while a forged/absent session and any
  machine principal cannot. The routes stay UNLISTED in `scopes.ts`, so the
  fail-closed scope gate 403s every API key / OAuth token (even one minted by
  the superadmin) before the handler runs. All rejection reasons return one
  uniform 403 so the endpoint is not an allowlist oracle.
- **Orphan-GC safety is layered, not a single query.** `NOT EXISTS` on ANY
  `workspace_members` row (no `is_active` filter, so a deactivated member is
  never an orphan) + a grace window + a live-pending-invitation exclusion (the
  invite row exists before its accept URL, closing the scan-then-accept race) +
  a per-row membership re-check immediately before each delete + the last-owner
  trigger backstopping the sole-owner cascade. Bounded batches with a
  no-progress break; `0` disables it.

## Forms audit remediation, as Slideless learned it (2026-07-26 — ADR 022, PRDCT-1331..1334 in Slideless)

The audit was of Slideless's deck forms runtime, which the template does not carry. The halves below
hold for any tool.

- **A trust-boundary comment written as a DESCRIPTION gets a feature waved
  through; write it as a CONSTRAINT with a test behind it.** At Slideless the
  forms runtime's comment said the runtime added no capability the deck did
  not have; a reviewer who checked two fields stopped reading, and a third
  field shipped a signed assertion of the signed-in viewer's identity into
  the same config (PRDCT-1331). State the invariant as a rule for future
  edits, and pin the KEY SET of anything handed across the boundary with an
  assertion, so adding a field turns a test red instead of depending on
  prose being read carefully.
- **A default-ON capability turns an opt-in code path into the default code
  path.** At Slideless a buffering injector that was affordable behind an
  opt-in flag became a ~10x-document memory spike on every share link the
  day a second flag defaulted ON (PRDCT-1333). When flipping a flag's
  default, re-audit every path it gates as if it were new.
- **Assert the SHAPE of a memory curve, not a byte count.** A bounded-window
  streamer and a buffering one produce identical output, so length and
  content prove nothing. Measuring bytes-in-minus-bytes-out at two input
  sizes does: the windowed one holds the same amount for both, the
  buffering one holds the input. And sample the high-water mark BEFORE
  counting each emitted chunk — sampling after reads zero for an
  implementation that flushes once at the end, which is precisely the
  implementation the test exists to catch.
- **Put the discriminator in the route, not only in the client.** At
  Slideless one page-level secret shared by every form on the page, while
  ownership was per form, let an edit of one form overwrite the answer to
  another (PRDCT-1334); the own-row routes carried no form segment, so the
  server structurally could not detect the mismatch. When ownership is per
  element, the route names the element, and the server refuses a mismatch
  whatever the client does.
- **A blanket `try/catch` around a runtime makes failure silent by
  construction.** At Slideless the forms suite was 7/7 green while five of
  five real presentations broke. Removed.
- **A new Playwright project spends a SHARED, rate-limited login budget.**
  `limiters.login` is 10 per 15 minutes keyed per IP _and_ per address, and
  every project in the suite signs in as the same owner from the same IP. At
  Slideless a `beforeEach(signIn)` in a five-test file took the whole suite
  from 7 logins to 12, and tests 10, 11 and 12 — including a spec that work
  did not touch — failed at the LOGIN PAGE. It read exactly like a flake and
  was not one. Sign in once per file (`beforeAll` on its own context) and
  treat the login budget as a suite-wide resource when adding a project.

## Phase 5 security review, as Slideless learned it (deck read privacy, 2026-07-10)

- **Inheriting a workspace-wide read posture makes every outsider with a
  membership a whole-workspace reader.** At Slideless the deck read handlers
  authorized on `workspace_id` alone, and the collaborator claim then minted
  workspace memberships for external per-deck collaborators: one deck's
  collaborator downloaded another deck's content. The template has the same
  kind of outsider, the guest (`workspace_members.origin='guest'`), which is
  why the guest is refused by capability rather than trusted by membership
  (CLAUDE.md, "Guest origin is a capability boundary"). Whenever onboarding
  mints memberships for outsiders, every resource read path re-derives its
  own authorization instead of riding the workspace boundary, and a failed
  read check answers 404, never 403.
- **Every public account-minting endpoint needs a duplicate-account catch
  around `signUpEmail`.** Two concurrent claims of one invite both pass the
  account lookup (password hashing is tens of ms, the lookup is ~1 ms), so
  the loser's INSERT hits the unique-email violation — an uncaught 500
  until mapped to the same 409 `account_exists` the sequential path
  answers. The integration test hits this interleaving deterministically
  for the same timing reason. The workspace invitation's accept had the
  identical window; it is fixed in the chassis
  (`packages/chassis-server/src/api/invitations.ts`, the
  `isDuplicateAccountError` catch around `signUpEmail`).

## Phase 6 (CLI + CLI auth, 2026-07-10)

- **`emailOTP` with `disableSignUp` is exactly the browserless-login
  primitive** (verified against 1.6.15 routes.mjs): send-verification-otp
  for an unknown email deletes the pending code and answers a generic
  success (no mail, no enumeration, no user); sign-in-email-otp verifies
  atomically with a 3-attempt limit and maps unknown-account to the same
  INVALID_OTP as a wrong code. The CLI auth endpoints are thin wrappers over
  these two calls — never reimplement OTP storage/verification.
- **Server-side `auth.api.signInEmailOTP` runs the config hooks too**: the
  2FA after-hook intercepts an enrolled user's OTP sign-in exactly as over
  HTTP and returns `{ twoFactorRedirect: true }` with no session — so the
  CLI-auth complete endpoint refuses 2FA users (403 two_factor_required)
  without any extra check beyond "no token in the response". Never "fix"
  that into a bypass.
- **`/setup`'s `signUpEmail` auto-creates an owner session** (better-auth
  autoSignIn default) that nothing ever holds. Tests asserting session
  cleanup must diff against a baseline instead of expecting zero rows.
- **The CLI resolves its target as flag → env → profile → ERROR, no default
  URL.** With a config file in play, a hard-coded localhost default silently
  points real commands at the wrong instance; failing loudly is the feature.
  Any file the CLI writes to link a local folder to a remote resource records
  the instance's base URL for the same reason (at Slideless, the push link
  file), so a folder linked to instance A errors on instance B instead of
  targeting a foreign id.

## Phase 7 (MCP tool set, 2026-07-10)

- **In-process multipart works: `app.request(path, { body: FormData })`
  round-trips through Hono's parseBody** (File/FormData are Node ≥20
  globals), so an MCP tool can reuse the exact API route the CLI hits (the
  template's tools go through `ctx.fetchApi`, `callApi` in
  `packages/chassis-server/src/mcp/tool-kit.ts`) — same hashing, same
  entitlement gate, same audit rows. At Slideless the MCP upload tools do
  this. An in-process Request with a body and no header carries no
  Content-Length, so a caller that uploads that way must declare the size:
  a byte-metered route answers 411 `length_required` to a metered account
  (the rule of "Billing phases 2 and 3" below).
- **Tool-level size caps must undercut the transport cap to be reachable.**
  The /mcp bodyLimit (1 MiB, `packages/chassis-server/src/mcp/http.ts`)
  rejects oversized envelopes with a plain 413 before any tool runs; a
  tool-side "too big" check equal to that cap is dead code. At Slideless the
  inline uploads cap at 768 KiB decoded — the base64-inflation bound of a
  1 MiB envelope — so the friendly use-the-CLI error is what models see.
- **Raw JSON-RPC POSTs against the stateless /mcp are a valid test harness**:
  every request builds a fresh McpServer, nothing enforces an initialize
  handshake, and `enableJsonResponse` returns plain JSON — so tools can be
  integration-tested via `app.request` without a listening server (the
  oauth-mcp suite still proves the real SDK-client + listener path).

## Cloud-binding Phase 3 (hub SSO entrance, 2026-07-12)

- **Never enable `transaction: true` on the drizzle adapter.** The
  better-auth transaction runner executes queued `create.after` database
  hooks EVEN when the transaction rolled back (pinned 1.6.15,
  `@better-auth/core` `transaction.mjs`) — `user.created` would fire for a
  user row that no longer exists, and any subscriber of that event would act
  for a ghost (at Slideless, the collaborator grant sweep would flip grants).
  Today's passthrough default (no `transaction` key,
  adapter default false) is load-bearing: hooks always see committed rows on
  the outer pool (spike S1(d)).
- **Org claims exist ONLY in the callback exchange's access token.** The hub
  mints the workspace-claim JWT iff the TOKEN request carries RFC 8707
  `resource` (genericOAuth `tokenUrlParams`); the plugin's refresh shim
  drops it, so stored/refreshed hub tokens are opaque and claimless. Never
  read org context from `account.accessToken` after login.
- **jose `createRemoteJWKSet` throttles kid-miss refetches** (30 s
  cooldown): a rotation-fresh token can fail `JWKSNoMatchingKey` with no
  network attempt. `hub-jwt.ts` retries once against a rebuilt key set on
  both `JWKSNoMatchingKey` and `JWSSignatureVerificationFailed`; keep both
  arms on any Better Auth / jose bump.
- **better-auth's OAuth state is a double-submit pair**: the DB-stored state
  PLUS a signed `state` cookie set at `/sign-in/oauth2`; a callback without
  the cookie fails `state_mismatch`. Integration tests must carry the
  sign-in response's cookie into the callback request (browsers do it for
  free).
- **`hooks.after` CAN fail a completed OAuth login cleanly**: delete the
  session row, `deleteSessionCookie(ctx, true)`, `setNewSession(null)`, then
  `throw ctx.redirect(...)` — the dispatch pipeline catches the APIError and
  replaces the success redirect (same undo dance as the email-OTP 2FA
  interstitial). Used by the SSO after-hook's fail-closed path (ADR 015).

## Cloud-binding Phase 5 (CLI cross-tool connect, 2026-07-12)

- **jose's `jwtVerify` validates `exp` only when the claim EXISTS** — a
  token minted without one sails through signature+iss+aud verification.
  Any flow whose security story says "bounded by the TTL" must REQUIRE the
  claim itself (`verifyConnectToken` refuses a missing `exp`); the same
  goes for `jti` before using it as a replay handle.
- **One-time-use must be claim-FIRST**: `/sso/cli-connect` INSERTs the jti
  into `sso_connect_jtis` (PK conflict = replay, multi-replica safe) BEFORE
  provisioning/minting. Insert-after-work would let two concurrent
  presentations of one token both reach the mint. Corollary: a transient
  provisioning failure burns the token — deliberate; the caller re-exchanges
  with the hub for a fresh one (120 s tokens are free), and the safe side of
  the race is the only acceptable side on a public endpoint.
- **`internalAdapter.createOAuthUser` is the reusable SSO-JIT primitive**
  for server-side entrances (no HTTP dance): it is the exact call the
  genericOAuth callback makes, wraps user+account in the transaction
  passthrough, lowercases the email, and fires `databaseHooks.user.create`
  — so the `user.created` seam (`packages/chassis-server/src/boot.ts`; at
  Slideless the collaborator sweep subscribes to it) covers a
  non-better-auth entrance for free. Mirror better-auth's own linking rules
  around it (account-by-(provider,sub) first, then trusted-link by email
  ONLY onto a VERIFIED local address) or the entrance diverges from the
  browser SSO path's takeover posture.

## The Playwright suite and the release gate (PRDCT-2268 / PRDCT-2274, 2026-09-12)

- **The Playwright suite (`apps/dashboard/e2e`) runs nowhere in CI, so it rots silently.** It
  had been dead since PRDCT-1347 made the first-boot claim require a setup token: the harness
  passed `SETUP_TOKEN=''`, every dependent project failed at the wizard, and nobody saw it for
  two weeks. Now `playwright.config.ts` mints one token in the runner process, `stack-env.mjs`
  boots the stack with it and `smoke.spec.ts` fills the field, which the setup wizard
  (`apps/dashboard/src/routes/setup/+page.svelte`) shows from the start (PRDCT-2389). Run the
  suite locally before shipping anything the smoke exercises; no CI job runs it.
- **Better Auth's own sign-in throttle, not ours, is what "Too many attempts" means in e2e.**
  Our `limiters.login` is 10 points per 15 minutes and consumes on FAILURE for sign-in; the
  e2e projects never fail a login. What trips is Better Auth's default special rule on
  `/sign-in*` and `/sign-up*` (3 requests per 10-second sliding window per IP), active because
  the image runs `NODE_ENV=production`, and the dashboard renders any 429 with the same
  `login.errorRateLimited` string. Projects that sign in right after the smoke hit it;
  `signInAsOwner()` in `e2e/accounts.ts` waits 12 s once and retries. A future Better Auth
  bump that widens that window makes the wait too short: re-check on any bump.
- **At Slideless the prod release publishes nothing when Trivy finds a HIGH anywhere in the
  image**, even in a dependency the change never touched (nodemailer 9.0.3,
  GHSA-2x7j-588g-ccc2, blocked the PRDCT-2268 roll). In the template release.yml is disabled
  (every job `if: ${{ false }}`) and nothing publishes; a tool that re-enables it inherits the
  gate. Bump such a dependency alone: `pnpm add` re-resolves the Better Auth
  transitive pins ADR 001 keeps exact (better-call, @better-fetch/fetch), so restore the
  lockfile and edit the package's three entries by hand (importer, packages, snapshots), then
  `pnpm install --frozen-lockfile` to validate. The roll itself, once the image is published,
  is the fleet repo's runbook: `labs/products/antasphere/infra/README.md`, "The roll as it
  actually runs".

## Blob authorization (SL-B1, 2026-07-26)

- **An ACL on the resource is not an ACL on its bytes.** At Slideless ADR 013
  made deck reads private, then left `/files` authorizing on `workspace_id`
  alone — so the same content ADR 013 protected was streamable by any member
  and any `presentations:read` key one route down. When a policy is added to
  a domain surface, sweep every OTHER surface that can reach the same rows:
  the generic file cabinet, its DELETE, and any path of the tool that binds
  a blob to a resource. The template's answer is `blobReadScope`
  (`apps/server/src/files/blob-read-scope.ts`).
- **`files.created_by` cannot answer "does this principal hold these
  bytes".** Blobs are content-addressed and unique per (workspace, sha256),
  so the SECOND uploader of identical bytes deduplicates onto the FIRST
  uploader's row and the column keeps naming the first one. Authorizing on
  it would lock a member out of a shared logo they just uploaded. Possession
  is its own fact — `file_uploaders` (the migration that added it), written
  on BOTH the fresh-insert and the dedupe branch, by every upload route.
- **Scope an existence check with the read.** At Slideless a precheck that
  answered "already present" for a blob the caller may not read was both a
  whole-workspace existence probe and a protocol dead end: the client
  skipped the upload on that answer, then the guard on the binding refused
  the sha and there was no way forward. A tool that asks "do you hold these
  bytes" before a binding answers it and guards the binding with one
  predicate.
- **Refuse an unauthorized sha as MISSING, not as its own error code.** A
  distinct "you may not use this blob" status would confirm that the
  workspace holds those exact bytes — the same reason a blob the caller may
  not read answers 404 and never 403.

## Signing-key durability (PRDCT-1379 port, 2026-08-12)

- **A fresh instance's FIRST token issuance can mint TWO jwks rows.** On the
  pinned 1.6.15 the id_token and access-token signs run concurrently and both
  can hit `createJwk` when no key exists yet (sign.mjs has no lock around the
  get-or-create). Harmless in production (newest key signs, every key is
  published and verifies) but tests must never assert `jwks` row counts, and
  row count is not a health signal (ADR 023).
- **jose's local JWK set throws `JWKSNoMatchingKey` for an unknown kid, not
  `JWSSignatureVerificationFailed`.** A refetch-on-failure JWKS cache keyed
  to the latter alone never picks up a NEWLY minted signing key until its
  TTL — a live rotation would answer 401 for 10 minutes. The verifier
  (`identity/oauth-jwt.ts`) retries on both names; pinned by the mid-cache
  rotation test.

## Deployment posture (PRDCT-1347 / 1357 / 1356 / 1440, 2026-08-29)

- **"Optional when set" is a hole for the one request that decides ownership.**
  `SETUP_TOKEN` was checked only when configured, so a bare `docker run` produced
  a free-to-claim instance. The claim now always needs a token: env, or one
  generated into `$DATA_DIR/setup-token` at boot and printed to the log
  (`resolveSetupToken`, the same zero-config shape as the auth secret). The
  token check sits AFTER the 410 already-set-up answer so a replay never
  turns into a free claim when the token is null; the generated file is
  removed on success (it would otherwise ride in every backup). 76 test
  bodies had to grow a `setupToken` — the test helper now boots every app with
  `SETUP_TOKEN` so new suites pass it from `helpers.ts`.
- **The one unencrypted artifact defines the backup's secrecy.** With a
  passphrase the config archive was encrypted while `/data/secret` rode in
  the cleartext data tarball. `backup.sh` now `--exclude=./secret`s the
  tarball and carries the root as `data-secret` in the encrypted archive;
  `restore.sh` learned the third home (`config_secret`, written into the
  volume after the swap through a read-only mount of the decrypted WORKDIR,
  never through the backup dir). Bash 3.2 (macOS, where the unit suite runs
  the scripts) treats an empty array under `set -u` as unbound — use
  `${arr[@]+"${arr[@]}"}`.
- **An erasure replay that fails is fail-open unless the boot says otherwise
  (PRDCT-1809).** The replay deletes through Better Auth's cascade, which drops
  the account rows BEFORE the user row; when the subject is the sole active
  owner in the restored dump the last-owner trigger refuses the membership delete
  mid-cascade, and a swallowed error left a half-erased owner (no credential,
  PII back, membership intact), readiness green, no audit row. The replay now
  runs under every last-owner guard (`withAllLastOwnerGuards`, nothing touched
  on a refusal) and a refused tombstone CLOSES the service (`state.closed` →
  503 everywhere but the probes) with a `user.erasure_replay_refused` audit row
  until an operator promotes another owner and restarts. Readiness alone is not
  a closure: only `/readyz` reads `state.ready`, and the compose healthcheck
  watches `/healthz`.
- **An erasure that lives only in the database is undone by a restore.**
  The tombstone (`$DATA_DIR/erasures.jsonl`, append-only, hashed email)
  lives outside the dump; `restore.sh` carries the LIVE file forward into the
  restored tree; boot replays it through Better Auth's cascade with a
  `user.erasure_replayed` system audit row. The append lives in
  `AccountDeletionService.afterUserDelete` because every GDPR surface (self
  delete, admin delete) funnels through the adapter hooks; the orphan purge
  deliberately does not (it is GC, not erasure).
- **Count-based migration status calls a downgrade "current".** drizzle
  records the sha256 of each applied file; comparing hash SETS (not counts)
  makes a database migrated by a newer image show `unknownApplied > 0`. The
  check runs before `runMigrations` on every boot (drizzle's own migrator only
  compares timestamps and would happily proceed) and refuses readiness.
- **The flip acknowledgement is not a migration.** `EDITION_CHANGE_ALLOWED`
  re-stamped and proceeded; the oss→cloud flip now pre-flights (no
  unprojected workspace, no unverified user) and cloud→oss is refused. Tests
  that flip must project the setup workspace first.
- **On cloud, "no link" is definitive only for a user the hub never
  projected.** A principal holding `origin='hub'` rows whose account row is
  gone has a SEVERED link; treating it as the fail-open `no_link` (cached
  like a success) was the way to switch enforcement off. It now fails closed
  as a dead grant, and `/unlink-account` for `antasphere` is refused in the
  same before-hook as reset/OTP. `/sign-in/email` on cloud is the operator's
  (`instance_settings.operator_user_id`, the durable record that also keeps
  them out of the orphan purge) and the allowlist's door only.
- **`case "${VAR:-default}"` with a `*)` fallthrough that re-reads `$VAR`
  loses the default.** `restore.sh`/`update.sh` probed `http://:3000` on
  every `.env` without `APP_BIND` (the `127.0.0.1` default matched `*`,
  which assigned the EMPTY variable). Default into the variable first, then
  `case "$VAR"`. Also: `docker compose run` allocates a pseudo-TTY when
  stdin is one — pass `-T` whenever stdout carries bytes you will store.
- **The break-glass upsert must stamp `origin='local'` on the conflict
  path too** — an `onConflictDoUpdate` `set` that omits a column keeps the
  row's old value, so a hub-projected row promoted by break-glass stayed
  `origin='hub'` and the reconciler swept the recovery ~12 s later.

## Config / HTTP hardening pass (PRDCT-1374 + PRDCT-1375, 2026-07-26)

- **Log the matched route pattern, never the raw path (PRIV-1).** A path segment
  can carry a credential (a share secret, a one-time token, an invitation
  code); `path: c.req.path` on the completion log line writes it into the log
  stream, and a span attribute exports it off-instance. Redaction cannot help:
  pino keys off object PROPERTIES and `path` is one opaque string. The log
  line, the span and the metrics label carry `routeLabel(c)`
  (`packages/chassis-server/src/route-label.ts`), the matched pattern, read
  AFTER `next()`. At Slideless it was live, not latent: the public viewer
  route is `/v/:secret`.
- **A contract-wide sweep does not reach an inline schema.** At Slideless one
  anonymous free-text write validated against a schema defined inline in a
  server file, not in the contract package, and missed the `noControlChars`
  sweep. When sweeping a class of sink, grep for the pattern in
  `apps/server/src` too, not just `packages/contract`.
- **"4xx" is not an assertion.** At Slideless two of this pass's own tests
  passed while the fix they named was broken. A fixture silently produced
  `undefined`, so every assertion of one suite was hitting a 404 — which
  satisfies both `not.toBe(403)` and `status < 500`. And another case parsed
  a half-built payload, so `success === false` held for reasons that had
  nothing to do with the field under test. Fixes: assert the SPECIFIC status and error
  code, assert the negative control (the same request without the NUL
  succeeds), attribute the zod failure to a path, and assert every fixture step
  in `beforeAll` so a broken fixture fails loudly instead of making the suite
  vacuous.
- **`HUB_CLIENT_SECRET` belongs on the redaction list.** It is this tool's own
  identity at the Antasphere hub — leaking it lets anyone impersonate the tool
  at the authorization server. `*.secret` never matched it, and neither it nor
  `GOOGLE_CLIENT_SECRET` was listed.
- **A blank env value is not zero (PLT-13).** `Number('')` is 0, and 0 means
  keep-forever for a retention knob. `docker-compose.yml` feeds
  `ORPHAN_USER_RETENTION_HOURS=${ORPHAN_USER_RETENTION_HOURS:-}` (and
  `MAX_WORKSPACES_PER_USER`, `API_RATE_LIMIT_PER_MINUTE`,
  `API_RATE_LIMIT_BURST` the same way), so every numeric knob rides
  `numeric()` (`packages/chassis-server/src/env.ts`), which reads a blank as
  the documented default; `AUDIT_RETENTION_DAYS`, which compose does not
  feed, rides it too, because the day someone adds `VAR=${VAR:-}` to compose
  it would go live silently. `apps/server/test/unit/env.test.ts` pins it.

## Release gate (PRDCT-1345 / 1344 / 1346, 2026-08-29)

- **Trivy's image export is what wedged Docker Desktop, twice.** `trivy image
<tag>` pulls the image through the daemon API while downloading its vuln DB;
  on this Mac that hung the daemon (every `docker` call timing out, an
  error-dialog process up) and took the integration suite's testcontainers down
  with it. Scan a `docker save` tarball instead (`trivy image --input x.tar`):
  same findings, no daemon in the loop. release.yml runs Trivy from its own
  container on a fresh runner (at Slideless; in the template the workflow is
  disabled, every job `if: ${{ false }}`), so CI is not affected.
- **better-auth's optional peers ship in the image unless denied.** The plugin
  declares svelte, vite, vitest, better-sqlite3, @sveltejs/kit and
  @prisma/client as `optionalDependencies`, so `pnpm deploy --prod` resolves
  them all — 48 MB of node_modules and the scanner surface behind the Trivy
  HIGHs. They are on the deny-list now, and the prune script grew an ORPHAN
  pass: removing a package strands its own subtree in `.pnpm` as real
  directories (rollup, postcss, tinypool, …) that the dangling-symlink sweep
  never sees. The pass keeps only store entries reachable through
  `node_modules` symlink chains from the deployed package. `.pnpm/node_modules`
  hoist links are deliberately NOT an edge (they would mark everything
  reachable) — and that hoist dir IS a Node resolution path for undeclared
  requires, so the honest statement is: the declared graph (step 4) and the
  static graph (step 5) are proven; a phantom DYNAMIC require satisfiable only
  through the hoist would break at container runtime, the same class of gap
  the deny-list always had (checked on the 2026-08-29 lock: every specifier
  that stops resolving belongs to a pruned package or a test dir). A dangling
  hoist left by the pass is attributed and unlinked, anything else still fails
  the build. The sweep's "resolves" verdict is build-stage-relative: a link
  that lands outside the deploy dir works in the build stage and dangles in
  the runtime image — `pnpm deploy --legacy` leaves exactly one (the deployed
  package's own hoist entry), now unlinked; any other escape fails the build. Unit
  test: `apps/server/test/unit/prune-runtime-deps.test.ts` on a synthetic pnpm tree.
- **Compare store paths against `realpathSync(store)`.** `realpathSync` on a
  symlink answers the canonical path; on macOS the temp dir is `/var →
/private/var`, so a prefix test against the store path as spelled marks
  nothing reachable and the orphan pass deletes the whole store. A DANGLING
  link's lexical target, on the other hand, carries the spelled prefix — test
  both.
- **The 1.6.22 bump had two teeth beyond the schema drift** (both already met
  by the hub on its own bump, both re-hit here because the mirror was ported
  before the fix): `two_factor` gains `failed_verification_count` +
  `locked_until` (the migration that added them), and the email-OTP → 2FA mirror must park a
  `2fa-attempts-<identifier>` verification row beside the `2fa-` one, because
  `verifyTwoFactor.beginAttempt` consumes it and 401s without it. The
  two-factor + cli-auth integration suites are the guard (6 red without it).
  Route surface re-enumerated 1.6.15 → 1.6.22: 156 → 157, one added
  (`GET /oauth-popup/start`, plugin not registered), nothing removed; ADR 001
  carries the method.
- **`@app/db` resolves to `dist`, so a schema edit is invisible to the
  server's tests until `pnpm --filter @app/db build`.** The symptom is
  Better Auth's "field X does not exist in the Drizzle schema" 500 on routes
  that touch the table — not a drift failure.

## Attachments, as Slideless learned it (PRDCT-2278 in Slideless, 2026-09-13, lane A of the artifact wave)

- **A contract type exported as `z.infer` of a schema with `.default()` fields is the
  SERVER's shape, not the client's, and every client that spells the body breaks at typecheck
  the day the schema gains a defaulted field.** At Slideless the share-link create type was
  `z.infer<...>`: adding a defaulted boolean made the field required for the CLI and the
  dashboard, both of which build a typed body and neither of which had a reason to know the new
  switch. The client-facing type is now `z.input<...>` (every defaulted field optional to a
  caller); the server keeps reading the schema's output through `c.req.valid('json')`. Apply the
  same rule to any create/update type a client constructs.

## The master page, as Slideless learned it (PRDCT-2279 in Slideless, 2026-09-13, lane C of the artifact wave)

- **The API caches the dashboard's SPA shell at boot.** After `pnpm --filter @app/dashboard
build`, a running API keeps serving the OLD `index.html`, which imports chunks the rebuild
  deleted (`Failed to load module script … MIME type of "text/html"`), or, when turbo restored a
  cached shell beside fresh chunks, a shell whose `__sveltekit_<id>` global does not match the
  chunk's (`Cannot read properties of undefined (reading 'data')` at start). Restart the API
  after every dashboard rebuild; the browser suite never sees this because it builds the image.
- **A hands-on session signs in on the API's own port, not through the Vite proxy.** The sign-in
  Origin hook trusts `PUBLIC_BASE_URL` only, so a login posted from `localhost:5230` to an API
  whose base URL is `localhost:3230` answers 403 and the page says {{This account cannot sign
  in here.}} — an origin mismatch, not an account problem. For a look at a built page, open it on
  the API port (it serves the built dashboard); keep Vite for hot reload of unauthenticated
  pages, or point `PUBLIC_BASE_URL` at the Vite port and lose every URL the API builds from it (at
  Slideless, the viewer URLs).
- **A Vite proxy key is a prefix, and `/api` is also the start of `/api-keys`.** Through the dev
  server the API keys page stayed on its boot spinner (`Failed to fetch dynamically imported
module …/_app/immutable/entry/start.*.js`): the proxy handed the PAGE to the API server, which
  answered with its own built shell. The key is `/api/`, slash included (rebrand lane, 2026-09-18).
  The same session: a cookie is scoped to the host, not the port, so a hands-on look at Vite pages
  signs in on the API port and reads them on the Vite port; only the writes are refused there
  (403 `cross_site_forbidden`, {{Cross-site requests are not accepted on this API}}: at Slideless
  the deck preview mints a token with a POST, so it failed through Vite and worked on the API
  port).
- **`pnpm --filter <pkg> dev -- --port N` does not reach Vite.** The `--` is swallowed and Vite
  boots on 5173, outside every lane band. Use `pnpm --filter <pkg> exec vite dev --port N
--strictPort`, and `lsof` the band before trusting the log line.
- **A menu item's accessible name carries its trailing count.** At Slideless `Version history`
  with a `3` badge is `menuitem "Version history 3"`; a Playwright `getByRole('menuitem', { name })` matches
  by substring unless `exact: true`, so keep the count in a separate span and never pass `exact`.
- **A snippet loses the template's null narrowing.** Inside `{#snippet child({ props })}` a
  read of a nullable value's field fails svelte-check with `'<name>' is possibly 'null'` even
  under an `{:else}` that proved it (at Slideless, `deck.title`); read such values through a
  `$derived` (`deck?.title ?? ''` there) declared in the script.

## The artifact surface, second pass (PRDCT-2308 / PRDCT-2299, 2026-09-14, lane F)

- **In the shared `DataTable` (`table-fixed`), a column WITHOUT a `meta.width` gets whatever the
  others leave, which can be nothing.** At Slideless the links table's recipient column had
  `minWidth` only and rendered 4px wide inside the share sheet, its lock icon spilling into the
  next cell — the exact "cut column" Romain reported on the wave. Give EVERY column a width and
  make them add up to the table's `min-w-*` (`tableClass`), so a narrow host scrolls the table
  sideways instead of eating a column, and pin the width of a column that once collapsed in a
  browser spec (Slideless's pins that first column).
- **The dashboard CSP allowed styles and fonts from `'self'` only, so the Fontshare and Google
  Fonts links in `app.html` had never loaded on a built page** — Sentient and Onest fell back to
  the system stack silently (the console said so, nothing else did). `buildCsp` now lists the two
  API hosts under `style-src` and the two file hosts under `font-src`, nothing more. When adding a
  CDN link to the shell, add its hosts to the CSP in the same commit and look at the console of a
  built page, not the Vite dev server (which sets no CSP).
- **A hands-on seed that signs in from Node needs an `Origin` header**: the sign-in Origin hook
  refuses a request with none (403), the same answer a wrong origin gets. Send
  `origin: <PUBLIC_BASE_URL>` on `/sign-in/email` and on every JSON POST from a script.

## A restored `.svelte-kit` cache breaks the typecheck when a route group is added (2026-09-14, lane F)

- **`svelte-kit sync` does not clean the generated types it is regenerating, and CI restores them
  between runs.** At Slideless, adding `(present)/+layout.ts` made SvelteKit generate a NEW
  `.svelte-kit/types/src/routes/(present)/proxy+layout.ts`; on a runner whose cache predated the
  change, the config loader walked the restored tree and `stat`ed an entry sync had since rewritten,
  dying with `ENOENT … proxy+layout.ts` before a single file was checked. Green on every developer
  machine and in a fresh clone (the tree is byte-identical), red only where a stale cache is
  restored — the `checks` job was the ONLY new failure on dev, beside three that had failed for two
  days. `typecheck` now does `rm -rf .svelte-kit/types` first: idempotent, costs a second, and makes
  the gate independent of whatever a runner restored. Reproduce the class by planting a dangling
  entry under `.svelte-kit/types/src/routes/` and running the typecheck.
- **CI failing "already" is not the same as CI failing the same way.** Compare the FAILING JOB NAMES
  against the previous commits on the base, not the red/green of the run: three drills had been red
  since 12 September, which is exactly what hides a fourth job going red for the first time.

## Workspace creation from inside the product (PRDCT-2444 / PRDCT-2443, 2026-09-18)

- **The route's audit row belongs to the NEW workspace, and the generic audit middleware has to be
  told to stay out.** `auditMiddleware` attributes every mutation to `principal.workspaceId`, the
  workspace the caller happens to be in. For `POST /workspaces` that is the wrong trail: a workspace
  never learns what its members do elsewhere. The path is in `isAuditExempt` and the handler writes
  its one `workspace.create` row itself, the setup pattern. Any future route whose effect lands
  OUTSIDE the caller's current workspace needs the same two moves, or the event leaks into a log
  its readers have no standing over.
- **`/me.canCreateWorkspace` and the route share ONE function** (`workspaceCreationRefusal`,
  `api/workspaces.ts`), and the route calls it INSIDE the locked transaction. A flag computed by a
  second copy of the rule promises what the route refuses the first time one of them moves.
- **A POST to the hub is never re-posted on an ambiguous answer.** The read path
  (`HubUserClient.orgs`) retries once after a 401 OR a 403, which is harmless for a GET. For
  `createOrg` only a 401 earns the retry (the hub refused the token before doing anything); a 403
  is a policy answer, and a timeout or a 5xx may hide a committed creation, so a second POST is a
  second organization. The `commit_then_500` mode of the fake hub pins it: one POST, a 403
  `hub_unavailable`, and the organization arrives by the next reconcile pass.
- **The Write tool turns a unicode NUL escape (backslash, `u0000`) inside a string literal into a
  real NUL byte in the file.** The test still "worked" (a NUL is a control character) but the
  source carried a raw NUL. Write such escapes through a script and byte-scan the file before
  committing.
- **Opening creation changes what an owner can do for a member.** A `user` row is instance-global:
  the moment a member owns a second workspace, `mintRefusal` answers `cross_workspace_target` and
  the delete answers `member_of_other_workspaces` for them in the FIRST workspace too. That is the
  guard working, not a regression: it is documented for operators in
  `docs/self-hosting/deployment-profiles.md`, and `MAX_WORKSPACES_PER_USER=0` is the switch for an
  instance that wants to stay one team's.
- **A rate wall mounted on a PATH counts everything that touches the path.** The first wall on
  `POST /workspaces` was `api.use('/workspaces', rateLimit(...))` on arrival: OPTIONS, HEAD and
  anonymous POSTs (all of them 404/401, none of them a creation) each spent the address's budget, so
  61 preflights locked a person out of a route they had never used, and `/me` still said they could
  create. The wall now lives IN the handler, after the caller is identified: the per-person bucket
  is judged first and a person it refuses never reaches the per-address one, which is ten people's
  worth, so one colleague takes at most a tenth of an office's NAT address. `/me.canCreateWorkspace`
  reads both buckets (no spend). Rule: a wall protecting an authenticated act is spent by the
  handler, keyed on who it identified; path mounts are for surfaces whose cost IS the arrival.
- **The deploy-order refusal lands on the TOOL's callback, not on a hub page.** Verified live by
  the federation drill's Phase 3b (hub `lane/org-create-for-tools` beside this branch, 2026-09-18):
  an authorize that requests a scope the hub does not list for the client answers a 302 to
  Slideless's own callback carrying `error=invalid_scope` and an `error_description` naming the
  scope — no code, no consent screen, the whole sign-in over. So a tool that ships
  `orgs:create` before the hub lists it does not "lose workspace creation", it locks every user out
  at the door, and the symptom shows in the tool's callback logs, not the hub's. The hub first.
- **The drill's "next /24" is not a free subnet on a busy machine.** `172.30.250.0/24` overlapped
  a standing `172.30.0.0/16` compose network here, and so would `172.30.251.0/24`: Docker's default
  pool hands out /16s, so any neighbour inside the same /16 swallows every /24 of it. To run the
  drill beside other stacks, set `FEDERATION_SUBNET_PREFIX` OUTSIDE the pool (`10.99.250` worked),
  and read `docker network inspect` for the real masks before picking, not just the prefixes.
- **The hub and Slideless dashboards are near-twins, and a look pass on one is not a look pass on
  both.** A sweep of the two shells on 2026-09-19 (after the settings/band/gate passes) found drift
  in both directions: Slideless had moved the `.float` backdrop blur onto a `::before`
  pseudo-element — a backdrop filter makes its element the containing block of every fixed
  descendant, so a `DropdownMenu.SubContent` inside it opens as a sliver — while the hub still
  carried the broken shape; and the hub had a French typography test (the space before `? ! : ;`
  and inside guillemets must be U+00A0, or the punctuation wraps onto its own line) that Slideless
  lacked, with 32 real violations behind it. Both are now fixed in both repos. When a change lands
  in the shared shell layer (`app.css`, `lib/components/{shared,shell,brand,settings,sidebar}`,
  `lib/i18n`, `theme.svelte.ts`, `nav.ts`), diff the same file in the other repo before closing the
  task: the vocabulary differs (organization vs workspace, `@antasphere/contract` vs
  `@app/contract`) but the mechanism should not.

## The chassis boundary (PRDCT-2529, 2026-09-19)

- **`db:generate` reads the chassis schema through its BUILT package, so `chassis-db` is built
  first.** `packages/db/src/schema.ts` imports `@antasphere/chassis-db/schema`, whose `exports`
  answer `dist`; drizzle-kit loads the schema files itself, outside turbo, so nothing builds the
  dependency for it. On a fresh clone, or after `dist` is cleaned, `pnpm --filter @app/db
db:generate` dies with `MODULE_NOT_FOUND … packages/db/node_modules/@antasphere/chassis-db`,
  which reads like a broken install and is not one. The same mechanism has a quiet form: with a
  STALE `dist`, drizzle-kit sees the chassis tables as they were at the last build, and says so
  with no error. The command, verified both ways on 2026-09-19 (it ends on `No schema changes, nothing to
migrate` on an unchanged schema):
  `pnpm --filter @antasphere/chassis-db build && pnpm --filter @app/db db:generate`.
- **The dev server runs the chassis from `dist`: a chassis source edit reaches it only through a
  rebuild.** `pnpm --filter @app/server dev` is `tsx watch src/index.ts`, and every
  `@antasphere/chassis-*` specifier resolves to the package's `dist` (that is what lets ONE copy
  ship in the image). Verified with a `tsx watch` probe importing `@antasphere/chassis-server/util`:
  touching `packages/chassis-server/src/**` restarts nothing; `pnpm --filter
@antasphere/chassis-server build` rewrites `dist` and `tsx watch` restarts by itself, no manual
  restart needed. After an edit that may span the three packages, `pnpm turbo build
--filter=@antasphere/chassis-server` builds chassis-db, chassis-contract and chassis-server in
  order. The symptom of forgetting is the most confusing one there is: the edit is on disk, the
  server restarts on the next app-side save, and the old behaviour is still there. (The chassis
  package's OWN tests alias these names to `src`, so they never show the staleness; the app's
  integration run goes through turbo, which builds first.)
- **The app's integration run and the tool-host CLI run read the chassis from `dist`: an
  edit, OR A TEST MUTATION, under `packages/chassis-*/src` reaches them only after a rebuild.**
  The chassis suites run twice, and only the chassis package's own run aliases the names to
  `src`; `apps/server` (`vitest.integration.config.ts`) and `packages/cli` (`vitest.config.ts`)
  resolve `@antasphere/chassis-*` to the built package, the same single copy that ships. Through
  turbo this is invisible (`^build` runs first). By hand it is not: a mutation written into
  `packages/chassis-cli/src/context.ts` turned the chassis run red and left the Slideless run
  GREEN, 470 of 470, until `pnpm --filter @antasphere/chassis-cli build` made it red too
  (measured 2026-09-20, PRDCT-2530). An independent reviewer measured a false "not caught" twice
  this way. When mutating chassis source to prove a test bites: rebuild the package before
  reading the tool-side result, and rebuild again after restoring the file.
- **The published CLI stays ONE package because the chassis packages sit under `devDependencies`
  and esbuild inlines them: never move them to `dependencies`.** `packages/cli` bundles with no
  `external`, so `@antasphere/chassis-cli`, `@antasphere/chassis-sdk`, `@antasphere/chassis-contract`,
  `@app/sdk`, `@app/contract`, `cli-core` and `commander` are all inside `dist/bin.js`,
  and the packed `package.json` carries no `dependencies` key at all. These packages are private
  and unpublished: one line under `dependencies` and an `npm i` of the published CLI package fails on a name
  the registry does not know. The proof to rerun after touching the CLI's packaging: `npm pack`,
  install the tarball in an empty directory, `--version`, `--help`, and one class definition each
  of `CliUsageError`, `PlatformApiError` and `CommanderError` in the bundle (two would mean two
  loaded copies, and `context.ts` and `stdin.ts` hold module-level WeakMaps: a second copy routes
  `--json` through the sanitizer). The test-only entry `@antasphere/chassis-cli/testing` is built
  but excluded from the package's `files` and is imported by nothing under a `src/`.
- **On this Mac, `docker build` and testcontainers can stall on pulling a PUBLIC image: the
  keychain credential helper never answers.** The symptom is a pull that never progresses, with no error. The workaround leaves `~/.docker/config.json` alone: an empty
  throwaway config, `export DOCKER_CONFIG=/private/tmp/sl-dockercfg` (a directory holding a
  `config.json` of `{}` and a `cli-plugins` symlink to the real one, so `docker compose` and
  `buildx` still resolve), exported in the shell that runs `docker build` or
  `pnpm turbo test:integration`. Public images need no credentials, so nothing is lost.

## The tool's identity in one definition (PRDCT-2531, 2026-09-20)

- **A test suite that takes the identity from its host pins nothing about its value.** The chassis
  suites read the key prefix, the scopes and the hub client id from `{ boot, identity, scopes, … }`, so
  they stay green whatever the host says: rename the key prefix to anything and every one of them still passes.
  The literals therefore live on the TOOL's side, in
  `apps/server/test/integration/identity-pins.test.ts` (the prefix on a minted key and on an
  accepted bearer, the OTel service name, the MCP server name and the `<prefix>whoami` tool, the mail
  subjects, the fallback page, the wire sentences of the `copy` slot, the three OpenAPI strings).
  Never make that file read `IDENTITY`; a tool that takes its own name rewrites its literals.
- **Spreading a `createRoute` result drops its `getRoutingPath`: re-word a route through a
  factory, never a spread.** `@hono/zod-openapi` attaches `getRoutingPath` with
  `Object.defineProperty(route, 'getRoutingPath', { enumerable: false })`, and an object spread
  copies enumerable properties only, so the copy is a plain config and no longer what
  `createRoute` returns. A route whose wording depends on the tool (the export route's scope in its
  summary, the file delete route's in-use sentence) is built INSIDE `defineChassisRoutes` from the
  identity and its third argument, with one `createRoute` call per route.
- **`turbo` without `--continue` silently skips the dependants of a failed task.** The CLI's test
  task can exit 1 on a machine's file-watcher limit with every test green (`EMFILE … watch`, after
  the run), and turbo then never starts what depends on it. Run the gate as
  `pnpm turbo lint typecheck test build --continue`, and judge it by the per-package test COUNTS
  against the last known figures, never by the absence of a red line.
- **The chassis registers `<toolPrefix>whoami`, so a list of the tool's MCP tools read off
  `registerTools` no longer holds it.** `apps/server/test/unit/mcp-docs-coverage.test.ts` records what
  `registerTools` registers; the whoami the docs carry and the count includes is added there by name
  (`CHASSIS_REGISTERED`). A tool that registers a whoami of its own fails when the MCP server is built:
  the SDK refuses a second tool under a name already registered (`Tool <name> is already registered`).

## Projects in the template (PRDCT-2581 / PRDCT-2585, 2026-09-21, lane C of the projects wave)

- **A chassis table that arrives with a later copy lands as the next migration of the tool's chain,
  never in the baseline.** The migration status is hash-based (`packages/db/test/migration-status.test.ts`,
  OPS-6): an instance that booted on `0000_chassis_baseline.sql` reads an edited baseline as an unknown
  applied hash, that is a DOWNGRADE, and refuses to boot. `0002_projects.sql` is the two project tables,
  generated from the chassis schema after the copy (`pnpm --filter @antasphere/chassis-db build && pnpm
--filter @app/db db:generate --name projects`) and byte-identical to the source's own `0046`; the tool's
  `0003_item_projects.sql` follows it. The journal test pins the chain and says so.
- **The template's item is workspace-wide, so the project seam is plugged where it changes an answer and
  nowhere else.** A read-rule branch over `projectGrantPredicate` would be dead code on a resource every
  member already reads; what is load-bearing is the payload (the caller's readable projects, through the
  predicate), the list filter (404 through `projectRole`), the link gate (`atLeast: 'editor', access:
'write'`) and the export entry. The header of `apps/server/src/items/projects.ts` says where a PRIVATE
  resource adds the branch (three homes, changed together), so the next tool reads the rule instead of a
  branch that does nothing.
- **The machine allowlist sees the pathname, never the query string.** A pin written as
  `requiredScopeFor('/api/v1/items?project=…', 'GET')` answers null and reads as a fail-closed hole; the
  filter rides the list rule, and the pin is on the plain path.
- **The chassis's MCP write tools say `confirm with the user first`; the tool's say `Always confirm with the
user before calling.`** A test that walks "every write tool" for the second sentence goes red on the nine
  project tools the chassis registers under the tool's prefix. Scope the walk to the tool's own set, and pin
  the chassis's tools by name and position only (`identity-pins.test.ts`).
- **`--workspace <name>` in a CLI test costs a `GET /me` the routed harness does not answer.** A name is
  looked up against the caller's workspaces before the command runs; a 404-hint test that passes a fake name
  fails on `no fake route GET /api/v1/me`. Pass the workspace id (a uuid is sent as it is).
- **The hub reconcile DEACTIVATES a swept membership and never deletes it, so a foreign key's
  ON DELETE CASCADE never fires on a hub removal** (Slideless's projects lane, PRDCT-2576).
  `packages/chassis-server/src/identity/hub-reconcile.ts` flips `is_active`, and
  `projectOrgMembership` reuses the same row when the hub adds the person back. A design that says
  "a removed member loses X by cascade" is true for a local delete and false for the cloud edition;
  anything that must die with a hub removal is deleted in the sweep's own transaction
  (`deleteMembershipGrants`, `packages/chassis-server/src/members/removal.ts`;
  `packages/chassis-server/test/integration/projects-cloud.test.ts` pins a real removal and re-add
  through the fake hub). A LOCAL pause by an admin (`PATCH /members/{id}` `isActive: false`) keeps
  such rows on purpose.
- **A drizzle column object inside a `sql` template renders UNQUALIFIED in the select list of a
  single-table query (`"id"`, not `"items"."id"`), and inside a subquery that bare name binds to
  the subquery's own tables.** In a WHERE it is qualified. A predicate builder embedded in both
  places therefore takes a raw qualified reference (`PROJECTS_ID`, `ITEMS_ID`), never a column
  object, and every subquery alias is prefixed (`prj_pm` in
  `packages/chassis-server/src/projects/access.ts`, `ip_f` in `apps/server/src/items/service.ts`)
  so it cannot shadow the caller's.
- **A fixture whose resource author is the WORKSPACE owner cannot pin a 404 to a non-member: the
  workspace owner manages every project.** At Slideless the first run of the deck-projects suite
  failed 15 of 29 tests on that alone, and the code was right. The author of an access-rule
  fixture is a plain member, and the setup owner appears nowhere else
  (`apps/server/test/integration/items-projects.test.ts`: a plain member creates the project, and
  the workspace owner appears only in the cases about an owner: the operator view and the
  cross-workspace refusal).
- **A route is not done until the coverage guards have gone red and green.** A new route turns
  `packages/sdk/test/route-coverage.test.ts` and `packages/chassis-sdk/test/route-coverage.test.ts`
  red until the SDK has its method, a new CLI command turns `packages/cli/test/docs-coverage.test.ts`
  red until `docs/agents/cli.md` names it, a new MCP tool turns
  `apps/server/test/unit/mcp-docs-coverage.test.ts` red, and a new export entry meets
  `RESERVED_EXPORT_ENTRY_NAMES` (`packages/chassis-server/test/unit/export-entries.test.ts`).
  Expect them to go red, and read them as the checklist they are (at Slideless an existence-oracle
  probe table pinned to the OpenAPI document is a fourth).
- **A ported shell file is diffed against its source, not read.** Twenty of the twenty-one dashboard shell
  files came over byte-identical to Slideless at the source commit and the one difference was the contract
  import; `diff <(git -C <source> show <sha>:<path>) <path>` per file is the review, and it is what let the
  lane sign the port in minutes rather than re-read four thousand lines.

## The billing rail, phase 1, as Slideless learned it (PRDCT-2626 in Slideless, 2026-09-22, lane B of the billing-rail wave; re-copied here by PRDCT-2648)

What happened in Slideless when the chassis gained the billing rail, kept here because the template
carries the same chassis and a tool built from it meets the same traps.

- **A price is a declaration on the route, and the chassis knows no key.** Slideless's two hand-written
  metering sites (in the chassis's files route and in its presentations route) were byte-for-byte twins
  that drifted the moment one learned a field; now a route carries `meter` / `limit` / `feature` ONCE in
  the tool's contract (`TOOL_ROUTE_ENTITLEMENTS` here, built from the route objects so a typo throws at
  module load) and ONE gate in `create-api.ts` enforces it after the scope gate and emits after a 2xx.
  The chassis's own `/files` route is priced by the TOOL's declaration too:
  `git grep -i 'files.maxBytes\|items.create' -- ':(glob)packages/chassis-*/src/**'` stays empty. A handler that
  checks or emits by hand is the regression.
- **The gate reads what the handler recorded for its audit row.** `c.set('audit', { …, metadata:
{ sizeBytes } })` is where the stored size and the created resource live; the declaration's
  `quantity` runs twice, before the handler on the declared Content-Length (the check) and after it
  with `ctx.audit` set (the emit, `auditedSizeBytes`). A multipart body's Content-Length is the
  framing, not the file: an emit on it would over-bill by a few hundred bytes per upload.
- **The event's `userId` is the HUB user, never the tool's local id.** The hub refuses a local id as
  `unknown_user`; the SSO link stores the hub's `sub` as `account.account_id` under the `antasphere`
  provider, and `hubSubjectResolver` reads it (cached five minutes). The operator, who has no hub
  link, reports null.
- **On oss the credit check runs BEFORE the declared limit; on cloud the order is feature → limit →
  credits.** Both editions refuse an upload over the cap at the same threshold in phase 1 (the free
  value IS `MAX_FILE_SIZE_MB` by construction), but oss keeps 413 `entitlement_denied` with the message
  `file exceeds MAX_FILE_SIZE_MB (100MB)` byte for byte because the local check answers first, while a
  cloud account gets 403 `plan_required` with the upgrade link. Flipping the oss order changes the
  message every self-hosted CLI already prints.
- **A failed entitlements read keeps the last known plan for fifteen minutes, then free.** "Any
  failure = free" would refuse a pro account above the free cap on every hub blip; a miss is cached for
  the TTL like an answer, so a request storm never becomes a hub storm.
- **The queue's retry budget must outlive a hub deploy.** Five retries in about a minute archived the
  event as failed while the hub was still rolling; ten retries from thirty seconds (about eight hours)
  is `DEFAULT_USAGE_RETRY`, the poster treats 404 as an outage, never as data loss, and
  `BootOverrides.usageRetry` shrinks it for a test that watches a retried batch land.
- **The machine token is minted single-flight and the hub pins its shape**: the mint carries
  `resource=<hub>/mcp` and EXACTLY `scope=usage:write`; a 400 `invalid_scope`, `invalid_target`,
  `unauthorized_client` or `invalid_client` is a configuration error logged at error level and never
  retried into a loop. The fake hub refuses a mint without the resource.
- **The app's integration suite reads the chassis from its BUILD, not its source.** The server's
  integration config carries no source alias for `@antasphere/chassis-server`, so a chassis edit is
  invisible to the app's run until `pnpm turbo build` has run. CI builds first; a lane running one
  file by hand must too.
- **The fake hub judges per element like the real hub**: `unknown_account` for an accountRef no
  seeded org holds, `unknown_user` for a userId no fixture minted, `invalid_event` with `id: null` for
  an element that does not parse, `duplicate` for a re-post. A test that seeds a person through
  `ssoLogin` gets its org known; a hand-written accountRef is rejected.

## The pair meets, as Slideless learned it (PRDCT-2629 to 2637 in Slideless, 2026-09-22, lane D of the billing-rail wave; re-copied here by PRDCT-2648)

- **Two halves verified against stubs of each other do not meet; the stub must speak the real
  contract, not a paraphrase.** Slideless's chassis stamped its identity slug into every usage event,
  the real hub names the tool from the token's registry entry (`slideless-cloud`) and refuses a body
  slug that differs, and the fake hub never read the field: on the real pair NOTHING landed while the
  suite was green. The fix is subtraction (the body never names the tool, the token is the only
  authority) plus the rule that makes the class visible: `usageEventSchema` in chassis-contract is the
  hub's schema MIRRORED VERBATIM, `FakeHub` parses every element with it and refuses `tool_mismatch`
  against a registry slug that is NOT the identity slug by default (`yourtool-cloud` here). Since
  PRDCT-2677 the mirror is guarded rather than trusted: see the hub's wire section at the end of this file.
- **A body limit installed before the gate shadows the plan refusal.** hono's `bodyLimit` refuses a
  declared Content-Length over its cap at once, so an upload over the cap met 413 and never the 403
  with the upgrade link. The `bodyLimit` slot now declares DATA (`BodyCap`), the chassis builds the
  middleware, and when the matched route carries a limit-judging gate (`isDeferringGate`, keyed on the
  gate handler itself) the refusal is parked on the context for the gate to fire after the plan check,
  with the request's body DROPPED so no middleware between the cap and the gate can read a byte of
  it. Test a plan refusal on the phase-1 profile with a declared size over the REAL cap (a header
  alone proves it), never on a hub override alone.
- **A stale-while-revalidate cache must still answer a cold account.** Serving the default on a first
  miss would judge a pro account as free once per boot; awaiting the read stalls the request on a slow
  hub. `coldWaitMs` (1.5 s) bounds the cold wait, and `settle()` is the test seam that awaits
  background refreshes.
- **pg-boss's terminal `failed` is a silent drop unless a dead letter catches it.** The dead letter is
  set ON THE QUEUE by the worker boot (`updateQueue`, the held queue created first), never on a send:
  an api-role replica with no DDL would otherwise fail every send until the held queue existed. A
  worker logs, counts (`usage_events_held_total`) and re-sends after `heldDelaySeconds`, and
  `usageSendOptions()` is the ONE statement both the sink and the re-drive use.
- **Mirror a hub schema verbatim or it bites at the first new value.** The profile mirror said
  `limits: number | null` where the hub says `number | boolean`; the first boolean would have read every
  profile as malformed and held paying accounts to free caps after fifteen minutes. A boolean resolves
  as unlimited (`true`) or nothing (`false`).
- **A negative cache sized for outages is a hammer on a configuration error.** Five seconds is right
  for a hub that is down and wrong for a secret that is wrong: twelve mints a minute per replica
  against the hub's token wall. Two holds, keyed on the failure's kind (`invalid_client`: five minutes).
- **A price per byte is a price per byte.** `creditsPerUnit: 5, unit: 'bytes'` with a label saying
  "per MB" is a comment doing a contract's job: seeded verbatim, a 20 MB upload is a hundred million
  credits. `per` on the action (`5 per 1,048,576 bytes`) keeps the meter exact, the boot refuses a
  route whose meter unit differs from the action's, and `declaredCredits()` lets a test pin the seed
  values from the declaration (`items-metering.test.ts` does).

## The billing rail in the template (PRDCT-2648, 2026-09-22, lane H after the billing-rail wave)

- **A re-copy can REMOVE a behaviour the template relied on the chassis for.** The chassis's files
  route at 12ef2f8 checks no declared size and emits no usage event: both moved to the gate, which
  runs only on a route the TOOL declares. A template that took the copy and declared nothing would
  keep the hard cap mid-stream and lose the declared-size refusal of `POST /files` with no test going
  red in the chassis. The template's slot therefore carries `files.upload` on the chassis's upload
  route, and `items-metering.test.ts` pins the 413 on oss and the 403 on cloud through the real boot.
  Read the diff of a re-copy for what LEFT the chassis, not only for what arrived.
- **A feature declared for the paid tier is wired on no route in a template.** In phase 1 every cloud
  account was `free`, so a route carrying `feature:` would have answered 403 `plan_required` to every
  cloud account from the day the copy landed; that was the reason of 22 September. Phase 3 (Slideless
  PRDCT-2702) made the hub sell `pro`, so a wired feature now opens its route to a `pro` account and
  refuses a `free` one with the upgrade link, and the premise no longer holds. The template still
  wires none, for the reason of phase 3: a feature is sold on the act, and the item has no option to
  sell (see "A feature is sold on the act" in "Billing phases 2 and 3" below).
- **Count the owed re-copies with git, not with the brief.** The rail said the template was four
  copies behind (three small chassis moves of 19 September, then the billing rail). Measured on the
  source (`git log ffca2c9..12ef2f8 -- 'packages/chassis-*'`), the template's copy of 21 September
  already held every chassis commit before the rail: the whole difference was PR #67 and PR #70, 35
  files (17 new, 18 changed), and nothing else was owed. One `git archive <sha> packages/chassis-*` over the removed
  folders, then `node scripts/check-chassis-copies.mjs --write`, landed it with `diff -r` empty. A
  re-copy owed for days costs nothing more than one owed for hours, but every day in between is a
  day a new tool starts behind.

## An optional external worker, the pattern not yet lifted (Slideless PRDCT-2725, PRDCT-2785 and PRDCT-2790, 24 to 27 September 2026; recorded here by PRDCT-2865)

Slideless needed a process its app image must not carry (a headless browser that opens untrusted
content) and must therefore hold nothing of the app. The shape that came out is general and is
recorded here for the day a second tool needs one: an **optional external worker** the app hands jobs
to, fire and forget, over three legs (`POST` a job the size of a line under a shared secret; the worker
pulls what it needs from the app under a ONE-TIME KEY minted per claim and stored as its hash on the
claim row; the worker puts the result back under the same key), the app behaving the same when the
worker is absent, busy or down (a lease per claim, attempts, an in-flight cap, a backoff that costs no
attempt), the worker's own image holding its runtime and nothing else, a boot self-check that refuses
to serve when its own precondition fails, an opt-in compose profile, and the worker's secret in a volume
of its own on the one-file Hostinger template, never the database credential's. The generic half is
about 60 % of the claim service, the whole worker client and the Google identity token, the routes'
skeleton and the worker's queue and server; the tool's half is what the worker reads, what it accepts
back and the worker image itself. Romain's ruling (TEMPLATE-FEEDBACK #32 at Slideless, 24 September
2026): not generalised now; lift it when a second tool (or a `labs/services/` renderer shared by
several) needs it, with the compose profile, the CI job that proves the worker's precondition in the
image, and the release step that publishes the worker image beside the app's. The lessons that already
hold for any tool:

- **The worker must be the least trusted process, and the credential design says so.** The shared
  secret only lets the app hand a job to the worker; it never travels back. What travels back is
  a one-time key minted per claim (32 random bytes, the sha256 on the row): it opens the files of
  that one job and accepts that one job's result, only while the lease lives, and a replayed,
  foreign or late key answers 401 with nothing else. A wrong-token oracle on a 256-bit key needs no
  rate limit. The integration suite plays the worker's side of the protocol over the app's own
  routes (a fake with no browser), which is what pins the containment; the worker's own suite
  pins its own lockdown with the real runtime.
- **`..` never reaches a route through a URL parser.** The WHATWG parser resolves dot segments
  (and `%2e%2e`) before Hono sees the path, so an HTTP-level test of a traversal exercises the
  parser, not the code; the traversal rule is tested at the service (`fileFor`), where a path
  arrives however it was spelled. The route decodes the RAW pathname one time per segment, so a
  file whose own name holds a percent sign resolves whatever Hono's `c.req.path` does with
  encoded characters (it applies `decodeURI`, which turns `%20` into a space and leaves `%25`
  and `%2F` as they are; the verifier found no request the two readings tell apart, and the raw
  read stays the one that cannot drift).
- **A fake that answers "the oldest held job" leaks state between tests.** The first version of
  the integration fake's `finish()` shifted its held queue; a job finished by hand in an earlier
  test stayed in that queue, the shift PUT with a dead key, 401, and three later tests saw the
  in-flight cap full for no visible reason. A fake that holds state takes the job it must answer
  by identity and throws on a refused answer.
- **A URL-shaped env key is read once, at boot, in the tool's env slot.** The worker's URL key
  without its secret key refuses the boot with the fix named (the worker would take no job and
  every job would wait forever); blank means unset, as for every other key.
- **`docker compose run` BUILDS a missing image when the service has a `build:` section.** A
  script that checks a pulled image by running it must first confirm the image is on the host
  (`config --images <service>`, then `docker image inspect`), or a failed pull turns into minutes
  of building on a customer's server and an unpublished build switched on. A fake `docker` in a
  test must answer `config --images` with a non-default name, or the check can inspect the wrong
  image and stay green.
- **On Cloud Run, the Google token goes in `X-Serverless-Authorization`.** Cloud Run checks it and
  still hands `Authorization` to the container, so a shared secret there keeps working; the token
  in `Authorization` takes the secret's place. A person's `gcloud auth print-identity-token` is
  accepted whatever the audience, so it proves the header, never the audience or a service
  account's invoker binding: only the service account's own token does.
- **A new Cloud Run service needs the deployer's actAs on ITS runtime account.** `run.admin`
  cannot create a revision that runs as an account the deployer may not act as; the plan cannot
  show it, and the roll would apply the first service and be refused on the second.
- **An optional service's variable is never `${VAR:?}`.** Compose checks a `:?` for EVERY command on
  the file, the service on or off, so an install without the optional service could not even run
  `docker compose up` (at Slideless, the worker's secret broke `compose` on every install without it,
  fixed on 27 September 2026). The variable takes an empty default (`${VAR:-}`) and the service
  itself refuses to boot without a value; CI reads the file with only the required variable set
  (`docker compose config --quiet`), which is what catches the next one.

## The hub's teams and refusals in the chassis (Slideless, 27 September 2026, the teams lane; re-copied here by PRDCT-2862)

- **A `.default()` on a field of a RESPONSE schema makes the field required for every handler
  that answers it.** The typed `c.json` of an `openapi` route checks against the schema's OUTPUT
  type, so `hubDenied: z.array(…).default([])` on `/me` failed the typecheck of the oss and
  machine branches, which must not carry the key at all. A field that only some answers carry is
  `.optional()` on the wire and the reader supplies the default (`me.hubDenied ?? []` in the
  dashboard).
- **The fake hub re-seeds a user's org entry from the fixture at every login**, keeping only the
  registry-level extras it knows by name (`status`, `isDefault`, now `teams`). A new per-org field
  on `HubOrgEntry` must be added to BOTH re-seed sites (the code exchange and the H3 connect), or
  the next login silently drops what a test set with `setUserOrg`.
- **A zero-membership session is outside the live gate's reach.** The gate runs on a resolved
  principal, and a session whose last projected membership was swept resolves to none, so
  nothing ran a reconcile for it again: a person re-seated at the hub stayed on the zero state
  for ever while the refusal page promised access within seconds (only a request naming the
  swept workspace re-admitted, through `onWorkspaceMiss`). Anything that must reach that
  person, re-admission after a hub-side change first, runs from the zero-state read itself:
  the zero-membership `/me` runs the reconciler's cached pass (`reconcileForZeroState`, cloud
  only; its 10 s TTL and 15 s retry throttle keep a polling page off the hub), resolves the
  session again through the same resolver and gate, and answers the normal shape when a
  membership came back. The refusal page polls `/me` every ten seconds while the tab is visible.

## Teams on both editions, a team as a project member (Slideless PRDCT-2813 / PRDCT-2794, 27 September 2026; re-copied here by PRDCT-2862)

- **The rule the editions audit set: a concept is on both editions with the same tables, routes and
  screens, and only its SOURCE differs.** The teams lane of the same morning had built a read-only
  projection (`hub_team_id NOT NULL`, no route, no screen), which left the self-hosted edition with
  nothing. Making the hub id nullable and giving the routes a second lock (`hub_team_id IS NULL` on
  every write) turned the same two tables into the tool's own on self-hosted and the hub's on a
  hub-origin workspace, with one page and one CLI family reading both.
- **The caller-scoped `GET /orgs` is not enough for a team list.** It carries the caller's OWN seats,
  so a team existed here only once one of its members had signed in, and a project could not be
  shared with a team nobody had signed in from. The hub opens `GET /teams` to a grant under
  `account:read` (which the SSO scopes carry) with `X-Workspace-Id` selecting the organization, so
  the reconcile reads the organization's whole list as the person, throttled per org per replica
  (`orgTeamsTtlMs`). The delete of the teams the list no longer names is what makes a team deleted
  at the hub lose its project grants here; a list cut at the drain's page cap (`complete: false`)
  only upserts, else an organization of a thousand teams would lose the rest on every read.
- **A local slug's uniqueness is a PARTIAL index (`WHERE hub_team_id IS NULL`).** A projected team's
  slug is the hub's, unique there at any moment; two projections read at different moments (a
  person's seat from `/orgs`, the org list a minute later) can hold the same slug for an instant,
  and a full unique index would have made the reconcile fail on the hub's own rename. Postgres
  reports the INDEX name as the violated constraint, so the 409 `slug_taken` mapping matches
  `workspace_teams_workspace_slug_local_uniq`, not a constraint name.
- **One list, two kinds, one cursor.** A project's members are people and teams in one list
  (`kind`), newest first: the two tables are read in a raw `UNION ALL` with the value-carrying
  cursor applied inside EACH branch, since a set operation is where drizzle's builder stops and a
  cursor applied outside would page each kind on its own.
- **A machine allowlist entry answers `insufficient_scope`, not `endpoint_not_allowed`, to the wrong
  scope.** A read key on a listed write route is refused by the scope gate with the scope's own
  code; `endpoint_not_allowed` is for shapes the allowlist does not name. A test that pins the
  wrong one passes for the wrong reason.

## Demo sign-in on the self-hosted edition (Slideless PRDCT-2821 and PRDCT-2842, 27 and 28 September 2026; re-copied here by PRDCT-2862)

- **A session a link opens is a visit, and the sign-in library is not the only door.** The first
  round refused the library's account paths and still let a link's session make an API key; the
  second found it could also create a workspace and accept an invitation, routes of our own. The
  rule to write is the one about the account ("it changes nothing durable"), then every route that
  creates a credential, an organization or a membership checks `demoPassId`; the library's paths
  are a named list (`DEMO_SESSION_REFUSED_AUTH_PATHS`) to review at every plugin or version bump.
- **OAuth token rows outlive their session: `session_id` is `on delete set null`.** Deleting a
  session leaves the tool's refresh token alive and unattached, out of reach of anything keyed on
  the session. To end what a session opened, delete its OAuth rows BEFORE the session row, and
  hook every path that deletes a session (sign-out, the library's revoke paths), not only yours.
- **A cleanup that runs before the library authenticates must authenticate the caller itself.**
  A hook that read the caller from the cookie's token part ended live sessions on a request the
  library then refused with 401 (a forged signature). Resolve the caller with
  `auth.api.getSession`; the token-only lookup is fine for a refusal, never for a write.
- **A migration renumbered by a rebase breaks every local database that ran the old number.**
  Rebased behind a sibling lane's `0051`, the demo lane's `0051_demo_passes` became `0052`; a stack that
  had applied it as `0051` then crashed at boot on `relation "demo_pass_sessions" already exists`:
  Drizzle runs only migrations newer than the last applied, so it skipped the sibling's and replayed
  ours. Repair in one transaction: apply the skipped SQL, record it, move our row to the new
  timestamp (its hash is unchanged). Or `down -v` a throwaway stack.
- **A list the chassis owns cannot see the product's doors, and a lock that closes one race opens
  another.** The refusals became one list (`DEMO_SESSION_REFUSED_API_ROUTES`) with a contract walk
  over the CHASSIS routes; at Slideless a pass at admin still invited an outsider through the
  product's own invite route, whose claim link seated a standing guest member: the product's
  route, the product's contract, a key (`claimUrl`) the walk did not know. The tool now declares
  its own routes
  (`demoSessionRefusedRoutes`) and walks its own contract with the chassis's. In the same round,
  every add started holding the membership `FOR SHARE` against a removal; a DUPLICATE add then
  waited on the removal's uncommitted delete of the same grant while the removal's update waited on
  the add's share lock, and 14 removals in 40 answered 500 on a deadlock. An add that meets a lock
  must not wait on a row the removal is deleting: read the existing row first (a plain read still
  sees the uncommitted delete) and answer the repeat without an insert.

## The small gaps between the editions (Slideless PRDCT-2815 to PRDCT-2819, 28 September 2026; re-copied here by PRDCT-2862)

- **A rule that two editions share is a function, not two copies of three lines.** The hub's removal
  lived inside the reconcile's sweep; giving self-hosted "the same removal" by copying its two deletes
  into a route would have held until the next table hung on a membership row (the teams merge added
  one the day before). `deleteMembershipGrants` is the one statement, and both callers run it in the
  transaction that switches the row off.
- **A setting of the person is not an event of the workspace the request happened to be in.** The
  generic audit middleware writes into the principal's workspace; a default-workspace change recorded
  there would tell workspace A that one of its members prefers workspace B. Setting no audit entry
  in the handler is NOT enough: the middleware writes its generic row (method and path) for every
  authenticated mutation unless the path is exempt in `isAuditExempt`. The handler's comment and the
  invariant both said "no audit row" while every call wrote one; the test that counts the rows before
  and after found it. The path is exempt now, the rule `POST /workspaces` already follows.
- **A hidden form is not a closed route.** The cloud edition reported `emailChange: false` and the
  dashboard hid the form, while `/change-email` stayed open to any signed-in caller. Discovery says
  what the screens offer; only the before-hook says what the instance accepts.
- **A page that finishes with `goto('/')` opens the person's default workspace, not the one they just
  joined.** On cloud everyone has at least their own organization, so an accepted invitation landed
  somewhere else. The invitation page now persists the accepted workspace and navigates in full, the
  pattern of every page that lands the person in one workspace.
- **`turbo typecheck lint` prints both failures in one stream; read to the end.** A lint error was
  fixed and the typecheck error two lines below it was committed (e5867eb, fixed by 00c00a8).
- **Intent in a URL is anyone's intent (verifier round 1, F2).** `?accept=1` was meant as "the person
  pressed the button before leaving for the sign-in", and it read as that for anyone who was sent the
  link. What says "this person, in this tab, pressed the button" is state the page wrote itself at
  the click: session storage, one invitation, a short life, taken once.
- **Closing one door of a kind is not closing the kind (verifier round 2, N1 and N2).** At
  Slideless, round 1 found the product's own invite that outlives a removal; the fix revoked those
  and left the WORKSPACE invitation, which reactivates the row at the role it names, and the
  invitations the removed person had issued. The question to ask of a removal is not "which table did the finding name" but "what
  can switch this row back on, and what did this person leave open": the accept, the claim, and
  everything with their name in `invited_by`.
- **A browser test that answers a route itself costs the instance nothing.** The suite spends the
  ten invitation calls an hour the instance allows, so a test that opens a real invitation starves
  the tests after it. `page.route` on the lookup and the accept lets the page run its own logic
  against answers the test gives; what is tested is the page, which is what had no test.
- **"Flaky" is a claim, and a comparison settles it.** One test of the hub's team list went red in
  the lane's full integration runs and green alone. The lane touches the file that test exercises, so
  "older than this lane" was not known. Twelve runs alone on a clean `dev` and twelve on the lane's
  head were all green; six runs each beside the same load on the machine were red on BOTH (8 failed
  tests on `dev`, 7 on the head). The test counts reads inside a 250 ms window and fails when the
  machine is busy, whatever the branch. Run the comparison before writing the word in a pull request.

## Billing phases 2 and 3 on the placeholder, as Slideless learned them and as the template met them (PRDCT-2863, 2026-09-29, lane A of the 0.13.0 wave)

What Slideless learned when the chassis started charging (PRDCT-2664 and its kin) and when free
became limited (PRDCT-2702), kept here because a tool born from this template meets the same traps
on its first count limit; then what the template's own port taught.

- **A count limit is a lookup, and a lookup that fails must never become a plan refusal.** A count
  reads the tool's tables and the body, so the hook is async and answers `null` for "nothing to
  judge": no principal, no domain, a caller the handler would refuse. The gate then lets the route
  answer its own 403 or 404. A hook that THROWS is caught by the gate and logged at warn with the
  route and the key (a cap that silently stops biting is a cap an operator cannot see), and judges
  nothing on that request. Refusing `plan_required` on a lookup error would sell a plan for a bug.
- **A count hook judges only a caller the handler would let act.** The gate runs before the
  handler, so a count scoped by workspace alone would answer `plan_required` to a guest the handler
  refuses 403, and to a member naming a project they cannot link into, whose 404 says nothing
  about the project's existence. `items-of-workspace.ts` asks the handler's own questions first
  (`origin === 'guest'`, `ItemService.mayCreate` over `canLinkIntoProject`) and answers null
  otherwise: a plan refusal never says more than the handler would. The verifier's one mutation on
  this lane removed that check: `plan-limits.test.ts` went red, but on the plan switch's prime (a
  create naming an unknown project, asserted 404 inside the helper every switch runs), and the guest's
  and the member's cases never ran because their setup aborted on it. The prime now moves the plan
  through an upload declared over the cap (a refusal on every plan, nothing stored), so the named
  cases are what a regression reddens: a helper must not assert the property under test.
- **A hook reads the body through the handler's own schema before it looks anything up.** The first
  cut of the count hook kept every string of `projectIds` and asked the project predicate once per
  element: a body of twenty thousand strings under the 1 MiB cap cost that many round trips, and a
  value that is not a uuid threw in the predicate's cast, for a request the validator refuses at the
  twenty-first element or the first bad value (the verifier's round 1). Parsing the list alone was
  not enough either: a create with an empty name at the cap read the plan's 403 where the validator
  answers 400 (round 2). The hook now parses the WHOLE body with `itemCreateSchema` and answers null
  on a failure, so the validator's 400 follows with no lookup spent, whatever field it refuses.
- **The body is read once, by whoever reads it first, and Hono keeps the parse.** The gate's
  `ctx.body()` and the handler's `c.req.valid('json')` read the same cached parse, so the hook may
  read `projectIds` before the validator without consuming the body. A body that is not JSON reads
  as `undefined` in the hook, and the validator's own 400 follows. Never buffer the body a second
  way.
- **Only a size limit defers the body cap, and only a size limit demands a Content-Length.** The
  deferral of PRDCT-2632 exists so the plan sees a declared size before the cap's 413; keyed on
  "any limit" it would park the cap on the item create, drop the body and run the count's lookups
  on a request that could only answer 413. It is keyed on `limit.value === declaredContentLength`,
  the same predicate the 411 rule uses, so a count limit on a JSON route never refuses a body that
  declares no size (every `json()` request of the suites sends none, and they all land).
- **A cache of a quantity-priced answer is sound only through monotonicity, and a per-call action
  always asks for 1.** The price never decreases with the quantity, so a fresh allowed answer is
  good for any smaller or equal quantity (thirty seconds) and a fresh denial for any larger or
  equal one (five seconds). An action priced per call (`items.create`) therefore asks the hub once
  per window; a drill that wants the hub asked again for the fail-open leg uses a LARGER upload
  (3072 bytes, then 3073), never a second create, and sleeps past the five-second outage hold
  before the healing call. The same cache bites the REFUSAL leg: the first leg's allowed answer for
  `items.create` serves a create at an empty balance for thirty seconds, so the drill waits the
  window out (measured from the last allowed create) before asking for the 402, or the refusal reads
  as a 201 and the leg fails on a rule that holds.
- **A declaration that could never refuse is a false guarantee.** `workspace.members` is declared
  by the template so the hub caps invitations for every tool born from it, and wired on NO route of
  the tool: on a hub-projected workspace the tool's invitation doors answer `hub_managed` before
  any plan could be judged, a cloud-local workspace has no account and no plan, oss declares the
  cap as null. The key is wired only on a door the tool opens itself (a per-resource invitation, a
  claim), with a seats hook counting the seats AFTER the act.
- **A feature is sold on the act, not on the route, and the act is what the schema accepts.** A
  plain `feature: 'items.premium'` on the create would refuse every free item; `{ key, when }` with
  `when` reading the parsed body for the option the feature sells refuses only the create that asks
  for it, and is judged before the plan is read so a plain create costs no hub read. The template's
  item has no such option and invents none: the shape is in the comment beside `TOOL_FEATURES`,
  the wiring belongs to the first route that sells an act.
- **The fake hub's price book is the hub's, not the declaration's.** `items-metering.test.ts` prices
  `items.create` at the fake with `setPrice` and pins the charge on that row; discovery pins the
  declaration. A hub that seeded a price keeps it until staff edits the row, and the chassis
  charges what the hub answers. Never conflate the two.
- **`packages/contract` is read from `dist` by the app's suites, like the chassis.** A mutation or an
  edit under `packages/contract/src` (the factory, a limit key) stays invisible to `apps/server`'s
  runs until `pnpm --filter @app/contract build`; the server's typecheck also pulls the CLI in
  through project references, so an unbuilt `@app/sdk` fails it with errors that name the CLI.
  Build the workspace once after the install, before believing any red or green.
- **A drill that inherits metered actions from earlier phases counts deltas, never totals.** The
  template's Phase 3c and Phase 8 already create items on the cloud edition, and their events may
  still be in flight when the billing legs start. Every baseline of Phase 8b drains the usage queue
  first and reads the counts, and the per-row assertions of the first leg are restricted to the
  event ids queued since the leg started; `GET /billing/usage` is compared with the hub's own count
  for the account, never with 4.
- **`*.localhost` hostnames bite twice in a real browser, and a headless drill never notices.**
  First, a sign-in started on `localhost:<port>` ends on the tool's `/login?error=state_mismatch`
  when the registered callback is the other host: the state cookie lives on the host the flow
  started on (Slideless PRDCT-2645, reproduced with a driven Chromium). Start a browser sign-in on
  the host the registry entry names. Second, the hub's hint cookie domain defaults to the issuer
  host minus its first label, `localhost` on `hub.localhost`, a domain browsers refuse, so the hub set no hint cookie and the dashboard's
  hint-watch signed a fresh session out within a second (PRDCT-2825, seen on the hackathon copy of
  the template). The pair now lives under one parent domain, `hub.ant.localhost` and
  `yourtool.ant.localhost`, with `SSO_HINT_COOKIE_DOMAIN` and `HUB_HINT_COOKIE_DOMAIN` both
  `ant.localhost`; the drill's `--resolve` entries, the compose aliases, the registry entry and the
  drill overlay's `extra_hosts` all moved together, because the issuer string, the redirect URI and
  the hop's pinned name must agree to the byte.
- **A fail-open posture without a hold is a timeout per request.** Failing open is the right
  verdict for a hub that does not answer, but a hub that times out costs the full budget (five
  seconds) on EVERY metered request for fifteen minutes unless the hub is left alone between
  probes. `HubCreditCheck` (`packages/chassis-server/src/entitlements/check.ts`) has `outageHoldMs`
  (five seconds, one probe per window for the instance), and a held request never re-arms the
  window (only a real failed call does), or the hold would extend itself under load. A suite that
  wants every request to reach the fake sets the hold to zero through `entitlementCheckDials`, as
  it does for the two TTLs; the drill sleeps past the hold before the healing call.
- **What discovery advertises must be what the instance serves.** At Slideless a `pro: 500 MB`
  beside a handler that cut the stream at `MAX_FILE_SIZE_MB` (100) advertised a value nobody could
  use, and the hub would have seeded it as truth (PRDCT-2653). The paid tier IS the operator's cap,
  the free value a number of its own, and the boot refuses any tier above a numeric `oss` ceiling
  (`assertToolEntitlements`, `packages/chassis-server/src/entitlements/slot.ts`); the template's
  `files.maxBytes` follows it, and `apps/server/test/unit/entitlements-declaration.test.ts` pins
  the three values. The cloud cap must be raised (infra) BEFORE staff seeds the hub from discovery.
- **A body with no Content-Length is a plan limit passed at 0 bytes.** Refusing it before the
  handler (411 `length_required`) is safer than storing and rolling back: the blob is
  content-addressed and may be another resource's. Node's fetch and the browser declare the length
  for a buffer, a blob or a form; `app.request` with a body and no header sends NONE, which is how
  a test reproduces the case (`items-metering.test.ts` pins the 411 on the upload).
- **A meter in bytes needs the declared size whether or not a plan limit sits beside it.** The 411
  rule was first keyed on the route's limit alone; at Slideless an anonymous upload door with a
  meter and no limit then priced a chunked upload at 0 bytes, allowed it at an empty balance and
  debited the stored size, leaving the owner below zero (the verifier's round 3). The gate keys the
  rule on the meter's unit too (`judgesSize` in `packages/chassis-server/src/entitlements/gate.ts`):
  every door that meters bytes refuses a body with no declared size before storing.
- **A stale event held is a loop by design, and the held worker must not count it twice.** An
  event older than the hub's window goes to the held queue and comes back hourly forever (only an
  operator ends it), so the `reason` label on `usage_events_held_total` (`retry_budget`,
  `occurred_at_window`) and the marker singleton key on the held job are what keep it out of the
  `retry_budget` count and the "exhausted the retry budget" error log
  (`packages/chassis-server/src/jobs/pgboss.ts`). Count a held event only once its batch has
  settled: a post that throws re-queues the whole batch, held events included.
- **A viewer learns nothing from any refusal, not just the credit one.** On an anonymous surface
  (a route whose declaration carries an `actor` hook) every refusal of the gate is one code and one
  neutral sentence, `account_suspended` and `hub_unavailable` included, and a plan refusal carries
  no upgrade link; the branch sits BEFORE any reason-specific answer (`gate.ts`). At Slideless the
  first cut covered only `insufficient_credits`. The template has no anonymous door; a tool that
  opens one inherits the branch.
- **A wall in front of a public door is keyed on the caller, never on the resource.** At Slideless
  the first wall on the form doors consumed a point per address AND per share secret, and the
  per-secret half capped a link's whole audience at 90 respondents per ten minutes, on oss too
  (the verifier's round 5). A key on the resource is a ceiling on its legitimate use; the address
  is what bounds one holder. The wall goes in the `api.rateLimits` slot, per address, cloud only
  (`hubSso` in the slot's context is the chassis's cloud-presence switch), and its test spends ONE
  address on a fresh resource, then proves a second address on the same resource still passes.
- **The check is not a lock, except where a lock already exists.** Two creates at the cap that
  arrive together both read the same count and both pass: the gate has no transaction seam, so
  the overshoot is bounded by the concurrency and the next act sees it (CLAUDE.md says so of
  `items.perWorkspace`). Where the service already serializes the act under a lock, the cap
  belongs under it: on the hub the invitation service locks creates per workspace, and a first cut
  that checked the member cap BEFORE the lock let two invitations through on a cap of three (the
  hub's verifier, round 1); the cap is now a `guard` the hub's service runs under the lock, after
  the duplicate checks and before the insert.
- **A hook that stands in for a handler's check reads the same credential the handler reads.** At
  Slideless the claim handler resolved the invitee's grant through the SESSION while the claim's
  count hook used the principal, so a claim presented with the invitee's own key was judged by the
  hook where the handler answers 404. The hook now takes that path only when the principal is a
  session. The template's hook asks `ItemService.mayCreate` with the principal the handler uses.
- **The hub's cap is the smallest among the tools that declare it, and the door names the tool.**
  Two tools may declare `workspace.members` with different values for one organization; the hub
  takes the smallest numeric one (a `null` value bounds nothing) and its upgrade page carries that
  tool (`tool=yourtool-cloud`), so the person lands on the page of the product that limited them.
  `requiredPlan` is resolved by re-running the same resolution on the pro tier: an account
  override wins on every tier, so it may say no plan helps, and the card then offers nothing.
- **A drill assertion sampled after the act cannot fail.** At Slideless the first version of the
  third leg read its usage-events baseline AFTER the three refusals and checked the count had not
  shrunk: a refusal that posted, or a landed create that posted nothing, both passed. The template's
  Phase 8b third leg reads `before_cap` after filling the workspace and before the first refused
  call, asserts equality after the three refusals, and then one event for the create that lands
  (the workspace rule: a loop must be able to show its own failure).
- **A worktree a wave cuts is not installed.** The lane's worktree had no `node_modules` and no
  `dist`, so the first typecheck failed on the CLI's imports of an SDK nobody had built. `pnpm
install --frozen-lockfile` and `pnpm turbo build` are the first two commands in a fresh worktree,
  before any gate is read.

## The hub owns the wire (Slideless PRDCT-2677, 2026-09-23; the guard re-copied here by PRDCT-2862)

- **A copy labelled "mirrored verbatim" is a promise nothing keeps.** The chassis's copy of the
  hub's check answer drifted within a day of the hub's change: the hub added a third refusal
  reason (`unpriceable`), the copy knew two and carried a `.min(0)` the hub never had. The only
  guard was a unit test that read the hub's source text when the two checkouts sat side by side on
  one machine, and skipped everywhere else, CI included. And `HubCreditCheck` parses the answer
  strictly, so an answer it did not know read as a hub OUTAGE: fail open for fifteen minutes, then
  403 `hub_unavailable`, for what the hub meant as a plain refusal. It still does (an unreadable 2xx
  is an outage in `check.ts`), which is why the drift must be caught before it ships.
- **The owner publishes, the follower compares structurally, in CI.** The hub publishes its
  definitions as one generated artefact (`packages/contract/wire/hub-tool-messages.json` of the
  hub: the JSON Schema of the shapes, the constants, the occurrence table, a probe table the
  refinements show in). The chassis rebuilds the same artefact from its own copies with the hub's
  builder copied verbatim (`packages/chassis-contract/src/wire.ts`) and compares STRUCTURALLY
  (`pnpm --filter @antasphere/chassis-contract wire:check`,
  `packages/chassis-contract/scripts/hub-wire-check.mjs`, the `hub-wire` job of
  `.github/workflows/ci.yml` against the hub's `dev`). Never compare source text. The check runs
  one way: the hub changes first, the chassis follows through a re-copy.
- **The fake hub speaks through the chassis's own schema.** `FakeHub`
  (`packages/chassis-server/src/testing/fake-hub.ts`) sends every answer through the schema the
  chassis parses with, so a fake that drifts throws in the test that used it instead of passing a
  shape the real hub would never send.
