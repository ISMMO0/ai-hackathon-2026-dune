import { defineConfig } from '@playwright/test';

/**
 * The browser suite that needs a PAIR: this instance on `EDITION=cloud` behind
 * a running Antasphere hub. Nothing is booted here (the federation harness,
 * `docker-compose.federation.yml`, or any live pair is the stack); the suite
 * reads where the pair is from the environment and skips itself when it is
 * not told:
 *
 *   PW_PAIR_HUB             the hub's public base URL (http://hub.ant.localhost:6601)
 *   PW_PAIR_SL              this instance's public base URL (http://starter.ant.localhost:6610)
 *   PW_PAIR_OWNER_EMAIL     an owner of the hub organization below, with a password
 *   PW_PAIR_OWNER_PASSWORD  its password (never printed)
 *   PW_PAIR_ORG             the hub organization's name (the demo people are its members)
 *   PW_PAIR_TOOL            the tool's registry slug (default starter-cloud)
 *   PW_PAIR_PERSON_A / _B   two demo-eligible members of that organization (example or test addresses)
 *   PW_PAIR_MAIL, PW_PAIR_SETUP_TOKEN and the passwords: what the walk (walk.spec.ts) needs to claim a fresh pair
 *
 *   PW_PAIR_HUB=… PW_PAIR_SL=… pnpm --filter @app/dashboard test:e2e:pair
 *
 * Kept apart from `playwright.config.ts`, whose `webServer` boots the
 * self-hosted stack the main suite runs on.
 */
export default defineConfig({
  testDir: './e2e/pair',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // The walk claims the fresh pair and leaves the fixtures the two other specs
  // read (the organization, its owner, two members with passwords), so it runs
  // first; the other two depend on it and run in declaration order after it.
  projects: [
    { name: 'walk', testMatch: /walk\.spec\.ts/ },
    { name: 'landing', testMatch: /cloud-landing\.spec\.ts/, dependencies: ['walk'] },
    { name: 'signin', testMatch: /tool-signin\.spec\.ts/, dependencies: ['walk'] }
  ],
  use: { trace: 'retain-on-failure' }
});
