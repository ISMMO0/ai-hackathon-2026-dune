---
name: federate-to-hub
description: Connect a tool made from this template to the Antasphere hub, the OIDC identity provider at account.antasphere.com. Use it when a new cloud tool needs "Sign in with Antasphere", when someone asks how to write the tool's entry in the hub TOOL_REGISTRY, how to set EDITION=cloud and the HUB_* variables, how to run the local federation drill, or when a person on a cloud instance sees hub_grant_expired, hub_unavailable, membership_revoked, account_suspended, hub_reauth_required or invalid_scope and you must say what heals it.
---

# Federate a tool to the Antasphere hub

This skill connects one tool to the hub. The hub has no code per tool. A tool exists for the hub
as one JSON entry in a runtime secret. The tool side is four environment variables. Slideless is
the first tool made this way, and every step below is what was done for it.

Examples use an invented tool: slug `examplenotes`, display name `Example Notes`, domain `examplenotes.example.com`,
client id `tool-examplenotes-cloud`, registry slug `examplenotes-cloud`. In the template files, `<tool>` stands
for the tool's slug wherever a value carries it.

Three repositories are named below:

- **tool repo**: the repository made from this template (`antasphere/<tool>`).
- **hub repo**: `antasphere/hub`, in the workspace at `labs/products/antasphere/hub`.
- **infra repo**: `antasphere/infra`, in the workspace at `labs/products/antasphere/infra`.

## Before you start

- [ ] The slug, the display name and the FINAL domain are fixed. The client id, the redirect URI,
      the resource URL and every grant derive from the domain. Changing it later kills them.
- [ ] The tool has its own name already: `pnpm instantiate` ran (skill `instantiate`). From then
      on the harness files of Part 3 say `examplenotes` wherever the template said its own slug.
- [ ] A local checkout of the hub repo exists (the drill builds the hub from it).
- [ ] `docker`, `jq`, `curl` and `openssl` are installed (the drill refuses to run without them).
- [ ] The cloud instance starts from a fresh database. Setup stamps the edition, and a boot whose
      `EDITION` differs from the stamp refuses to start.
- [ ] For production: the tool's instance exists in the infra repo (`envs/<tool>/main.tf`), and
      its domain serves. The sister skill `deploy-on-fleet` creates that directory and the
      instance; this skill fits after its DNS step and before its setup wizard. Someone who owns GCP project `antasphere-hub` and someone who owns GCP
      project `antasphere-<tool>` are available, ideally one person for both (steps 13 and 14
      share one shell), and a GCP org member for the `tofu apply` of step 12. Steps 12 to 15 are
      theirs.

## Order constraints

Read these first. Each one was a real failure mode.

1. **The domain is final before the entry is minted.** Grants and redirect URIs die with it.
2. **THE HUB DEPLOYS FIRST for any new scope.** The hub's authorize endpoint answers
   `invalid_scope` for a scope it does not list for the client. That fails the WHOLE sign-in,
   for every user of the tool. Add a scope to the tool only after the hub release that lists it
   is live.
3. **A malformed registry is a boot error of the hub.** The identity provider refuses to start
   on invalid JSON or a schema violation. Validate the JSON before you add the secret version.
4. **The new secret version replaces the whole array.** Keep every existing entry. Losing
   another tool's entry breaks that tool's SSO.
5. **Hub entry first, tool secret second.** The hub registry entry must exist before the tool's
   first SSO login.
6. **Image first, env second.** An env value the image does not know yet crashloops the
   revision. Roll the image, then the env.

## Part 1. The tool's cloud environment

1. Read the env schema in the tool repo: `packages/chassis-server/src/env.ts`. On
   `EDITION=cloud` the boot requires exactly three hub variables (`HUB_REQUIRED_VARS`):
   `HUB_ISSUER_URL`, `HUB_CLIENT_ID`, `HUB_CLIENT_SECRET`. The other rows of the table are
   optional. A cloud
   boot missing any of them refuses to start and prints one table naming every missing variable.

   | Variable                 | Constraint in the schema                                    | Value                                                                       |
   | ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
   | `EDITION`                | `oss` (default) or `cloud`; any other value refuses to boot | `cloud`                                                                     |
   | `HUB_ISSUER_URL`         | an `http` or `https` URL                                    | `https://account.antasphere.com` in production                              |
   | `HUB_CLIENT_ID`          | string, min 4 chars                                         | the registry entry's `clientId`, here `tool-examplenotes-cloud`             |
   | `HUB_CLIENT_SECRET`      | string, min 16 chars                                        | the same string as the registry entry's `clientSecret`                      |
   | `HUB_HINT_COOKIE_NAME`   | optional                                                    | default `ant_sso_hint`; leave unset                                         |
   | `HUB_HINT_COOKIE_DOMAIN` | optional                                                    | default: the issuer host minus its first label; leave unset                 |
   | `EDITION_CHANGE_ALLOWED` | optional boolean                                            | one-boot acknowledgement of an edition flip; not needed on a fresh database |

   The commented block at the end of `.env.example` (tool repo) lists the same variables.

2. Do not look for a resource URL variable. The tool's own OAuth resource identifier is derived:
   `<PUBLIC_BASE_URL>/mcp`. So `PUBLIC_BASE_URL` must be the final domain, because the registry
   entry's `resourceUrl` must equal it plus `/mcp`.

3. Do not add a service key. There is none. Every hub read between logins is `GET <hub>/orgs` as
   the user, with that user's own stored grant. An older ADR (017) still lists `HUB_SERVICE_KEY`;
   ADR 019 retired it. The infra repo's `README.md` also still lists a secret
   `slideless-hub-service-key` in its secrets table: it is retired too, never mint one.

4. Know the scopes the tool requests. They are stated once, in the tool repo:
   `packages/chassis-server/src/identity/hub-sso.ts`, constant `HUB_SSO_SCOPES`:
   `openid profile email offline_access account:read orgs:create`. The hub allows every registry
   client one fixed list, in the hub repo: `apps/server/src/platform/tool-registry.ts`, constant
   `TOOL_CLIENT_SCOPES`, which adds `account:write` to the same list. Every scope in the first list must be in the second. If the tool needs a scope
   the hub does not list, stop: change the hub, release the hub, wait until it is live, and only
   then add the scope to `HUB_SSO_SCOPES`. `account:write` is never requested by the tool.

5. Know what cloud closes. On `EDITION=cloud` the login page renders only "Sign in with
   Antasphere". Password reset, OTP sign-in, the tool's own CLI OTP mint and Google social are
   closed. `/sign-in/email` stays wired as the break-glass operator door. Membership changes on
   a hub-origin workspace answer 403 `hub_managed` with a link to the hub. The tool repo's
   `CLAUDE.md` holds these invariants. Do not loosen them to make a login work.

## Part 2. The registry entry

6. Write the entry. The type is `toolEntrySchema` in the hub repo,
   `apps/server/src/platform/tool-registry.ts`. The hub repo's `.env.example` carries a
   commented example.

   | Field                    | Required   | Rule                                                                                                      | Example                                                                       |
   | ------------------------ | ---------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
   | `slug`                   | yes        | `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`. Stable machine identity. Drives the default client id `tool-<slug>`. | `examplenotes-cloud`                                                          |
   | `name`                   | yes        | 1 to 120 chars. Shown on the hub login and signup branding, the connections list and the tool catalog.    | `Example Notes`                                                               |
   | `resourceUrl`            | yes        | A URL. The tool's RFC 8707 resource identifier, its `/mcp` URL. Joins the hub's valid audiences.          | `https://examplenotes.example.com/mcp`                                        |
   | `redirectUris`           | yes, min 1 | URLs. For a tool from this template: the Better Auth genericOAuth callback, provider id `antasphere`.     | `["https://examplenotes.example.com/api/v1/auth/oauth2/callback/antasphere"]` |
   | `launchUrl`              | no         | Where hub buttons ("Continue to Example Notes") send the browser. Default: the origin of `resourceUrl`.   | `https://examplenotes.example.com`                                            |
   | `postLogoutRedirectUris` | no         | Logout landings. The hub redirects only to an EXACT string match.                                         | `["https://examplenotes.example.com/login?signed_out=1"]`                     |
   | `clientId`               | no         | 4 to 128 chars. Default `tool-<slug>`.                                                                    | `tool-examplenotes-cloud`                                                     |
   | `clientSecret`           | no         | 16 to 256 chars. Present: confidential client. Absent: public PKCE client. PKCE is required either way.   | generated in step 7                                                           |

   `slug`, the client id and `resourceUrl` must each be unique across the whole array. Set
   `clientSecret`: the tool's env schema requires `HUB_CLIENT_SECRET` on cloud, so the client is
   confidential.

   The complete entry, without the secret value:

   ```json
   {
     "slug": "examplenotes-cloud",
     "name": "Example Notes",
     "resourceUrl": "https://examplenotes.example.com/mcp",
     "redirectUris": ["https://examplenotes.example.com/api/v1/auth/oauth2/callback/antasphere"],
     "launchUrl": "https://examplenotes.example.com",
     "postLogoutRedirectUris": ["https://examplenotes.example.com/login?signed_out=1"],
     "clientId": "tool-examplenotes-cloud",
     "clientSecret": "<generated>"
   }
   ```

7. The client secret is generated by the HUMAN who does step 13, in that human's own shell,
   inside step 13's first block. An agent never generates it, never reads it and never asks
   for it: a value an agent prints stays in its transcript. It lives in one shell variable,
   is never echoed, and goes to exactly two places: the registry entry (step 13) and the
   tool's secret (step 14). Steps 13 and 14 are written as ONE shell session for one person
   who can write to both GCP projects. When two people hold the two projects, how the value
   passes from one to the other is not recorded in the sources: they decide it between them,
   and it is never a chat message, a ticket or a file in a repository.

   What the hub does with the entry at every boot, with no action from you: it upserts one OAuth
   client with `skipConsent: true`, `enableEndSession: true`, `requirePKCE: true`, grant types
   `authorization_code` and `refresh_token`, and `scopes = TOOL_CLIENT_SCOPES`. It stores the
   secret as a base64url SHA-256 hash. Scopes are one constant for all tools, not per entry.
   Removing an entry stops issuance but leaves the client row inert; deleting the row is manual.

## Part 3. The local drill, before production

The tool repo ships a two-instance harness: a local hub and a local cloud instance of the tool.

8. Check the three harness files in the tool repo agree with each other. After
   `pnpm instantiate` they carry the tool's slug (`examplenotes.localhost`, `tool-examplenotes-cloud`, compose
   project `examplenotes-federation`). "Agree" means the same client id, secret, host name and port in
   all three, whatever the slug is.
   - `docker-compose.federation.yml`: the hub service's `TOOL_REGISTRY` line and the app
     service's `EDITION=cloud`, `HUB_ISSUER_URL`, `HUB_CLIENT_ID`, `HUB_CLIENT_SECRET`. The
     client id and secret are dev-only literals and must be the same pair on both services. The
     entry's `resourceUrl` and `redirectUris` use the app's `<tool>.ant.localhost` name and port
     (both apps live under the one parent domain `ant.localhost`, with `SSO_HINT_COOKIE_DOMAIN` on
     the hub and `HUB_HINT_COOKIE_DOMAIN` on the tool, so a browser keeps the hub's hint cookie).
   - `docker-compose.federation.drill.yml`: repeats the `TOOL_REGISTRY` line and adds a second
     tool, `tool-drill-second`. Compose replaces the variable, so keep the first entry identical
     to the base file.
   - `scripts/federation-drill.sh`: `SL_CLIENT_ID`, `SL_CLIENT_SECRET`, `SL`, `SL_RESOURCE` at the
     top must match the compose values.
   - `docker-compose.federation.seamless.yml` is optional. Its registry entry adds `launchUrl`
     and `postLogoutRedirectUris` to the base's. Use it to try silent connect and logout in a
     browser. The drill does not use it.

9. Run the drill from the tool repo root:

   ```bash
   FEDERATION_HUB_DIR=/path/to/hub ./scripts/federation-drill.sh
   ```

   `FEDERATION_HUB_DIR` defaults to `../../../hub`, which is right only when the tool repo sits
   at `labs/products/antasphere/tools/<tool>/<tool>` in the workspace. Anywhere else, give the
   path. `DRILL_SKIP_BUILD=1` reuses existing images.
   `DRILL_KEEP=1` leaves the stack up after a pass. The drill needs host ports 3300 (hub), 3310
   (tool) and 8474 (delay hop) free, and refuses to run if one answers. Each is a variable
   (`FEDERATION_HUB_PORT`, `FEDERATION_SL_PORT`, `FEDERATION_HOP_PORT`); the script header lists
   all of them. The stack and its volumes are removed on exit, pass or fail.

10. To look by hand instead, bring the harness up without the drill:

    ```bash
    docker compose -f docker-compose.federation.yml up -d --build
    curl -fsS http://localhost:3300/healthz   # hub
    curl -fsS http://localhost:3310/healthz   # the tool (EDITION=cloud)
    docker compose -f docker-compose.federation.yml logs hub   # look for "tool registry: client seeded"
    docker compose -f docker-compose.federation.yml down -v
    ```

    Run each setup wizard once: the hub at `http://hub.ant.localhost:3300`, the tool at
    `http://<tool>.ant.localhost:3310` (both apps under the one parent domain the hub's hint
    cookie needs; a session on plain `hub.localhost` signs out within a second, PRDCT-2825).
    Mailpit is at `http://localhost:8030`. The tool's wizard asks
    for a setup token. This compose file sets none, and an unset `SETUP_TOKEN` is generated at
    boot and printed in the container's log (`packages/chassis-server/src/env.ts` says so):
    read it with `docker compose -f docker-compose.federation.yml logs app`.

11. CI runs the same drill. The tool repo's `.github/workflows/ci.yml`, job `federation-drill`,
    checks out `antasphere/hub@dev` with a token it mints on every run from the GitHub App
    `antasphere-federation-drill` (contents: read on the hub, installed on `hub` only). An org
    owner sets the app's id and one of its private keys on the tool's repository before the first
    CI run: `gh secret set FEDERATION_DRILL_APP_ID -R antasphere/<tool>` (it prompts for the
    value) and `gh secret set FEDERATION_DRILL_APP_KEY -R antasphere/<tool> < <the .pem file>`
    (the whole file, BEGIN and END lines included). Until then the job is red where it mints the
    token, and that says nothing about the code.

## Part 4. Production

Steps 12 to 15 are done by hand. No workflow does them.

12. **Tool env (infra repo, `envs/<tool>/main.tf`).** Who: the agent writes the lines, a GCP org
    member applies them. In the `env = {}` block:
    `HUB_ISSUER_URL = "https://account.antasphere.com"` and `HUB_CLIENT_ID = "tool-examplenotes-cloud"`.
    In the `glue_secrets = {}` block, an entry `HUB_CLIENT_SECRET` with
    `name = "<tool>-hub-client-secret"` and a `placeholder` of 16 characters or more. The
    placeholder must pass the boot-time env schema (min 16),
    or the first revision crashloops. You do not set `EDITION` or `PUBLIC_BASE_URL`: the
    instance module sets `EDITION = "cloud"` and `PUBLIC_BASE_URL` from `domain` for every
    instance (`modules/instance/main.tf`, local `base_env`). On a tool's FIRST apply these
    lines are part of `deploy-on-fleet`'s three-move apply and nothing more is needed. On an
    instance that is already live, mind the order: the image that knows the variables rolls
    first; then a GCP org member applies the new secret container by hand with a targeted
    `tofu apply` (`deploy.yml` refuses any plan that is not one in-place service update); then
    the env change rides a normal apply. A glue secret is TWO resources of the instance module
    (`modules/instance/main.tf`), the container and its placeholder version, and the targeted
    apply names both, or the secret exists with no version:

    ```bash
    tofu apply \
      -target='module.instance.google_secret_manager_secret.glue["HUB_CLIENT_SECRET"]' \
      -target='module.instance.google_secret_manager_secret_version.glue_placeholder["HUB_CLIENT_SECRET"]'
    ```

    The agent's lines reach that person as a commit on a branch of the infra repo; who may
    commit to its `main` is not recorded in the sources.

13. **Hub registry (GCP Secret Manager, secret `hub-tool-registry`, project `antasphere-hub`,
    mounted as env `TOOL_REGISTRY`).** Who: an owner of project `antasphere-hub`, by hand, in
    ONE shell session that also serves step 14, one block at a time. Do NOT paste the blocks
    as one: each ends on a check to read before the next. An agent prepares the values of the
    entry (everything but the secret) and stays out of this shell.

    Block 1. Read the current version into a private temporary directory, outside every
    repository, never to the terminal. Keep an untouched copy. Generate the secret into a
    variable, never echoed.

    ```bash
    D=$(mktemp -d)
    gcloud secrets versions access latest --secret=hub-tool-registry --project=antasphere-hub > "$D/before.json"
    jq -e 'type == "array"' "$D/before.json" && jq 'length' "$D/before.json"   # true, then today's count
    SECRET=$(openssl rand -base64 24)   # not exported: no other program of this shell sees it
    ```

    Block 2. APPEND the entry with `jq`, which reads the secret from the environment, so the
    value is on no command line and in no editor (the `SECRET="$SECRET"` prefix hands it to this
    one `jq` and to nothing else). Write the tool's own values in place of the
    example's.

    ```bash
    SECRET="$SECRET" jq '. + [{
      slug: "examplenotes-cloud",
      name: "Example Notes",
      resourceUrl: "https://examplenotes.example.com/mcp",
      redirectUris: ["https://examplenotes.example.com/api/v1/auth/oauth2/callback/antasphere"],
      launchUrl: "https://examplenotes.example.com",
      postLogoutRedirectUris: ["https://examplenotes.example.com/login?signed_out=1"],
      clientId: "tool-examplenotes-cloud",
      clientSecret: $ENV.SECRET
    }]' "$D/before.json" > "$D/registry.json"
    ```

    Block 3. Validate. Each line must end on `OK`. The first proves every existing entry is
    byte for byte what it was (order constraint 4). The second is the hub's own rule: it keeps
    ONE set for `slug`, client id and `resourceUrl` together
    (`apps/server/src/platform/tool-registry.ts`), so a slug equal to another entry's client id
    is refused too. The third checks the new entry's secret length and slug pattern.

    ```bash
    jq -e --slurpfile b "$D/before.json" '.[:-1] == $b[0] and length == ($b[0] | length) + 1' "$D/registry.json" && echo OK
    jq -e '[.[] | .slug, (.clientId // ("tool-" + .slug)), .resourceUrl] | length == (unique | length)' "$D/registry.json" && echo OK
    jq -e '.[-1] | (.clientSecret | length >= 16) and (.slug | test("^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$"))' "$D/registry.json" && echo OK
    ```

    Block 4. ONLY after three `OK`: add the version and roll the hub. A new secret version
    restarts nothing. The roll is the form the infra repo's `README.md` records (it says
    `terraform apply` for the step after; the fleet uses `tofu`). `<N>` is a value the label
    `glue-rev` does not hold yet: the second line prints the labels the service has now.

    ```bash
    gcloud secrets versions add hub-tool-registry --project antasphere-hub --data-file="$D/registry.json"
    gcloud run services describe hub --region=europe-west1 --project=antasphere-hub --format='yaml(metadata.labels)'
    gcloud run services update hub --region=europe-west1 --project=antasphere-hub --update-labels=glue-rev=<N>
    ```

    Block 5. Look for `tool registry: client seeded` with the new `clientId` in the hub's logs
    (the Logs tab of the service in the Cloud Run console), and check that
    `https://account.antasphere.com/readyz` answers 200. Keep `$D` until you have seen both.
    - Seen: run `tofu apply` in `envs/hub` of the infra repo to remove the label drift, and go
      to step 14 in the SAME shell.
    - Not seen, or the hub does not come up: the new version is wrong. Put the untouched copy
      back as a NEW version, which is why block 1 kept it, then roll the hub with the next
      `<N>` and confirm the hub answers before anything else. Do not rely on disabling the bad
      version: the service mounts `latest`, and what `latest` resolves to after a disable is
      not recorded in the sources. The hub's boot error names the place, never the value:
      invalid JSON with a character position, or an invalid field with its path.

      ```bash
      gcloud secrets versions add hub-tool-registry --project antasphere-hub --data-file="$D/before.json"
      gcloud run services update hub --region=europe-west1 --project=antasphere-hub --update-labels=glue-rev=<next N>
      ```

    The hub also reads `TOOL_REGISTRY_FILE`, which wins over `TOOL_REGISTRY` when set. Production
    uses the secret above; do not set both. Never paste the array into a chat, a ticket or a
    commit: it holds every tool's client secret.

14. **Tool secret (GCP Secret Manager, secret `<tool>-hub-client-secret`, project
    `antasphere-<tool>`).** Who: an owner of project `antasphere-<tool>`, in the same shell as
    step 13, where `SECRET` still holds the value. The value goes through stdin and touches no
    file. Then roll the tool with a `glue-rev` value its label does not hold yet, clean up, and
    run `tofu apply` in `envs/<tool>` to remove the drift.

    ```bash
    printf %s "$SECRET" | gcloud secrets versions add <tool>-hub-client-secret \
      --project antasphere-<tool> --data-file=-
    gcloud run services describe <tool> --region=europe-west1 --project=antasphere-<tool> --format='yaml(metadata.labels)'
    gcloud run services update <tool> --region=europe-west1 --project=antasphere-<tool> \
      --update-labels=glue-rev=<N>
    unset SECRET
    rm -rf "$D"
    ```

15. **Setup wizard.** Who: the operator. Run the tool's setup wizard ONCE at
    `https://examplenotes.example.com`, only when the final domain serves. The setup token is in secret
    `<tool>-setup-token` of project `antasphere-<tool>`; the operator, never the agent (the value
    would stay in its transcript), reads it with the command below and pastes it nowhere but the
    wizard.

    ```bash
    gcloud secrets versions access latest --secret=<tool>-setup-token --project=antasphere-<tool>
    ```

    Setup mints the operator with a verified email; the operator then
    enters through hub SSO, which links onto that verified address.

## Verdicts, and what heals each

| What the person sees                                                                 | Meaning                                                                                                                                                         | What heals it                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_scope` (from the hub's authorize endpoint; every sign-in of the tool fails) | The tool requests a scope the hub does not list for its client.                                                                                                 | Deploy the hub release that lists the scope. Until then, remove the scope from `HUB_SSO_SCOPES`. The order rule prevents it: the hub deploys first.                   |
| 401 `hub_grant_expired`                                                              | The user's stored hub grant is dead (`invalid_grant` at the hub, or a probe answered `active:false`). Immediate, no stale window.                               | One browser "Sign in with Antasphere". Every SSO login rewrites the stored tokens. A CLI heals by `antasphere login` and a new connect. Nothing else revives a grant. |
| 403 `hub_unavailable`                                                                | No definitive reconcile pass for about 15 minutes and the hub keeps failing. Also the first request per user on a replica restarted during a hub outage.        | Restore the hub. Recovery is automatic and nothing is corrupted. Local (non-projected) workspaces keep working meanwhile.                                             |
| 401 `membership_revoked`                                                             | The hub no longer lists the user in that organization; the reconcile swept the local row.                                                                       | Correct by design. To restore access, add the person back to the organization at the hub. The next reconcile reactivates the row.                                     |
| 403 `account_suspended`                                                              | The workspace's `hub_status` is `suspended`. `GET /me` still answers (visible but blocked).                                                                     | Lift the suspension at the hub. It lands within the reconcile TTL (about 10 s per replica).                                                                           |
| 401 `hub_reauth_required`                                                            | The hub answered 403 `insufficient_scope` on workspace creation: the grant lacks `orgs:create` (minted before the scope shipped, or replaced by a CLI connect). | One browser sign-in.                                                                                                                                                  |
| `/login?error=sso_projection_failed`                                                 | The login's fail-closed reconcile did not definitively succeed; the session was revoked.                                                                        | Sign in again once the hub answers. The sources record no other remedy.                                                                                               |
| 403 `hub_managed`                                                                    | A local membership change on a hub-origin workspace.                                                                                                            | Not an error. Manage members at the hub; `details.manageUrl` is the link.                                                                                             |

`invalid_client` at the hub token endpoint means the tool's `HUB_CLIENT_ID` or
`HUB_CLIENT_SECRET` does not match the registry entry. It is a loud transient and never kills a
grant. Fix the pair (steps 13 and 14 must hold the same string).

## Proof

Federation works when all of these are observed.

1. **The drill passes.** In the lines below `<Tool>` is the display name as the script spells
   it after `pnpm instantiate`. The last line is `✔ federation drill passed — <n> assertions`. Among the
   `PASS` lines:
   - `hub, <Tool> (cloud) and the delay hop are up`
   - `hub setup (owner ...), <Tool> cloud setup (no workspace), two registry clients seeded`
   - `SSO login through the proxy hop: <Tool> session + encrypted grant; hub family = 1 live row`
   - `deploy order: a sign-in requesting a scope the hub does not list for the client is refused whole (invalid_scope)`
   - `the login's hub grant carries orgs:create`
   - `/auth/get-access-token and /auth/refresh-token answer 403 provider_grant_forbidden with no token material`
   - `the next demand PROBED: <Tool> answers 401 hub_grant_expired, its grant is dead, and the hub family is intact ...`
2. **The hub seeded the client.** The production hub logs show `tool registry: client seeded`
   with `clientId` `tool-examplenotes-cloud` after the roll. The other tools' lines are still there.
3. **SSO works end to end on the final domain.** Open `https://examplenotes.example.com/login`. It shows
   only "Sign in with Antasphere". Sign in at the hub. No consent screen appears (registry
   clients skip it). The browser returns through
   `/api/v1/auth/oauth2/callback/antasphere` to the tool with a session. `GET /api/v1/me` lists
   the user's hub organizations as workspaces with `hubOrigin: true`.
4. **Discovery agrees.** `GET https://examplenotes.example.com/api/v1/instance` lists `antasphere` in
   `auth.methods`, and no `password`, `email-otp` or `google`.
5. **Logout lands.** Signing out ends at `https://examplenotes.example.com/login?signed_out=1`. If the hub
   refuses the redirect, the `postLogoutRedirectUris` string is not an exact match.
