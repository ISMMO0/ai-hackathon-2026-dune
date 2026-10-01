import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { UsageEvent } from '@antasphere/chassis-contract';
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
 * The plan's count limit on the template (PRDCT-2863), on the cloud edition
 * against the fake hub: a hundred items per workspace on the free plan
 * (`items.perWorkspace`), refused past the hundredth on the three surfaces
 * with the upgrade link and posting nothing, a deleted item freeing its
 * slot. The cap never says more than the handler would: a guest, and a
 * member naming a project they cannot link into, read the handler's own
 * refusal on a workspace at its cap, never the plan's. The member cap the
 * template declares (`workspace.members`) is the hub's to enforce, since a
 * hub-projected workspace's invitation door is closed here. A pro account
 * passes all of it, and a self-hosted instance knows no count at all.
 *
 * The plan read is stale-while-revalidate (PRDCT-2633): with a zero TTL a
 * change at the hub is served on the request AFTER the one that notices it,
 * so `setPlan` primes the cache with a request that changes nothing (a
 * create naming a project that does not exist: 404, no event) and waits for
 * the refresh.
 */

const OPERATOR = { email: 'operator@planlimits.test', name: 'Operator', password: 'operator-plan-pass-1' };
const OWNER = { email: 'owner@planlimits-oss.test', name: 'Oss Owner', password: 'oss-owner-plan-pass-1' };
const HUB_CLIENT_ID = 'tool-starter-cloud';
const HUB_SECRET = 'integration-test-hub-secret-plans';
const ORG_ITEMS = '88888888-aaaa-4bbb-8ccc-0000000000a1';
const ORG_PRO = '88888888-aaaa-4bbb-8ccc-0000000000a2';
const ORG_NEIGHBOUR = '88888888-aaaa-4bbb-8ccc-0000000000a3';
const ORG_OVERRIDE = '88888888-aaaa-4bbb-8ccc-0000000000a4';
const ITEMS_MESSAGE = 'items.perWorkspace is limited to 100 on the free plan; the pro plan allows it';

let container: StartedPostgreSqlContainer;

const json = (body: unknown, headers: Record<string, string> = {}, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp(), ...headers },
  body: JSON.stringify(body)
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > deadline) return v;
    await sleep(100);
  }
}

async function itemCount(app: TestApp, workspaceId: string): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM items WHERE workspace_id = $1',
    [workspaceId]
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('the cloud edition: the plan counts the items of a hub organization', () => {
  let hub: FakeHub;
  let app: TestApp;

  interface Person {
    cookie: string;
    workspaceId: string;
    key: string;
    sub: string;
    org: string;
    localUserId: string;
  }

  async function hubPerson(fixture: HubUserFixture): Promise<Person> {
    const cookie = await sso.ssoLogin(app, hub, fixture);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.workspace.hubOrigin).toBe(true);
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json(
          { name: 'plan-key', scopes: ['items:read', 'items:write'], workspaceId: me.activeWorkspaceId },
          { cookie, 'x-workspace-id': me.activeWorkspaceId }
        )
      )
    );
    expect(minted.key).toBeTruthy();
    return {
      cookie,
      workspaceId: me.activeWorkspaceId as string,
      key: minted.key as string,
      sub: fixture.sub,
      org: fixture.workspaceId,
      localUserId: me.user.id as string
    };
  }

  const fixture = (
    sub: string,
    org: string,
    email: string,
    role: 'owner' | 'member' = 'owner'
  ): HubUserFixture => ({
    sub,
    email,
    name: sub,
    workspaceId: org,
    role,
    workspaceName: `Org ${org.slice(-2)}`
  });

  const dashboard = (p: Person) => ({ cookie: p.cookie, 'x-workspace-id': p.workspaceId });
  const cli = (p: Person) => ({ authorization: `Bearer ${p.key}` });

  const createItem = (headers: Record<string, string>, body: Record<string, unknown>) =>
    app.app.request('/api/v1/items', json(body, headers));

  /** The upgrade link of a plan refusal (items-metering.test.ts's shape). */
  function expectedUpgradeUrl(org: string, plan: string, key: string, requiredPlan: string | null): string {
    const url = new URL(`${hub.issuer}/billing/upgrade`);
    url.searchParams.set('org', org);
    url.searchParams.set('tool', hub.toolSlug);
    url.searchParams.set('plan', plan);
    url.searchParams.set('key', key);
    if (requiredPlan !== null) url.searchParams.set('requiredPlan', requiredPlan);
    return url.toString();
  }

  let rpcId = 0;
  async function mcpTool(key: string, name: string, args: Record<string, unknown>) {
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

  const events = () => [...hub.usageEvents.values()];
  const eventsOf = (org: string, actionKey: string) =>
    events().filter((e) => e.accountRef === org && e.actionKey === actionKey).length;

  /** Nothing more reaches the hub for this organization and action within the poster's window. */
  async function expectNothingPosted(org: string, actionKey: string, posted: number): Promise<void> {
    await sleep(2_500);
    expect(eventsOf(org, actionKey)).toBe(posted);
  }

  /** A signed-in plan refusal: 403 plan_required with the key, the plans and the upgrade link. */
  async function expectPlanRequired(res: Response, org: string, key: string, message: string): Promise<void> {
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.message).toBe(message);
    expect(body.error.details).toEqual({
      key,
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: expectedUpgradeUrl(org, 'free', key, 'pro')
    });
  }

  /**
   * Change the account's plan at the hub and make the instance read it: one
   * request that reads the plan and changes nothing, then the refresh it
   * started behind it. The prime is an upload declared over the instance's
   * cap: the upload route checks `files.maxBytes`, so the plan is read, and
   * no tier allows more than the cap, so the answer is 403 `plan_required`
   * on free and on pro alike, nothing stored, nothing posted. It must not
   * be a create: a create at the cap is the property this file tests, and a
   * helper every plan switch runs must not assert it (the verifier's round
   * 1: the mutation went red here, and the named cases never ran).
   */
  async function setPlan(person: Person, plan: 'free' | 'pro'): Promise<void> {
    hub.setEntitlements(person.org, { plan });
    const reads = () => hub.entitlementsRequests.filter((r) => r.accountRef === person.org).length;
    const before = reads();
    const posted = eventsOf(person.org, 'items.create');
    const prime = await app.app.request(`/api/v1/files?name=${encodeURIComponent('prime.txt')}`, {
      method: 'POST',
      headers: {
        ...cli(person),
        'content-type': 'text/plain',
        'content-length': String(2 * 1024 * 1024 * 1024),
        'x-forwarded-for': sso.nextIp()
      },
      body: 'prime'
    });
    expect(prime.status, await prime.clone().text()).toBe(403);
    const body = await readJson(prime);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details.key).toBe('files.maxBytes');
    await until(reads, (n) => n > before);
    await sleep(200);
    expect(eventsOf(person.org, 'items.create')).toBe(posted);
  }

  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: HUB_CLIENT_ID, clientSecret: HUB_SECRET });
    app = await createTestApp(
      await createDatabase(container, 'plan_limits_cloud'),
      {
        EDITION: 'cloud',
        HUB_ISSUER_URL: hub.issuer,
        HUB_CLIENT_ID,
        HUB_CLIENT_SECRET: HUB_SECRET
      },
      {
        usageRetry: { limit: 3, delaySeconds: 1 },
        entitlementCheckDials: { allowTtlMs: 0, denyTtlMs: 0 },
        // Every gated request reads the plan again (served stale, refreshed behind: see setPlan).
        entitlementDials: { ttlMs: 0, coldWaitMs: 1_500 }
      }
    );
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Plan Limits', owner: OPERATOR })
    );
    expect(setup.status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    await hub?.stop();
  });

  describe('discovery carries the plan values', () => {
    it('the two count limits and the feature, as the slot declares them', async () => {
      const info = await readJson(await app.app.request('/api/v1/instance'));
      expect(info.entitlements.limits['items.perWorkspace']).toEqual({ oss: null, free: 100, pro: null });
      expect(info.entitlements.limits['workspace.members']).toEqual({ oss: null, free: 3, pro: null });
      expect(info.entitlements.features['items.premium']).toEqual({ free: false, pro: true });
    });
  });

  // The items org is shared by the count describe and the handler describe (the latter needs a full workspace).
  let itemsOwner: Person;

  describe('the items per workspace', () => {
    const created: string[] = [];

    beforeAll(async () => {
      itemsOwner = await hubPerson(fixture('hub-plan-items', ORG_ITEMS, 'items@planlimits.test'));
    });

    it('a hundred items are created, the hundred-and-first is refused with the upgrade link and posts nothing', async () => {
      for (let n = 1; n <= 100; n++) {
        const res = await createItem(cli(itemsOwner), { name: `item-${n}` });
        expect(res.status, await res.clone().text()).toBe(201);
        created.push((await readJson(res)).item.id as string);
      }
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(100);
      await until(
        () => eventsOf(ORG_ITEMS, 'items.create'),
        (n) => n >= 100,
        30_000
      );
      expect(eventsOf(ORG_ITEMS, 'items.create')).toBe(100);
      await expectPlanRequired(
        await createItem(cli(itemsOwner), { name: 'item-101' }),
        ORG_ITEMS,
        'items.perWorkspace',
        ITEMS_MESSAGE
      );
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(100);
      await expectNothingPosted(ORG_ITEMS, 'items.create', 100);
    }, 120_000);

    it('the dashboard and an agent meet the same refusal, and nothing is posted', async () => {
      await expectPlanRequired(
        await createItem(dashboard(itemsOwner), { name: 'item-101-dashboard' }),
        ORG_ITEMS,
        'items.perWorkspace',
        ITEMS_MESSAGE
      );
      const result = await mcpTool(itemsOwner.key, `${IDENTITY.mcp.toolPrefix}create_item`, {
        name: 'item-101-agent'
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('code: plan_required');
      expect(result.text).toContain(
        `Upgrade: ${expectedUpgradeUrl(ORG_ITEMS, 'free', 'items.perWorkspace', 'pro')}`
      );
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(100);
      await expectNothingPosted(ORG_ITEMS, 'items.create', 100);
    });

    it('deleting an item frees its slot: the next create lands, the one after is refused again', async () => {
      const deleted = await app.app.request(`/api/v1/items/${created[0]}`, {
        method: 'DELETE',
        headers: { ...cli(itemsOwner), 'x-forwarded-for': sso.nextIp() }
      });
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(99);
      const res = await createItem(cli(itemsOwner), { name: 'item-after-delete' });
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(100);
      await expectPlanRequired(
        await createItem(cli(itemsOwner), { name: 'item-over-again' }),
        ORG_ITEMS,
        'items.perWorkspace',
        ITEMS_MESSAGE
      );
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(100);
    });

    it('on pro the hundred-and-first item is created', async () => {
      await setPlan(itemsOwner, 'pro');
      const res = await createItem(cli(itemsOwner), { name: 'item-pro' });
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });
  });

  describe('the cap never says more than the handler would', () => {
    let member: Person;
    let projectId: string;

    beforeAll(async () => {
      // Back on free with 101 items: the count alone refuses every create here.
      await setPlan(itemsOwner, 'free');
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
      // A plain member of the same organization, on no project of the owner's.
      member = await hubPerson(
        fixture('hub-plan-items-member', ORG_ITEMS, 'member@planlimits.test', 'member')
      );
      const project = await app.app.request(
        '/api/v1/projects',
        json({ name: 'Owner only' }, dashboard(itemsOwner))
      );
      expect(project.status, await project.clone().text()).toBe(201);
      projectId = (await readJson(project)).id as string;
    });

    it('a guest of the workspace reads the handler’s 403 guest_forbidden, never the plan', async () => {
      const guest = await hubPerson(
        fixture('hub-plan-items-guest', ORG_ITEMS, 'guest@planlimits.test', 'member')
      );
      await app.db.pool.query(
        "UPDATE workspace_members SET origin = 'guest' WHERE user_id = $1 AND workspace_id = $2",
        [guest.localUserId, guest.workspaceId]
      );
      const res = await createItem(dashboard(guest), { name: 'guest item' });
      expect(res.status, await res.clone().text()).toBe(403);
      const body = await readJson(res);
      expect(body.error.code).toBe('guest_forbidden');
      expect(body.error.details).toBeUndefined();
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });

    it('a member naming a project they are not on reads the handler’s 404, never the plan: the project is not probeable through the cap', async () => {
      const res = await createItem(dashboard(member), { name: 'probe', projectIds: [projectId] });
      expect(res.status, await res.clone().text()).toBe(404);
      const body = await readJson(res);
      expect(body.error.code).toBe('project_not_found');
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });

    it('the same member as a viewer of that project still reads the handler’s 404', async () => {
      const added = await app.app.request(
        `/api/v1/projects/${projectId}/members`,
        json({ userId: member.localUserId, role: 'viewer' }, dashboard(itemsOwner))
      );
      expect(added.status, await added.clone().text()).toBe(201);
      const res = await createItem(dashboard(member), { name: 'viewer probe', projectIds: [projectId] });
      expect(res.status, await res.clone().text()).toBe(404);
      expect((await readJson(res)).error.code).toBe('project_not_found');
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });

    it('the member creating with no project reads the plan refusal: the cap is the workspace’s, not the owner’s', async () => {
      await expectPlanRequired(
        await createItem(dashboard(member), { name: 'member at the cap' }),
        ORG_ITEMS,
        'items.perWorkspace',
        ITEMS_MESSAGE
      );
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });

    it('the member refused at the cap on the CLI key and on the MCP tool too; the project probe reads the handler’s 404 on both', async () => {
      await expectPlanRequired(
        await createItem(cli(member), { name: 'member key at the cap' }),
        ORG_ITEMS,
        'items.perWorkspace',
        ITEMS_MESSAGE
      );
      const probe = await createItem(cli(member), { name: 'member key probe', projectIds: [projectId] });
      expect(probe.status, await probe.clone().text()).toBe(404);
      expect((await readJson(probe)).error.code).toBe('project_not_found');
      const agent = await mcpTool(member.key, `${IDENTITY.mcp.toolPrefix}create_item`, {
        name: 'member agent at the cap'
      });
      expect(agent.isError).toBe(true);
      expect(agent.text).toContain('code: plan_required');
      const agentProbe = await mcpTool(member.key, `${IDENTITY.mcp.toolPrefix}create_item`, {
        name: 'member agent probe',
        projectIds: [projectId]
      });
      expect(agentProbe.isError).toBe(true);
      expect(agentProbe.text).toContain('code: project_not_found');
      expect(agentProbe.text).not.toContain('plan_required');
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });

    it('a body the validator refuses reads the validator’s 400 at the cap, never the plan: over twenty projects, a value that is not a uuid, a list that is not one, an empty name, a note too long', async () => {
      const twentyOne = Array.from({ length: 21 }, () => randomUUID());
      const refused: Array<Record<string, unknown>> = [
        { name: 'refused body', projectIds: twentyOne },
        { name: 'refused body', projectIds: ['not-a-uuid'] },
        { name: 'refused body', projectIds: 'p1' },
        { name: '' },
        { name: 'refused body', note: 'n'.repeat(2001) }
      ];
      for (const body of refused) {
        const res = await createItem(dashboard(itemsOwner), body);
        expect(res.status, await res.clone().text()).toBe(400);
        expect((await readJson(res)).error.code).not.toBe('plan_required');
      }
      // Twenty uuids the schema accepts on a project the owner may not link
      // into (it does not exist): the handler's 404, and the hook asked the
      // predicate rather than the count.
      const twenty = Array.from({ length: 20 }, () => randomUUID());
      const res = await createItem(dashboard(itemsOwner), { name: 'twenty unknown', projectIds: twenty });
      expect(res.status, await res.clone().text()).toBe(404);
      expect((await readJson(res)).error.code).toBe('project_not_found');
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
    });

    it('a second free workspace under its own cap is not held to this one’s count: the cap is per workspace', async () => {
      const neighbour = await hubPerson(
        fixture('hub-plan-neighbour', ORG_NEIGHBOUR, 'neighbour@planlimits.test')
      );
      const res = await createItem(cli(neighbour), { name: 'neighbour-1' });
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await itemCount(app, neighbour.workspaceId)).toBe(1);
      expect(await itemCount(app, itemsOwner.workspaceId)).toBe(101);
      await expectPlanRequired(
        await createItem(cli(itemsOwner), { name: 'still capped' }),
        ORG_ITEMS,
        'items.perWorkspace',
        ITEMS_MESSAGE
      );
    });

    it('the member cap is the hub’s to enforce: the projected workspace’s invitation door answers hub_managed', async () => {
      const res = await app.app.request(
        '/api/v1/invitations',
        json({ email: 'newcomer@planlimits.test', role: 'member' }, dashboard(itemsOwner))
      );
      expect(res.status, await res.clone().text()).toBe(403);
      const body = await readJson(res);
      expect(body.error.code).toBe('hub_managed');
      expect(body.error.details.manageUrl).toBeTruthy();
    });
  });

  describe('a limit the hub sets on an account is the cap the create is held to', () => {
    it('items.perWorkspace overridden to 5 by the hub: the sixth item is refused naming 5, the message the hub’s value', async () => {
      hub.setEntitlements(ORG_OVERRIDE, { plan: 'free', limits: { 'items.perWorkspace': 5 } });
      const person = await hubPerson(fixture('hub-plan-override', ORG_OVERRIDE, 'override@planlimits.test'));
      for (let n = 1; n <= 5; n++) {
        const res = await createItem(cli(person), { name: `override-${n}` });
        expect(res.status, await res.clone().text()).toBe(201);
      }
      const sixth = await createItem(cli(person), { name: 'override-6' });
      expect(sixth.status).toBe(403);
      const body = await readJson(sixth);
      expect(body.error.code).toBe('plan_required');
      expect(body.error.message).toBe(
        'items.perWorkspace is limited to 5 on the free plan; the pro plan allows it'
      );
      expect(body.error.details).toMatchObject({
        key: 'items.perWorkspace',
        plan: 'free',
        requiredPlan: 'pro'
      });
      expect(await itemCount(app, person.workspaceId)).toBe(5);
    });
  });

  describe('a pro account passes all of it', () => {
    let person: Person;

    beforeAll(async () => {
      hub.setEntitlements(ORG_PRO, { plan: 'pro' });
      person = await hubPerson(fixture('hub-plan-pro', ORG_PRO, 'pro@planlimits.test'));
    });

    it('a hundred and one items are created', async () => {
      for (let n = 1; n <= 101; n++) {
        const res = await createItem(cli(person), { name: `pro-${n}` });
        expect(res.status, await res.clone().text()).toBe(201);
      }
      expect(await itemCount(app, person.workspaceId)).toBe(101);
    }, 120_000);
  });
});

describe('the self-hosted edition: no limit on a count', () => {
  let app: TestApp;
  let cookie: string;
  let workspaceId: string;
  const downstream: UsageEvent[] = [];

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'plan_limits_oss'),
      {},
      { usageDownstream: { emit: async (e) => void downstream.push(e) } }
    );
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Plan Limits Oss', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    cookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    workspaceId = me.activeWorkspaceId as string;
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('a hundred and one items are created, and nothing leaves the instance', async () => {
    for (let n = 1; n <= 101; n++) {
      const res = await app.app.request('/api/v1/items', json({ name: `oss-${n}` }, { cookie }));
      expect(res.status, await res.clone().text()).toBe(201);
    }
    expect(await itemCount(app, workspaceId)).toBe(101);
    await sleep(2_500); // longer than the queue's poll
    expect(downstream).toEqual([]);
    // The durable side of the negative: no usage job was ever sent on this instance.
    const { rows } = await app.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'usage-events'"
    );
    expect(rows[0]!.n).toBe(0);
  }, 120_000);
});
