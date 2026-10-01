# Contributing

The tool template is developed by Antasphere, and outside contributions
are welcome. It is fair-code under the [Sustainable Use License](LICENSE),
source-available and not open source: read the license before you contribute.

- **Branches.** `main` is the only branch. Branch from `main` and open your pull
  request against `main`.
- **Security problems never go in an issue or a pull request.** Follow
  [SECURITY.md](SECURITY.md).
- **Bigger changes start with an issue**, so the design is agreed before the
  code is written.

`packages/chassis-*` are copies and are never edited here (CLAUDE.md, "The
chassis packages are copies"). What a tool built from the template sends back
goes in [TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md).

## Prerequisites

- **Node 22** (`engines` in package.json; the image is `node:22-alpine`)
- **pnpm 10** (`packageManager` pin — corepack picks it up)
- **Docker** — the integration suite runs Postgres via testcontainers

## Setup

```bash
pnpm install
pnpm turbo build
```

## Task rail

```bash
pnpm chassis:check                     # CI's checks job, first: packages/chassis-* match chassis-source.json
pnpm shell:check                       # then the dashboard shell against shell-source.json (CI also runs its test)
pnpm turbo lint typecheck test build   # then this — run before every push
pnpm turbo test:integration            # real Postgres via testcontainers; needs Docker (CI's integration job)
pnpm format                            # prettier --write (CI runs format:check, then the drift check below and the compose config check)
```

## Better Auth schema drift guard

CI runs `pnpm --filter @app/server drift:check`, which regenerates the
auth schema with the pinned `@better-auth/cli` and diffs it against the
committed snapshot. Any Better Auth config change that alters the schema
(new plugin, changed table shape) therefore requires, in the same PR:

1. Update `apps/server/scripts/auth-schema-config.ts`.
2. Regenerate with the pinned CLI and update **both**
   `packages/chassis-db/src/auth-schema.ts` and
   `apps/server/scripts/auth-schema.snapshot.ts` (the CLI silently writes
   nothing when the output file exists — give it a fresh path).
3. Add the corresponding **additive** drizzle migration in
   `packages/db/drizzle`.

`packages/chassis-db` is a copy, so step 2 is made at the chassis source and
the folders are copied again.

See LESSONS.md for the sharp edges (CLI version line, prettier
normalization of the diff).

## Version pins

The `better-auth` / `@better-auth/oauth-provider` / `@better-auth/cli` trio
is exact-pinned.
**Never bump one of them in isolation** — the oauth-provider peer conflict
breaks installs and the drift guard fails CI. Bump all three together with
the drift and integration suites green, or not at all. Dependabot is
configured to ignore the trio for this reason.

## Pull requests

- Tests for every behavior change — no untested behavior lands.
- Docs updated in the same PR (`docs/`, and regenerate
  `docs/reference/env-reference.md` via `pnpm --filter @app/server docs:env`
  when env vars change).
- prettier and eslint clean (`pnpm format`, `pnpm turbo lint`).
- Call out breaking changes and migration impact explicitly in the PR
  description.
