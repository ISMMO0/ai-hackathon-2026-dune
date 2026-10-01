# The walk

The walk plays every screen, every CLI command and every MCP tool of the self-hosted edition once, against a
stack that is already running. It is a record as much as a test: each step writes one line in a ledger and, when it has a page, one
screenshot, so a person can read what the tool looks like and what it answered without running it.

It runs in no CI job. Run it by hand on a stack you booted, before a release or after a change to the shell, the
CLI or the MCP tools.

## Boot a stack

Build the image from the checkout and boot it with the dev overlay, which adds Mailpit (the walk reads its mails
there). Demo sign-in must be on, and the files chapter expects a 1 MB cap:

```bash
docker build -t starter:walk .
cat > .env <<'EOF'
POSTGRES_PASSWORD=<a password of your own>
SETUP_TOKEN=<a token of your own>
DEMO_SIGN_IN=true
MAX_FILE_SIZE_MB=1
EOF
APP_IMAGE=starter:walk APP_PORT=3000 PUBLIC_BASE_URL=http://localhost:3000 MAILPIT_UI_PORT=8025 \
  docker compose -p walk -f docker-compose.yml -f docker-compose.dev.yml up -d --wait
pnpm --filter @antasphere/starter... build    # the CLI chapter runs packages/cli/dist/bin.js
```

The instance may be unclaimed (the owner chapter claims it through the setup page with `WALK_SETUP_TOKEN`) or
already claimed by `owner@example.com` with the password `owner-password-123`.

## Run it

From `apps/dashboard`:

```bash
WALK_BASE_URL=http://localhost:3000 WALK_MAILPIT=http://localhost:8025 WALK_SETUP_TOKEN=<the token> \
WALK_COMPOSE_PROJECT=walk pnpm exec playwright test --config e2e/walk/playwright.config.ts
```

One project runs one chapter. `--project cli` runs the CLI chapter and, first, the owner chapter it depends on;
add `--no-deps` to run a chapter alone on the data an earlier run left in the out folder.

The environment:

- `WALK_BASE_URL`: the instance (default `http://localhost:3000`).
- `WALK_MAILPIT`: the Mailpit of that stack (default `http://localhost:8025`).
- `WALK_SETUP_TOKEN`: the setup token, needed only when the instance is unclaimed.
- `WALK_COMPOSE_PROJECT`: the compose project of the stack, required. The owner chapter seats a guest
  through that project's database, since the self-hosted edition has no door that makes one; there is no
  default, so the walk never writes into a stack it was not told about.
- `WALK_OUT`: where the ledger, the screenshots and what a chapter keeps for the next land (default
  `apps/dashboard/.tmp/walk`).
- `WALK_CLI`: the CLI bundle (default `packages/cli/dist/bin.js`).
- `WALK_OWNER_API_KEY`: a key of the owner carrying `data:export`. With it the CLI chapter downloads the
  workspace export; without it the chapter records only the refusal of the walk's own key.
- `WALK_INSTANCE_NAME`: the name given at setup (default `Walk Instance`).

## The four chapters

1. `01-owner.spec.ts`, the owner: the instance claimed, the account, the People pages, a team, a project with a
   person and a team on it, items, files, API keys, the audit log, the settings, demo links, a second workspace
   and the default, a member paused, removed, reactivated and deleted, a guest seated. It keeps `cli.json` for
   the next chapters: the key it minted (read and write), the workspace, the project, the team and Mia's id.
2. `02-member-guest.spec.ts`, the member and the guest: what each of them sees and what each is refused.
3. `03-cli.spec.ts`, the CLI: every command once with the kept key, in a config home of the walk's own (never
   the machine's), the demo commands as the owner, the email OTP sign-in with the code read from Mailpit.
4. `04-mcp.spec.ts`, the MCP endpoint: the handshake, the tool list checked against the table of
   `docs/agents/mcp-connector.md`, and every one of the 23 tools called once with the kept key.

## What it leaves

In the out folder:

- `results.json`, the ledger: one line per step with its chapter, its title, `ok` or `fail`, the screenshot's
  name and a note. Every run appends to it; delete it to start a fresh ledger.
- One PNG per step that has a page, the whole page, numbered in the ledger's order; a step played in a clean
  browser or on the API alone carries `shot: null`. The CLI and MCP chapters draw their commands and answers as
  a terminal and shoot that. No key, password or demo secret is ever drawn: each is replaced by an ellipsis.
- `cli.json` (mode 600, it holds a key), `cli-commands.json` (every command the CLI chapter ran and its exit
  code), `mcp-calls.json` (every tool call and whether it answered an error), the CLI chapter's config home
  (`xdg/`, cleared at the end), its files, downloads and export.

On the instance, the walk leaves what a person would after the same visit: the owner's workspaces, Mia a member
seated on the team and on the project, a guest, the items and the projects it made. Projects are never deleted,
so each run of the CLI and MCP chapters leaves one project of its own; the items, the team, the files and the
demo passes those chapters make are deleted or revoked before they end, and the key the OTP sign-in mints is
revoked too.
