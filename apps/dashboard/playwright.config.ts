import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// The first-boot claim requires a setup token (PRDCT-1347). One value is
// minted here, in the runner process, so the compose stack (webServer
// inherits this env) and the smoke spec (workers inherit it too) agree.
process.env.PW_SMOKE_SETUP_TOKEN ??= randomBytes(16).toString('hex');

// Keep in lockstep with e2e/stack-env.mjs (this config cannot import the
// .mjs): the port is overridable so the suite can run beside another
// instance of the product already holding 3100.
const APP_PORT = process.env.PW_SMOKE_PORT ?? '3100';

/**
 * Smoke suite against the REAL stack: the docker compose file at the repo
 * root, built fresh, on an isolated compose project (pw-smoke) with its own
 * volumes and a random Postgres password. start-stack.mjs owns the lifecycle;
 * global-teardown.mjs runs `compose down -v` so every run starts from an
 * empty database (the /setup wizard is part of the spec).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './e2e/global-teardown.mjs',
  // Explicit ordering: smoke sets up the fresh instance (setup wizard) and
  // creates the owner; the workspaces suite signs in as that owner.
  projects: [
    { name: 'smoke', testMatch: /smoke\.spec\.ts/ },
    // The tool's page: an item added, seen on the overview, edited, deleted.
    // It leaves the owner's workspace as it found it, with no item.
    { name: 'items', testMatch: /items\.spec\.ts/, dependencies: ['smoke'] },
    // The starter's Try it page with its two integrations NOT configured: the
    // chips name the keys to set, the buttons answer the 503 sentence. It
    // writes nothing (every POST is refused), so it may run anywhere after smoke.
    { name: 'try', testMatch: /try\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2444 / PRDCT-2443 / PRDCT-2426: a workspace created from the sidebar,
    // and every dashboard download from that NON-default workspace. Declared
    // LAST on purpose: the projects run in declaration order (one worker), and
    // this one leaves the owner with a second workspace, which no other project
    // has to know about. It depends on `smoke` alone: depending on every project
    // makes Playwright schedule them in reverse.
    { name: 'workspaces', testMatch: /workspaces\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2585: the Projects section of the shell — the list, a
    // project's page, its members and their roles, the archive, and what each
    // of four people may and may not do with it — and the tool's side of it:
    // the items a project holds, added, linked, filtered and unlinked. Declared
    // after `workspaces` (the projects run in declaration order, one worker):
    // it adds four people to the instance and leaves projects and items
    // behind, which no earlier project has to know about, and its own walk
    // stays in the default workspace.
    { name: 'projects', testMatch: /projects\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2864: the Teams pages of the shell — the Teams tab of the People
    // section, a team made, renamed and deleted, a person seated on its page,
    // and the team as a project member with a role. Declared LAST: it seats the
    // viewer `projects` left active (and invites her only when that project did
    // not run), and leaves one project holding the owner alone and no team.
    { name: 'teams', testMatch: /teams\.spec\.ts/, dependencies: ['smoke'] }
  ],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node e2e/start-stack.mjs',
    url: `http://localhost:${APP_PORT}/readyz`,
    // First run builds the docker image — give it room.
    timeout: 600_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
