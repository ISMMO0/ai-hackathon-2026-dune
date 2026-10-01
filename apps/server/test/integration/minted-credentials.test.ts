import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1354 — the minted-credential cross-tenant account-takeover chain.
 *
 * The proven chain the audit walked, end to end:
 *
 *   1. AUTH-6 — any PLAIN MEMBER of workspace A creates a domain object and
 *      invites an arbitrary outside email onto it (a per-object grant). The claim path
 *      mints that outsider a real, instance-GLOBAL `user` row plus an
 *      `origin='guest'` membership of A.
 *   2. AUTH-1/AUTH-2 — an admin of A then mints
 *      `POST /members/{id}/change-email-link` (or `reset-link`) against that
 *      membership. Both links are SIGN-IN-EQUIVALENT (LESSONS.md M6:
 *      consuming a change-email JWT while logged out CREATES a session for
 *      the target). The `user` row is global, so the credential works
 *      everywhere the victim belongs — including workspace B, which A has no
 *      relationship with at all.
 *   3. AUTH-8 — the only guards on either route fired when
 *      `target.role === 'owner'`, so the step above also worked
 *      admin-against-admin inside A.
 *   4. AUTH-3/AUTH-7 — orthogonal, same theme: `/api/v1/auth/get-access-token`
 *      and `/api/v1/auth/refresh-token` hand any session-bearing caller their
 *      own provider grant in plaintext, outside the scope gate / quota /
 *      idempotency / audit (the `/auth/*` mount precedes `authContext`), and
 *      the refresh leg rotates the hub grant outside ADR 019's single-flight.
 *
 * Step 1 is a DOMAIN step (a per-object grant that onboards an outsider).
 * Items ship no per-item grant (every member reads and writes the workspace's
 * items, a guest sees none of them), so step 1 has no route here: its cases left with
 * the slot and the guest membership of step 2 is seeded directly. A tool that
 * adds a per-item grant brings the AUTH-6 cases back with it. The AUTH-5
 * existence-oracle cases run against real items.
 *
 * Each `it` below fails on the pre-fix tree and passes after. The negative
 * cases assert the STATUS *and* that no credential material was produced —
 * a 403 that still wrote a verification row would be no fix at all.
 */

const OWNER = { email: 'owner@mint.test', name: 'A Owner', password: 'mint-owner-password-123' };
const ADMIN = { email: 'admin@mint.test', name: 'A Admin', password: 'mint-admin-password-123' };
const ADMIN2 = { email: 'admin2@mint.test', name: 'A Admin Two', password: 'mint-admin2-password-12' };
const PLAIN = { email: 'plain@mint.test', name: 'A Plain', password: 'mint-plain-password-123' };
const SOLO = { email: 'solo@mint.test', name: 'A Solo', password: 'mint-solo-password-1234' };
const DUAL = { email: 'dual@mint.test', name: 'Dual Tenant', password: 'mint-dual-password-1234' };
const GUEST = { email: 'guest@outsider.test', name: 'Outside Guest', password: 'mint-guest-password-12' };

let container: StartedPostgreSqlContainer;
let app: TestApp;

let ownerCookie = '';
let adminCookie = '';
let dualCookie = '';

let wA = '';
let wB = ''; // DUAL's second, unrelated tenant

// Member row ids inside wA, by email.
const rowId: Record<string, string> = {};

// The public claim + invitation-accept routes ride a tight per-IP wall and
// TRUST_PROXY is on in tests — rotate the forwarded address every request.
let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

/** Invite + accept a workspace member of wA, then sign them in. */
async function addMember(person: { email: string; name: string; password: string }): Promise<string> {
  const invited = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: person.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: person.name, password: person.password })
  );
  expect(accept.status).toBe(200);
  return signIn(person.email, person.password);
}

async function refreshRowIds(): Promise<void> {
  const { members } = await readJson(
    await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
  );
  for (const m of members as Array<{ id: string; email: string }>) rowId[m.email] = m.id;
}

/** Every reset token currently live in Better Auth's own verification table. */
async function resetTokenCount(): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM verification WHERE identifier LIKE 'reset-password:%'`
  );
  return rows[0]!.n;
}

const mintReset = (memberId: string, cookie: string) =>
  app.app.request(`/api/v1/members/${memberId}/reset-link`, {
    method: 'POST',
    headers: { cookie, 'x-forwarded-for': nextIp() }
  });

const mintChangeEmail = (memberId: string, cookie: string, newEmail: string) =>
  app.app.request(`/api/v1/members/${memberId}/change-email-link`, json({ newEmail }, { cookie }));

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'minted_creds'));

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Mint A', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  wA = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER.email, OWNER.password);

  adminCookie = await addMember(ADMIN);
  await addMember(ADMIN2);
  await addMember(PLAIN);
  await addMember(SOLO);
  dualCookie = await addMember(DUAL);
  await refreshRowIds();

  // Promote the two admins.
  for (const person of [ADMIN, ADMIN2]) {
    const res = await app.app.request(`/api/v1/members/${rowId[person.email]}`, {
      ...json({ role: 'admin' }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(res.status).toBe(200);
  }

  // DUAL also belongs to a SECOND, unrelated tenant — the cross-tenant blast
  // radius the mint routes must refuse to touch. (Seeded directly, exactly
  // like the workspace-scoping suite: the platform has no "create workspace"
  // HTTP surface on oss.)
  const dualUser = await app.db.db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, rowId[DUAL.email]!))
    .limit(1);
  wB = (await app.registry.workspaces.create('Mint B', dualUser[0]!.userId)).workspaceId;
  expect(wB).not.toBe(wA);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ AUTH-1 / AUTH-2 — the mint routes ═══════════════════════════════════════

describe('AUTH-1/AUTH-2: no mint against a target who belongs to another workspace', () => {
  it('reset-link refuses (403 cross_workspace_target) and writes NO verification row', async () => {
    const before = await resetTokenCount();
    const res = await mintReset(rowId[DUAL.email]!, ownerCookie);
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('cross_workspace_target');
    expect(body.resetUrl).toBeUndefined();
    expect(await resetTokenCount()).toBe(before);
  });

  it('change-email-link refuses (403 cross_workspace_target) and returns no verifyUrl', async () => {
    const res = await mintChangeEmail(rowId[DUAL.email]!, ownerCookie, 'dual-hijacked@mint.test');
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('cross_workspace_target');
    expect(body.verifyUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('verify-email');
  });

  it('the sanctioned recovery still works for a single-workspace member (control)', async () => {
    const reset = await mintReset(rowId[SOLO.email]!, ownerCookie);
    expect(reset.status).toBe(200);
    expect((await readJson(reset)).resetUrl).toContain('/reset-password?token=');

    const change = await mintChangeEmail(rowId[SOLO.email]!, ownerCookie, 'solo-renamed@mint.test');
    expect(change.status).toBe(200);
    expect((await readJson(change)).verifyUrl).toContain('/api/v1/auth/verify-email?token=');
  });
});

describe('AUTH-1/AUTH-2: no mint against an origin=guest membership', () => {
  let guestRowId = '';

  beforeAll(async () => {
    // What the real chain leaves behind (a per-item grant claimed by an
    // outsider): a GLOBAL user row and a guest membership of A. Seeded
    // directly while the tool has no grant route.
    const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [wA, guestUserId]
    );
    const [row] = await app.db.db
      .select({ id: workspaceMembers.id, origin: workspaceMembers.origin })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, guestUserId))
      .limit(1);
    expect(row!.origin).toBe('guest');
    guestRowId = row!.id;
  }, 60_000);

  it('reset-link refuses (403 guest_target) and writes NO verification row', async () => {
    const before = await resetTokenCount();
    const res = await mintReset(guestRowId, ownerCookie);
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_target');
    expect(await resetTokenCount()).toBe(before);
  });

  it('change-email-link refuses (403 guest_target) — the sign-in-equivalent leg', async () => {
    const res = await mintChangeEmail(guestRowId, ownerCookie, 'guest-hijacked@mint.test');
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('guest_target');
    expect(body.verifyUrl).toBeUndefined();
  });
});

describe('AUTH-8: minting is an OWNER act, not an admin one', () => {
  it('an admin cannot mint a reset link against another admin, nor against a plain member', async () => {
    const before = await resetTokenCount();
    for (const victim of [ADMIN2.email, PLAIN.email]) {
      const res = await mintReset(rowId[victim]!, adminCookie);
      expect(res.status).toBe(403);
      expect((await readJson(res)).resetUrl).toBeUndefined();
    }
    expect(await resetTokenCount()).toBe(before);
  });

  it('an admin cannot mint a change-email link against another admin, nor against a plain member', async () => {
    for (const victim of [ADMIN2.email, PLAIN.email]) {
      const res = await mintChangeEmail(rowId[victim]!, adminCookie, `taken-${victim}`);
      expect(res.status).toBe(403);
      expect((await readJson(res)).verifyUrl).toBeUndefined();
    }
  });
});

// ═══ FUZZ-7 — the second mint route joins the idempotency claim ══════════════

/**
 * `reset-link` has always been an idempotency target; `change-email-link`
 * never was, even though its contract declared `Idempotency-Key` and a 409
 * for it. So a retried mint — a network blip, a double-clicked dialog, a
 * deliberate replay — produced a SECOND, independently live
 * sign-in-equivalent JWT for the same target, and change-email tokens are
 * stateless (LESSONS.md M6): they cannot be revoked, only waited out for an
 * hour. Two secret-minting routes, one claim list.
 */
describe('FUZZ-7: a replayed change-email mint replays, it does not mint twice', () => {
  it('answers the SAME verifyUrl, flagged as a replay', async () => {
    const key = 'K-change-email-replay';
    const target = rowId[PLAIN.email]!;
    const first = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-target@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(first.status).toBe(200);
    const firstUrl = (await readJson(first)).verifyUrl as string;
    expect(firstUrl).toContain('/api/v1/auth/verify-email?token=');

    const replay = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-target@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(replay.status).toBe(200);
    // The claim header is the assertion that NAMES the fix: the JWT itself
    // can coincide across two mints inside the same second, so URL equality
    // alone would pass on the unclaimed tree too.
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect((await readJson(replay)).verifyUrl).toBe(firstUrl);
  });

  it('409s when the same key comes back with a different target email', async () => {
    const key = 'K-change-email-conflict';
    const target = rowId[PLAIN.email]!;
    const first = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-first@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(first.status).toBe(200);
    const conflicting = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-second@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(conflicting.status).toBe(409);
    expect((await readJson(conflicting)).verifyUrl).toBeUndefined();
  });
});

// ═══ AUTH-3 / AUTH-7 — the provider-grant endpoints ══════════════════════════

describe('AUTH-3/AUTH-7: the provider-grant endpoints are closed', () => {
  const GRANT_PATHS = ['/api/v1/auth/get-access-token', '/api/v1/auth/refresh-token'];

  it('answers 403 to a session-bearing caller and leaks no token material', async () => {
    for (const path of GRANT_PATHS) {
      const res = await app.app.request(path, json({ providerId: 'antasphere' }, { cookie: ownerCookie }));
      expect(res.status, path).toBe(403);
      const raw = await res.text();
      for (const leak of ['accessToken', 'idToken', 'refreshToken', 'tokenType', 'access_token']) {
        expect(raw, `${path} must not carry ${leak}`).not.toContain(leak);
      }
    }
  });

  it('answers 403 to an anonymous caller too — the closure precedes session resolution', async () => {
    for (const path of GRANT_PATHS) {
      const res = await app.app.request(path, json({ providerId: 'google' }));
      expect(res.status, path).toBe(403);
    }
  });
});

// ═══ AUTH-5 — the write-surface existence oracle ═════════════════════════════

/**
 * Items belong to a workspace and every member of it holds them, so the caller
 * who does NOT hold an item is a member of ANOTHER workspace: DUAL, acting in
 * wB, probing an item of wA. To that caller a real item and a missing one must
 * be indistinguishable on every per-item route, and the probe must be free.
 */
describe('AUTH-5: no per-item route confirms an item exists', () => {
  const unknownItem = '00000000-0000-4000-8000-000000000000';
  let itemOfA = '';

  /** DUAL in wB: the selector is the header, checked against DUAL's live memberships. */
  const fromB = (extra: Record<string, string> = {}) => ({
    cookie: dualCookie,
    'x-workspace-id': wB,
    'x-forwarded-for': nextIp(),
    ...extra
  });

  const itemRow = async () =>
    (
      await app.db.pool.query<{ name: string; note: string; updated_at: Date }>(
        `SELECT name, note, updated_at FROM items WHERE id = $1`,
        [itemOfA]
      )
    ).rows;

  const itemAuditRows = async () =>
    (
      await app.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE resource_type = 'item' AND resource_id = $1`,
        [itemOfA]
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    const created = await app.app.request(
      '/api/v1/items',
      json({ name: 'Held by A', note: 'not for B' }, { cookie: ownerCookie })
    );
    expect(created.status).toBe(201);
    itemOfA = (await readJson(created)).item.id;
    // The premise: DUAL really is in wB on these requests, and wB holds nothing.
    const listB = await app.app.request('/api/v1/items', { headers: fromB() });
    expect(listB.status).toBe(200);
    expect((await readJson(listB)).items).toEqual([]);
  });

  it('a per-item READ answers 404, not 403, to a member who does not hold the item, exactly as for a missing one', async () => {
    const bodies: unknown[] = [];
    for (const [label, id] of [
      ['a real item of another workspace', itemOfA],
      ['an item that does not exist', unknownItem]
    ] as const) {
      const res = await app.app.request(`/api/v1/items/${id}`, { headers: fromB() });
      expect(res.status, label).toBe(404);
      const body = await readJson(res);
      expect(body.error.code, label).toBe('not_found');
      bodies.push(body);
    }
    // Not only the status: the two answers are the same bytes.
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('every per-item WRITE route (patch, delete) answers the same 404 for both, and writes nothing', async () => {
    const before = await itemRow();
    const auditBefore = await itemAuditRows();
    for (const [label, id] of [
      ['a real item of another workspace', itemOfA],
      ['an item that does not exist', unknownItem]
    ] as const) {
      const patch = await app.app.request(`/api/v1/items/${id}`, {
        ...json({ name: 'Taken over' }, fromB()),
        method: 'PATCH'
      });
      expect(patch.status, `patch: ${label}`).toBe(404);
      expect((await readJson(patch)).error.code, `patch: ${label}`).toBe('not_found');

      const del = await app.app.request(`/api/v1/items/${id}`, { method: 'DELETE', headers: fromB() });
      expect(del.status, `delete: ${label}`).toBe(404);
      expect((await readJson(del)).error.code, `delete: ${label}`).toBe('not_found');
    }
    // The probe was free: the row is byte-for-byte what it was (name, note,
    // updated_at), it still exists, and no audit row names it.
    expect(await itemRow()).toEqual(before);
    expect(before).toHaveLength(1);
    expect(await itemAuditRows()).toBe(auditBefore);
  });
});

// ═══ RACE-7 — the email_taken pre-check is advisory, the UNIQUE index is not ══

/**
 * The `email_taken` pre-check in the change-email-link handler cannot be a
 * uniqueness boundary and must never be treated as one: it is a read taken
 * outside any lock, the mint writes NOTHING (the token is a stateless JWT —
 * LESSONS.md M6), and the link then stays live for an hour, so even a
 * perfectly serialized mint could not stop a second one from passing.
 *
 * The boundary that actually holds is the `user_email_unique` index at
 * CONSUMPTION time. This test pins both halves of that sentence.
 *
 * PRDCT-1437 closed the old residual here: the LOSING consumption used to
 * surface as a sanitized 500 (the 23505 escaped Better Auth's own
 * `/verify-email` handler) — which, against the winner's 302, was exactly
 * the account-existence oracle. The consume now answers the SAME
 * non-revealing 302 on both branches (rewriteChangeEmailCollision at the
 * /auth mount in api/index.ts re-signs the losing token as a no-op change,
 * so Better Auth runs its native success path), so the RESPONSE no longer says who won; the
 * DATA assertions below are what prove the unique index still let exactly
 * one land. Uniform response + intact integrity, both pinned.
 */
describe('RACE-7: concurrent change-email mints for one address', () => {
  it('both links mint (the pre-check is NOT the boundary) but only one lands', async () => {
    const contested = 'contested@mint.test';
    const [a, b] = await Promise.all([
      mintChangeEmail(rowId[ADMIN2.email]!, ownerCookie, contested),
      mintChangeEmail(rowId[SOLO.email]!, ownerCookie, contested)
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const outcomes: Array<{ status: number; location: string | null }> = [];
    for (const res of [a, b]) {
      const { verifyUrl } = await readJson(res);
      const consumed = await app.app.request(verifyUrl, { headers: { 'x-forwarded-for': nextIp() } });
      outcomes.push({ status: consumed.status, location: consumed.headers.get('location') });
    }
    // Winner AND loser answer the same non-revealing 302 (PRDCT-1437): the
    // response is not the place the race's outcome can be read.
    for (const outcome of outcomes) {
      expect(outcome.status).toBeGreaterThanOrEqual(300);
      expect(outcome.status).toBeLessThan(400);
      expect(outcome.location ?? '').not.toContain('error=');
    }
    expect(outcomes[1]!.status).toBe(outcomes[0]!.status);
    expect(outcomes[1]!.location).toBe(outcomes[0]!.location);

    // The unique index did the work: exactly one account, and the loser
    // still holds its original address.
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "user" WHERE email = $1`,
      [contested]
    );
    expect(rows[0]!.n).toBe(1);
    const survivors = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "user" WHERE email = $1`,
      [SOLO.email]
    );
    expect(survivors.rows[0]!.n).toBe(1);
  });
});
