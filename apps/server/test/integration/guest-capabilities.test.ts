import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { workspaceMembers } from '@antasphere/chassis-db';
import { OauthJwtVerifier } from '@antasphere/chassis-server/identity';
import type { Auth } from '@antasphere/chassis-server/identity';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Phase 6 — guest capability limits (D2, BOTH editions; this suite pins the
 * self-host/oss edition):
 *
 * A membership with origin='guest' exists so the platform can resolve an
 * external person granted ONE domain object to a principal — it is NOT a
 * workspace actor. This suite proves the boundary from both sides:
 *
 *  - KEPT: the authenticated domain READS (the items list, an item by id),
 *    with a session AND with the guest's own API key. They show a guest only
 *    what they were granted, and items ship NO per-item grant: the list is
 *    200 and empty, an ungranted item is the 404 of a missing one, never a
 *    403. A tool that adds a grant brings "reads and writes the ONE granted
 *    item" with it (the predicate is `ItemService.visibleTo`).
 *  - REFUSED (403 guest_forbidden): every items MUTATION, the generic /files
 *    surface (reads INCLUDED — a workspace-level inventory an outsider has no
 *    business in), the member roster, the workspace export.
 *  - LOCKED: an admin cannot promote a guest row (guest_role_locked) — the
 *    capability limits key on origin, which nothing upgrades; deactivation
 *    stays available.
 *  - Ordinary members are untouched: files, roster all keep working (the
 *    guard keys on origin, not role).
 *
 * The guest is SEEDED (an account plus a `workspace_members` row with
 * origin='guest', the chassis suite's own fixture): the journey that mints
 * one — a per-item invitation and its claim — belongs to a tool that ships a
 * per-item grant.
 */

const OWNER = { email: 'owner@guest.test', name: 'Guest Host', password: 'guest-owner-pass-1' };
const GUEST = { email: 'guest@guest.test', name: 'The Guest', password: 'guest-guest-pass-1' };
const MEMBER = { email: 'member@guest.test', name: 'Plain Member', password: 'plain-member-pass-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mail: RecordingEmailDriver;
let ownerCookie: string;
let guestCookie: string;
let guestKey: string;
let guestUserId: string;
/** An item of the host workspace, created by its owner: never granted to the guest. */
let hostItemId: string;
// The suite runs with TRUST_PROXY=true so each request brings a fresh forwarded IP.
let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'guest_caps'), {}, { email: mail });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'GuestCaps', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  // Seed the guest: a local-password account and a guest-origin membership
  // of the host workspace (what a claimed per-item grant leaves behind).
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  const hostWorkspaceId = me.workspace.id as string;
  guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
  await app.db.pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
     VALUES ($1, $2, 'member', 'guest', true)`,
    [hostWorkspaceId, guestUserId]
  );

  guestCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: GUEST.email, password: GUEST.password })
    )
  );
  const minted = await readJson(
    await app.app.request(
      '/api/v1/api-keys',
      json({ name: 'guest-key', scopes: ['items:read', 'items:write'] }, { cookie: guestCookie })
    )
  );
  guestKey = minted.key;
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

async function expectGuestForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect((await readJson(res)).error.code).toBe('guest_forbidden');
}

describe('what the guest KEEPS', () => {
  it('reaches the authenticated domain surface, with the session and with their own API key', async () => {
    for (const headers of [{ cookie: guestCookie }, { authorization: `Bearer ${guestKey}` }]) {
      const res = await app.app.request('/api/v1/items', { headers });
      expect(res.status).toBe(200);
    }
  });

  it('sees nothing they were not granted: the list is empty, and a real item stays 404, never 403', async () => {
    const created = await app.app.request(
      '/api/v1/items',
      json({ name: 'Of the host' }, { cookie: ownerCookie })
    );
    expect(created.status).toBe(201);
    hostItemId = (await readJson(created)).item.id as string;

    for (const headers of [{ cookie: guestCookie }, { authorization: `Bearer ${guestKey}` }]) {
      const list = await app.app.request('/api/v1/items', { headers });
      expect(await readJson(list)).toEqual({ items: [], nextCursor: null });
      const byId = await app.app.request(`/api/v1/items/${hostItemId}`, { headers });
      expect(byId.status).toBe(404);
      expect((await readJson(byId)).error.code).toBe('not_found');
    }
  });
});

describe('what the guest is REFUSED (403 guest_forbidden — D2, capability of origin)', () => {
  it('cannot create items in the host workspace — session and API key alike', async () => {
    for (const headers of [{ cookie: guestCookie }, { authorization: `Bearer ${guestKey}` }]) {
      await expectGuestForbidden(
        await app.app.request('/api/v1/items', json({ name: 'From a guest' }, headers))
      );
    }
    // Refused BEFORE the handler: nothing was written (the host's one item is all there is).
    const { rows } = await app.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items`);
    expect(rows[0]!.n).toBe(1);
  });

  it('cannot change or delete an item of the host workspace — session and API key alike', async () => {
    const id = hostItemId;
    for (const headers of [{ cookie: guestCookie }, { authorization: `Bearer ${guestKey}` }]) {
      await expectGuestForbidden(
        await app.app.request(`/api/v1/items/${id}`, {
          ...json({ name: 'Renamed' }, headers),
          method: 'PATCH'
        })
      );
      await expectGuestForbidden(await app.app.request(`/api/v1/items/${id}`, { method: 'DELETE', headers }));
    }
    // The item is untouched, and an ordinary member of the same workspace reads it.
    const read = await app.app.request(`/api/v1/items/${id}`, { headers: { cookie: ownerCookie } });
    expect(read.status).toBe(200);
    expect((await readJson(read)).name).toBe('Of the host');
  });

  it('cannot touch the generic /files surface — reads INCLUDED', async () => {
    await expectGuestForbidden(await app.app.request('/api/v1/files', { headers: { cookie: guestCookie } }));
    await expectGuestForbidden(
      await app.app.request('/api/v1/files?name=x.bin', {
        method: 'POST',
        headers: { cookie: guestCookie },
        body: 'zz'
      })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/files/00000000-0000-4000-8000-000000000000/content', {
        headers: { cookie: guestCookie }
      })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/files/00000000-0000-4000-8000-000000000000', {
        method: 'DELETE',
        headers: { cookie: guestCookie }
      })
    );
    // The API key path hits the same wall (scope opens the door, origin rules).
    await expectGuestForbidden(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${guestKey}` } })
    );
  });

  it('cannot read the member roster or the workspace export', async () => {
    await expectGuestForbidden(
      await app.app.request('/api/v1/members', { headers: { cookie: guestCookie } })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/workspace/export', {
        headers: { cookie: guestCookie, 'x-forwarded-for': nextIp() }
      })
    );
  });
});

describe('/me tells clients how to adapt (P7 additions, oss values)', () => {
  it("the guest's /me carries origin='guest' so the dashboard hides the guest-forbidden surfaces", async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie: guestCookie } });
    expect(res.status).toBe(200);
    const me = await readJson(res);
    expect(me.origin).toBe('guest');
    // oss: nothing is a hub projection and there is no hub to link out to.
    expect(me.workspace.hubOrigin).toBe(false);
    expect(me.workspaces.every((w: { hubOrigin: boolean }) => w.hubOrigin === false)).toBe(true);
    expect(me.hubManageUrl).toBeNull();
  });

  it("a regular member's /me stays origin='local'", async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } });
    const me = await readJson(res);
    expect(me.origin).toBe('local');
    expect(me.workspace.hubOrigin).toBe(false);
    expect(me.hubManageUrl).toBeNull();
  });
});

describe('the guest role-lock (origin is a capability axis nothing upgrades)', () => {
  let guestMembershipId: string;

  beforeAll(async () => {
    const [row] = await app.db.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, guestUserId), eq(workspaceMembers.origin, 'guest')));
    guestMembershipId = row!.id;
  });

  it('an admin cannot promote a guest row (403 guest_role_locked)', async () => {
    const res = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ role: 'admin' })
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_role_locked');
  });

  it('deactivating (and reactivating) a guest stays available', async () => {
    const off = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ isActive: false })
    });
    expect(off.status).toBe(200);
    // A deactivated guest resolves to no principal at all.
    const read = await app.app.request('/api/v1/items', { headers: { cookie: guestCookie } });
    expect(read.status).toBe(401);

    const on = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ isActive: true })
    });
    expect(on.status).toBe(200);
    expect((await app.app.request('/api/v1/items', { headers: { cookie: guestCookie } })).status).toBe(200);
  });
});

describe('the OAuth-bearer leg (the third credential kind — MCP rides this)', () => {
  it('a bearer JWT resolving the guest membership carries origin=guest from the LIVE row', async () => {
    // Verifier-direct, the oauth-workspace.test.ts pattern (the full
    // authorize/consent/token dance is exercised there): sign a JWT for the
    // guest bound to the host workspace against a fake JWKS and resolve it
    // through the REAL OauthJwtVerifier. The load-bearing link this pins is
    // that the oauth resolver reads origin from the membership row — the
    // token itself carries NO origin claim to spoof. requireNonGuest judges
    // the resolved principal identically for all three credential kinds
    // (proven above with sessions and API keys), so origin='guest' here is
    // exactly the 403 guest_forbidden wall for OAuth bearers and MCP.
    const [guestRow] = await app.db.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, guestUserId), eq(workspaceMembers.origin, 'guest')));
    const hostWorkspaceId = guestRow!.workspaceId;

    const base = 'http://guest-caps.test';
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'guest-caps' };
    const fakeAuth = { api: { getJwks: async () => ({ keys: [jwk] }) } } as unknown as Auth;
    const verifier = new OauthJwtVerifier(fakeAuth, app.db.db, base);

    const token = await new SignJWT({
      scope: 'items:read items:write'
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'guest-caps' })
      .setIssuer(base)
      .setAudience(`${base}/mcp`)
      .setSubject(guestUserId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    // The workspace is a per-request SELECTOR now (user-scoped model), never
    // a token claim — the guest origin must ride the live membership either way.
    const principal = await verifier.resolve(token, hostWorkspaceId);
    expect(principal).toMatchObject({
      userId: guestUserId,
      workspaceId: hostWorkspaceId,
      role: 'member',
      origin: 'guest',
      via: 'oauth'
    });
  });
});

describe('ordinary members are untouched (the guard keys on origin, not role)', () => {
  let memberCookie: string;

  beforeAll(async () => {
    const invited = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
      )
    );
    await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: invited.acceptUrl.split('/invite/')[1], name: MEMBER.name, password: MEMBER.password })
    );
    memberCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: MEMBER.email, password: MEMBER.password })
      )
    );
  });

  it('a plain member still uses /files and reads the roster', async () => {
    const files = await app.app.request('/api/v1/files', { headers: { cookie: memberCookie } });
    expect(files.status).toBe(200);

    const roster = await app.app.request('/api/v1/members', { headers: { cookie: memberCookie } });
    expect(roster.status).toBe(200);
  });

  it("a member's role change still works (the lock is guest-only)", async () => {
    const { rows } = await app.db.pool.query(
      `SELECT m.id FROM workspace_members m JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
      [MEMBER.email]
    );
    const res = await app.app.request(`/api/v1/members/${rows[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ role: 'admin' })
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).role).toBe('admin');
  });
});
