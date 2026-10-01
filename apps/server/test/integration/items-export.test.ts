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
 * The items in `GET /workspace/export`, through the REAL boot: the tool's
 * entry of the bundle (slot `api.exportEntries`, `src/items/export.ts`).
 *
 * The chassis proves the slot itself on its own test tool
 * (`packages/chassis-server/test/integration/export-entries.test.ts`: the
 * sanitized names, the 500s, the workspace id that is never a request value).
 * This file proves what is the TOOL's to hold, and that the chassis's rules
 * still stand in front of the tool's entry:
 *
 *  - the bundle of a workspace holds `items.json`, after `files.json`, with
 *    exactly that workspace's items, oldest first, and none of another's,
 *    then `item_projects.json`, the links to its projects;
 *  - a workspace without items gets `items.json` holding `[]`, and the same
 *    for the links;
 *  - the columns are the seven of the wire shape and nothing else (the
 *    projects the wire names per caller are not a column: the links are
 *    their own entry, with their five columns);
 *  - a plain member and a guest are refused; a key without `data:export` is
 *    refused, a key with it gets the entry.
 *
 * The export bucket is 5 per USER per 10 minutes, and a key spends its
 * owner's: the owner exports three times here, the member and the guest once.
 */

const OWNER = { email: 'owner@items-export.test', name: 'Export Owner', password: 'export-owner-password-1' };
const MEMBER = {
  email: 'member@items-export.test',
  name: 'Export Member',
  password: 'export-member-password-1'
};
const GUEST = {
  email: 'guest@items-export.test',
  name: 'Export Guest',
  password: 'export-guest-password-12'
};
const WS = 'x-workspace-id';

/** The columns of an exported item, in order: the wire shape of `itemSchema`, minus the per-caller `projects`. */
const EXPORTED_KEYS = ['id', 'workspaceId', 'name', 'note', 'createdBy', 'createdAt', 'updatedAt'];
/** The columns of an exported link, in order. */
const EXPORTED_LINK_KEYS = ['itemId', 'projectId', 'workspaceId', 'addedBy', 'createdAt'];

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie = '';
let wA = '';
let wB = '';
let wEmpty = '';

let ipCounter = 0;
const nextIp = () => `10.72.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

type Headers = Record<string, string>;
type WireItem = Record<string, unknown> & { id: string };

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

const inWorkspace = (id: string): Headers => ({ cookie: ownerCookie, [WS]: id });

async function createItem(
  workspaceId: string,
  body: { name: string; note?: string; projectIds?: string[] }
): Promise<WireItem> {
  const res = await send('POST', '/items', inWorkspace(workspaceId), body);
  expect(res.status).toBe(201);
  // The wire names the projects the caller can read; the export does not
  // (the links are their own entry), so the row compared below is without it.
  const { projects: _projects, ...row } = (await readJson(res)).item as WireItem & { projects: unknown };
  return row as WireItem;
}

async function createWorkspace(name: string): Promise<string> {
  const res = await send('POST', '/workspaces', { cookie: ownerCookie }, { name });
  expect(res.status).toBe(201);
  return (await readJson(res)).workspace.id as string;
}

async function mintKey(name: string, scopes: string[]): Promise<Headers> {
  const res = await send('POST', '/api-keys', inWorkspace(wA), { name, scopes });
  expect(res.status).toBe(201);
  return { authorization: `Bearer ${(await readJson(res)).key as string}`, [WS]: wA };
}

async function bundleOf(headers: Headers): Promise<AdmZip> {
  const res = await send('GET', '/workspace/export', headers);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  return new AdmZip(Buffer.from(await res.arrayBuffer()));
}

let itemsOfA: WireItem[] = [];
let itemOfB: WireItem;
let projectOfA = '';

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'items_export'));

  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Workspace A', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  wA = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER);
  wB = await createWorkspace('Workspace B');
  wEmpty = await createWorkspace('Workspace Empty');

  // A's and B's items are interleaved in time: only the WHERE separates them.
  // The names sort in the REVERSE of the creation order, so an export ordered by name, or
  // not ordered at all, cannot pass for oldest first (verifier round 3, F1).
  const first = await createItem(wA, { name: 'Zulu, the first of A', note: 'line one\nline two' });
  itemOfB = await createItem(wB, { name: 'Only of B', note: 'never in the bundle of A' });
  // B's item sits in a project of B: a link row of another workspace, which
  // only the WHERE of the links entry keeps out of A's bundle.
  const projectB = await send('POST', '/projects', inWorkspace(wB), { name: 'Project of B' });
  expect(projectB.status).toBe(201);
  const linkedB = await send(
    'PUT',
    `/items/${itemOfB.id}/projects/${(await readJson(projectB)).id as string}`,
    inWorkspace(wB)
  );
  expect(linkedB.status).toBe(200);
  const second = await createItem(wA, { name: 'Yankee, the second of A' });
  // The third sits in a project of A: its link is the one row of item_projects.json.
  const project = await send('POST', '/projects', inWorkspace(wA), { name: 'Export project' });
  expect(project.status).toBe(201);
  projectOfA = (await readJson(project)).id as string;
  const third = await createItem(wA, { name: 'Xray, the third of A', note: '', projectIds: [projectOfA] });
  itemsOfA = [first, second, third];
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the items entry of the workspace export', () => {
  it('items.json sits right after files.json and holds exactly the workspace’s items, oldest first, in the wire shape', async () => {
    const zip = await bundleOf(inWorkspace(wA));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.indexOf('files.json')).toBeGreaterThanOrEqual(0);
    expect(names[names.indexOf('files.json') + 1]).toBe('items.json');
    expect(names.filter((n) => n === 'items.json')).toHaveLength(1);

    // Byte for byte what the routes answered for the same rows: the ids, the
    // author, the ISO timestamps, in (created_at, id) order.
    expect(zip.readAsText('items.json')).toBe(JSON.stringify(itemsOfA, null, 2) + '\n');

    const rows = JSON.parse(zip.readAsText('items.json')) as WireItem[];
    expect(rows.map((r) => r.workspaceId)).toEqual([wA, wA, wA]);
    expect(rows.map((r) => r.id)).not.toContain(itemOfB.id);
    expect(zip.readAsText('items.json')).not.toContain('never in the bundle of A');
  });

  it('a key that holds data:export gets the entry, and its columns are exactly the seven selected ones', async () => {
    // The key set is pinned: a column added to the table does not leave the
    // instance until it is added to the selection AND to this list.
    const zip = await bundleOf(await mintKey('export', ['data:export']));
    const rows = JSON.parse(zip.readAsText('items.json')) as WireItem[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Object.keys(row)).toEqual(EXPORTED_KEYS);
  });

  it('item_projects.json follows items.json and holds the workspace’s links, with their five columns', async () => {
    const zip = await bundleOf(inWorkspace(wA));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names[names.indexOf('items.json') + 1]).toBe('item_projects.json');
    // The chassis writes the projects themselves, before the tool's entries.
    expect(names.indexOf('projects.json')).toBeLessThan(names.indexOf('items.json'));
    const links = JSON.parse(zip.readAsText('item_projects.json')) as Array<Record<string, unknown>>;
    // One row: A's own link. B's link is absent, and every row names A (the
    // statement's WHERE, not the fixture's shape, is what keeps B out).
    expect(links).toHaveLength(1);
    expect(Object.keys(links[0]!)).toEqual(EXPORTED_LINK_KEYS);
    expect(links[0]).toMatchObject({ itemId: itemsOfA[2]!.id, projectId: projectOfA, workspaceId: wA });
    expect(links.map((l) => l.workspaceId)).toEqual([wA]);
    expect(links.map((l) => l.itemId)).not.toContain(itemOfB.id);
  });

  it('a workspace without items gets items.json and item_projects.json each holding an empty array', async () => {
    const zip = await bundleOf(inWorkspace(wEmpty));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names[names.indexOf('files.json') + 1]).toBe('items.json');
    expect(zip.readAsText('items.json')).toBe('[]\n');
    expect(zip.readAsText('item_projects.json')).toBe('[]\n');
  });
});

describe('the chassis’s rules stand in front of the tool’s entry', () => {
  it('a plain member is refused the export', async () => {
    const invited = await readJson(
      await send('POST', '/invitations', inWorkspace(wA), { email: MEMBER.email, role: 'member' })
    );
    const accepted = await send(
      'POST',
      '/invitations/accept',
      {},
      { token: invited.acceptUrl.split('/invite/')[1], name: MEMBER.name, password: MEMBER.password }
    );
    expect(accepted.status).toBe(200);
    const res = await send('GET', '/workspace/export', { cookie: await signIn(MEMBER) });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect((await readJson(res)).error.code).toBe('forbidden');
  });

  it('a guest is refused the export', async () => {
    // A guest membership of A, seeded the way the chassis suite seeds one.
    const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [wA, guestUserId]
    );
    const res = await send('GET', '/workspace/export', { cookie: await signIn(GUEST) });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_forbidden');
  });

  it('a key that holds the items scopes but not data:export is refused; the scope stays opt-in', async () => {
    const res = await send(
      'GET',
      '/workspace/export',
      await mintKey('items-only', ['items:read', 'items:write'])
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('insufficient_scope');
  });
});
