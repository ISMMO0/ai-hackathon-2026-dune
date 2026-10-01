import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * What every chapter of the walk shares: the environment it runs against, the
 * people it seats, the ledger it writes, one screenshot per step, and the
 * small helpers (sign in, Mailpit, the API, a terminal card, the guest's row).
 */

export const HERE = import.meta.dirname;
export const REPO_ROOT = resolve(HERE, '../../../..');

export const ENV = {
  base: process.env.WALK_BASE_URL ?? 'http://localhost:3000',
  mailpit: process.env.WALK_MAILPIT ?? 'http://localhost:8025',
  out: resolve(process.env.WALK_OUT ?? join(HERE, '../../.tmp/walk')),
  setupToken: process.env.WALK_SETUP_TOKEN ?? '',
  // No default on purpose: the guest step writes into this project's database, and a
  // guess would write into whatever stack answers to a name on the machine.
  compose: process.env.WALK_COMPOSE_PROJECT ?? '',
  cli: resolve(process.env.WALK_CLI ?? join(REPO_ROOT, 'packages/cli/dist/bin.js')),
  // The owner's own key with data:export, when the operator hands one over;
  // without it the CLI chapter records the export refusal instead.
  ownerKey: process.env.WALK_OWNER_API_KEY ?? ''
};

/** The identity, read from its one definition so the walk names the tool the tree carries. */
export const IDENTITY = readIdentity();

function readIdentity() {
  const text = readFileSync(join(REPO_ROOT, 'packages/contract/src/identity.ts'), 'utf8');
  const field = (name: string) => new RegExp(`\\b${name}:\\s*['"]([^'"]+)['"]`).exec(text)?.[1] ?? '';
  const id = {
    slug: field('slug'),
    displayName: field('displayName'),
    apiKeyPrefix: field('apiKeyPrefix'),
    readScope: field('read'),
    writeScope: field('write'),
    exportScope: field('dataExport'),
    envPrefix: field('envPrefix'),
    bin: field('bin'),
    toolPrefix: field('toolPrefix')
  };
  for (const [k, v] of Object.entries(id)) if (!v) throw new Error(`identity.ts: no ${k}`);
  return id;
}

// ── The people ────────────────────────────────────────────────────────────
export interface Person {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  password: string;
}
const person = (first: string, last: string, email: string): Person => ({
  firstName: first,
  lastName: last,
  name: `${first} ${last}`,
  email,
  password: `${first.toLowerCase()}-password-123`
});
export const OWNER = person('Owner', 'One', 'owner@example.com');
export const MIA = person('Mia', 'Member', 'mia@example.com');
export const GUEST = person('Gus', 'Guest', 'guest@example.org');
export const ZED = person('Zed', 'Gone', 'zed@example.com');
export const NOAH_EMAIL = 'noah@example.com';

export const INSTANCE_NAME = process.env.WALK_INSTANCE_NAME ?? 'Walk Instance';
export const TEAM = { name: 'Walk crew', slug: 'walk-crew', renamed: 'Walk studio' };
export const PROJECT = { name: 'Walk atlas', description: 'Everything the walk links.' };
export const ITEMS = { one: 'Walk item one', two: 'Walk item two', twoNote: 'A note the walk edited.' };
export const SECOND_WORKSPACE = 'Walk second';

// ── The ledger and the screenshots ────────────────────────────────────────
mkdirSync(ENV.out, { recursive: true });
const LEDGER = join(ENV.out, 'results.json');

export interface StepEntry {
  n: number;
  chapter: string;
  title: string;
  status: 'ok' | 'fail';
  shot: string | null;
  note?: string;
  t: string;
}

export function ledger(): { v: 1; startedAt: string; app: string; steps: StepEntry[] } {
  if (existsSync(LEDGER)) return JSON.parse(readFileSync(LEDGER, 'utf8'));
  return { v: 1, startedAt: new Date().toISOString(), app: ENV.base, steps: [] };
}

function record(entry: StepEntry) {
  const l = ledger();
  l.steps.push(entry);
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n');
}

/** The failed steps of this process, asserted empty by the chapter's last test. */
export const failures: string[] = [];

/**
 * One step of the walk: run it, shoot the page after it, write the ledger
 * line. A throw inside (an expect, a locator that never came) is recorded as
 * a failed step and the walk goes on to the next one, so one broken screen
 * never hides the rest; the chapter's last test fails on the list.
 */
export async function step(
  chapter: string,
  page: Page | null,
  title: string,
  fn: () => Promise<string | void>
): Promise<void> {
  const n = ledger().steps.length + 1;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const shot = page ? `${String(n).padStart(2, '0')}-${slug}.png` : null;
  await test.step(title, async () => {
    let status: StepEntry['status'] = 'ok';
    let note: string | undefined;
    try {
      const r = await fn();
      if (typeof r === 'string') note = r;
    } catch (e) {
      status = 'fail';
      // The first line, then the locator and the expected/received lines: the
      // ledger has to say WHAT was not found, not only that something was not.
      const lines = String((e as Error).message ?? e)
        .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const detail = lines.slice(1).filter((l) => /^(Locator|Expected|Received|waiting for)/.test(l));
      note = [lines[0], ...detail.slice(0, 3)].join(' | ').slice(0, 500);
    }
    if (page && shot) {
      try {
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(ENV.out, shot), fullPage: true });
      } catch (e) {
        note = `${note ?? ''} (no screenshot: ${String((e as Error).message).split('\n')[0]})`.trim();
      }
    }
    record({ n, chapter, title, status, shot, note, t: new Date().toISOString() });
    if (status === 'fail') failures.push(`${n} ${title}: ${note}`);
  });
}

/** What a chapter keeps for the next one (ids, the key for the CLI), outside the ledger. */
export function keep(name: string, value: Record<string, string>) {
  writeFileSync(join(ENV.out, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function kept(name: string): Record<string, string> {
  const p = join(ENV.out, `${name}.json`);
  if (!existsSync(p)) throw new Error(`${p} is missing: the owner chapter writes it first`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ── Sign in ───────────────────────────────────────────────────────────────
/**
 * Through the login page, the shape of the browser suite's helper: the
 * sign-in throttle (three per ten seconds per address) answers "Too many
 * attempts" when chapters sign in back to back; wait the window out once.
 */
export async function signIn(page: Page, who: Person): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const throttled = await page
    .getByText('Too many attempts')
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (throttled) {
    await page.waitForTimeout(12_000);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
}

export async function signOut(page: Page, who: Person): Promise<void> {
  await page.getByRole('button', { name: who.name }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

// ── The API, on a context's cookies or a bearer ───────────────────────────
export async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire's shape is whatever the route answers; the steps read it
): Promise<{ status: number; json: any; text: string }> {
  const res = await request.fetch(`${ENV.base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    data: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status(), json, text };
}

/** A person made through an invitation the owner mints and a clean context accepts. */
export async function createMember(owner: APIRequestContext, clean: APIRequestContext, who: Person) {
  const invite = await api(owner, 'POST', '/invitations', { email: who.email, role: 'member' });
  expect(invite.status, `invite ${who.email}: ${invite.text}`).toBe(201);
  const token = new URL(invite.json.acceptUrl).pathname.split('/invite/')[1];
  const accepted = await api(clean, 'POST', '/invitations/accept', {
    token,
    name: who.name,
    password: who.password
  });
  expect(accepted.status, `accept ${who.email}: ${accepted.text}`).toBe(200);
  return accepted.json as { workspaceId: string; userId: string };
}

// ── Mailpit ───────────────────────────────────────────────────────────────
export async function mailTo(
  request: APIRequestContext,
  email: string,
  tries = 10
): Promise<{ id: string; subject: string; text: string } | null> {
  for (let i = 0; i < tries; i++) {
    const res = await request.get(`${ENV.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (res.ok()) {
      const { messages } = await res.json();
      if (messages?.length) {
        const m = messages[0];
        const full = await (await request.get(`${ENV.mailpit}/api/v1/message/${m.ID}`)).json();
        return { id: m.ID, subject: m.Subject, text: full.Text ?? '' };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// ── The guest ─────────────────────────────────────────────────────────────
/**
 * The self-hosted edition has no door that makes a guest (a guest is a
 * per-resource collaborator of a tool that has such a resource), so the walk
 * seats one the way the integration suite does: the person is a member first,
 * then their membership row is turned into a guest row on the stack's database.
 */
export function seatGuest(email: string): string {
  if (!ENV.compose)
    throw new Error(
      'WALK_COMPOSE_PROJECT names the compose project whose database seats the guest; it is not set'
    );
  const sql = `update workspace_members set origin = 'guest' where user_id = (select id from "user" where email = '${email}') returning origin`;
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      ENV.compose,
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'app',
      '-d',
      'app',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql
    ],
    { encoding: 'utf8' }
  ).trim();
}

// ── A terminal card, for the CLI and the MCP chapters ─────────────────────
const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

export async function terminalCard(
  page: Page,
  title: string,
  cards: { cmd: string; out: string }[]
): Promise<void> {
  const body = cards
    .map(
      (c) =>
        `<div class="cmd"><span class="ps">$</span> ${esc(c.cmd)}</div><div class="out">${esc(c.out.replace(/\s+$/, ''))}</div>`
    )
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;min-height:100%;background:#EAE4D8}
    body{display:grid;place-items:start center;padding:24px;font:13px/1.5 ui-monospace,'SF Mono',Menlo,monospace}
    .term{width:1180px;background:#1d1b19;color:#e9e4da;border-radius:12px;box-shadow:0 18px 50px rgb(40 30 20 / .28);overflow:hidden}
    .bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#2a2724}
    .bar i{width:11px;height:11px;border-radius:50%;background:#5a534c;display:block}
    .bar span{margin-left:10px;color:#a39c92;font-size:12px}
    .body{padding:16px 22px 22px;white-space:pre-wrap;word-break:break-all}
    .cmd{color:#f3c7ac;margin-top:10px}.ps{color:#db7d5f}
    .out{margin-top:4px;color:#e9e4da}
  </style><div class="term"><div class="bar"><i></i><i></i><i></i><span>${esc(title)}</span></div><div class="body">${body}</div></div>`;
  await page.setContent(html);
  await page.waitForTimeout(150);
}

/** Bytes for the files chapter: a small text file, and one over a 1 MB cap. */
export const SMALL_FILE = {
  name: 'walk-note.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('a note the walk uploaded\n')
};
export const BIG_FILE = {
  name: 'walk-too-big.bin',
  mimeType: 'application/octet-stream',
  buffer: Buffer.alloc(1_100_000, 7)
};

/** The zip's entry names, through the machine's unzip (the walk runs on the operator's machine). */
export function zipEntries(path: string): string[] {
  return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter(Boolean);
}
export function zipRead(path: string, entry: string): string {
  return execFileSync('unzip', ['-p', path, entry], { encoding: 'utf8' });
}
