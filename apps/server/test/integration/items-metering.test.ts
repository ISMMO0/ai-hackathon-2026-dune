import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { declaredCredits, type UsageEvent } from '@antasphere/chassis-contract';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { IDENTITY } from '@app/contract';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The billing rail on the placeholder tool (PRDCT-2648): the `entitlements`
 * slot of `src/tool.ts` over the route declarations of `@app/contract/routes`,
 * through the REAL boot, on both editions.
 *
 *  - The self-hosted edition (oss): discovery shows the declared slot with
 *    the operator's cap as the oss and free values; an item created and a
 *    file uploaded answer as before and NO event leaves the instance (the
 *    downstream is asked nothing); an upload declared over the cap answers
 *    413 entitlement_denied, the credit check's message byte for byte.
 *  - The cloud edition, against the fake hub of the chassis test kit (it
 *    speaks the hub's contract verbatim): the operator's cloud-local workspace
 *    is unmetered; an item created by a hub user lands in the hub's
 *    usage_events with the hub user's sub, the via of each credential (the
 *    dashboard's session, the CLI's API key, an agent's MCP call), the item
 *    it created, and one machine token minted for the whole run; the body
 *    never names the tool; an upload over the cap answers 403 plan_required
 *    with the upgrade link, the header alone proving it, and posts nothing.
 *
 * Phases 2 and 3 of the rail add three things this file pins on the tool:
 *
 *  - The check goes live (PRDCT-2664): before a priced action the gate asks
 *    the hub whether the organization holds the credits, with the machine
 *    token; a short balance answers 402 entitlement_denied with the top-up
 *    link on the three surfaces and posts nothing, an unpriced action is
 *    checked and allowed at 0 credits, and a hub that does not answer the
 *    check fails open, visible on /metrics, until it answers again.
 *  - A metered upload declares its size (PRDCT-2652): a hub organization's
 *    upload with no Content-Length answers 411 length_required before the
 *    handler; the operator's cloud-local workspace and a self-hosted
 *    instance demand nothing, and neither does the item create, whose limit
 *    is a count on a JSON route.
 *  - The item create carries the count limit (PRDCT-2863), so the gate reads
 *    the plan on it; the count itself is pinned in plan-limits.test.ts.
 *
 * The chassis's own suite (`packages/chassis-server/test/integration/
 * entitlements.test.ts`) pins the poster's retries, the held queue and the
 * fake hub's judgement; this file pins the TOOL's declaration.
 */

const OWNER = { email: 'owner@meter.test', name: 'Meter Owner', password: 'meter-owner-password-1' };
const OPERATOR = { email: 'operator@meter.test', name: 'Operator', password: 'operator-meter-pass-1' };
const ORG_A = '77777777-aaaa-4bbb-8ccc-00000000ab01';
const ORG_TIGHT = '77777777-aaaa-4bbb-8ccc-00000000ab02';
const HUB_CLIENT_ID = 'tool-starter-cloud';
const HUB_SECRET = 'integration-test-hub-secret-meter';
const PAYLOAD = 'The quick brown fox jumps over the lazy dog'; // 43 bytes
const MB = 1024 * 1024;
const METRICS_TOKEN = 'integration-metrics-token-meter';

let container: StartedPostgreSqlContainer;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp(), ...headers },
  body: JSON.stringify(body)
});

/** An upload as a client sends it on the wire: the bytes with their Content-Length (a header passed in wins). */
function upload(app: TestApp, headers: Record<string, string>, text: string) {
  return app.app.request(`/api/v1/files?name=${encodeURIComponent('fox.txt')}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'content-length': String(Buffer.byteLength(text)),
      'x-forwarded-for': sso.nextIp(),
      ...headers
    },
    body: text
  });
}

function createItem(app: TestApp, headers: Record<string, string>, name: string) {
  return app.app.request('/api/v1/items', json({ name }, headers));
}

let rpcId = 0;
/** One MCP tool call, in process, as an agent makes it: the tool re-enters /api/v1 as the key. */
async function mcpTool(app: TestApp, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': sso.nextIp(),
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error).toBeUndefined();
  const text: string = body.result.content?.[0]?.text ?? '';
  return { isError: body.result.isError === true, text };
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 2_500)); // longer than the queue's poll

/**
 * The durable side of a negative: how many usage jobs were ever sent on this
 * instance (pg-boss keeps a completed job in its table until the archive
 * sweep, hours later). A sleep alone can pass while a slow worker has not
 * fetched yet; a row count cannot.
 */
async function usageJobsSent(app: TestApp): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'usage-events'"
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('the self-hosted edition: the slot is shown, nothing is metered', () => {
  let app: TestApp;
  let cookie: string;
  const downstream: UsageEvent[] = [];

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'meter_oss'),
      { MAX_FILE_SIZE_MB: '1' },
      { usageDownstream: { emit: async (e) => void downstream.push(e) } }
    );
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Meter', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    cookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('discovery shows the two actions, the cap as every tier’s value (free is 100 MB, or the cap when the cap is smaller), the one feature', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.entitlements.actions).toEqual([
      { key: 'items.create', creditsPerUnit: 1, unit: 'call', label: 'Create an item' },
      {
        key: 'files.upload',
        creditsPerUnit: 5,
        unit: 'bytes',
        per: MB,
        label: 'Upload a file (5 credits per MB)'
      }
    ]);
    // At a 1 MB cap every tier is the cap: the boot refuses a tier advertised above the instance's ceiling.
    // The two count limits do not move with the cap: unlimited on a self-hosted instance and on pro.
    expect(info.entitlements.limits).toEqual({
      'files.maxBytes': { oss: MB, free: MB, pro: MB },
      'items.perWorkspace': { oss: null, free: 100, pro: null },
      'workspace.members': { oss: null, free: 3, pro: null }
    });
    expect(info.entitlements.features).toEqual({ 'items.premium': { free: false, pro: true } });
  });

  it('the upload is priced per MB, never per byte: a 20 MB upload is 100 credits', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    const action = info.entitlements.actions.find((a: { key: string }) => a.key === 'files.upload');
    expect(declaredCredits(action, 20 * MB)).toBe(100);
  });

  it('an item created and a file uploaded answer as before, and no event leaves the instance', async () => {
    const created = await createItem(app, { cookie }, 'Unmetered');
    expect(created.status).toBe(201);
    const uploaded = await upload(app, { cookie }, PAYLOAD);
    expect(uploaded.status).toBe(201);
    expect((await readJson(uploaded)).file.sizeBytes).toBe(43);
    await settle();
    expect(downstream).toEqual([]);
    expect(await usageJobsSent(app)).toBe(0);
  });

  it('an upload with no Content-Length still lands (201): a self-hosted instance demands no size, nothing leaves', async () => {
    // A string body gets no Content-Length from app.request: the header is
    // absent, as from a client streaming a body of unknown length.
    const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent('fox.txt')}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', 'x-forwarded-for': sso.nextIp() },
      body: PAYLOAD
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await readJson(res)).file.sizeBytes).toBe(Buffer.byteLength(PAYLOAD));
    await settle();
    expect(downstream).toEqual([]);
    expect(await usageJobsSent(app)).toBe(0);
  });

  it('an upload declared over the cap answers 413 entitlement_denied, the credit check’s message byte for byte', async () => {
    const res = await upload(app, { cookie, 'content-length': String(MB + 1) }, 'x'.repeat(MB + 1));
    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({
      error: { code: 'entitlement_denied', message: 'file exceeds MAX_FILE_SIZE_MB (1MB)' }
    });
    await settle();
    expect(downstream).toEqual([]);
    expect(await usageJobsSent(app)).toBe(0);
  });
});

describe('the cloud edition: every metered action of a hub organization lands in the hub', () => {
  let hub: FakeHub;
  let app: TestApp;
  let operatorCookie: string;
  let person: { cookie: string; workspaceId: string; key: string; sub: string; localUserId: string };

  const events = () => [...hub.usageEvents.values()];

  /** The upgrade link of a plan refusal: the hub's page for the organization, the refused key appended, the required plan when one exists. */
  function expectedUpgradeUrl(org: string, plan: string, key: string, requiredPlan: string | null): string {
    const url = new URL(`${hub.issuer}/billing/upgrade`);
    url.searchParams.set('org', org);
    url.searchParams.set('tool', hub.toolSlug);
    url.searchParams.set('plan', plan);
    url.searchParams.set('key', key);
    if (requiredPlan !== null) url.searchParams.set('requiredPlan', requiredPlan);
    return url.toString();
  }

  async function hubPerson(fixture: HubUserFixture) {
    const cookie = await sso.ssoLogin(app, hub, fixture);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.workspace.hubOrigin).toBe(true);
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json(
          { name: 'meter-key', scopes: ['items:read', 'items:write'], workspaceId: me.activeWorkspaceId },
          { cookie, 'x-workspace-id': me.activeWorkspaceId }
        )
      )
    );
    return {
      cookie,
      workspaceId: me.activeWorkspaceId as string,
      key: minted.key as string,
      sub: fixture.sub,
      localUserId: me.user.id as string
    };
  }

  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: HUB_CLIENT_ID, clientSecret: HUB_SECRET });
    app = await createTestApp(
      await createDatabase(container, 'meter_cloud'),
      {
        EDITION: 'cloud',
        HUB_ISSUER_URL: hub.issuer,
        HUB_CLIENT_ID,
        HUB_CLIENT_SECRET: HUB_SECRET,
        MAX_FILE_SIZE_MB: '1',
        METRICS_TOKEN
      },
      {
        usageRetry: { limit: 3, delaySeconds: 1 },
        entitlementDials: { ttlMs: 60_000 },
        // Every priced action asks the hub again: a balance set by a case is felt on its next request.
        entitlementCheckDials: { allowTtlMs: 0, denyTtlMs: 0 }
      }
    );
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Meter Cloud', owner: OPERATOR })
    );
    expect(setup.status).toBe(201);
    await sso.seedLocalWorkspace(app, 'Meter Cloud', OPERATOR.email);
    operatorCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OPERATOR.email, password: OPERATOR.password })
      )
    );
    person = await hubPerson({
      sub: 'hub-meter-a',
      email: 'a@meter.test',
      name: 'Meter A',
      workspaceId: ORG_A,
      role: 'owner',
      workspaceName: 'Org A'
    });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    await hub?.stop();
  });

  it('the operator’s cloud-local workspace is unmetered: no plan read, no event', async () => {
    const res = await createItem(app, { cookie: operatorCookie }, 'Operator item');
    expect(res.status).toBe(201);
    expect(hub.entitlementsRequests).toEqual([]);
    await settle();
    expect(hub.usageEvents.size).toBe(0);
    expect(hub.usageRequests).toEqual([]);
    expect(await usageJobsSent(app)).toBe(0);
  });

  it('the dashboard (a session) creates an item: via session, the item it created, the hub sub, one machine token', async () => {
    const res = await createItem(
      app,
      { cookie: person.cookie, 'x-workspace-id': person.workspaceId },
      'Metered'
    );
    expect(res.status).toBe(201);
    const itemId = (await readJson(res)).item.id as string;
    await until(
      () => events().length,
      (n) => n >= 1
    );
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      actionKey: 'items.create',
      quantity: 1,
      unit: 'call',
      workspaceId: person.workspaceId,
      accountRef: ORG_A,
      userId: person.sub,
      via: 'session',
      resourceType: 'item',
      resourceId: itemId,
      source: { edition: 'cloud' }
    });
    // The hub's sub, never the tool's local id.
    expect(events()[0]!.userId).not.toBe(person.localUserId);
    // The positive control of every negative below: the helper counts the
    // queue the chassis really sends on, so a renamed queue cannot leave the
    // negatives green against a dead count.
    expect(await usageJobsSent(app)).toBeGreaterThanOrEqual(1);
    // The body never names the tool: the hub records the token's registry
    // slug, which is not the identity slug, and would refuse a stamped body.
    const posted = (hub.usageRequests[0]!.body as { events: Array<Record<string, unknown>> }).events;
    expect(posted.every((e) => !('toolSlug' in e))).toBe(true);
    expect(hub.toolSlug).toBe('starter-cloud');
    expect(hub.toolSlug).not.toBe(IDENTITY.slug);
    expect(events()[0]).toMatchObject({ toolSlug: 'starter-cloud' });
    // The machine channel: one client_credentials token, minted once, on every hub call.
    expect(hub.machineTokenMints).toBe(1);
    expect(hub.usageRequests[0]!.auth).toMatch(/^Bearer mach_/);
    // The route carries the count limit (items.perWorkspace), so the gate
    // reads the organization's plan once, then serves it from its cache for
    // the 60 s this boot keeps it.
    expect(hub.entitlementsRequests.map((r) => r.accountRef)).toEqual([ORG_A]);
  });

  it('the CLI (an API key, the SDK’s call) creates an item: via api_key, the plan served from the cache', async () => {
    const res = await createItem(app, { authorization: `Bearer ${person.key}` }, 'From the CLI');
    expect(res.status).toBe(201);
    await until(
      () => events().length,
      (n) => n >= 2
    );
    const mine = events().find((e) => e.via === 'api_key');
    expect(mine).toMatchObject({ actionKey: 'items.create', userId: person.sub, accountRef: ORG_A });
    expect(hub.entitlementsRequests.map((r) => r.accountRef)).toEqual([ORG_A]);
    expect(hub.machineTokenMints).toBe(1);
  });

  it('an agent (the MCP tool, in process) creates an item: via api_key, the item it created', async () => {
    const before = events().length;
    const result = await mcpTool(app, person.key, `${IDENTITY.mcp.toolPrefix}create_item`, {
      name: 'From an agent'
    });
    expect(result.isError, result.text).toBe(false);
    await until(
      () => events().length,
      (n) => n >= before + 1
    );
    const mine = events().slice(before);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actionKey: 'items.create', via: 'api_key', resourceType: 'item' });
    expect(mine[0]!.resourceId).toBeTruthy();
    expect(hub.usageRequests.every((r) => /^Bearer mach_/.test(r.auth ?? ''))).toBe(true);
  });

  it('an upload lands in bytes, the bytes actually kept; a free route (the list) is not metered', async () => {
    const before = events().length;
    const listed = await app.app.request('/api/v1/items', {
      headers: { authorization: `Bearer ${person.key}`, 'x-forwarded-for': sso.nextIp() }
    });
    expect(listed.status).toBe(200);
    const res = await upload(app, { authorization: `Bearer ${person.key}` }, PAYLOAD);
    expect(res.status).toBe(201);
    const fileId = (await readJson(res)).file.id as string;
    await until(
      () => events().length,
      (n) => n >= before + 1
    );
    const mine = events().slice(before);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      actionKey: 'files.upload',
      quantity: 43,
      unit: 'bytes',
      via: 'api_key',
      resourceType: 'file',
      resourceId: fileId
    });
  });

  it('an upload declared over the cap on the free profile answers 403 plan_required with the upgrade link, the header alone proving it, and posts nothing', async () => {
    // At this instance's 1 MB cap the pro value is the cap too, so no plan
    // allows the size and none is named: `requiredPlan` is null. On an instance
    // capped above 100 MB the same refusal names `pro`.
    const posts = hub.usageRequests.length;
    const size = hub.usageEvents.size;
    const sent = await usageJobsSent(app);
    const res = await upload(
      app,
      { cookie: person.cookie, 'x-workspace-id': person.workspaceId, 'content-length': String(MB + 1) },
      'x'.repeat(MB + 1)
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toEqual({
      key: 'files.maxBytes',
      plan: 'free',
      requiredPlan: null,
      upgradeUrl: expectedUpgradeUrl(ORG_A, 'free', 'files.maxBytes', null)
    });
    await settle();
    expect(hub.usageRequests).toHaveLength(posts);
    expect(hub.usageEvents.size).toBe(size);
    expect(await usageJobsSent(app)).toBe(sent);
  });

  it('a paid account above the cap meets 403 plan_required too, with no plan to name: no tier is advertised above the instance’s ceiling, no event', async () => {
    // The `pro` value IS the cap (the boot refuses a tier above it), so a paid
    // account declaring more than the cap is refused by the plan gate like a
    // free one, and no higher plan can be named: `requiredPlan` is null and the
    // message stops at the limit. The paid tier above the free one exists only
    // on an instance whose cap is above 100 MB, where free stays at 100 MB.
    const ORG_PRO = '77777777-aaaa-4bbb-8ccc-00000000ab03';
    hub.setEntitlements(ORG_PRO, { plan: 'pro' });
    const pro = await hubPerson({
      sub: 'hub-meter-pro',
      email: 'pro@meter.test',
      name: 'Meter Pro',
      workspaceId: ORG_PRO,
      role: 'owner',
      workspaceName: 'Org Pro'
    });
    const sent = await usageJobsSent(app);
    const size = hub.usageEvents.size;
    const res = await upload(
      app,
      { authorization: `Bearer ${pro.key}`, 'content-length': String(2 * MB) },
      'x'.repeat(2 * MB)
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.message).toBe(`files.maxBytes is limited to ${MB} on the pro plan`);
    expect(body.error.details).toEqual({
      key: 'files.maxBytes',
      plan: 'pro',
      requiredPlan: null,
      upgradeUrl: expectedUpgradeUrl(ORG_PRO, 'pro', 'files.maxBytes', null)
    });
    await settle();
    expect(hub.usageEvents.size).toBe(size);
    expect(await usageJobsSent(app)).toBe(sent);
  });

  it('a limit the hub tightens on an account refuses that account with a session and with an API key; its item creation, whose count is far under the cap, still lands', async () => {
    hub.setEntitlements(ORG_TIGHT, { plan: 'free', limits: { 'files.maxBytes': 10 } });
    const tight = await hubPerson({
      sub: 'hub-meter-tight',
      email: 'tight@meter.test',
      name: 'Meter Tight',
      workspaceId: ORG_TIGHT,
      role: 'owner',
      workspaceName: 'Org Tight'
    });
    const size = hub.usageEvents.size;
    const session = await upload(app, { cookie: tight.cookie, 'x-workspace-id': tight.workspaceId }, PAYLOAD);
    expect(session.status).toBe(403);
    expect((await readJson(session)).error.code).toBe('plan_required');
    const key = await upload(app, { authorization: `Bearer ${tight.key}` }, PAYLOAD);
    expect(key.status).toBe(403);
    // The hub tightened the upload cap only; the item count is far under its cap, so the create lands.
    const item = await createItem(app, { authorization: `Bearer ${tight.key}` }, 'Tight but allowed');
    expect(item.status).toBe(201);
    await until(
      () => events().filter((e) => e.accountRef === ORG_TIGHT).length,
      (n) => n >= 1
    );
    expect(
      events()
        .filter((e) => e.accountRef === ORG_TIGHT)
        .map((e) => e.actionKey)
    ).toEqual(['items.create']);
    expect(hub.usageEvents.size).toBe(size + 1);
  });

  /** One exposition line of /metrics, read with the operator's token; 0 when the series is absent. */
  const metric = async (name: string): Promise<number> => {
    const res = await app.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(200);
    const line = (await res.text())
      .split('\n')
      .find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
    return line ? Number(line.split(' ').at(-1)) : 0;
  };

  const debitsOf = (org: string) => hub.ledger.filter((l) => l.kind === 'debit' && l.accountRef === org);

  describe('the check goes live: the hub is asked before a priced action (PRDCT-2664)', () => {
    // Runs after every case above: the price set here is the hub's price book
    // for the rest of the file. The upload stays unpriced on purpose, the
    // shape of an action the hub has not priced yet.
    const ORG_CHECK = '77777777-aaaa-4bbb-8ccc-00000000ab04';
    let checker: typeof person;
    const eventsOf = () => events().filter((e) => e.accountRef === ORG_CHECK);
    const dashboard = () => ({ cookie: checker.cookie, 'x-workspace-id': checker.workspaceId });
    const topUpUrl = (credits: number, balance: number) =>
      `${hub.issuer}/billing/top-up?org=${ORG_CHECK}&credits=${credits}&balance=${balance}&tool=${hub.toolSlug}&action=items.create`;

    beforeAll(async () => {
      hub.setPrice('items.create', { creditsPerUnit: 1, unit: 'call' });
      checker = await hubPerson({
        sub: 'hub-meter-check',
        email: 'check@meter.test',
        name: 'Meter Check',
        workspaceId: ORG_CHECK,
        role: 'owner',
        workspaceName: 'Org Check'
      });
    });

    const expectShort = async (res: Response) => {
      expect(res.status).toBe(402);
      const body = await readJson(res);
      expect(body.error.code).toBe('entitlement_denied');
      expect(body.error.details).toEqual({ credits: 1, balance: 0, topUpUrl: topUpUrl(1, 0) });
      expect(body.error.details.topUpUrl.startsWith(`${hub.issuer}/billing/top-up?org=${ORG_CHECK}`)).toBe(
        true
      );
      expect(body.error.message).toContain(topUpUrl(1, 0));
    };

    it('the dashboard creates an item: the hub is asked with the machine token, then debits the call at ingest', async () => {
      // The first read of a balance seeds the signup grant, so read it before the create.
      const balance = hub.balanceOf(ORG_CHECK);
      const checks = hub.checkRequests.length;
      const res = await createItem(app, dashboard(), 'Checked');
      expect(res.status, await res.clone().text()).toBe(201);
      const itemId = (await readJson(res)).item.id as string;
      expect(hub.checkRequests).toHaveLength(checks + 1);
      expect(hub.checkRequests.at(-1)).toEqual({
        auth: expect.stringMatching(/^Bearer mach_/),
        body: { accountRef: ORG_CHECK, actionKey: 'items.create', quantity: 1, unit: 'call' }
      });
      await until(
        () => debitsOf(ORG_CHECK).length,
        (n) => n >= 1
      );
      const [eventId, event] = [...hub.usageEvents.entries()].find(([, e]) => e.accountRef === ORG_CHECK)!;
      expect(event).toMatchObject({ actionKey: 'items.create', resourceId: itemId });
      expect(hub.balanceOf(ORG_CHECK)).toBe(balance - 1);
      expect(debitsOf(ORG_CHECK)).toEqual([
        { accountRef: ORG_CHECK, kind: 'debit', amount: -1, sourceRef: eventId }
      ]);
    });

    it('a balance below the price: the dashboard meets 402 entitlement_denied with the top-up link, and nothing is posted', async () => {
      hub.setBalance(ORG_CHECK, 0);
      const posted = hub.usageEvents.size;
      const sent = await usageJobsSent(app);
      await expectShort(await createItem(app, dashboard(), 'Short'));
      await settle();
      expect(hub.usageEvents.size).toBe(posted);
      expect(await usageJobsSent(app)).toBe(sent);
      expect(hub.balanceOf(ORG_CHECK)).toBe(0);
    });

    it('the CLI (an API key): the same 402 with the same details', async () => {
      await expectShort(await createItem(app, { authorization: `Bearer ${checker.key}` }, 'Short CLI'));
    });

    it('an agent (the MCP tool): the text names the code, the top-up link, the price and the balance, and nothing is posted', async () => {
      const posted = hub.usageEvents.size;
      const result = await mcpTool(app, checker.key, `${IDENTITY.mcp.toolPrefix}create_item`, {
        name: 'Short agent'
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('code: entitlement_denied');
      // The gate's own message carries the link and the numbers; the MCP text
      // adds no second sentence, so the URL appears exactly once.
      expect(result.text).toContain(`top up at ${hub.issuer}/billing/top-up?org=${ORG_CHECK}`);
      expect(result.text.split(`${hub.issuer}/billing/top-up`).length - 1).toBe(1);
      expect(result.text).toContain('This needs 1 credits and the organization holds 0');
      await settle();
      expect(hub.usageEvents.size).toBe(posted);
    });

    it('at the empty balance a guest reads the handler’s 403 guest_forbidden, never the host’s balance, and the hub is not asked', async () => {
      // The count hook answers null for a guest, and that null ends the gate's
      // judgement: no plan, no credit check, so the host organization's balance
      // and top-up link never reach a caller the handler refuses (the chassis at
      // slideless@326d5ff; the template's feedback of 29 September 2026).
      const guest = await hubPerson({
        sub: 'hub-meter-check-guest',
        email: 'guest@meter.test',
        name: 'Meter Guest',
        workspaceId: ORG_CHECK,
        role: 'member',
        workspaceName: 'Org Check'
      });
      expect(guest.workspaceId).toBe(checker.workspaceId);
      await app.db.pool.query(
        "UPDATE workspace_members SET origin = 'guest' WHERE user_id = $1 AND workspace_id = $2",
        [guest.localUserId, guest.workspaceId]
      );
      hub.setBalance(ORG_CHECK, 0);
      const checks = hub.checkRequests.length;
      const posted = hub.usageEvents.size;
      const res = await createItem(
        app,
        { cookie: guest.cookie, 'x-workspace-id': guest.workspaceId },
        'Guest'
      );
      expect(res.status, await res.clone().text()).toBe(403);
      const body = await readJson(res);
      expect(body.error.code).toBe('guest_forbidden');
      expect(body.error.details).toBeUndefined();
      expect(hub.checkRequests).toHaveLength(checks);
      await settle();
      expect(hub.usageEvents.size).toBe(posted);
    });

    it('at the empty balance a member naming a project they are not on reads the handler’s 404, never the balance', async () => {
      const project = await app.app.request('/api/v1/projects', json({ name: 'Owner only' }, dashboard()));
      expect(project.status, await project.clone().text()).toBe(201);
      const projectId = (await readJson(project)).id as string;
      const member = await hubPerson({
        sub: 'hub-meter-check-member',
        email: 'member@meter.test',
        name: 'Meter Member',
        workspaceId: ORG_CHECK,
        role: 'member',
        workspaceName: 'Org Check'
      });
      hub.setBalance(ORG_CHECK, 0);
      const checks = hub.checkRequests.length;
      const res = await app.app.request(
        '/api/v1/items',
        json(
          { name: 'Probe', projectIds: [projectId] },
          { cookie: member.cookie, 'x-workspace-id': member.workspaceId }
        )
      );
      expect(res.status, await res.clone().text()).toBe(404);
      const body = await readJson(res);
      expect(body.error.code).toBe('project_not_found');
      // The handler's own details: the id the caller named, nothing of the balance.
      expect(body.error.details).toEqual({ projectId });
      expect(hub.checkRequests).toHaveLength(checks);
    });

    it('the balance restored, the dashboard create lands and is debited once more', async () => {
      hub.setBalance(ORG_CHECK, 5_000);
      const debits = debitsOf(ORG_CHECK).length;
      const res = await createItem(app, dashboard(), 'Restored');
      expect(res.status, await res.clone().text()).toBe(201);
      await until(
        () => debitsOf(ORG_CHECK).length,
        (n) => n >= debits + 1
      );
      expect(debitsOf(ORG_CHECK)).toHaveLength(debits + 1);
      expect(hub.balanceOf(ORG_CHECK)).toBe(4_999);
    });

    it('an upload with no price row is checked and allowed at 0 credits: no debit, the balance unmoved', async () => {
      const balance = hub.balanceOf(ORG_CHECK);
      const debits = debitsOf(ORG_CHECK).length;
      const checks = hub.checkRequests.length;
      const res = await upload(app, dashboard(), PAYLOAD);
      expect(res.status, await res.clone().text()).toBe(201);
      const fileId = (await readJson(res)).file.id as string;
      expect(hub.checkRequests).toHaveLength(checks + 1);
      expect(hub.checkRequests.at(-1)).toEqual({
        auth: expect.stringMatching(/^Bearer mach_/),
        // The declared Content-Length is what the gate asks with.
        body: { accountRef: ORG_CHECK, actionKey: 'files.upload', quantity: 43, unit: 'bytes' }
      });
      await until(
        () => eventsOf().some((e) => e.actionKey === 'files.upload'),
        (landed) => landed
      );
      const [uploadId, event] = [...hub.usageEvents.entries()].find(
        ([, e]) => e.accountRef === ORG_CHECK && e.actionKey === 'files.upload'
      )!;
      expect(event).toMatchObject({ resourceId: fileId, quantity: 43 });
      // Accepted at 0 credits: no ledger entry carries its id and the balance did not move.
      expect(hub.ledger.some((l) => l.sourceRef === uploadId)).toBe(false);
      expect(debitsOf(ORG_CHECK)).toHaveLength(debits);
      expect(hub.balanceOf(ORG_CHECK)).toBe(balance);
    });

    it('a hub that does not answer the check fails open, on /metrics; once it answers again the posture heals', async () => {
      hub.checkMode = 'network';
      try {
        const down = await createItem(app, dashboard(), 'Hub down');
        expect(down.status, await down.clone().text()).toBe(201);
        expect(await metric('usage_check_posture')).toBe(1);
        expect(await metric('usage_check_total{outcome="fail_open"}')).toBeGreaterThanOrEqual(1);
      } finally {
        hub.checkMode = 'ok';
      }
      // Past the outage hold (5 s from the failed call), the next request asks the hub again.
      await new Promise((r) => setTimeout(r, 5_100));
      const up = await createItem(app, dashboard(), 'Hub up');
      expect(up.status, await up.clone().text()).toBe(201);
      expect(await metric('usage_check_posture')).toBe(0);
    });
  });

  describe('a metered upload declares its size (PRDCT-2652)', () => {
    const ORG_LENGTH = '77777777-aaaa-4bbb-8ccc-00000000ab05';
    let sizer: typeof person;
    const dashboard = () => ({ cookie: sizer.cookie, 'x-workspace-id': sizer.workspaceId });
    // Scoped to this organization: an earlier describe's last event may still be in flight.
    const postedHere = () => events().filter((e) => e.accountRef === ORG_LENGTH).length;

    /** The upload's bytes with no Content-Length: app.request adds none for a string body. */
    const silentUpload = (headers: Record<string, string>) =>
      app.app.request(`/api/v1/files?name=${encodeURIComponent('fox.txt')}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-forwarded-for': sso.nextIp(), ...headers },
        body: PAYLOAD
      });

    const fileCount = async () => {
      const res = await app.app.request('/api/v1/files', {
        headers: { ...dashboard(), 'x-forwarded-for': sso.nextIp() }
      });
      expect(res.status).toBe(200);
      return ((await readJson(res)).files as unknown[]).length;
    };

    beforeAll(async () => {
      sizer = await hubPerson({
        sub: 'hub-meter-length',
        email: 'length@meter.test',
        name: 'Meter Length',
        workspaceId: ORG_LENGTH,
        role: 'owner',
        workspaceName: 'Org Length'
      });
    });

    it('a hub organization’s upload with no Content-Length is 411 length_required: no file, no check, no event', async () => {
      const files = await fileCount();
      const checks = hub.checkRequests.length;
      expect(postedHere()).toBe(0);
      const res = await silentUpload(dashboard());
      expect(res.status).toBe(411);
      expect((await readJson(res)).error.code).toBe('length_required');
      expect(await fileCount()).toBe(files);
      expect(hub.checkRequests).toHaveLength(checks);
      await settle();
      expect(postedHere()).toBe(0);
    });

    it('the operator’s cloud-local workspace uploads with no Content-Length and lands (201): nothing is metered there', async () => {
      const res = await silentUpload({ cookie: operatorCookie });
      expect(res.status, await res.clone().text()).toBe(201);
    });

    it('the hub organization creates an item with no Content-Length and lands (201): a count limit demands no size', async () => {
      // Every json() request of this file already goes out with no
      // Content-Length, so each create above proves it too; this case names
      // the rule: only a size limit (or a meter in bytes) demands the header.
      const res = await createItem(app, dashboard(), 'Sizeless');
      expect(res.status, await res.clone().text()).toBe(201);
    });
  });
});
