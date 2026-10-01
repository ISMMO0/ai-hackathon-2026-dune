import { defineConfig } from '@playwright/test';

/**
 * The walk: every screen, command and agent tool of the self-hosted edition,
 * played once against a stack ALREADY BOOTED by the operator (PRDCT-2866). No
 * webServer here: the browser suite's harness (`../start-stack.mjs`) boots the
 * pw-smoke project; the walk takes the address of a stack from the environment
 * and leaves it as it found it plus what it made. Run it on a freshly claimed
 * instance or one the walk claims itself through the setup wizard.
 *
 *   WALK_BASE_URL=http://localhost:3000 WALK_SETUP_TOKEN=… WALK_MAILPIT=http://localhost:8025 \
 *   WALK_COMPOSE_PROJECT=walk pnpm exec playwright test --config e2e/walk/playwright.config.ts
 *
 * The four chapters run in this order, one worker, and each writes one
 * screenshot per step that has a page and one line per step into `results.json` under
 * WALK_OUT (`apps/dashboard/.tmp/walk` by default). README.md beside this
 * file says the rest.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\d\d-.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    { name: 'owner', testMatch: /01-owner\.spec\.ts/ },
    { name: 'member-guest', testMatch: /02-member-guest\.spec\.ts/, dependencies: ['owner'] },
    { name: 'cli', testMatch: /03-cli\.spec\.ts/, dependencies: ['owner'] },
    { name: 'mcp', testMatch: /04-mcp\.spec\.ts/, dependencies: ['owner'] }
  ],
  use: {
    baseURL: process.env.WALK_BASE_URL ?? 'http://localhost:3000',
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    // A control that never comes fails its STEP (the ledger line), not the
    // whole test: without it an action waits out the 120 s test timeout and
    // every later step of that test is lost.
    actionTimeout: 15_000,
    navigationTimeout: 30_000
  }
});
