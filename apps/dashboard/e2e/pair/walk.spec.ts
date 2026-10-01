import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The cloud walk (29 September 2026, lane E2 of the 0.13.0 wave): everything a
 * cloud person, a cloud operator and an agent do with a tool born from this
 * template, connected to an Antasphere hub, played in order on ONE fresh pair
 * with one screenshot per screen. It is the scripted form of the deep
 * end-to-end test Romain asked for on 28 September, kept so the next release
 * replays it.
 *
 * The pair: `docker-compose.federation.yml` plus `walk-pair.yml` beside this
 * file (demo sign-in and staff on the hub, the claim credential on the tool,
 * the registry's launch and post-logout addresses). The walk boots nothing and
 * runs both setups itself, so it needs a pair nobody has claimed; it then
 * leaves the fixtures the two other pair specs read (the organization, its
 * owner, two demo-eligible members with passwords), so `test:e2e:pair` runs
 * the three files on one pair, this one first.
 *
 *   PW_PAIR_HUB / PW_PAIR_SL      the two public base URLs (*.ant.localhost)
 *   PW_PAIR_MAIL                  Mailpit's base URL (the hub's CLI code is read there)
 *   PW_PAIR_SETUP_TOKEN           the tool's SETUP_TOKEN (walk-pair.yml hands it to the container)
 *   PW_PAIR_OWNER_EMAIL / _PASSWORD    the hub's owner, staff on this pair (SUPERADMIN_EMAILS)
 *   PW_PAIR_ORG                   the organization's name (the hub's instance name; default Northwind)
 *   PW_PAIR_TOOL                  the tool's registry slug (default starter-cloud)
 *   PW_PAIR_PERSON_A / _PASSWORD  a member seated on the allowed team (default jonas.peeters@example.com)
 *   PW_PAIR_PERSON_B / _PASSWORD  a member outside it at first (default sam.leaver@drill.test)
 *   PW_PAIR_OPERATOR_EMAIL / _PASSWORD  the tool's operator (its break-glass owner; defaults below)
 *   PW_WALK_SHOTS                 where the screenshots and the export land (default test-results/walk)
 *   PW_WALK_CLI                   the built CLI (default ../../packages/cli/dist/bin.js)
 *
 * Every hub call runs as the hub's owner through a request context of its
 * own; every tool call of a signed-in person runs through the browser
 * context's request, which shares its cookies, with the Origin the
 * cross-site guard wants.
 */

const HUB = process.env.PW_PAIR_HUB;
const SL = process.env.PW_PAIR_SL;
const MAIL = process.env.PW_PAIR_MAIL;
const SETUP_TOKEN = process.env.PW_PAIR_SETUP_TOKEN;
const OWNER = process.env.PW_PAIR_OWNER_EMAIL ?? 'owner@example.com';
const OWNER_PASSWORD = process.env.PW_PAIR_OWNER_PASSWORD;
const ORG = process.env.PW_PAIR_ORG ?? 'Northwind';
const TOOL = process.env.PW_PAIR_TOOL ?? 'starter-cloud';
const A = process.env.PW_PAIR_PERSON_A ?? 'jonas.peeters@example.com';
const A_PASSWORD = process.env.PW_PAIR_PERSON_A_PASSWORD;
const B = process.env.PW_PAIR_PERSON_B ?? 'sam.leaver@drill.test';
const B_PASSWORD = process.env.PW_PAIR_PERSON_B_PASSWORD;
const OPERATOR = process.env.PW_PAIR_OPERATOR_EMAIL ?? 'sl-operator@example.com';
const OPERATOR_PASSWORD = process.env.PW_PAIR_OPERATOR_PASSWORD ?? 'operator-password-0001';
const SHOTS = path.resolve(process.env.PW_WALK_SHOTS ?? 'test-results/walk');
const CLI = path.resolve(process.env.PW_WALK_CLI ?? '../../packages/cli/dist/bin.js');

test.skip(
  !HUB || !SL || !MAIL || !SETUP_TOKEN || !OWNER_PASSWORD || !A_PASSWORD || !B_PASSWORD,
  'PW_PAIR_HUB, PW_PAIR_SL, PW_PAIR_MAIL, PW_PAIR_SETUP_TOKEN and the three passwords name the pair'
);
test.describe.configure({ mode: 'serial' });

/**
 * One browser context for the owner's steps, signed in ONCE at step 2: the
 * sign-in library's wall on both sides allows three sign-in calls per ten
 * seconds per address, so a step that signed in again would meet it. The
 * member's steps (12, 13) open contexts of their own, seconds apart.
 */
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await page.context().close();
});

/** What the walk learns as it goes; every step reads what the ones before it wrote. */
const state = {
  hubOwnerId: '',
  orgId: '',
  teamId: '',
  memberIds: {} as Record<string, string>,
  workspaceId: '',
  accountId: '',
  walkKey: '',
  connectKey: '',
  mcpBearer: ''
};

let shotCount = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotCount += 1;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${String(shotCount).padStart(2, '0')}-${name}.png`) });
}

const json = { 'content-type': 'application/json' };
function idem(): Record<string, string> {
  return { 'Idempotency-Key': `walk-${randomBytes(8).toString('hex')}` };
}

/** The hub's owner, signed in through a request context of its own (never the browser's). */
async function hubOwner(request: APIRequestContext): Promise<APIRequestContext> {
  const r = await request.post(`${HUB}/api/v1/auth/sign-in/email`, {
    headers: { origin: HUB!, ...json },
    data: { email: OWNER, password: OWNER_PASSWORD }
  });
  expect(r.status(), 'the owner signs in at the hub').toBe(200);
  return request;
}
function hubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: HUB!, 'x-workspace-id': state.orgId, ...json, ...extra };
}

/** The signed-in person on one side, read through a context's own cookie jar. */
async function whoAmI(request: APIRequestContext, base: string): Promise<string | null> {
  const r = await request.get(`${base}/api/v1/me`, { headers: { origin: base } });
  if (r.status() !== 200) return null;
  const d = (await r.json()) as { user?: { email?: string } };
  return d.user?.email ?? null;
}

/** Sign in with Antasphere from the tool's login page, through the hub's password form. */
async function sso(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${SL}/login`);
  await page.getByRole('button', { name: 'Sign in with Antasphere' }).click();
  await page.waitForURL((u) => u.origin === new URL(HUB!).origin, { timeout: 30_000 });
  await page.getByLabel(/email/i).first().fill(email);
  await page
    .getByLabel(/password/i)
    .first()
    .fill(password);
  await page
    .getByRole('button', { name: /^(sign in|continue|log in)$/i })
    .first()
    .click();
  await page.waitForURL((u) => u.origin === new URL(SL!).origin && !u.pathname.startsWith('/login'), {
    timeout: 30_000
  });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** The toast the next action raises, read within four seconds (a toast lives about that long). */
async function nextToast(
  page: Page,
  act: () => Promise<void>,
  expected: string
): Promise<{ text: string; buttons: string[] }> {
  await act();
  // The toast that carries the expected words: an older one still on screen is not it.
  const toast = page.locator('[data-sonner-toast]', { hasText: expected }).first();
  await expect(toast).toBeVisible({ timeout: 4_000 });
  return {
    text: (await toast.innerText()).replace(/\s+/g, ' ').trim(),
    buttons: await toast.locator('button').allInnerTexts()
  };
}

/** The invitation token of the link the hub mailed to an address, read from Mailpit. */
async function mailedInviteToken(request: APIRequestContext, email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const found = (await (await request.get(`${MAIL}/api/v1/search?query=to:${email}`)).json()) as {
      messages: { ID: string }[];
    };
    for (const m of found.messages) {
      const body = (await (await request.get(`${MAIL}/api/v1/message/${m.ID}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const link = /\/invite\/([A-Za-z0-9_-]+)/.exec(`${body.Text ?? ''}\n${body.HTML ?? ''}`);
      if (link) return link[1]!;
    }
    await pause(1_000);
  }
  throw new Error(`no invitation mail for ${email} reached Mailpit (${MAIL})`);
}

/** The sign-in library's wall on both sides: three sign-in calls per ten seconds per address. */
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('0. both setups and the organization: two people with passwords, one team with Jonas on it', async ({
  playwright
}) => {
  const request = await playwright.request.newContext();
  const fresh = await request.get(`${SL}/api/v1/instance`);
  const instance = (await fresh.json()) as { edition: string; setupRequired: boolean };
  expect(instance.edition, 'the tool boots the cloud edition').toBe('cloud');
  expect(instance.setupRequired, 'the walk needs a pair nobody has claimed').toBe(true);

  const hub = await request.post(`${HUB}/api/v1/setup`, {
    headers: json,
    data: { instanceName: ORG, owner: { email: OWNER, name: 'Nora Owens', password: OWNER_PASSWORD } }
  });
  expect(hub.status(), 'the hub setup').toBe(201);
  state.hubOwnerId = ((await hub.json()) as { ownerUserId: string }).ownerUserId;

  const tool = await request.post(`${SL}/api/v1/setup`, {
    headers: json,
    data: {
      instanceName: 'Hackathon Starter (the pair)',
      setupToken: SETUP_TOKEN,
      owner: { email: OPERATOR, name: 'Tool Operator', password: OPERATOR_PASSWORD }
    }
  });
  expect(tool.status(), 'the tool setup').toBe(201);
  expect(
    ((await tool.json()) as { workspaceId: string | null }).workspaceId,
    'a cloud setup mints no workspace'
  ).toBeNull();

  const owner = await hubOwner(request);
  const orgs = (await (await owner.get(`${HUB}/api/v1/orgs`, { headers: { origin: HUB! } })).json()) as {
    orgs: { id: string; name: string; role: string }[];
  };
  const org = orgs.orgs.find((o) => o.name === ORG);
  expect(org?.role, `the setup made ${ORG} with the owner as its owner`).toBe('owner');
  state.orgId = org!.id;

  for (const [email, name, password] of [
    [A, 'Jonas Peeters', A_PASSWORD],
    [B, 'Sam Leaver', B_PASSWORD]
  ] as const) {
    const invite = await owner.post(`${HUB}/api/v1/invitations`, {
      headers: hubHeaders(idem()),
      data: { email, role: 'member' }
    });
    expect(invite.status(), `an invitation for ${email}`).toBe(201);
    // The link the hub MAILED, not the one its answer carries: accepting with
    // the emailed token proves the mailbox, and the hub's sign-in stops an
    // unverified address at a verification step.
    const token = await mailedInviteToken(request, email);
    const accept = await request.post(`${HUB}/api/v1/invitations/accept`, {
      headers: { origin: HUB!, ...json },
      data: { token, name, password }
    });
    expect(accept.status(), `${email} accepts with a password`).toBe(200);
  }

  const team = await owner.post(`${HUB}/api/v1/teams`, {
    headers: hubHeaders(),
    data: { name: 'Field Research' }
  });
  expect(team.status(), 'the team Field Research').toBe(201);
  state.teamId = ((await team.json()) as { id: string }).id;
  const members = (await (await owner.get(`${HUB}/api/v1/members`, { headers: hubHeaders() })).json()) as {
    members: { id: string; email: string }[];
  };
  for (const m of members.members) state.memberIds[m.email] = m.id;
  const seat = await owner.put(`${HUB}/api/v1/teams/${state.teamId}/members/${state.memberIds[A]}`, {
    headers: hubHeaders()
  });
  expect(seat.status(), 'Jonas seated on Field Research').toBe(200);

  await request.dispose();
});

test('1. the cloud login page offers Sign in with Antasphere and nothing else', async () => {
  await page.goto(`${SL}/login`);
  await expect(page.getByRole('button', { name: 'Sign in with Antasphere' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /google/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /email code|send code/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /forgot/i })).toHaveCount(0);
  await shot(page, 'login-cloud');

  // The reset page does not exist on cloud: it sends the visitor to the login page.
  await page.goto(`${SL}/forgot-password`);
  await page.waitForURL((u) => u.pathname === '/login', { timeout: 15_000 });
});

test('2. a first visit signs the owner in through the hub and projects the organization as a workspace', async () => {
  await sso(page, OWNER, OWNER_PASSWORD!);
  await expect(page.getByRole('heading', { name: `Welcome to Hackathon Starter (the pair)` })).toBeVisible();
  await expect(page.getByText('Your Antasphere account is connected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(ORG);
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Owner');
  await shot(page, 'first-visit');

  const me = (await (
    await page.context().request.get(`${SL}/api/v1/me`, { headers: { origin: SL! } })
  ).json()) as {
    workspace: { id: string; name: string; hubOrigin: boolean };
    role: string;
    workspaces: { hubOrigin: boolean }[];
    hubManageUrl: string | null;
  };
  expect(me.workspace.name).toBe(ORG);
  expect(me.workspace.hubOrigin, 'the workspace is the hub organization, projected').toBe(true);
  expect(me.role).toBe('owner');
  expect(
    me.workspaces.every((w) => w.hubOrigin),
    'every workspace of a hub person is projected'
  ).toBe(true);
  expect(me.hubManageUrl?.startsWith(HUB!), 'the manage link names the hub').toBe(true);
  state.workspaceId = me.workspace.id;
});

test('3. members and invitations are managed at Antasphere; the pages say so and offer no control', async () => {
  await page.goto(`${SL}/members`);
  await expect(
    page.getByText(
      'Membership of this workspace is managed at Antasphere — invite, remove, and change roles there.'
    )
  ).toBeVisible();
  const manage = page.getByRole('link', { name: 'Manage at Antasphere' }).first();
  expect((await manage.getAttribute('href'))?.startsWith(HUB!), 'Manage at Antasphere opens the hub').toBe(
    true
  );
  await expect(page.getByRole('button', { name: /^invite( |$)/i })).toHaveCount(0);
  await shot(page, 'members-hub-managed');

  await page.goto(`${SL}/invitations`);
  await expect(page.getByText('Membership of this workspace is managed at Antasphere').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^invite( |$)/i })).toHaveCount(0);

  const r = page.context().request;
  const h = { origin: SL!, 'x-workspace-id': state.workspaceId, ...json };
  const invite = await r.post(`${SL}/api/v1/invitations`, {
    headers: h,
    data: { email: 'someone@example.com', role: 'member' }
  });
  expect(invite.status()).toBe(403);
  const body = (await invite.json()) as { error: { code: string; details?: { manageUrl?: string } } };
  expect(body.error.code).toBe('hub_managed');
  expect(body.error.details?.manageUrl?.startsWith(HUB!)).toBe(true);

  // Every other membership mutation of the projected workspace refuses the same way.
  const members = (await (await r.get(`${SL}/api/v1/members`, { headers: h })).json()) as {
    members: { id: string; email: string }[];
  };
  const self = members.members.find((m) => m.email === OWNER)!.id;
  const hubManaged = async (method: 'patch' | 'post' | 'delete', p: string, data?: unknown) => {
    const res = await r.fetch(`${SL}/api/v1${p}`, { method, headers: h, ...(data ? { data } : {}) });
    expect(res.status(), `${method.toUpperCase()} ${p}`).toBe(403);
    expect(
      ((await res.json()) as { error: { code: string } }).error.code,
      `${method.toUpperCase()} ${p}`
    ).toBe('hub_managed');
  };
  await hubManaged('patch', `/members/${self}`, { role: 'admin' });
  await hubManaged('patch', `/members/${self}`, { isActive: false });
  await hubManaged('post', `/members/${self}/remove`);
  await hubManaged('delete', `/members/${self}`);
  await hubManaged('post', `/members/${self}/reset-link`);
  await hubManaged('post', `/members/${self}/change-email-link`);
});

test('4. the teams are the hub’s, shown read-only with Manage at Antasphere', async () => {
  await page.goto(`${SL}/teams`);
  await expect(
    page.getByText(
      'Teams of this workspace are managed at Antasphere; they are shown here as the account site has them.'
    )
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage at Antasphere' }).first()).toBeVisible();
  await expect(page.getByText('Field Research').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /new team/i })).toHaveCount(0);
  await shot(page, 'teams-hub-managed');

  const r = page.context().request;
  const create = await r.post(`${SL}/api/v1/teams`, {
    headers: { origin: SL!, 'x-workspace-id': state.workspaceId, ...json },
    data: { name: 'Local team' }
  });
  expect(create.status(), 'a team is never made here in a hub organization').toBe(403);
  expect(((await create.json()) as { error: { code: string } }).error.code).toBe('hub_managed');
});

test('5. the name, the email and the default workspace are changed at Antasphere, and the pages point there', async () => {
  await page.goto(`${SL}/settings`);
  await expect(
    page.getByText('This workspace is an Antasphere organization: its name is changed there.')
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Antasphere' })).toBeVisible();
  await shot(page, 'settings-rename-at-hub');

  await page.goto(`${SL}/account`);
  await expect(
    page.getByText('You sign in with Antasphere. There is no password on this instance')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage your Antasphere account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change email' })).toHaveCount(0);
  await shot(page, 'account-managed-at-hub');

  // The switcher's quick action opens the account site instead of setting a default here.
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.getByTestId('workspace-entry').first().hover();
  const makeDefault = page.locator('[data-dropdown-menu-sub-content] [role="menuitem"]', {
    hasText: 'Make default'
  });
  await expect(makeDefault).toBeVisible();
  await expect(page.getByTestId('workspace-make-default')).toHaveCount(0);
  await shot(page, 'switcher-default-at-hub');
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }),
    makeDefault.click()
  ]);
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).origin, 'Make default opens the account site').toBe(new URL(HUB!).origin);
  await popup.close();

  const r = page.context().request;
  const h = { origin: SL!, 'x-workspace-id': state.workspaceId, ...json };
  const def = await r.put(`${SL}/api/v1/me/default-workspace`, {
    headers: h,
    data: { workspaceId: state.workspaceId }
  });
  expect(def.status()).toBe(403);
  expect(((await def.json()) as { error: { code: string } }).error.code).toBe('hub_managed');
  const rename = await r.patch(`${SL}/api/v1/workspace`, { headers: h, data: { name: `${ORG} 2` } });
  expect(rename.status()).toBe(403);
  expect(((await rename.json()) as { error: { code: string } }).error.code).toBe('hub_managed');
  const mail = await r.post(`${SL}/api/v1/auth/change-email`, {
    headers: h,
    data: { newEmail: 'nora@example.net' }
  });
  expect(mail.status()).toBe(403);
  expect(((await mail.json()) as { code: string }).code).toBe('email_change_disabled');
});

test('6. the closed entrances: no password reset, no emailed code, no Google, no CLI code', async ({
  playwright
}) => {
  const r = await playwright.request.newContext();
  const closed = async (p: string, data: unknown, status: number, marker: string) => {
    const res = await r.post(`${SL}/api/v1${p}`, { headers: { origin: SL!, ...json }, data });
    expect(res.status(), `POST ${p}`).toBe(status);
    const text = await res.text();
    expect(text, `POST ${p} names its refusal`).toContain(marker);
    expect(text, `POST ${p} hands out nothing`).not.toMatch(/"(token|key|url)"/);
  };
  const before = (
    (await (await r.get(`${MAIL}/api/v1/search?query=to:${OWNER}`)).json()) as { messages: unknown[] }
  ).messages.length;
  await closed('/auth/request-password-reset', { email: OWNER }, 403, 'Password reset is disabled');
  await closed(
    '/auth/reset-password',
    { newPassword: 'walk-new-password-0001', token: 'walk' },
    403,
    'Password reset is disabled'
  );
  await closed('/auth/sign-in/email-otp', { email: OWNER, otp: '000000' }, 403, 'otp_signin_disabled');
  await closed(
    '/auth/email-otp/send-verification-otp',
    { email: OWNER, type: 'sign-in' },
    403,
    'otp_signin_disabled'
  );
  await closed('/auth/sign-in/social', { provider: 'google', callbackURL: '/' }, 404, 'PROVIDER_NOT_FOUND');
  await closed('/cli/auth/request', { email: OWNER }, 403, 'cli_otp_disabled');
  await closed('/cli/auth/complete', { email: OWNER, otp: '000000' }, 403, 'cli_otp_disabled');
  const after = (
    (await (await r.get(`${MAIL}/api/v1/search?query=to:${OWNER}`)).json()) as { messages: unknown[] }
  ).messages.length;
  expect(after, 'none of the refused entrances mailed a code').toBe(before);

  // The break-glass door stays open to the operator's local account, on the API only.
  const operator = await r.post(`${SL}/api/v1/auth/sign-in/email`, {
    headers: { origin: SL!, ...json },
    data: { email: OPERATOR, password: OPERATOR_PASSWORD }
  });
  expect(operator.status(), 'the operator’s break-glass sign-in').toBe(200);
  await r.dispose();
});

test('7. the CLI connects through the hub, and its logout revokes exactly its own key', async ({
  playwright
}) => {
  const r = await playwright.request.newContext();
  // A key of the owner's own, minted from the dashboard session, alive beside the
  // CLI's: the logout must take exactly the CLI's and leave this one.
  const key = await page.context().request.post(`${SL}/api/v1/api-keys`, {
    headers: { origin: SL!, 'x-workspace-id': state.workspaceId, ...json },
    data: { name: 'walk key', scopes: ['items:read', 'items:write'] }
  });
  expect(key.status(), 'a key minted from the dashboard session').toBe(201);
  state.walkKey = ((await key.json()) as { key: string }).key;
  // What `antasphere login` does: a code mailed by the hub buys the account key.
  const req = await r.post(`${HUB}/api/v1/cli/auth/request`, { headers: json, data: { email: OWNER } });
  expect(req.status(), 'the hub mails a sign-in code').toBe(200);
  let otp = '';
  for (let i = 0; i < 20 && !otp; i++) {
    const found = (await (await r.get(`${MAIL}/api/v1/search?query=to:${OWNER}`)).json()) as {
      messages: { Subject: string }[];
    };
    otp = found.messages.map((m) => /^(\d{4,10})\b/.exec(m.Subject)?.[1] ?? '').find(Boolean) ?? '';
    if (!otp) await pause(1_000);
  }
  expect(otp, 'the code reached Mailpit').not.toBe('');
  const complete = await r.post(`${HUB}/api/v1/cli/auth/complete`, {
    headers: json,
    data: { email: OWNER, otp, keyName: 'walk cli' }
  });
  expect(complete.status(), 'the hub mints the account key').toBe(201);
  const hubKey = ((await complete.json()) as { key: string }).key;

  // The profile `antasphere login` stores, in a config home of the walk's own.
  const home = path.join(SHOTS, 'cli-home');
  mkdirSync(path.join(home, 'antasphere'), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home, 'antasphere', 'config.json'),
    JSON.stringify({
      activeProfile: 'default',
      profiles: { default: { apiKey: hubKey, baseUrl: HUB, email: OWNER } }
    }),
    { mode: 0o600 }
  );
  const cli = (...args: string[]) => {
    const run = spawnSync(process.execPath, [CLI, ...args, '--api-url', SL!], {
      env: { ...process.env, XDG_CONFIG_HOME: home, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  };
  const whoami = cli('whoami');
  expect(whoami.status, whoami.out).toBe(0);
  expect(whoami.out).toContain(`as ${OWNER} via Antasphere`);
  expect(whoami.out).toContain(ORG);
  const cache = JSON.parse(readFileSync(path.join(home, 'antasphere', 'tools', 'starter.json'), 'utf8')) as {
    profiles: { default: { connectKeys: { default: { apiKey: string } } } };
  };
  state.connectKey = cache.profiles.default.connectKeys.default.apiKey;
  expect(state.connectKey.startsWith('ytk_'), 'the exchange minted a tool key of the person’s own').toBe(
    true
  );
  const list = cli('items', 'list', '--workspace', ORG, '--json');
  expect(list.status, list.out).toBe(0);
  const logout = cli('logout');
  expect(logout.status, logout.out).toBe(0);
  expect(logout.out).toContain('key revoked server-side');
  const dead = await r.get(`${SL}/api/v1/items`, {
    headers: { authorization: `Bearer ${state.connectKey}`, 'x-workspace-id': state.workspaceId }
  });
  expect(dead.status(), 'the revoked connect key reaches nothing').toBe(401);
  const alive = await r.get(`${SL}/api/v1/items`, {
    headers: { authorization: `Bearer ${state.walkKey}`, 'x-workspace-id': state.workspaceId }
  });
  expect(alive.status(), 'the owner’s other key is untouched by the CLI’s logout').toBe(200);
  writeFileSync(
    path.join(SHOTS, 'cli-connect.txt'),
    `${whoami.out}\n${list.out.slice(0, 400)}\n${logout.out}`
  );
  await r.dispose();
});

test('8. an agent on the MCP endpoint with a grant the person approved on the consent screen', async ({
  playwright
}) => {
  // The agent's own calls carry no cookie: a bearer, never the browser's session.
  const r = await playwright.request.newContext();
  const redirect = 'http://127.0.0.1:19999/callback';
  const register = await r.post(`${SL}/api/v1/auth/oauth2/register`, {
    headers: json,
    data: {
      client_name: 'walk agent',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    }
  });
  expect([200, 201], 'dynamic registration at the tool').toContain(register.status());
  const clientId = ((await register.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const meta = (await (await r.get(`${SL}/.well-known/oauth-authorization-server`)).json()) as {
    scopes_supported: string[];
  };
  const authorize = new URL(`${SL}/api/v1/auth/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: meta.scopes_supported.join(' '),
    state: 'walk-mcp',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${SL}/mcp`
  }).toString();
  let code = '';
  await page.route(`${redirect}**`, async (route) => {
    code = new URL(route.request().url()).searchParams.get('code') ?? '';
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'the agent has its code' });
  });
  await page.goto(authorize.toString());
  await expect(page.getByRole('heading', { name: 'Authorize access' })).toBeVisible();
  await expect(page.getByText('walk agent wants to access your workspace.')).toBeVisible();
  await shot(page, 'agent-consent');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL(`${redirect}**`, { timeout: 15_000 });
  expect(code, 'the consent handed the agent a code').not.toBe('');

  const token = await r.post(`${SL}/api/v1/auth/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${SL}/mcp`
    }
  });
  expect(token.status(), 'the token exchange').toBe(200);
  state.mcpBearer = ((await token.json()) as { access_token: string }).access_token;

  const mcp = async (body: unknown) => {
    const res = await r.post(`${SL}/mcp`, {
      headers: {
        authorization: `Bearer ${state.mcpBearer}`,
        ...json,
        accept: 'application/json, text/event-stream'
      },
      data: body
    });
    expect(res.status(), 'the MCP endpoint answers').toBe(200);
    const line = (await res.text())
      .split('\n')
      .map((l) => l.replace(/^data: /, ''))
      .find((l) => l.startsWith('{'));
    return JSON.parse(line!) as {
      result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
    };
  };
  const tools = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = tools.result.tools!.map((t) => t.name);
  expect(names).toContain('get_me');
  expect(names).toContain('starter_whoami');
  expect(names).toContain('starter_list_items');
  const who = await mcp({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'starter_whoami', arguments: {} }
  });
  const whoText = JSON.parse(who.result.content![0]!.text) as {
    user: { email: string };
    workspace: { hubOrigin: boolean };
  };
  expect(whoText.user.email, 'the agent acts as the person who approved').toBe(OWNER);
  expect(whoText.workspace.hubOrigin).toBe(true);
  writeFileSync(path.join(SHOTS, 'mcp-tools.txt'), names.join('\n'));
  await r.dispose();
});

test('9. a priced action on an empty balance: the top-up card on the item dialog, the 402 on the key', async ({
  playwright
}) => {
  // Staff seeds the price book from the tool's discovery and empties the balance.
  const hub = await hubOwner(await playwright.request.newContext());
  const seed = await hub.post(`${HUB}/api/v1/admin/billing/prices/seed`, {
    headers: { origin: HUB!, ...idem(), ...json },
    data: { toolSlug: TOOL }
  });
  expect(seed.status(), 'the price book seeded from discovery').toBe(200);
  const account = (await (
    await hub.get(`${HUB}/api/v1/billing/account`, { headers: hubHeaders() })
  ).json()) as {
    accountId: string;
    balance: number;
  };
  state.accountId = account.accountId;
  const drain = await hub.post(`${HUB}/api/v1/admin/billing/accounts/${state.accountId}/grant`, {
    headers: { origin: HUB!, ...idem(), ...json },
    data: { credits: -account.balance, reason: 'the walk empties the balance for the top-up card' }
  });
  expect(drain.status()).toBe(201);
  expect(((await drain.json()) as { balance: number }).balance).toBe(0);

  await page.goto(`${SL}/items`);
  await page.getByRole('button', { name: 'New item' }).first().click();
  await page.getByRole('dialog').getByLabel('Name').fill('Field notes');
  const toast = await nextToast(
    page,
    () => page.getByRole('dialog').getByRole('button', { name: 'New item' }).click(),
    'Not enough credits'
  );
  expect(toast.text).toContain('Not enough credits');
  expect(toast.text).toContain('This needs 1 credits; your organization holds 0.');
  expect(toast.buttons).toContain('Top up');
  await shot(page, 'item-top-up-card');

  const r = page.context().request;
  const refused = await r.post(`${SL}/api/v1/items`, {
    headers: { authorization: `Bearer ${state.walkKey}`, 'x-workspace-id': state.workspaceId, ...json },
    data: { name: 'Field notes' }
  });
  expect(refused.status()).toBe(402);
  const body = (await refused.json()) as {
    error: { code: string; details: { credits: number; balance: number; topUpUrl: string } };
  };
  expect(body.error.code).toBe('entitlement_denied');
  expect(body.error.details.credits).toBe(1);
  expect(body.error.details.balance).toBe(0);
  expect(body.error.details.topUpUrl.startsWith(`${HUB}/billing/top-up?org=${state.orgId}`)).toBe(true);
  await hub.dispose();
});

test('10. the free cap: the hundred-and-first item meets the upgrade card, and the agent the same refusal', async ({
  playwright
}) => {
  test.setTimeout(180_000);
  const hub = await hubOwner(await playwright.request.newContext());
  const restore = await hub.post(`${HUB}/api/v1/admin/billing/accounts/${state.accountId}/grant`, {
    headers: { origin: HUB!, ...idem(), ...json },
    data: { credits: 5000, reason: 'the walk restores the balance' }
  });
  expect(restore.status()).toBe(201);
  await hub.dispose();
  // The denial is remembered five seconds; the allowed answer thirty, for any smaller quantity.
  await pause(6_000);

  const r = await playwright.request.newContext();
  const h = { authorization: `Bearer ${state.walkKey}`, 'x-workspace-id': state.workspaceId, ...json };
  let created = 0;
  let refusal: { status: number; body: string } | null = null;
  // Paced under the chassis's burst cap (a hundred requests per principal per
  // second): an idle machine creates an item in under ten milliseconds, and the
  // hundred-and-first would then read the cap's 429, not the plan's 403.
  for (let n = 1; n <= 101 && !refusal; n++) {
    const res = await r.post(`${SL}/api/v1/items`, { headers: h, data: { name: `Field note ${n}` } });
    if (res.status() === 201) created += 1;
    else refusal = { status: res.status(), body: await res.text() };
    await pause(25);
  }
  expect(created, 'the free plan allows a hundred items').toBe(100);
  expect(refusal?.status, 'the hundred-and-first is refused').toBe(403);
  expect(refusal?.body).toContain('plan_required');
  expect(refusal?.body).toContain('items.perWorkspace');
  await r.dispose();

  await page.goto(`${SL}/items`);
  await page.getByRole('button', { name: 'New item' }).first().click();
  await page.getByRole('dialog').getByLabel('Name').fill('Field note 101');
  const toast = await nextToast(
    page,
    () => page.getByRole('dialog').getByRole('button', { name: 'New item' }).click(),
    'This needs a higher plan'
  );
  expect(toast.text).toContain('This needs a higher plan');
  expect(toast.text).toContain('The pro plan allows it.');
  expect(toast.buttons).toContain('Upgrade the plan');
  await shot(page, 'item-upgrade-card');

  const agentContext = await playwright.request.newContext();
  const agent = await agentContext.post(`${SL}/mcp`, {
    headers: {
      authorization: `Bearer ${state.mcpBearer}`,
      ...json,
      accept: 'application/json, text/event-stream'
    },
    data: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'starter_create_item',
        arguments: { workspace: state.workspaceId, name: 'Field note 101' }
      }
    }
  });
  const text = await agent.text();
  expect(text).toContain('"isError":true');
  expect(text).toContain('plan_required');
  expect(text).toContain(`${HUB}/billing/upgrade?org=${state.orgId}`);
  await agentContext.dispose();
});

test('11. sign out ends the session on both sides; a returning person lands straight on the overview', async ({
  playwright
}) => {
  await page.goto(`${SL}/`);
  const r = page.context().request;
  expect(await whoAmI(r, HUB!), 'the hub holds the owner').toBe(OWNER);
  await page.getByRole('button', { name: OWNER }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((u) => u.pathname === '/login' && u.searchParams.get('signed_out') === '1', {
    timeout: 30_000
  });
  await expect(page.getByText('You have been signed out.')).toBeVisible();
  expect(await whoAmI(r, SL!), 'the tool holds nobody').toBeNull();
  expect(await whoAmI(r, HUB!), 'the hub holds nobody either').toBeNull();
  const machine = await playwright.request.newContext();
  const keyAfter = await machine.get(`${SL}/api/v1/items?limit=1`, {
    headers: { authorization: `Bearer ${state.walkKey}`, 'x-workspace-id': state.workspaceId }
  });
  expect(keyAfter.status(), 'the API key outlives the browser’s sign-out').toBe(200);
  const agentAfter = await machine.post(`${SL}/mcp`, {
    headers: {
      authorization: `Bearer ${state.mcpBearer}`,
      ...json,
      accept: 'application/json, text/event-stream'
    },
    data: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }
  });
  expect(agentAfter.status(), 'the agent’s grant outlives the browser’s sign-out').toBe(200);
  await machine.dispose();
  await shot(page, 'signed-out');

  await pause(11_000);
  await sso(page, OWNER, OWNER_PASSWORD!);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(ORG);
  await shot(page, 'returning-person');
});

test('12. a member whose organization closes the tool meets the refusal page, and is admitted once seated', async ({
  browser,
  playwright
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const member = await context.newPage();
  const hub = await hubOwner(await playwright.request.newContext());
  const access = async (data: unknown) => {
    const res = await hub.put(`${HUB}/api/v1/tool-access/${TOOL}`, { headers: hubHeaders(), data });
    expect(res.status(), 'the organization chooses who may use the tool').toBe(200);
  };
  try {
    await sso(member, B, B_PASSWORD!);
    await expect(member.getByRole('button', { name: 'Switch workspace' })).toContainText(ORG);
    expect(await whoAmI(context.request, SL!)).toBe(B);

    // The organization opens the tool to Field Research only; Sam is not on it.
    await access({ mode: 'teams', teamIds: [state.teamId] });
    // The tool reads the organization as the person, a few seconds apart: the
    // next visit past the reconcile window lands on the refusal page.
    await expect
      .poll(
        async () => {
          await member.goto(`${SL}/`);
          await member.waitForLoadState('networkidle').catch(() => {});
          return new URL(member.url()).pathname;
        },
        { timeout: 60_000, intervals: [5_000] }
      )
      .toBe('/no-organization');
    await expect(member.getByText(`is not open to you in ${ORG}`)).toBeVisible();
    await expect(member.getByText(`${ORG} lets only some of its teams use`)).toBeVisible();
    await shot(member, 'refusal-page');

    const seat = await hub.put(`${HUB}/api/v1/teams/${state.teamId}/members/${state.memberIds[B]}`, {
      headers: hubHeaders()
    });
    expect(seat.status(), 'Sam seated on Field Research').toBe(200);
    // The page checks again every ten seconds and opens the workspace by itself.
    await member.waitForURL((u) => u.pathname !== '/no-organization', { timeout: 60_000 });
    await expect(member.getByRole('button', { name: 'Switch workspace' })).toContainText(ORG);
    expect(await whoAmI(context.request, SL!)).toBe(B);
    await shot(member, 'readmitted');
  } finally {
    await access({ mode: 'everyone' });
    await hub.dispose();
    await context.close();
  }
});

test('13. a hub demo link opened in a browser that holds another person lands as the named person', async ({
  browser,
  playwright
}) => {
  const hub = await hubOwner(await playwright.request.newContext());
  const mint = async (email: string) => {
    const res = await hub.post(`${HUB}/api/v1/demo/passes`, {
      headers: hubHeaders(),
      data: { email, path: '/items', toolSlug: TOOL, expiresInMinutes: 30 }
    });
    expect(res.status(), `a demo link for ${email}`).toBe(201);
    return ((await res.json()) as { url: string }).url;
  };
  const linkA = await mint(A);
  const linkB = await mint(B);
  await hub.dispose();

  const context = await browser.newContext();
  const member = await context.newPage();
  const open = async (link: string) => {
    await member.goto(link);
    await member.waitForURL((u) => u.origin === new URL(SL!).origin && !u.pathname.startsWith('/login'), {
      timeout: 30_000
    });
    await member.waitForLoadState('networkidle').catch(() => {});
  };
  try {
    await open(linkA);
    expect(await whoAmI(context.request, SL!), 'the tool after Jonas’s link').toBe(A);
    expect(await whoAmI(context.request, HUB!), 'the hub after Jonas’s link').toBe(A);
    await open(linkB);
    expect(new URL(member.url()).pathname, 'the link opens the page it names').toBe('/items');
    expect(await whoAmI(context.request, HUB!), 'the hub after Sam’s link').toBe(B);
    expect(await whoAmI(context.request, SL!), 'the tool after Sam’s link').toBe(B);
    await shot(member, 'demo-link-landing');
  } finally {
    await context.close();
  }
});

test('14. the workspace export, kept on the record for the replica test', async () => {
  // The owner's page is signed in again since step 11.
  const res = await page.context().request.get(`${SL}/api/v1/workspace/export`, {
    headers: { origin: SL!, 'x-workspace-id': state.workspaceId }
  });
  expect(res.status(), 'the owner exports the workspace').toBe(200);
  expect(res.headers()['content-type']).toContain('application/zip');
  const zip = await res.body();
  expect(zip.length).toBeGreaterThan(0);
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, 'workspace-export.zip');
  writeFileSync(file, zip);
  const entry = <T>(name: string): T => {
    const out = spawnSync('unzip', ['-p', file, name], { encoding: 'utf8' });
    expect(out.status, `${name} is in the export`).toBe(0);
    return JSON.parse(out.stdout) as T;
  };
  const items = entry<Record<string, unknown>[]>('items.json');
  expect(items, 'the hundred items of the walk').toHaveLength(100);
  const columns = Object.keys(items[0]!).sort();
  expect(columns, 'the seven selected columns').toEqual(
    ['createdAt', 'createdBy', 'id', 'name', 'note', 'updatedAt', 'workspaceId'].sort()
  );
  expect(items.every((i) => Object.keys(i).length === 7 && i.workspaceId === state.workspaceId)).toBe(true);
  expect(entry<unknown[]>('item_projects.json')).toEqual([]);
  const members = entry<{ email: string }[]>('members.json')
    .map((m) => m.email)
    .sort();
  expect(members, 'the three people who signed in here').toEqual([OWNER, A, B].sort());
  const teams = entry<{ name: string; hubTeamId: string | null }[]>('teams.json');
  expect(teams.map((t) => t.name)).toEqual(['Field Research']);
  expect(teams[0]!.hubTeamId, 'a projected team carries its hub id').not.toBeNull();
  expect(entry<unknown[]>('team_members.json'), 'the two seats the sign-ins projected').toHaveLength(2);

  // The same seats on the tool's own teams read, as the owner.
  const list = (await (
    await page.context().request.get(`${SL}/api/v1/teams`, {
      headers: { origin: SL!, 'x-workspace-id': state.workspaceId }
    })
  ).json()) as { teams: { id: string; name: string }[] };
  const team = list.teams.find((t) => t.name === 'Field Research')!;
  const seats = (await (
    await page.context().request.get(`${SL}/api/v1/teams/${team.id}/members`, {
      headers: { origin: SL!, 'x-workspace-id': state.workspaceId }
    })
  ).json()) as { members: { email: string }[] };
  expect(seats.members.map((m) => m.email).sort()).toEqual([A, B].sort());
});
