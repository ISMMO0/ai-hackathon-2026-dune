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

The template's full manual (chassis, slots, invariants, gates) is in CLAUDE.md, below this same briefing.
