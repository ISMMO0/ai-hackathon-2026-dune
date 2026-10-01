# Hackathon Starter

Hackathon Starter is a working tool you build on: a dashboard, a command-line client (`starter`) and an MCP
endpoint an agent connects to, over one API. It comes wired to two services:

- **Gradium**, the voice: it speaks a text as a wav file, and it turns a recording back into text.
- **H**, an agent in a cloud browser: you say what to do on the web in plain words, it does it in a real
  browser you can watch live, and it answers in plain text.

## With your agent: the hackathon plugin

The participant skills live in the hackathon's Claude Code plugin, not in this repository. In Claude Code:

```
/plugin marketplace add antasphere-hackathon/plugin
/plugin install plugin@antasphere-hackathon
```

Then `/plugin:join` sets up your team's app from zero (the `hackathon` CLI, the sign-in, your GitHub
invitation, the clone, the start), `/plugin:check` checks your setup and reads the clock, and `/plugin:demo`
screenshots your running app, builds your demo deck, hosts it on Slideless and sets its link on the
platform. The steps below are the same thing by hand.

## Start in three steps

`./scripts/env.sh` writes the `.env` of step 1 for you (random secrets, the two keys left to fill), and
`./scripts/link-cli.sh` builds the `starter` CLI and puts it on your PATH for step 3.

**1. Put your two keys in `.env`.** Create a Gradium key in the Gradium console (https://gradium.ai) and an
H key at https://platform.hcompany.ai/settings/api-keys, then, at the root of this repository:

```bash
cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
GRADIUM_API_KEY=<your Gradium key>
HAI_API_KEY=<your H key>
ENV
chmod 600 .env
```

A key left out does not stop anything: the routes that need it answer `503` with a sentence naming the key
to set, and the dashboard's Try it page says the same.

**2. Boot it with one command.**

```bash
DEMO_SIGN_IN=true docker compose up -d --build --wait
```

It builds the image, starts the app and its Postgres on http://localhost:3000, and turns on demo links
(sign a teammate in without a password on your own machine: [docs/self-hosting/demo-links.md](docs/self-hosting/demo-links.md)).
On the first boot the dashboard asks for the owner account and the setup token, which the server writes to
its log: `docker compose logs app | grep 'claim the instance'`.

**3. Try it.** Open the dashboard, sign in, and open **Try it** in the menu: the two integrations with their
state, a text to speak, a microphone to transcribe, and an instruction to run in a browser, with its live
view and its answer. The same from the CLI. First create a key on the **API keys** page with the write
box (**items:write**) ticked: the dialog defaults to read only, and `starter speak`, `starter transcribe`
and `starter run` need write. Then, from this folder, build the CLI once and define `starter` (a shell
function, so it works in any shell; the path is captured when you define it):

```bash
pnpm install && pnpm turbo build --filter=@antasphere/starter
STARTER_DIR="$PWD"; starter() { node "$STARTER_DIR/packages/cli/dist/bin.js" "$@"; }
starter login --api-url http://localhost:3000 --api-key <the key you created>
```

and try it:

```bash
starter speak "Bonjour"                                     # writes speech.wav
starter transcribe speech.wav                               # prints the text; without --language, Gradium detects it (any)
starter run "What is the main heading of example.com?" --wait   # every 3 s until done, then the answer
```

An agent connects to `http://localhost:3000/mcp` and finds the same verbs as tools (`starter_voice_speak`,
`starter_voice_transcribe`, `starter_run_start`, `starter_run_get`, `starter_list_runs`):
[docs/getting-started/connect-an-agent.md](docs/getting-started/connect-an-agent.md).

## Make it yours

Give the tool its own name, then add your own resources beside the examples:

```bash
pnpm instantiate <slug> --name "<Name>"
```

The `add-resource` skill (`plugin/skills/add-resource/SKILL.md`) walks a new resource through every layer,
table, API, SDK, CLI, MCP tools and dashboard page, one commit per step, the way `items` was added. The
voice and the runs are two more worked examples: `apps/server/src/integrations/` holds the two clients,
`apps/server/src/api/voice.ts` and `apps/server/src/runs/` their routes and service.

## Running and operating it

This repository is also an Antasphere tool like any other: the chassis every tool shares (the dashboard
shell, members, workspaces, API keys, the audit log, files, the MCP endpoint, sign-in) sits in
`packages/chassis-*` as copies that are never edited here, and the tool half holds the placeholder resource
`items` (a name and a note per workspace), the voice and the runs. Its identity is slug `starter`, display
name `Hackathon Starter`, API key prefix `ytk`.

### What you get

- One Docker image plus a Postgres container (`Dockerfile`, `docker-compose.yml`). All state lives in the
  database and one data volume.
- A versioned HTTP API under `/api/v1`, with an OpenAPI document built from the route contracts.
- A SvelteKit dashboard in English and French: overview, members, invitations, workspaces, API keys, files,
  audit log, account and settings pages.
- Sign-in with sessions, closed sign-up, invitations, optional 2FA per user, and a built-in OAuth 2.1
  authorization server.
- Workspaces, with roles for their members; teams, named groups of members a project can take as a member;
  projects, subgroups with their own members and the items linked to them. A person chooses their default
  workspace. An owner or an admin takes a person out in three acts: deactivate, remove from the workspace,
  delete the member.
- Scoped `ytk_` API keys. Machine credentials reach only the routes a fail-closed allowlist opens.
- An audit log, a workspace export (behind the opt-in `data:export` scope; the workspace's items leave in it
  as `items.json`) and account deletion.
- File storage on a local volume or on S3.
- Demo links on the self-hosted edition: with `DEMO_SIGN_IN` on, an owner mints a link that signs one member
  in without a password, for a demonstration ([docs/self-hosting/demo-links.md](docs/self-hosting/demo-links.md)).
- Background jobs on pg-boss, a Prometheus `/metrics` endpoint, `/healthz` and `/readyz`.
- A bundled MCP endpoint at `/mcp`, with the chassis tools `get_me`, `list_files`, a whoami, the project tools
  and the team reads, and the item tools ([docs/agents/mcp-connector.md](docs/agents/mcp-connector.md)).
- A typed SDK (`packages/sdk`) and a CLI (`packages/cli`, [docs/agents/cli.md](docs/agents/cli.md)).
- The placeholder resource `items`, which goes through every slot a tool fills, and the starter's demo: the
  voice (Gradium) and the runs (H), on the API, the SDK, the CLI, the MCP endpoint and the Try it page.
- Operator scripts: `scripts/backup.sh`, `scripts/restore.sh`, `update.sh`, a multi-replica drill
  (`scripts/scale-drill.sh`) and a federation drill (`scripts/federation-drill.sh`).
- Public docs under `docs/` ([docs/index.md](docs/index.md) is the landing page).

### Quick start, self-hosted

The template publishes no image. Build the image from your checkout.

```bash
git clone <your-copy-of-this-repo> my-tool && cd my-tool
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" > .env && chmod 600 .env
docker compose build
docker compose up -d --wait
docker compose logs app | grep 'claim the instance'   # the setup token the server generated
open http://localhost:3000
```

With only `POSTGRES_PASSWORD` set, the server generates its auth secret and its setup token at first boot. It
writes the token to the container log. `.env.example` lists the other keys, and
[docs/reference/env-reference.md](docs/reference/env-reference.md) documents every one.

1. **Create the owner.** The dashboard shows the first-boot wizard. It asks for the instance name, the owner
   account and the setup token.
2. **Sign in.** Use the owner's email and password on the login page.
3. **Connect the CLI.** Build it with `pnpm install && pnpm turbo build --filter=@antasphere/starter`, then
   run `node packages/cli/dist/bin.js`. Create an API key in the dashboard (API keys page) and save it as a
   profile:

   ```bash
   node packages/cli/dist/bin.js login --api-url http://localhost:3000 --api-key ytk_...
   node packages/cli/dist/bin.js whoami
   ```

   When the instance has an email driver configured, agents and headless machines can skip the dashboard
   with the one-time-code flow (`auth login-request`, then `auth login-complete`; self-hosted edition only,
   see [docs/agents/cli.md](docs/agents/cli.md)).

Migrations apply at boot under an advisory lock, and the data survives in the `pg_data` and `app_data`
volumes across an upgrade. A tool that has published its image can also be installed on a dedicated Hostinger
VPS: [docs/self-hosting/hostinger.md](docs/self-hosting/hostinger.md).

Do not run `./setup.sh`, `./install.sh` or `./update.sh` from the template itself. They name this
repository's own identity: `install.sh` clones `antasphere/starter` into `/opt/starter`, `setup.sh` starts
the stack with `--pull always` and `update.sh` runs `docker compose pull` on `ghcr.io/antasphere/starter`.
The template has no repository and no published image under that name, so the clone and the pulls fail.
`pnpm instantiate` writes the new name into `install.sh` and `update.sh`, and into the `image:` of
`docker-compose.yml`, which `setup.sh` starts (`setup.sh` itself names no identity). The scripts work
from the day that repository exists and its first release has published its image.

### Operating an instance

| Topic                            | Doc                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Install (one-liner, manual)      | [docs/self-hosting/install.md](docs/self-hosting/install.md)                         |
| Install on Hostinger             | [docs/self-hosting/hostinger.md](docs/self-hosting/hostinger.md)                     |
| Every env var                    | [docs/reference/env-reference.md](docs/reference/env-reference.md)                   |
| Reverse proxy and TLS (Caddy)    | [docs/self-hosting/reverse-proxy.md](docs/self-hosting/reverse-proxy.md)             |
| Upgrades and rollback            | [docs/self-hosting/upgrade.md](docs/self-hosting/upgrade.md)                         |
| Backup and restore               | [docs/operations/backup-restore.md](docs/operations/backup-restore.md)               |
| Connect an agent (CLI, MCP)      | [docs/getting-started/connect-an-agent.md](docs/getting-started/connect-an-agent.md) |
| Scaling beyond one box           | [docs/self-hosting/deployment-profiles.md](docs/self-hosting/deployment-profiles.md) |
| Demo links (self-hosted edition) | [docs/self-hosting/demo-links.md](docs/self-hosting/demo-links.md)                   |

### Develop

Node 22 and pnpm 10 (the `packageManager` pin in `package.json`). Docker is needed for the integration suite.

```bash
pnpm install
pnpm chassis:check                           # packages/chassis-* match chassis-source.json
pnpm turbo lint typecheck test build
pnpm format:check                            # `pnpm format` fixes
pnpm --filter @app/server drift:check  # the auth-schema drift guard
pnpm turbo test:integration                  # real Postgres via testcontainers; needs Docker
```

Turbo replays cached results, and its local cache is shared by every checkout on a machine. When a run has to
prove something (the first gate of a new tool, a figure in a report), add `--force` to the two `pnpm turbo`
commands and read the `Cached:` line.

To run the server from source, uncomment the `ports:` mapping of the `db` service in `docker-compose.yml`
(loopback only), then:

```bash
docker compose up -d db
DATABASE_URL=postgres://app:<pw>@localhost:5432/app pnpm --filter @app/server dev
```

For a local mail catcher, run the dev overlay:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`. The Mailpit inbox is on
`http://localhost:8025` unless `MAILPIT_UI_PORT` says otherwise.

### Replace the placeholder

- Read "Adding your domain" in [CLAUDE.md](CLAUDE.md). It names each slot a tool fills and the file where it
  lives.
- Follow the `items` commits, one slot per commit, and replace `items` with your own resource.
- Never edit `packages/chassis-*`. Send what the template lacked back through
  [TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md).

### The two editions

One codebase runs as two editions, chosen by the `EDITION` key. `oss` is the default and the self-hosted
edition. Accounts are local and the instance never contacts the hub. `cloud` is the edition Antasphere runs on
its fleet. Sign-in goes through the Antasphere hub, and the instance needs `HUB_ISSUER_URL`, `HUB_CLIENT_ID`
and `HUB_CLIENT_SECRET`. `HUB_HINT_COOKIE_NAME` and `HUB_HINT_COOKIE_DOMAIN` are optional. An instance that is
already set up refuses to boot under a different edition without `EDITION_CHANGE_ALLOWED=true`. With the key
set, the boot can still refuse the change.
`docker-compose.yml` does not pass the `EDITION` and `HUB_*` keys to the container.
`docker-compose.federation.yml` is the development stack that runs a cloud-edition instance beside a hub.
On the cloud edition every metered action (the prices the tool declares in its `entitlements` slot, shown on
`GET /instance`) is posted to the hub under the organization's account, and a limit or a feature the account's
plan does not allow answers `403 plan_required` with the upgrade link. A self-hosted instance meters nothing:
its limits are the operator's own caps and no usage event leaves it.

### Licence

The template is [fair-code](https://faircode.io), distributed under the [Sustainable Use License](LICENSE).
The source is open to read. You may self-host it, modify it and use it for your own internal business or
personal purposes, free of charge. You may not sell it or offer it to others as a paid or hosted service. It
is source-available, not open source. The licensor is Antasphere. Copyright (c) 2026 Antasphere.

### CI and releases in the template

`ci.yml` runs on every push to `main` and on every pull request. Nothing else runs. No tag push, no branch
push and no manual run can publish, deploy or dispatch anything from the template.

Five workflows are kept as files and switched off the same way. Each one has `on: workflow_dispatch` as its
only trigger. Every job in it carries `if: ${{ false }}`, so a manual run does nothing. The original `on:`
block is preserved in a comment at the top of the file.

| Workflow                  | What it does when enabled                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `release.yml`             | Builds, smokes and scans the image, pushes it to ghcr.io, then dispatches the fleet repository `antasphere/infra` |
| `publish-cli.yml`         | Publishes the CLI package to npm on a `cli-v*.*.*` tag                                                            |
| `docs-notify.yml`         | Dispatches a docs sync to `antasphere/docs` when `docs/` changes                                                  |
| `docs-notify-release.yml` | Dispatches a docs sync to `antasphere/docs` on a release tag                                                      |
| `hostinger-pages.yml`     | Publishes the files under `deploy/` to GitHub Pages                                                               |

To turn one back on, copy the original `on:` block from the comment back over `on: workflow_dispatch`, and
remove the `if: ${{ false }}` line from each job. Do it only after the tool has its own name, its own image
and its own secrets. `release.yml` also needs the repository variable `RELEASE_ENABLED=true` before its
`publish` job runs.

Nothing in `ci.yml` is switched off by hand. Its `hostinger` job rehearses the self-hosted installation on
the image it builds, on every run. It rehearses the PUBLISHED image too, as soon as one exists: the job reads
`deploy/hostinger/docker-compose.yml`. The template's app image there is `:unreleased`, the one reference
allowed without a digest, which says the tool has published nothing. The job then prints a notice and does
not rehearse a published image. The first release replaces `:unreleased` with `<version>@sha256:<digest>`.
From then on `scripts/hostinger-template.test.mjs` refuses anything but a digest pin, and the rehearsal on the
published image runs with no edit to the workflow.

The `federation-drill` job checks out the private repository `antasphere/hub` with a token it mints on
every run from the GitHub App `antasphere-federation-drill` (secrets `FEDERATION_DRILL_APP_ID` and
`FEDERATION_DRILL_APP_KEY`). Without those two secrets the job fails before its checkout. Run the drill
locally with `scripts/federation-drill.sh` and a checkout of the hub.

Dependabot is switched off too. Its version updates are driven by the presence of `.github/dependabot.yml`, and an empty `updates: []` there did not stop them, so the file is kept as `.github/dependabot.yml.disabled`. A tool turns Dependabot on by renaming it back.
Replace `updates: []` with that block to turn the updates back on.
