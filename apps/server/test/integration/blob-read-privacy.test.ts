import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * SL-B1 — per-principal authorization on the generic `/files` surface: the
 * proof of THIS tool's `api.filePolicy` (`src/files/blob-read-scope.ts`). The
 * chassis suite cannot give it: its minimal tool answers `undefined` for
 * everyone (the whole-workspace view), a test fixture and not a policy.
 *
 * The hole a tool must not reopen: `/files`, `GET /files/{id}` and
 * `GET /files/{id}/content` authorizing on `principal.workspaceId` alone, so
 * that any plain member — and any `items:read` API key — lists and streams
 * every blob of the workspace.
 *
 * The policy: a blob is readable by whoever uploaded it; workspace
 * admins/owners keep the operator view. Refusals are 404, never 403 (AUTH-5:
 * a blob you cannot read must not be probeable). Items reference no blob, so
 * there is no second way to a blob here: a tool whose resource references one
 * adds the clause "or referenced by a resource you can read" to the predicate,
 * guards the bind with it, and brings those two cases with it.
 */

const OWNER = { email: 'owner@blobs.test', name: 'Blob Owner', password: 'blob-owner-password-1' };
const MEMBER = { email: 'member@blobs.test', name: 'Plain Member', password: 'blob-member-password-1' };
const ADMIN = { email: 'admin@blobs.test', name: 'Workspace Admin', password: 'blob-admin-password-11' };

/** The owner's private bytes — what a member must never reach. */
const SECRET = Buffer.from('<!doctype html><h1>SL-B1 SECRET — the private bytes of the owner</h1>');
const SECRET_2 = Buffer.from('<!doctype html><h1>SL-B1 SECOND — more private bytes of the owner</h1>');
/** The member's own content — must stay fully readable to them. */
const MINE = Buffer.from('<!doctype html><h1>the plain member owns these bytes</h1>');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberCookie: string;
let adminCookie: string;
let memberReadKey: string;
let secretFileId: string;
let secret2FileId: string;

// TRUST_PROXY=true in tests, so give every request its own address.
let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const signIn = async (who: typeof OWNER) =>
  extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );

const upload = (bytes: Buffer, name: string, cookie: string): Promise<Response> =>
  Promise.resolve(
    app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/html', cookie },
      body: bytes.toString()
    })
  );

/** Join the workspace through an ordinary invitation (origin != guest). */
async function joinWorkspace(who: typeof MEMBER, role: 'member' | 'admin'): Promise<string> {
  const invited = await readJson(
    await app.app.request('/api/v1/invitations', json({ email: who.email, role }, { cookie: ownerCookie }))
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: who.name, password: who.password })
  );
  expect(accept.status).toBe(200);
  return signIn(who);
}

const listFileIds = async (headers: Record<string, string>): Promise<string[]> => {
  const res = await app.app.request('/api/v1/files?limit=100', { headers });
  expect(res.status).toBe(200);
  return ((await readJson(res)).files as Array<{ id: string }>).map((f) => f.id);
};

/** Every read shape of one blob on the generic surface, as one snapshot. */
async function blobStatuses(
  id: string,
  headers: Record<string, string>
): Promise<{ meta: number; content: number; head: number }> {
  const [meta, content, head] = await Promise.all([
    app.app.request(`/api/v1/files/${id}`, { headers }),
    app.app.request(`/api/v1/files/${id}/content`, { headers }),
    app.app.request(`/api/v1/files/${id}/content`, { method: 'HEAD', headers })
  ]);
  return { meta: meta.status, content: content.status, head: head.status };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'blob_read_privacy'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Blobs', owner: OWNER })
  );
  ownerCookie = await signIn(OWNER);

  const first = await upload(SECRET, 'secret.html', ownerCookie);
  expect(first.status).toBe(201);
  secretFileId = (await readJson(first)).file.id;
  const second = await upload(SECRET_2, 'secret-2.html', ownerCookie);
  expect(second.status).toBe(201);
  secret2FileId = (await readJson(second)).file.id;

  memberCookie = await joinWorkspace(MEMBER, 'member');
  adminCookie = await joinWorkspace(ADMIN, 'admin');
  memberReadKey = (
    await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json({ name: 'member-ro', scopes: ['items:read'] }, { cookie: memberCookie })
      )
    )
  ).key as string;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the whole-tenant blob read on /files is closed', () => {
  it('a plain member never sees another member’s blob in the listing; admins and the owner do', async () => {
    const memberIds = await listFileIds({ cookie: memberCookie });
    expect(memberIds).not.toContain(secretFileId);
    expect(memberIds).not.toContain(secret2FileId);
    // Their own key is no wider than their session.
    expect(await listFileIds({ authorization: `Bearer ${memberReadKey}` })).toEqual(memberIds);

    for (const cookie of [ownerCookie, adminCookie]) {
      const ids = await listFileIds({ cookie });
      expect(ids).toContain(secretFileId);
      expect(ids).toContain(secret2FileId);
    }
  });

  it('a plain member 404s — never 403 — on the metadata, content and HEAD of a foreign blob', async () => {
    const denied = { meta: 404, content: 404, head: 404 };
    expect(await blobStatuses(secretFileId, { cookie: memberCookie })).toEqual(denied);
    expect(await blobStatuses(secretFileId, { authorization: `Bearer ${memberReadKey}` })).toEqual(denied);

    // Not one byte leaks, on any of the streaming shapes.
    for (const headers of [{ cookie: memberCookie }, { authorization: `Bearer ${memberReadKey}` }]) {
      for (const init of [{ headers }, { headers: { ...headers, range: 'bytes=0-10' } }]) {
        const res = await app.app.request(`/api/v1/files/${secretFileId}/content`, init);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('SECRET');
      }
    }
  });

  it('DELETE of a foreign blob 404s and leaves the row and the bytes untouched', async () => {
    const del = await app.app.request(`/api/v1/files/${secretFileId}`, {
      method: 'DELETE',
      headers: { cookie: memberCookie }
    });
    expect(del.status).toBe(404);

    // The side effect is absent: the row is still live…
    const { rows } = await app.db.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM files WHERE id = $1',
      [secretFileId]
    );
    expect(rows[0]!.deleted_at).toBeNull();
    // …and the blob still streams for the operator.
    const still = await app.app.request(`/api/v1/files/${secretFileId}/content`, {
      headers: { cookie: ownerCookie }
    });
    expect(still.status).toBe(200);
    expect(await still.text()).toContain('SL-B1 SECRET');
  });

  it('the operator view is intact: owner and admin stream any workspace blob', async () => {
    for (const cookie of [ownerCookie, adminCookie]) {
      expect(await blobStatuses(secretFileId, { cookie })).toEqual({ meta: 200, content: 200, head: 200 });
    }
  });

  it('a member keeps full access to the blobs they uploaded themselves', async () => {
    const up = await upload(MINE, 'mine.html', memberCookie);
    expect(up.status).toBe(201);
    const mineId = (await readJson(up)).file.id as string;

    expect(await blobStatuses(mineId, { cookie: memberCookie })).toEqual({
      meta: 200,
      content: 200,
      head: 200
    });
    expect(await listFileIds({ cookie: memberCookie })).toContain(mineId);
  });
});

describe('possession survives content-addressed dedupe', () => {
  it('a member who uploads bytes another member uploaded first can read them', async () => {
    // Content addressing means this upload deduplicates onto the OWNER's
    // row — `files.created_by` still names the owner. Attribution must not
    // depend on who got there first, or a member would be locked out of
    // bytes they demonstrably hold.
    const up = await upload(SECRET, 'same-bytes.html', memberCookie);
    expect(up.status).toBe(201);
    expect((await readJson(up)).deduplicated).toBe(true);

    expect(await blobStatuses(secretFileId, { cookie: memberCookie })).toEqual({
      meta: 200,
      content: 200,
      head: 200
    });
    // The blob they did NOT upload stays closed.
    expect(await blobStatuses(secret2FileId, { cookie: memberCookie })).toEqual({
      meta: 404,
      content: 404,
      head: 404
    });
  });
});
