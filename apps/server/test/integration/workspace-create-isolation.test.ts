import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * ISOLATION of a workspace created from inside the product, self-hosted
 * (PRDCT-2444). The instance used to hold ONE workspace for everyone; from
 * now on any member can open a second one, so the boundary between two
 * workspaces of the SAME instance is a real tenant boundary.
 *
 *   workspace 1 — Ann owns it: a file, a member (Bob), an open invitation,
 *                 an API key, audit rows.
 *   workspace 2 — Bob (a PLAIN member of 1) creates it through the route,
 *                 uploads a file, invites Cy, who accepts.
 *
 * Asserted, through the HTTP API only:
 *  - Bob IN workspace 2, and Cy, read NOTHING of workspace 1 — beyond what
 *    Bob's plain membership of 1 already allowed him WHILE ADDRESSING 1
 *    (and even there: not her file — the blob read scope, SL-B1);
 *  - Ann reads nothing of workspace 2: files list/get/content, members,
 *    invitations, audit, export, keys;
 *  - Bob's API key PINNED to workspace 2 cannot reach workspace 1;
 *  - the cross-workspace mint refusal still refuses Bob as a target.
 *
 * The DOMAIN half: an item of workspace 2 is hidden from, and unwritable by,
 * workspace 1 — for Ann, and for Bob himself while he addresses workspace 1
 * (he holds the item in 2; the workspace of the REQUEST rules, not the person).
 * Items reference no blob, so "an item cannot bind the other workspace's blob"
 * has no subject here: it comes with a tool whose resource references a blob.
 */
const ANN = { email: 'ann@isolation.test', name: 'Ann Owner', password: 'ann-owner-password-1234' };
const BOB = { email: 'bob@isolation.test', name: 'Bob Builder', password: 'bob-member-password-123' };
const CY = { email: 'cy@isolation.test', name: 'Cy Invitee', password: 'cy-invitee-password-1234' };

const WS = 'x-workspace-id';
const FILE1 = 'ONE-SECRET-FILE-BYTES';
const FILE2 = 'TWO-SECRET-FILE-BYTES';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let w1 = '';
let w2 = '';
let annCookie = '';
let bobCookie = '';
let cyCookie = '';
let file1 = '';
let file2 = '';
let item1 = '';
let item2 = '';
const ITEM2_NAME = 'two-private-item';
let bobPinnedKey = '';
let bobMemberIdInW1 = '';

let ipCounter = 0;
const nextIp = () => `10.62.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

type Creds = { cookie: string } | { authorization: string };
const as = (creds: Creds, workspace?: string): Record<string, string> => ({
  ...creds,
  ...(workspace ? { [WS]: workspace } : {})
});
const get = (path: string, headers: Record<string, string>) => app.app.request(`/api/v1${path}`, { headers });

async function signIn(who: { email: string; password: string }): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json(who));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function uploadFile(headers: Record<string, string>, name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...headers },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

async function createItem(headers: Record<string, string>, name: string): Promise<string> {
  const res = await app.app.request('/api/v1/items', json({ name, note: `note of ${name}` }, headers));
  expect(res.status).toBe(201);
  return (await readJson(res)).item.id as string;
}

async function invite(headers: Record<string, string>, email: string): Promise<string> {
  const res = await app.app.request('/api/v1/invitations', json({ email, role: 'member' }, headers));
  expect(res.status).toBe(201);
  return ((await readJson(res)).acceptUrl as string).split('/invite/')[1]!;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'ws_create_isolation'));

  // ── Workspace 1: Ann's. ────────────────────────────────────────────────
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Workspace One', owner: ANN })
  );
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;
  annCookie = await signIn(ANN);
  file1 = await uploadFile({ cookie: annCookie }, 'one-private.txt', FILE1);
  item1 = await createItem({ cookie: annCookie }, 'one-private-item');
  // Bob joins 1 as a PLAIN member, through the real invitation flow.
  const bobToken = await invite({ cookie: annCookie }, BOB.email);
  const accepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: bobToken, name: BOB.name, password: BOB.password })
  );
  expect(accepted.status).toBe(200);
  bobCookie = await signIn(BOB);
  // An OPEN invitation and an API key, so 1 has something to leak.
  await invite({ cookie: annCookie }, 'pending-one@isolation.test');
  const annKey = await app.app.request(
    '/api/v1/api-keys',
    json({ name: 'one-key', scopes: ['items:read'] }, { cookie: annCookie })
  );
  expect(annKey.status).toBe(201);

  // ── Workspace 2: Bob creates it THROUGH THE ROUTE. ─────────────────────
  const created = await app.app.request(
    '/api/v1/workspaces',
    json({ name: 'Workspace Two' }, { cookie: bobCookie })
  );
  expect(created.status).toBe(201);
  w2 = (await readJson(created)).workspace.id;
  const bob2 = as({ cookie: bobCookie }, w2);
  file2 = await uploadFile(bob2, 'two-private.txt', FILE2);
  item2 = await createItem(bob2, ITEM2_NAME);
  const cyToken = await invite(bob2, CY.email);
  const cyAccepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: cyToken, name: CY.name, password: CY.password })
  );
  expect(cyAccepted.status).toBe(200);
  expect((await readJson(cyAccepted)).workspaceId).toBe(w2);
  cyCookie = await signIn(CY);
  await invite(bob2, 'pending-two@isolation.test');

  const pinned = await app.app.request(
    '/api/v1/api-keys',
    json(
      {
        name: 'two-pinned',
        scopes: ['items:read', 'items:write', 'data:export'],
        workspaceId: w2
      },
      bob2
    )
  );
  expect(pinned.status).toBe(201);
  bobPinnedKey = (await readJson(pinned)).key;

  const roster = await readJson(await get('/members', { cookie: annCookie }));
  bobMemberIdInW1 = roster.members.find((m: { email: string }) => m.email === BOB.email).id;
}, 300_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

/** Every read of one file, by id. */
async function expectFileHidden(file: string, headers: Record<string, string>): Promise<void> {
  for (const path of [`/files/${file}`, `/files/${file}/content`]) {
    const res = await get(path, headers);
    expect(res.status, `${path} must hide existence`).toBe(404);
    expect(await res.text()).not.toContain('SECRET');
  }
  const head = await app.app.request(`/api/v1/files/${file}/content`, { method: 'HEAD', headers });
  expect(head.status).toBe(404);
}

describe('Ann (owner of 1) reads NOTHING of workspace 2', () => {
  it('cannot even address it: every request naming workspace 2 fails closed, 401', async () => {
    for (const path of ['/me', '/items', '/files', '/members', '/invitations', '/audit', '/api-keys']) {
      expect((await get(path, as({ cookie: annCookie }, w2))).status, path).toBe(401);
    }
    expect((await get('/workspace/export', as({ cookie: annCookie }, w2))).status).toBe(401);
    // /me does not list it.
    const me = await readJson(await get('/me', { cookie: annCookie }));
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([w1]);
  });

  it('from inside workspace 1 — as its OWNER, the widest view there is — 2’s file does not exist', async () => {
    const ann = { cookie: annCookie };
    await expectFileHidden(file2, ann);
    const files = await readJson(await get('/files', ann));
    expect(files.files.map((f: { id: string }) => f.id)).not.toContain(file2);
    expect(JSON.stringify(files)).not.toContain('two-private');
  });

  it('cannot WRITE into it either: deleting its file answers 404, and the file is intact', async () => {
    const ann = { cookie: annCookie };
    const delFile = await app.app.request(`/api/v1/files/${file2}`, { method: 'DELETE', headers: ann });
    expect(delFile.status).toBe(404);
    // Still intact.
    const still = await get(`/files/${file2}/content`, as({ cookie: bobCookie }, w2));
    expect(still.status).toBe(200);
    expect(await still.text()).toBe(FILE2);
  });

  it('an item of workspace 2 does not exist from workspace 1: every read by id is 404', async () => {
    // Ann (owner of 1), and Bob ADDRESSING 1: he holds the item in 2, and that changes nothing.
    for (const [who, headers] of [
      ['Ann', { cookie: annCookie }],
      ['Bob addressing 1', as({ cookie: bobCookie }, w1)]
    ] as const) {
      const byId = await get(`/items/${item2}`, headers);
      expect(byId.status, who).toBe(404);
      expect((await readJson(byId)).error.code, who).toBe('not_found');
      const list = await readJson(await get('/items', headers));
      expect(
        list.items.map((i: { id: string }) => i.id),
        who
      ).toEqual([item1]);
      expect(JSON.stringify(list), who).not.toContain(ITEM2_NAME);
    }
    // A cursor of workspace 2 positions nothing inside workspace 1's list.
    const foreignCursor = await readJson(await get(`/items?cursor=${item2}`, { cookie: annCookie }));
    expect(JSON.stringify(foreignCursor)).not.toContain(ITEM2_NAME);
  });

  it('an item of workspace 2 cannot be patched or deleted from workspace 1: all 404', async () => {
    for (const [who, headers] of [
      ['Ann', { cookie: annCookie }],
      ['Bob addressing 1', as({ cookie: bobCookie }, w1)]
    ] as const) {
      const patch = await app.app.request(`/api/v1/items/${item2}`, {
        ...json({ name: 'taken over', note: '' }, headers),
        method: 'PATCH'
      });
      expect(patch.status, `patch: ${who}`).toBe(404);
      const del = await app.app.request(`/api/v1/items/${item2}`, { method: 'DELETE', headers });
      expect(del.status, `delete: ${who}`).toBe(404);
    }
    // Still intact, from where it lives.
    const still = await get(`/items/${item2}`, as({ cookie: bobCookie }, w2));
    expect(still.status).toBe(200);
    expect(await readJson(still)).toMatchObject({
      id: item2,
      workspaceId: w2,
      name: ITEM2_NAME,
      note: `note of ${ITEM2_NAME}`
    });
  });

  it('members, invitations, keys, audit and the export of workspace 1 carry nothing of workspace 2', async () => {
    const ann = { cookie: annCookie };
    const members = JSON.stringify(await readJson(await get('/members', ann)));
    expect(members).toContain(BOB.email); // Bob IS a member of 1
    expect(members).not.toContain(CY.email);
    const invitations = JSON.stringify(await readJson(await get('/invitations', ann)));
    expect(invitations).toContain('pending-one@');
    expect(invitations).not.toContain('pending-two@');
    expect(invitations).not.toContain(CY.email);
    const keys = JSON.stringify(await readJson(await get('/api-keys', ann)));
    expect(keys).not.toContain('two-pinned');

    // Audit: page through ALL of it.
    let audit = '';
    let cursor: string | null = null;
    do {
      const page = await readJson(await get(`/audit${cursor ? `?cursor=${cursor}` : ''}`, ann));
      audit += JSON.stringify(page);
      cursor = page.nextCursor;
    } while (cursor);
    for (const needle of [w2, file2, item2, ITEM2_NAME, 'workspace.create', 'Workspace Two', CY.email]) {
      expect(audit, `workspace 1's audit log mentions ${needle}`).not.toContain(needle);
    }

    const exported = await get('/workspace/export', { ...ann, 'x-forwarded-for': nextIp() });
    expect(exported.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await exported.arrayBuffer()));
    expect(JSON.parse(zip.readAsText('manifest.json')).workspaceId).toBe(w1);
    const everything = zip
      .getEntries()
      .map((e) => `${e.entryName}\n${e.getData().toString('utf8')}`)
      .join('\n');
    expect(everything).toContain(FILE1);
    for (const needle of [
      w2,
      file2,
      FILE2,
      'TWO-SECRET',
      'two-private',
      'Workspace Two',
      CY.email,
      'pending-two@'
    ]) {
      expect(everything, `workspace 1's export carries ${needle}`).not.toContain(needle);
    }
  });
});

describe('Bob in workspace 2, and Cy, read NOTHING of workspace 1', () => {
  it('Cy cannot address workspace 1 at all, and from workspace 2 its file does not exist', async () => {
    const cy = { cookie: cyCookie };
    for (const path of ['/me', '/items', '/files', '/members', '/invitations', '/audit']) {
      expect((await get(path, as(cy, w1))).status, path).toBe(401);
    }
    const me = await readJson(await get('/me', cy));
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([w2]);
    await expectFileHidden(file1, cy);
    // Not even Bob's file, inside the workspace they share: a plain member reads the blobs they uploaded.
    await expectFileHidden(file2, cy);
    expect(JSON.stringify(await readJson(await get('/files', cy)))).not.toContain('one-private');
    const members = JSON.stringify(await readJson(await get('/members', cy)));
    expect(members).not.toContain(ANN.email);
  });

  it('Bob, ADDRESSING workspace 2 as its owner, sees only workspace 2', async () => {
    const bob2 = as({ cookie: bobCookie }, w2);
    await expectFileHidden(file1, bob2);
    const files = JSON.stringify(await readJson(await get('/files', bob2)));
    expect(files).not.toContain('one-private');
    const members = JSON.stringify(await readJson(await get('/members', bob2)));
    expect(members).not.toContain(ANN.email);
    expect(members).toContain(CY.email);
    const invitations = JSON.stringify(await readJson(await get('/invitations', bob2)));
    expect(invitations).not.toContain('pending-one@');
    const keys = JSON.stringify(await readJson(await get('/api-keys', bob2)));
    expect(keys).not.toContain('one-key');

    let audit = '';
    let cursor: string | null = null;
    do {
      const page = await readJson(await get(`/audit${cursor ? `?cursor=${cursor}` : ''}`, bob2));
      audit += JSON.stringify(page);
      cursor = page.nextCursor;
    } while (cursor);
    expect(audit).toContain('workspace.create'); // its own genesis row
    for (const needle of [w1, file1, 'one-private', ANN.email, 'instance.setup']) {
      expect(audit, `workspace 2's audit log mentions ${needle}`).not.toContain(needle);
    }

    const exported = await get('/workspace/export', { ...bob2, 'x-forwarded-for': nextIp() });
    expect(exported.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await exported.arrayBuffer()));
    expect(JSON.parse(zip.readAsText('manifest.json')).workspaceId).toBe(w2);
    const everything = zip
      .getEntries()
      .filter((e) => e.entryName !== 'manifest.json') // carries the INSTANCE name, public via GET /instance
      .map((e) => `${e.entryName}\n${e.getData().toString('utf8')}`)
      .join('\n');
    expect(everything).toContain(FILE2);
    for (const needle of [
      w1,
      file1,
      FILE1,
      'ONE-SECRET',
      'one-private',
      ANN.email,
      'pending-one@',
      'one-key'
    ]) {
      expect(everything, `workspace 2's export carries ${needle}`).not.toContain(needle);
    }
  });

  it('owning workspace 2 widens NOTHING in workspace 1: Bob is still a plain member there', async () => {
    const bob1 = as({ cookie: bobCookie }, w1);
    const me = await readJson(await get('/me', bob1));
    expect(me.role).toBe('member');
    // SL-B1: membership alone is not a blob read — Ann's file stays hidden.
    await expectFileHidden(file1, bob1);
    // Admin surfaces stay closed.
    expect((await get('/audit', bob1)).status).toBe(403);
    expect((await get('/workspace/export', bob1)).status).toBe(403);
    expect(
      (await app.app.request('/api/v1/invitations', json({ email: 'x@y.test', role: 'member' }, bob1))).status
    ).toBe(403);
    // And his workspace-2 file is not reachable while addressing workspace 1.
    await expectFileHidden(file2, bob1);
  });
});

describe('an API key of Bob PINNED to workspace 2 cannot reach workspace 1', () => {
  it('resolves its pin, refuses the other workspace loudly, and finds nothing of 1 by id', async () => {
    const key = { authorization: `Bearer ${bobPinnedKey}` };
    const me = await readJson(await get('/me', key));
    expect(me.activeWorkspaceId).toBe(w2);
    const named = await get('/items', as(key, w1));
    expect(named.status).toBe(403);
    expect((await readJson(named)).error.code).toBe('workspace_mismatch');
    await expectFileHidden(file1, key);
    expect((await get('/items', key)).status).toBe(200);
    // data:export on the pin exports the PIN, never workspace 1.
    const exported = await get('/workspace/export', { ...key, 'x-forwarded-for': nextIp() });
    expect(exported.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await exported.arrayBuffer()));
    expect(JSON.parse(zip.readAsText('manifest.json')).workspaceId).toBe(w2);
    // And a key cannot create a third workspace.
    const create = await app.app.request('/api/v1/workspaces', json({ name: 'By key' }, key));
    expect(create.status).toBe(403);
  });
});

describe('the cross-workspace guards did not loosen', () => {
  it('Ann can no longer mint a sign-in-equivalent link for Bob: cross_workspace_target', async () => {
    for (const [path, body] of [
      [`/members/${bobMemberIdInW1}/reset-link`, undefined],
      [`/members/${bobMemberIdInW1}/change-email-link`, { newEmail: 'bob-new@isolation.test' }]
    ] as Array<[string, unknown]>) {
      const res = await app.app.request(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: annCookie },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      expect(res.status, path).toBe(403);
      expect((await readJson(res)).error.code).toBe('cross_workspace_target');
    }
  });

  it('Ann cannot DELETE Bob’s account out from under workspace 2, and the last-owner guard covers BOTH his workspaces', async () => {
    const del = await app.app.request(`/api/v1/members/${bobMemberIdInW1}`, {
      method: 'DELETE',
      headers: { cookie: annCookie }
    });
    expect(del.status).toBe(409);
    expect((await readJson(del)).error.code).toBe('member_of_other_workspaces');
    // Bob is the sole owner of workspace 2: deleting his own account is refused too.
    const self = await app.app.request(
      '/api/v1/auth/delete-user',
      json({ password: BOB.password }, { cookie: bobCookie })
    );
    expect(self.status).toBe(400);
    expect(JSON.stringify(await readJson(self))).toContain('active owner');
    const still = await app.db.pool.query(`SELECT count(*)::int AS n FROM "user" WHERE email = $1`, [
      BOB.email
    ]);
    expect(still.rows[0].n).toBe(1);
    const owner = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' AND is_active`,
      [w2]
    );
    expect(owner.rows[0].n).toBe(1);
  });
});
