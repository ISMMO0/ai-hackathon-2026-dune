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
 * The items routes, through the REAL boot: the worked example of a tool
 * resource. One block per rule the routes must hold, so a tool that copies
 * the resource copies its proof:
 *
 *  - the five routes do what the contract says (CRUD, the wire shape);
 *  - the list pages across a boundary in ONE stable order, ties included;
 *  - a refused body is a 400 and writes nothing;
 *  - an item lives in ONE workspace: from another it is a 404 and absent;
 *  - a guest's reads show them nothing (200 empty, 404), their writes are 403;
 *  - machines: `items:read` reads, `items:write` mutates, anything else is 403;
 *  - every mutation lands its named audit row;
 *  - an item survives the erasure of its author's account;
 *  - an item leaves with its workspace, and only with its own.
 */

const OWNER = { email: 'owner@items.test', name: 'Items Owner', password: 'items-owner-password-1' };
const MEMBER = { email: 'member@items.test', name: 'Items Member', password: 'items-member-password-1' };
const GUEST = { email: 'guest@items.test', name: 'Items Guest', password: 'items-guest-password-12' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const WS = 'x-workspace-id';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie = '';
let ownerUserId = '';
let wA = '';
let wB = '';

// TRUST_PROXY=true in tests: the public invitation routes ride a per-IP wall.
let ipCounter = 0;
const nextIp = () => `10.71.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

type Headers = Record<string, string>;

const send = (method: string, path: string, headers: Headers, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function signIn(who: { email: string; password: string }): Promise<string> {
  const res = await send('POST', '/auth/sign-in/email', {}, { email: who.email, password: who.password });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function createItem(headers: Headers, body: { name: string; note?: string }) {
  const res = await send('POST', '/items', headers, body);
  expect(res.status).toBe(201);
  return (await readJson(res)).item as {
    id: string;
    workspaceId: string;
    name: string;
    note: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

async function mintKey(name: string, scopes: string[]): Promise<Headers> {
  const res = await send('POST', '/api-keys', { cookie: ownerCookie }, { name, scopes });
  expect(res.status).toBe(201);
  return { authorization: `Bearer ${(await readJson(res)).key as string}` };
}

/** The audit rows that name one item, oldest first. */
async function auditRowsOf(itemId: string) {
  const { rows } = await app.db.pool.query<{
    action: string;
    resource_type: string;
    resource_id: string;
    workspace_id: string;
    actor_user_id: string;
    actor_via: string;
    metadata: unknown;
  }>(
    `SELECT action, resource_type, resource_id, workspace_id, actor_user_id, actor_via, metadata
       FROM audit_log WHERE resource_type = 'item' AND resource_id = $1 ORDER BY id`,
    [itemId]
  );
  return rows;
}

/**
 * `updated_at` and `created_at` in MICROSECONDS, read SQL-side: the wire's ISO
 * strings stop at the millisecond, and two requests can share one.
 */
async function stampsOf(itemId: string): Promise<{ created: number; updated: number }> {
  const { rows } = await app.db.pool.query<{ created: string; updated: string }>(
    `SELECT (extract(epoch FROM created_at) * 1000000)::bigint AS created,
            (extract(epoch FROM updated_at) * 1000000)::bigint AS updated
       FROM items WHERE id = $1`,
    [itemId]
  );
  return { created: Number(rows[0]!.created), updated: Number(rows[0]!.updated) };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'items_routes'));

  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Workspace A', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  wA = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER);
  ownerUserId = (await readJson(await send('GET', '/me', { cookie: ownerCookie }))).user.id;

  // A second workspace of the SAME person: the workspace of the request rules,
  // not the person. (Two people in two workspaces: workspace-create-isolation.test.ts.)
  const created = await send('POST', '/workspaces', { cookie: ownerCookie }, { name: 'Workspace B' });
  expect(created.status).toBe(201);
  wB = (await readJson(created)).workspace.id;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

const inA = (): Headers => ({ cookie: ownerCookie, [WS]: wA });
const inB = (): Headers => ({ cookie: ownerCookie, [WS]: wB });

// ── CRUD ────────────────────────────────────────────────────────────────────

describe('the five routes', () => {
  it('create answers 201 with the wire shape: the workspace of the request, the author, ISO timestamps, the trimmed name', async () => {
    const item = await createItem(inA(), { name: '  First  ', note: 'line one\nline two' });
    expect(item).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      workspaceId: wA,
      name: 'First',
      note: 'line one\nline two',
      createdBy: ownerUserId,
      // The projects the caller can read: none, the item was created in none.
      projects: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    });
    expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
    expect(item.updatedAt).toBe(item.createdAt);
    // The note is optional and defaults to the empty string.
    expect((await createItem(inA(), { name: 'No note' })).note).toBe('');
  });

  it('a client cannot choose the workspace or the author in the body: both come from the principal', async () => {
    const res = await send('POST', '/items', inA(), {
      name: 'Smuggled',
      workspaceId: wB,
      createdBy: 'someone-else'
    });
    expect(res.status).toBe(201);
    const { item } = await readJson(res);
    expect(item.workspaceId).toBe(wA);
    expect(item.createdBy).toBe(ownerUserId);
  });

  it('get answers the item; a missing id answers 404 not_found', async () => {
    const item = await createItem(inA(), { name: 'To read' });
    const res = await send('GET', `/items/${item.id}`, inA());
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(item);

    const missing = await send('GET', `/items/${UNKNOWN}`, inA());
    expect(missing.status).toBe(404);
    expect((await readJson(missing)).error.code).toBe('not_found');
  });

  it('patch changes the fields it names and only those, and updated_at moves while created_at stays', async () => {
    const item = await createItem(inA(), { name: 'Before', note: 'kept' });
    const atCreate = await stampsOf(item.id);
    expect(atCreate.updated).toBe(atCreate.created);

    const renamed = await send('PATCH', `/items/${item.id}`, inA(), { name: ' After ' });
    expect(renamed.status).toBe(200);
    const afterName = await readJson(renamed);
    expect(afterName).toMatchObject({ id: item.id, name: 'After', note: 'kept', createdAt: item.createdAt });
    const atRename = await stampsOf(item.id);
    expect(atRename.updated).toBeGreaterThan(atCreate.updated);
    expect(atRename.created).toBe(atCreate.created);

    const renoted = await send('PATCH', `/items/${item.id}`, inA(), { note: '' });
    expect(renoted.status).toBe(200);
    const afterNote = await readJson(renoted);
    expect(afterNote).toMatchObject({ name: 'After', note: '' });
    expect((await stampsOf(item.id)).updated).toBeGreaterThan(atRename.updated);

    // What the route answered is what is stored.
    expect(await readJson(await send('GET', `/items/${item.id}`, inA()))).toEqual(afterNote);
    expect((await send('PATCH', `/items/${UNKNOWN}`, inA(), { name: 'x' })).status).toBe(404);
  });

  it('delete answers 200 with the final snapshot, then the item is gone: 404 on get, on a second delete, and off the list', async () => {
    const item = await createItem(inA(), { name: 'To delete' });
    const res = await send('DELETE', `/items/${item.id}`, inA());
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(item);

    expect((await send('GET', `/items/${item.id}`, inA())).status).toBe(404);
    expect((await send('DELETE', `/items/${item.id}`, inA())).status).toBe(404);
    const list = await readJson(await send('GET', '/items?limit=100', inA()));
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(item.id);
  });

  it('every route answers 401 to an anonymous caller', async () => {
    expect((await send('GET', '/items', {})).status).toBe(401);
    expect((await send('POST', '/items', {}, { name: 'x' })).status).toBe(401);
    expect((await send('GET', `/items/${UNKNOWN}`, {})).status).toBe(401);
    expect((await send('PATCH', `/items/${UNKNOWN}`, {}, { name: 'x' })).status).toBe(401);
    expect((await send('DELETE', `/items/${UNKNOWN}`, {})).status).toBe(401);
  });
});

// ── Pagination ──────────────────────────────────────────────────────────────

describe('the list pages across a boundary in one stable order', () => {
  it('walks every item exactly once, newest first, ties on created_at broken by id', async () => {
    // Workspace B is empty so far: the whole ordering is this test's.
    expect((await readJson(await send('GET', '/items', inB()))).items).toEqual([]);

    const made: string[] = [];
    for (const name of ['p1', 'p2', 'p3']) made.push((await createItem(inB(), { name })).id);
    // Three rows sharing ONE created_at (a bulk import does this): the order
    // between them can only come from the id, the keyset's tie-breaker.
    const tied = await app.db.pool.query<{ id: string }>(
      `INSERT INTO items (workspace_id, name, created_by, created_at, updated_at)
       SELECT $1, 'tied-' || n, $2, now(), now() FROM generate_series(1, 3) AS n RETURNING id`,
      [wB, ownerUserId]
    );
    for (const name of ['p4', 'p5']) made.push((await createItem(inB(), { name })).id);

    const whole = await readJson(await send('GET', '/items?limit=100', inB()));
    expect(whole.nextCursor).toBeNull();
    const expectedOrder = whole.items.map((i: { id: string }) => i.id) as string[];
    expect(expectedOrder).toHaveLength(8);
    // Newest first: p5, p4, the three tied rows by id DESC, then p3, p2, p1.
    const tiedDesc = tied.rows
      .map((r) => r.id)
      .sort()
      .reverse();
    expect(expectedOrder).toEqual([made[4], made[3], ...tiedDesc, made[2], made[1], made[0]]);

    // Pages of 3: 3 + 3 + 2. The first boundary falls INSIDE the tied group.
    const walked: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await readJson(
        await send('GET', `/items?limit=3${cursor ? `&cursor=${cursor}` : ''}`, inB())
      );
      sizes.push(page.items.length);
      walked.push(...page.items.map((i: { id: string }) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([3, 3, 2]);
    expect(walked).toEqual(expectedOrder);
  });

  it('a page that ends exactly on the last item has no next cursor', async () => {
    const page = await readJson(await send('GET', '/items?limit=8', inB()));
    expect(page.items).toHaveLength(8);
    expect(page.nextCursor).toBeNull();
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('a refused body is a 400 validation_error and writes nothing', () => {
  it('create: no name, a blank name, a name past 200, a note past 2000, a wrong type, no body at all', async () => {
    const before = (await readJson(await send('GET', '/items?limit=100', inA()))).items.length;
    for (const body of [
      {},
      { name: '   ' },
      { name: 'n'.repeat(201) },
      { name: 'ok', note: 'x'.repeat(2001) },
      { name: 42 },
      { name: 'ok', note: null }
    ]) {
      const res = await send('POST', '/items', inA(), body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await readJson(res)).error.code).toBe('validation_error');
    }
    // No content-type: the body is REQUIRED by the contract, so the schema answers, not the handler.
    const bare = await app.app.request('/api/v1/items', { method: 'POST', headers: inA() });
    expect(bare.status).toBe(400);
    // Malformed JSON is the chassis guard's own code.
    const broken = await app.app.request('/api/v1/items', {
      method: 'POST',
      headers: { ...inA(), 'content-type': 'application/json' },
      body: '{broken'
    });
    expect(broken.status).toBe(400);
    expect((await readJson(broken)).error.code).toBe('invalid_json');

    expect((await readJson(await send('GET', '/items?limit=100', inA()))).items).toHaveLength(before);
  });

  it('the limits are inclusive: 200 and 2000 characters land', async () => {
    const item = await createItem(inA(), { name: 'n'.repeat(200), note: 'x'.repeat(2000) });
    expect(item.name).toHaveLength(200);
    expect(item.note).toHaveLength(2000);
  });

  it('patch: an empty patch, a blank name, an unknown field alone, a malformed id', async () => {
    const item = await createItem(inA(), { name: 'Stays', note: 'as it is' });
    for (const body of [{}, { name: ' ' }, { title: 'x' }, { note: 'x'.repeat(2001) }]) {
      const res = await send('PATCH', `/items/${item.id}`, inA(), body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await readJson(res)).error.code).toBe('validation_error');
    }
    // A malformed id is refused by the contract (`uuidParams`), before Postgres' uuid cast.
    const malformed = await send('PATCH', '/items/not-a-uuid', inA(), { name: 'x' });
    expect(malformed.status).toBe(400);
    expect((await readJson(malformed)).error.code).toBe('validation_error');

    expect(await readJson(await send('GET', `/items/${item.id}`, inA()))).toEqual(item);
  });
});

// ── Workspace isolation ─────────────────────────────────────────────────────

describe('an item lives in ONE workspace', () => {
  it('an item of A is 404 from B for get, patch and delete, absent from the list of B, and intact in A', async () => {
    const item = await createItem(inA(), { name: 'Only in A', note: 'untouched' });

    const get = await send('GET', `/items/${item.id}`, inB());
    const patch = await send('PATCH', `/items/${item.id}`, inB(), { name: 'Taken', note: 'over' });
    const del = await send('DELETE', `/items/${item.id}`, inB());
    // The same answer as an id that exists nowhere: existence is not probeable.
    const missing = await readJson(await send('GET', `/items/${UNKNOWN}`, inB()));
    for (const res of [get, patch, del]) {
      expect(res.status).toBe(404);
      expect(await readJson(res)).toEqual(missing);
    }

    const listB = await readJson(await send('GET', '/items?limit=100', inB()));
    expect(listB.items.map((i: { id: string }) => i.id)).not.toContain(item.id);
    expect(listB.items.every((i: { workspaceId: string }) => i.workspaceId === wB)).toBe(true);
    // A cursor of A positions nothing inside B's ordering.
    const foreign = await readJson(await send('GET', `/items?cursor=${item.id}`, inB()));
    expect(JSON.stringify(foreign)).not.toContain('Only in A');

    expect(await readJson(await send('GET', `/items/${item.id}`, inA()))).toEqual(item);
    // The refused writes are not in the audit trail either: only the create is.
    expect((await auditRowsOf(item.id)).map((r) => r.action)).toEqual(['item.create']);
  });

  it('a workspace the caller is not a member of cannot be addressed at all: 401', async () => {
    const res = await send('GET', '/items', { cookie: ownerCookie, [WS]: UNKNOWN });
    expect(res.status).toBe(401);
  });
});

// ── Guests ──────────────────────────────────────────────────────────────────

describe('a guest: the reads show them nothing, the writes refuse them', () => {
  it('list is 200 and EMPTY though the workspace has items, get is the 404 of a missing id, mutations are 403 and write nothing', async () => {
    // A guest membership of A, seeded the way the chassis suite seeds one.
    const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [wA, guestUserId]
    );
    const guest = { cookie: await signIn(GUEST) };
    const item = await createItem(inA(), { name: 'Not for guests', note: 'untouched' });
    const countInA = async () =>
      (
        await app.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM items WHERE workspace_id = $1`,
          [wA]
        )
      ).rows[0]!.n;
    const before = await countInA();
    expect(before).toBeGreaterThan(0);

    // READS: open, and empty. No per-item grant exists, so nothing is visible.
    const list = await send('GET', '/items?limit=100', guest);
    expect(list.status).toBe(200);
    expect(await readJson(list)).toEqual({ items: [], nextCursor: null });
    // A real item answers the SAME 404 as an id that exists nowhere.
    const real = await send('GET', `/items/${item.id}`, guest);
    const missing = await send('GET', `/items/${UNKNOWN}`, guest);
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await readJson(real)).toEqual(await readJson(missing));
    // A member's cursor opens nothing either.
    const cursored = await send('GET', `/items?cursor=${item.id}`, guest);
    expect(await readJson(cursored)).toEqual({ items: [], nextCursor: null });

    // WRITES: refused before the handler.
    for (const res of [
      await send('POST', '/items', guest, { name: 'From a guest' }),
      await send('PATCH', `/items/${item.id}`, guest, { name: 'Renamed' }),
      await send('DELETE', `/items/${item.id}`, guest),
      // Not an existence oracle: a missing id is refused the same way.
      await send('DELETE', `/items/${UNKNOWN}`, guest)
    ]) {
      expect(res.status).toBe(403);
      expect((await readJson(res)).error.code).toBe('guest_forbidden');
    }
    expect(await countInA()).toBe(before);
    expect(await readJson(await send('GET', `/items/${item.id}`, inA()))).toEqual(item);
    expect((await auditRowsOf(item.id)).map((r) => r.action)).toEqual(['item.create']);
  });
});

// ── Machine scopes ──────────────────────────────────────────────────────────

describe('machine credentials: items:read reads, items:write mutates, anything else is 403', () => {
  it('a read key lists and gets, and is refused every mutation: 403 insufficient_scope, nothing written', async () => {
    const readKey = await mintKey('read-only', ['items:read']);
    const item = await createItem(inA(), { name: 'Read by a key', note: 'unchanged' });

    expect((await send('GET', '/items', readKey)).status).toBe(200);
    const got = await send('GET', `/items/${item.id}`, readKey);
    expect(got.status).toBe(200);
    expect(await readJson(got)).toEqual(item);

    for (const res of [
      await send('POST', '/items', readKey, { name: 'By a read key' }),
      await send('PATCH', `/items/${item.id}`, readKey, { name: 'By a read key' }),
      await send('DELETE', `/items/${item.id}`, readKey)
    ]) {
      expect(res.status).toBe(403);
      expect((await readJson(res)).error.code).toBe('insufficient_scope');
    }
    expect(await readJson(await send('GET', `/items/${item.id}`, inA()))).toEqual(item);
    const list = await readJson(await send('GET', '/items?limit=100', inA()));
    expect(JSON.stringify(list)).not.toContain('By a read key');
  });

  it('a write key creates, patches and deletes; alone it does not read', async () => {
    const writeKey = await mintKey('write-only', ['items:write']);
    const created = await send('POST', '/items', writeKey, { name: 'By a write key' });
    expect(created.status).toBe(201);
    const { item } = await readJson(created);
    expect(item.createdBy).toBe(ownerUserId);

    // A scope is not a superset of another: reading needs items:read.
    const read = await send('GET', `/items/${item.id}`, writeKey);
    expect(read.status).toBe(403);
    expect((await readJson(read)).error.code).toBe('insufficient_scope');

    expect((await send('PATCH', `/items/${item.id}`, writeKey, { note: 'patched' })).status).toBe(200);
    expect((await send('DELETE', `/items/${item.id}`, writeKey)).status).toBe(200);

    // The audit rows carry the key's identity, not a session's.
    const rows = await auditRowsOf(item.id);
    expect(rows.map((r) => [r.action, r.actor_via])).toEqual([
      ['item.create', 'api_key'],
      ['item.update', 'api_key'],
      ['item.delete', 'api_key']
    ]);
  });

  it('a key that holds neither scope is refused the whole tree', async () => {
    const exportKey = await mintKey('export-only', ['data:export']);
    for (const res of [
      await send('GET', '/items', exportKey),
      await send('POST', '/items', exportKey, { name: 'x' }),
      await send('GET', `/items/${UNKNOWN}`, exportKey),
      await send('DELETE', `/items/${UNKNOWN}`, exportKey)
    ]) {
      expect(res.status).toBe(403);
      expect((await readJson(res)).error.code).toBe('insufficient_scope');
    }
  });

  it('the rule opens the /items tree and nothing beside it: a neighbouring path stays fail-closed', async () => {
    const both = await mintKey('both', ['items:read', 'items:write']);
    // Not listed by any rule: shut to machines whatever the key holds.
    const neighbour = await send('GET', '/itemsx', both);
    expect(neighbour.status).toBe(403);
    expect((await readJson(neighbour)).error.code).toBe('endpoint_not_allowed');
    // Under the prefix the gate passes and the API answers for itself: no such route.
    const below = await send('GET', `/items/${UNKNOWN}/anything`, both);
    expect(below.status).toBe(404);
  });
});

// ── Audit ───────────────────────────────────────────────────────────────────

describe('every mutation lands its named audit row', () => {
  it('item.create, item.update, item.delete: resource type, resource id, workspace, actor, metadata', async () => {
    const item = await createItem(inA(), { name: 'Audited', note: 'a private note' });
    await send('PATCH', `/items/${item.id}`, inA(), { note: 'another private note' });
    await send('DELETE', `/items/${item.id}`, inA());

    const rows = await auditRowsOf(item.id);
    expect(rows).toEqual([
      {
        action: 'item.create',
        resource_type: 'item',
        resource_id: item.id,
        workspace_id: wA,
        actor_user_id: ownerUserId,
        actor_via: 'session',
        metadata: { name: 'Audited' }
      },
      {
        action: 'item.update',
        resource_type: 'item',
        resource_id: item.id,
        workspace_id: wA,
        actor_user_id: ownerUserId,
        actor_via: 'session',
        metadata: { fields: ['note'] }
      },
      {
        action: 'item.delete',
        resource_type: 'item',
        resource_id: item.id,
        workspace_id: wA,
        actor_user_id: ownerUserId,
        actor_via: 'session',
        metadata: { name: 'Audited' }
      }
    ]);
    // The trail names WHICH fields changed, never the content of a note.
    expect(JSON.stringify(rows)).not.toContain('private note');
  });

  it('the rows read back through GET /audit, filtered on the resource type', async () => {
    const item = await createItem(inA(), { name: 'In the trail' });
    const res = await send('GET', '/audit?resourceType=item&limit=100', inA());
    expect(res.status).toBe(200);
    const entry = (await readJson(res)).entries.find((e: { resourceId: string }) => e.resourceId === item.id);
    expect(entry).toMatchObject({ action: 'item.create', resourceType: 'item', resourceId: item.id });
  });

  it('a refused or failed write lands NO item row: a 400 and a 404 leave the trail as it was', async () => {
    const count = async () =>
      (
        await app.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log WHERE resource_type = 'item' OR action LIKE '%/items%'`
        )
      ).rows[0]!.n;
    const before = await count();
    expect((await send('POST', '/items', inA(), { name: '' })).status).toBe(400);
    expect((await send('PATCH', `/items/${UNKNOWN}`, inA(), { name: 'x' })).status).toBe(404);
    expect((await send('DELETE', `/items/${UNKNOWN}`, inA())).status).toBe(404);
    expect(await count()).toBe(before);
  });
});

// ── The author's erasure ────────────────────────────────────────────────────

describe('an item is workspace data: it survives its author', () => {
  it('erasing the author’s account keeps the item and nulls created_by', async () => {
    const invited = await readJson(
      await send('POST', '/invitations', inA(), { email: MEMBER.email, role: 'member' })
    );
    const accepted = await send(
      'POST',
      '/invitations/accept',
      {},
      { token: invited.acceptUrl.split('/invite/')[1], name: MEMBER.name, password: MEMBER.password }
    );
    expect(accepted.status).toBe(200);
    const member = { cookie: await signIn(MEMBER) };

    // Every member writes the workspace's items, and reads the others'.
    const item = await createItem(member, { name: 'Left behind' });
    expect(item.createdBy).not.toBe(ownerUserId);
    expect((await send('GET', `/items/${item.id}`, inA())).status).toBe(200);

    const roster = await readJson(await send('GET', '/members', inA()));
    const row = roster.members.find((m: { email: string }) => m.email === MEMBER.email);
    expect((await send('DELETE', `/members/${row.id}`, inA())).status).toBe(200);

    const after = await send('GET', `/items/${item.id}`, inA());
    expect(after.status).toBe(200);
    expect(await readJson(after)).toMatchObject({ id: item.id, name: 'Left behind', createdBy: null });
  });
});

// ── The workspace's deletion ────────────────────────────────────────────────

describe('an item is workspace data: it leaves with its workspace', () => {
  /**
   * The first rule of a tool table (`packages/db/src/schema.ts`): `workspace_id`
   * cascades. No route deletes a workspace today, so the row is deleted in SQL.
   * The last-active-owner guard refuses the cascade on `workspace_members` (it
   * cannot tell a workspace that is leaving from an owner that is), so it is
   * switched off for that ONE transaction; `session_replication_role = replica`
   * is not an option here, it would switch the cascade itself off. With the
   * rule at `no action` the DELETE is refused by the items' foreign key and this
   * test fails on it (verifier round 1, F2).
   */
  async function deleteWorkspace(id: string): Promise<void> {
    const client = await app.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE workspace_members DISABLE TRIGGER workspace_members_last_owner_guard');
      await client.query('DELETE FROM workspaces WHERE id = $1', [id]);
      await client.query('ALTER TABLE workspace_members ENABLE TRIGGER workspace_members_last_owner_guard');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const itemsIn = async (workspaceId: string): Promise<number> =>
    (
      await app.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM items WHERE workspace_id = $1', [
        workspaceId
      ])
    ).rows[0]!.n;

  it('deleting a workspace deletes its items and leaves every other workspace’s', async () => {
    const created = await send('POST', '/workspaces', { cookie: ownerCookie }, { name: 'Workspace C' });
    expect(created.status).toBe(201);
    const wC = (await readJson(created)).workspace.id as string;
    const inC: Headers = { cookie: ownerCookie, [WS]: wC };

    const gone = [
      await createItem(inC, { name: 'Leaves with C, one' }),
      await createItem(inC, { name: 'Leaves with C, two', note: 'and its note' })
    ];
    const staysInA = await createItem(inA(), { name: 'Stays in A' });
    const staysInB = await createItem(inB(), { name: 'Stays in B' });
    expect(await itemsIn(wC)).toBe(2);
    const inABefore = await itemsIn(wA);
    const inBBefore = await itemsIn(wB);

    await deleteWorkspace(wC);

    expect(await itemsIn(wC)).toBe(0);
    const { rows } = await app.db.pool.query('SELECT id FROM items WHERE id = ANY($1::uuid[])', [
      gone.map((i) => i.id)
    ]);
    expect(rows).toEqual([]);

    expect(await itemsIn(wA)).toBe(inABefore);
    expect(await itemsIn(wB)).toBe(inBBefore);
    expect(await readJson(await send('GET', `/items/${staysInA.id}`, inA()))).toMatchObject({
      id: staysInA.id,
      name: 'Stays in A'
    });
    expect(await readJson(await send('GET', `/items/${staysInB.id}`, inB()))).toMatchObject({
      id: staysInB.id,
      name: 'Stays in B'
    });
  });
});
