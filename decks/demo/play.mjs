#!/usr/bin/env node
/*
 * The play of a demo deck: plain Playwright, one file.
 *
 * The `hackathon-deck-demo` skill copies this file into the team's clone as
 * `decks/demo/play.mjs` and writes the gestures at the bottom for the team's
 * own app. It reads `decks/demo/guide.json` beside it, opens the app, plays
 * one gesture per step, numbered straight through the episodes (episode 1's
 * steps are 1, 2, …, episode 2's carry on), and writes one screenshot per
 * step into `screens/` (`01.jpg`, `02.jpg`, ...; none for a step with
 * `noshot`) and what it saw into `results.json`.
 *
 *   node decks/demo/play.mjs                      # play every step, headless
 *   node decks/demo/play.mjs --login              # a visible browser: sign in by hand, close the window
 *   node decks/demo/play.mjs --from 3 --until 5   # replay a range
 *   node decks/demo/play.mjs --headed             # watch it play
 *
 * The app URL is guide.json's `app.url`. A signed-in app needs `--login`
 * once: the participant signs in in the window that opens and closes it,
 * and the session is kept OUTSIDE the repository
 * (~/.cache/antasphere-hackathon/<folder>-auth.json) for the plays after.
 *
 * Playwright is resolved from the clone's own node_modules first, else from
 * ~/.cache/antasphere-hackathon/playwright (PLAYWRIGHT_PREFIX overrides it):
 *   npm i --prefix ~/.cache/antasphere-hackathon/playwright playwright@1
 *   npx --prefix ~/.cache/antasphere-hackathon/playwright playwright install chromium
 *
 * Two halves. Above the line, the generic part: the browser, the session,
 * the shots, the promises of a step (`expect` texts that must be on screen),
 * the results. Below the line, the gestures: one function per step number,
 * with the selectors this app needs. A gesture never deletes or sends
 * anything real: a demo shows, it does not spend.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ─── arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const LOGIN = args.includes('--login');
const HEADED = LOGIN || args.includes('--headed');
const FROM = Number(argVal('--from', 1));
const UNTIL = Number(argVal('--until', Infinity));

// ─── the demo ────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const guide = JSON.parse(fs.readFileSync(path.join(HERE, 'guide.json'), 'utf8'));
const APP = String(guide.app?.url ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(APP)) {
  console.error('guide.json has no app.url (http://127.0.0.1:<port>)');
  process.exit(2);
}
// every step of every episode, in order: the gestures are numbered the same way
const STEPS = (guide.episodes ?? []).flatMap((ep, k) =>
  (ep.steps ?? []).map((st) => ({ ...st, episode: k + 1, title: `${ep.title}: ${st.do}` }))
);
const SCREENS = path.join(HERE, 'screens');
fs.mkdirSync(SCREENS, { recursive: true });
const cacheDir = path.join(os.homedir(), '.cache', 'antasphere-hackathon');
fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
const AUTH = path.join(cacheDir, `${path.basename(path.resolve(HERE, '..', '..'))}-auth.json`);

// ─── Playwright ──────────────────────────────────────────────────────────────
function loadPlaywright() {
  const prefixes = [process.cwd(), process.env.PLAYWRIGHT_PREFIX, path.join(cacheDir, 'playwright')].filter(Boolean);
  for (const p of prefixes) {
    try {
      return createRequire(path.join(p, 'package.json'))('playwright');
    } catch {
      /* next */
    }
  }
  console.error(
    'Playwright is not installed. Run:\n' +
      '  npm i --prefix ~/.cache/antasphere-hackathon/playwright playwright@1\n' +
      '  npx --prefix ~/.cache/antasphere-hackathon/playwright playwright install chromium'
  );
  process.exit(4);
}
const { chromium } = loadPlaywright();

const browser = await chromium.launch({ headless: !HEADED, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  ...(fs.existsSync(AUTH) && !LOGIN ? { storageState: AUTH } : {})
});

// ─── --login: the participant signs in by hand, the session is kept ─────────
if (LOGIN) {
  const page = await context.newPage();
  await page.goto(APP);
  console.error(`Sign in to ${APP} in the window that opened, then close the window.`);
  await new Promise((resolve) => page.on('close', resolve));
  await context.storageState({ path: AUTH });
  fs.chmodSync(AUTH, 0o600);
  console.error(`Session kept in ${AUTH} (outside the repository).`);
  await browser.close();
  process.exit(0);
}

// ─── the play ────────────────────────────────────────────────────────────────
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const results = { v: 1, app: APP, startedAt: new Date().toISOString(), steps: [] };
const resultsPath = path.join(HERE, 'results.json');
const pad = (n) => String(n).padStart(2, '0');

const ctx = {
  page,
  app: APP,
  /** Open a path of the app and wait for the network to settle. */
  async open(p = '/') {
    await page.goto(APP + p, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  },
  /** A text that must be visible: the step fails without it. */
  async expect(text) {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible' });
  }
};

// ─── the gestures (written for this app; one per step of guide.json, numbered through the episodes) ─
// Each gesture brings the screen to what the step's `see` says. Keep them
// short: Playwright's own locators (getByRole, getByLabel, getByText).
const gestures = {
  // Episode 1: Andy builds his tutor
  async 1({ open }) { await open('/studio'); },
  async 2({ page }) {
    for (const answer of ['Andy', '11', 'Maths for a mission to Mars']) {
      const box = page.locator('input[type="text"]');
      await box.fill(answer);
      await box.press('Enter');
      await page.waitForTimeout(400);
    }
  },
  async 3({ page }) {
    for (const choice of ['I know the basics', 'Stories and analogies', 'Warm and encouraging', 'English']) {
      await page.getByRole('button', { name: choice }).click();
      await page.waitForTimeout(400);
    }
  },
  async 4({ page }) {
    await page.getByRole('button', { name: 'Create my tutor' }).click();
    await page.getByText('Creating your tutor').waitFor();
    await page.waitForTimeout(4000);
  },
  async 5({ page }) {
    await page.getByRole('link', { name: 'Start learning' }).waitFor({ timeout: 300_000 });
  },
  // Episode 2: the parent checks what H found
  async 6({ page }) {
    await page.getByRole('link', { name: 'See lessons and sources' }).click();
    await page.getByRole('heading', { name: 'Lessons' }).waitFor();
    await page.waitForTimeout(1500);
  },
  async 7({ page }) {
    await page.getByRole('heading', { name: 'SKILL.md' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
  },
  // Episode 3: a first lesson in the Tutor Room
  async 8({ page }) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('link', { name: /Start learning|Continue learning/ }).click();
    await page.getByLabel('Message your tutor').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2500);
  },
  async 9({ page }) {
    await page.getByLabel('Message your tutor').fill("I'm ready! What is my first mission?");
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Your tutor is thinking').waitFor({ timeout: 10_000 }).catch(() => {});
    await page.getByText('Your tutor is thinking').waitFor({ state: 'hidden', timeout: 300_000 });
    await page.waitForTimeout(2000);
  },
  async 10({ page }) {
    await page.getByRole('button', { name: "Open the tutor's brain" }).click();
    await page.getByRole('dialog', { name: "Tutor's brain" }).waitFor();
    await page.waitForTimeout(1000);
  },
};
// ─────────────────────────────────────────────────────────────────────────────

let failed = 0;
for (const [i, step] of STEPS.entries()) {
  const n = i + 1;
  if (n < FROM || n > UNTIL) continue;
  const shot = `${pad(n)}.jpg`;
  const entry = { step: n, episode: step.episode, title: step.title, status: 'passed', shot: `screens/${shot}`, missing: [], note: null };
  try {
    const gesture = gestures[n];
    if (gesture) await gesture(ctx);
    else if (step.path) await ctx.open(step.path);
    for (const text of step.expect ?? []) {
      try {
        await ctx.expect(text);
      } catch {
        entry.missing.push(text);
      }
    }
    if (entry.missing.length) entry.status = 'failed';
  } catch (err) {
    entry.status = 'failed';
    entry.note = String(err?.message ?? err).split('\n')[0];
  }
  if (!step.noshot) {
    await page.screenshot({ path: path.join(SCREENS, shot), type: 'jpeg', quality: 70 });
  } else {
    entry.shot = null;
  }
  if (entry.status === 'failed') failed++;
  results.steps.push(entry);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.error(`${pad(n)} ${entry.status}${entry.missing.length ? ` (missing: ${entry.missing.join(', ')})` : ''}${entry.note ? ` ${entry.note}` : ''}`);
}
results.finishedAt = new Date().toISOString();
results.verdict = failed ? 'failed' : 'passed';
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed ? 1 : 0);
