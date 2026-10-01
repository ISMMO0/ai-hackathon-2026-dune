import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
 * An item sits in the workspace's PROJECTS through the tool's own link
 * (`item_projects`), and every question about the project is the chassis's
 * one predicate (`src/items/projects.ts`). The worked example of a tool
 * resource linked to projects; one block per rule, so a tool that copies the
 * link copies its proof:
 *
 *  - the payload names the projects THE CALLER can read, and no other;
 *  - `?project=` keeps the list to one project, 404 to whoever cannot read it;
 *  - the link's tiers: 404 to a non-reader of the project, 403 below the
 *    editor role, 409 on an archived project, 403 to a guest;
 *  - a create with `projectIds` links in the same transaction, and one
 *    project that does not qualify refuses the whole create and writes nothing;
 *  - unlinking asks the same of the project as the link, so a non-reader
 *    learns nothing from it, not even whether the item is in the project;
 *  - a grant dies with the project membership and with the workspace one;
 *  - the link leaves with the item;
 *  - machines: the link routes are under the items scopes like the rest;
 *  - every link mutation lands its named audit row.
 *
 * The item is read and written by every member (the template's rule), so the
 * fixture's workspace owner appears in the operator-view cases only: a
 * workspace owner manages every project, and cannot pin a refusal.
 */
const PASSWORD = 'items-projects-pass-0001';
const people = {
  owner: { email: 'owner@items-projects.test', name: 'Workspace Owner' },
  /** A plain member on no project: writes every item, reads no project. */
  outsider: { email: 'outsider@items-projects.test', name: 'Plain Member' },
  manager: { email: 'manager@items-projects.test', name: 'Project Manager' },
  editor: { email: 'editor@items-projects.test', name: 'Project Editor' },
  viewer: { email: 'viewer@items-projects.test', name: 'Project Viewer' },
  guest: { email: 'guest@items-projects.test', name: 'A Guest' }
} as const;
type Who = keyof typeof people;
const PHANTOM = '00000000-0000-4000-8000-000000000001';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
const cookies: Record<Who, string> = {} as Record<Who, string>;
const userIds: Record<Who, string> = {} as Record<Who, string>;
const memberIds: Record<Who, string> = {} as Record<Who, string>;
/** The project under test: manager, editor and viewer on it; the outsider is not. */
let project = '';
let projectName = '';

let ipCounter = 0;
const nextIp = () => `10.73.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (
  method: string,
  path: string,
  who: Who | { key: string },
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      ...headers,
      'x-forwarded-for': nextIp(),
      ...(typeof who === 'string' ? { cookie: cookies[who] } : { authorization: `Bearer ${who.key}` }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res.clone());
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

type WireItem = { id: string; projects: Array<{ id: string; name: string }> };

async function createItem(who: Who | { key: string }, body: Record<string, unknown>): Promise<WireItem> {
  const res = await send('POST', '/items', who, { note: '', ...body });
  expect(res.status).toBe(201);
  return (await readJson(res)).item as WireItem;
}

/** The projects an item's payload names TO THIS CALLER, as ids. */
async function projectsSeenBy(who: Who | { key: string }, itemId: string): Promise<string[] | number> {
  const res = await send('GET', `/items/${itemId}`, who);
  if (res.status !== 200) return res.status;
  return ((await readJson(res)) as WireItem).projects.map((p) => p.id);
}

async function listIds(who: Who | { key: string }, query = ''): Promise<string[] | number> {
  const res = await send('GET', `/items${query}`, who);
  if (res.status !== 200) return res.status;
  return ((await readJson(res)).items as WireItem[]).map((i) => i.id);
}

const link = (who: Who | { key: string }, itemId: string, projectId = project) =>
  send('PUT', `/items/${itemId}/projects/${projectId}`, who);
const unlink = (who: Who | { key: string }, itemId: string, projectId = project) =>
  send('DELETE', `/items/${itemId}/projects/${projectId}`, who);

async function itemCount(): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM items WHERE workspace_id = $1',
    [workspaceId]
  );
  return rows[0]!.n;
}

async function linkRows(itemId: string): Promise<string[]> {
  const { rows } = await app.db.pool.query<{ project_id: string }>(
    'SELECT project_id FROM item_projects WHERE item_id = $1 ORDER BY project_id',
    [itemId]
  );
  return rows.map((r) => r.project_id);
}

async function mintKey(who: Who, name: string, scopes: string[]): Promise<{ key: string }> {
  const res = await send('POST', '/api-keys', who, { name, scopes });
  expect(res.status).toBe(201);
  return { key: (await readJson(res)).key as string };
}

async function addToProject(who: Who, role: 'manager' | 'editor' | 'viewer'): Promise<void> {
  const res = await send('POST', `/projects/${project}/members`, 'manager', { userId: userIds[who], role });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'items_projects'));
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'Items in projects',
      owner: { ...people.owner, password: PASSWORD }
    })
  });
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;

  for (const who of Object.keys(people) as Who[]) {
    if (who !== 'owner') {
      const created = await app.auth.api.signUpEmail({ body: { ...people[who], password: PASSWORD } });
      await app.db.db.insert(workspaceMembers).values({
        workspaceId,
        userId: created.user.id,
        role: 'member',
        origin: who === 'guest' ? 'guest' : 'local'
      });
    }
    const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ email: people[who].email, password: PASSWORD })
    });
    expect(signIn.status).toBe(200);
    cookies[who] = extractCookie(signIn);
    const me = await readJson(await send('GET', '/me', who));
    userIds[who] = me.user.id;
    const { rows } = await app.db.pool.query<{ id: string }>(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userIds[who]]
    );
    memberIds[who] = rows[0]!.id;
  }

  // The manager creates the project (any non-guest member may, and becomes
  // its first manager), then seats the editor and the viewer.
  const created = await send('POST', '/projects', 'manager', { name: 'Autumn launch' });
  expect(created.status).toBe(201);
  const body = await readJson(created);
  project = body.id;
  projectName = body.name;
  await addToProject('editor', 'editor');
  await addToProject('viewer', 'viewer');
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ── The payload ─────────────────────────────────────────────────────────────

describe('the payload names the projects the caller can read', () => {
  let item: WireItem;

  it('an editor creates an item linked to the project; the answer names it by id and name', async () => {
    item = await createItem('editor', { name: 'The launch plan', projectIds: [project] });
    expect(item.projects).toEqual([{ id: project, name: projectName }]);
    expect(await linkRows(item.id)).toEqual([project]);
  });

  it('every project member reads the link, whatever their role; the workspace owner too (the operator view)', async () => {
    for (const who of ['manager', 'editor', 'viewer', 'owner'] as const) {
      expect(await projectsSeenBy(who, item.id), who).toEqual([project]);
    }
  });

  it('a member on no project reads the item (the template’s rule) but not the project it sits in', async () => {
    expect(await projectsSeenBy('outsider', item.id)).toEqual([]);
    const listed = await send('GET', '/items', 'outsider');
    const row = ((await readJson(listed)).items as WireItem[]).find((i) => i.id === item.id)!;
    expect(row.projects).toEqual([]);
  });

  it('a guest reads nothing: the 404 of a missing id, the empty list', async () => {
    expect(await projectsSeenBy('guest', item.id)).toBe(404);
    expect(await listIds('guest')).toEqual([]);
  });

  it('the list carries the same projects per row as the read by id', async () => {
    const res = await send('GET', '/items', 'viewer');
    const row = ((await readJson(res)).items as WireItem[]).find((i) => i.id === item.id)!;
    expect(row.projects).toEqual([{ id: project, name: projectName }]);
  });
});

// ── The filter ──────────────────────────────────────────────────────────────

describe('?project= keeps the list to one project', () => {
  let inProject: WireItem;
  let outside: WireItem;

  beforeAll(async () => {
    inProject = await createItem('editor', { name: 'In the project', projectIds: [project] });
    outside = await createItem('outsider', { name: 'Outside every project' });
  });

  it('a project member lists the linked items only; without the filter, every item', async () => {
    const filtered = await listIds('viewer', `?project=${project}`);
    expect(filtered).toContain(inProject.id);
    expect(filtered).not.toContain(outside.id);
    const all = await listIds('viewer');
    expect(all).toContain(inProject.id);
    expect(all).toContain(outside.id);
  });

  it('the workspace owner lists through the filter without a seat on the project', async () => {
    expect(await listIds('owner', `?project=${project}`)).toContain(inProject.id);
  });

  it('a non-reader of the project answers 404 project_not_found: a member on no project, a guest, a phantom id', async () => {
    await expectError(await send('GET', `/items?project=${project}`, 'outsider'), 404, 'project_not_found');
    await expectError(await send('GET', `/items?project=${project}`, 'guest'), 404, 'project_not_found');
    await expectError(await send('GET', `/items?project=${PHANTOM}`, 'manager'), 404, 'project_not_found');
  });

  it('a filter that is not a uuid is a 400', async () => {
    expect((await send('GET', '/items?project=not-a-uuid', 'viewer')).status).toBe(400);
  });
});

// ── The link and its tiers ──────────────────────────────────────────────────

describe('linking: the editor role or more on a live project', () => {
  let item: WireItem;

  beforeAll(async () => {
    item = await createItem('outsider', { name: 'To be linked' });
  });

  it('a member on no project answers 404 project_not_found: the project is not theirs to learn of', async () => {
    await expectError(await link('outsider', item.id), 404, 'project_not_found');
    expect(await linkRows(item.id)).toEqual([]);
  });

  it('a viewer is a proven reader below the role: 403 insufficient_project_role', async () => {
    await expectError(await link('viewer', item.id), 403, 'insufficient_project_role');
    expect(await linkRows(item.id)).toEqual([]);
  });

  it('a guest is refused the mutation as it is refused every item mutation', async () => {
    await expectError(await link('guest', item.id), 403, 'guest_forbidden');
  });

  it('an unknown item answers the item’s 404 first, before the project is looked at', async () => {
    await expectError(await link('editor', PHANTOM), 404, 'not_found');
  });

  it('an editor links; the answer carries the project; linking twice is the same answer', async () => {
    const first = await link('editor', item.id);
    expect(first.status).toBe(200);
    expect(((await readJson(first)) as WireItem).projects).toEqual([{ id: project, name: projectName }]);
    const again = await link('editor', item.id);
    expect(again.status).toBe(200);
    expect(await linkRows(item.id)).toEqual([project]);
  });

  it('a manager and the workspace owner link too', async () => {
    const other = await createItem('outsider', { name: 'Linked by the operator' });
    expect((await link('owner', other.id)).status).toBe(200);
    const third = await createItem('outsider', { name: 'Linked by the manager' });
    expect((await link('manager', third.id)).status).toBe(200);
  });
});

describe('unlinking: the same gate as the link', () => {
  let item: WireItem;

  beforeAll(async () => {
    item = await createItem('editor', { name: 'To be unlinked', projectIds: [project] });
  });

  it('a member on no project answers 404 project_not_found, in or out of the project alike: the link is not probeable', async () => {
    await expectError(await unlink('outsider', item.id), 404, 'project_not_found');
    const never = await createItem('outsider', { name: 'Never linked' });
    await expectError(await unlink('outsider', never.id), 404, 'project_not_found');
    expect(await linkRows(item.id)).toEqual([project]);
  });

  it('a viewer is refused 403 insufficient_project_role; a guest 403 guest_forbidden', async () => {
    await expectError(await unlink('viewer', item.id), 403, 'insufficient_project_role');
    await expectError(await unlink('guest', item.id), 403, 'guest_forbidden');
    expect(await linkRows(item.id)).toEqual([project]);
  });

  it('an item not in the project answers 404 not_linked to an editor', async () => {
    const other = await createItem('outsider', { name: 'Never linked either' });
    await expectError(await unlink('editor', other.id), 404, 'not_linked');
  });

  it('an editor takes the item out, and the payload no longer names the project; a manager and the owner may too', async () => {
    const res = await unlink('editor', item.id);
    expect(res.status).toBe(200);
    expect(((await readJson(res)) as WireItem).projects).toEqual([]);
    expect(await linkRows(item.id)).toEqual([]);
    expect(await projectsSeenBy('viewer', item.id)).toEqual([]);
    const byManager = await createItem('editor', { name: 'Unlinked by the manager', projectIds: [project] });
    expect((await unlink('manager', byManager.id)).status).toBe(200);
    const byOwner = await createItem('editor', { name: 'Unlinked by the owner', projectIds: [project] });
    expect((await unlink('owner', byOwner.id)).status).toBe(200);
  });
});

// ── The create with projectIds ──────────────────────────────────────────────

describe('a create with projectIds links in the same transaction, or writes nothing', () => {
  it('a viewer naming the project is refused 404 project_not_found and no item is written', async () => {
    const before = await itemCount();
    const res = await send('POST', '/items', 'viewer', { name: 'Refused', projectIds: [project] });
    await expectError(res, 404, 'project_not_found');
    expect((await readJson(res)).error.details).toEqual({ projectId: project });
    expect(await itemCount()).toBe(before);
  });

  it('one phantom id among good ones refuses the whole create', async () => {
    const before = await itemCount();
    await expectError(
      await send('POST', '/items', 'editor', { name: 'Refused', projectIds: [project, PHANTOM] }),
      404,
      'project_not_found'
    );
    expect(await itemCount()).toBe(before);
  });

  it('the same id twice makes one link; more than the cap is a 400', async () => {
    const item = await createItem('editor', { name: 'Twice named', projectIds: [project, project] });
    expect(await linkRows(item.id)).toEqual([project]);
    const many = Array.from({ length: 21 }, () => project);
    expect((await send('POST', '/items', 'editor', { name: 'Too many', projectIds: many })).status).toBe(400);
  });
});

// ── A project of another workspace ──────────────────────────────────────────

describe('a project of another workspace is not found from this one, even to the person who manages both', () => {
  let projectElsewhere = '';

  beforeAll(async () => {
    // The owner makes a second workspace and a project in it; every request
    // below runs in the FIRST workspace (the cookie's default), naming that project.
    const created = await send('POST', '/workspaces', 'owner', { name: 'Elsewhere' });
    expect(created.status).toBe(201);
    const elsewhere = (await readJson(created)).workspace.id as string;
    const project = await send(
      'POST',
      '/projects',
      'owner',
      { name: 'Not here' },
      { 'x-workspace-id': elsewhere }
    );
    expect(project.status).toBe(201);
    projectElsewhere = (await readJson(project)).id;
  });

  it('on projectIds, on the link and on the filter: 404 project_not_found, nothing written', async () => {
    const before = await itemCount();
    await expectError(
      await send('POST', '/items', 'owner', { name: 'Across', projectIds: [projectElsewhere] }),
      404,
      'project_not_found'
    );
    expect(await itemCount()).toBe(before);
    const item = await createItem('owner', { name: 'Stays here' });
    await expectError(await link('owner', item.id, projectElsewhere), 404, 'project_not_found');
    await expectError(await unlink('owner', item.id, projectElsewhere), 404, 'project_not_found');
    expect(await linkRows(item.id)).toEqual([]);
    await expectError(
      await send('GET', `/items?project=${projectElsewhere}`, 'owner'),
      404,
      'project_not_found'
    );
  });
});

// ── The archived project ────────────────────────────────────────────────────

describe('an archived project: reads stay, writes through the project stop', () => {
  let linked: WireItem;

  beforeAll(async () => {
    linked = await createItem('editor', { name: 'Linked before the archive', projectIds: [project] });
    expect((await send('POST', `/projects/${project}/archive`, 'manager')).status).toBe(200);
  });

  afterAll(async () => {
    expect((await send('POST', `/projects/${project}/unarchive`, 'manager')).status).toBe(200);
  });

  it('the payload and the filter still name the project', async () => {
    expect(await projectsSeenBy('viewer', linked.id)).toEqual([project]);
    expect(await listIds('viewer', `?project=${project}`)).toContain(linked.id);
  });

  it('a link answers 409 project_archived, to the editor and to the workspace owner alike', async () => {
    const item = await createItem('outsider', { name: 'Not while archived' });
    await expectError(await link('editor', item.id), 409, 'project_archived');
    await expectError(await link('owner', item.id), 409, 'project_archived');
    expect(await linkRows(item.id)).toEqual([]);
  });

  it('a create naming the archived project is refused uniformly: 404 project_not_found', async () => {
    const before = await itemCount();
    await expectError(
      await send('POST', '/items', 'editor', { name: 'Not while archived', projectIds: [project] }),
      404,
      'project_not_found'
    );
    expect(await itemCount()).toBe(before);
  });

  it('an unlink answers 409 project_archived too: an archived project takes no change to what it holds', async () => {
    await expectError(await unlink('editor', linked.id), 409, 'project_archived');
    await expectError(await unlink('owner', linked.id), 409, 'project_archived');
    expect(await linkRows(linked.id)).toEqual([project]);
  });
});

// ── The grant dies with the membership ──────────────────────────────────────

describe('a grant dies with the membership it rides on', () => {
  let item: WireItem;

  beforeAll(async () => {
    item = await createItem('editor', { name: 'Seen while on the project', projectIds: [project] });
  });

  it('removed from the project, the viewer reads the item without its project and is refused the filter', async () => {
    expect(await projectsSeenBy('viewer', item.id)).toEqual([project]);
    expect((await send('DELETE', `/projects/${project}/members/${userIds.viewer}`, 'manager')).status).toBe(
      200
    );
    expect(await projectsSeenBy('viewer', item.id)).toEqual([]);
    await expectError(await send('GET', `/items?project=${project}`, 'viewer'), 404, 'project_not_found');
    await addToProject('viewer', 'viewer');
    expect(await projectsSeenBy('viewer', item.id)).toEqual([project]);
  });

  it('removed from the workspace, the project grant is deleted by the cascade', async () => {
    const before = await app.db.pool.query('SELECT 1 FROM project_members WHERE member_id = $1', [
      memberIds.viewer
    ]);
    expect(before.rowCount).toBe(1);
    expect((await send('DELETE', `/members/${memberIds.viewer}`, 'owner')).status).toBe(200);
    const after = await app.db.pool.query('SELECT 1 FROM project_members WHERE member_id = $1', [
      memberIds.viewer
    ]);
    expect(after.rowCount).toBe(0);
  });

  it('the link leaves with the item, and the final snapshot still names the project it sat in', async () => {
    const res = await send('DELETE', `/items/${item.id}`, 'editor');
    expect(res.status).toBe(200);
    expect(((await readJson(res)) as WireItem).projects).toEqual([{ id: project, name: projectName }]);
    expect(await linkRows(item.id)).toEqual([]);
  });
});

// ── Machines ────────────────────────────────────────────────────────────────

describe('machine credentials: the link routes sit under the items scopes', () => {
  let item: WireItem;
  let readKey: { key: string };
  let writeKey: { key: string };

  beforeAll(async () => {
    item = await createItem('outsider', { name: 'Linked by a key' });
    readKey = await mintKey('editor', 'read', ['items:read']);
    writeKey = await mintKey('editor', 'write', ['items:write']);
  });

  it('a read key is refused the link and the unlink: 403 insufficient_scope, nothing written', async () => {
    await expectError(await link(readKey, item.id), 403, 'insufficient_scope');
    await expectError(await unlink(readKey, item.id), 403, 'insufficient_scope');
    expect(await linkRows(item.id)).toEqual([]);
  });

  it('a write key links and unlinks as its holder; a read key lists through the filter', async () => {
    expect((await link(writeKey, item.id)).status).toBe(200);
    expect(await listIds(readKey, `?project=${project}`)).toContain(item.id);
    expect((await unlink(writeKey, item.id)).status).toBe(200);
    expect(await linkRows(item.id)).toEqual([]);
  });
});

// ── Audit ───────────────────────────────────────────────────────────────────

describe('every link mutation lands its named audit row', () => {
  it('item.project_link and item.project_unlink carry the project id; a create with projectIds names them', async () => {
    const item = await createItem('editor', { name: 'Audited', projectIds: [project] });
    expect((await link('editor', item.id)).status).toBe(200);
    expect((await unlink('editor', item.id)).status).toBe(200);
    const { rows } = await app.db.pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_log WHERE resource_type = 'item' AND resource_id = $1 ORDER BY id`,
      [item.id]
    );
    expect(rows.map((r) => r.action)).toEqual(['item.create', 'item.project_link', 'item.project_unlink']);
    expect(rows[0]!.metadata).toEqual({ name: 'Audited', projectIds: [project] });
    expect(rows[1]!.metadata).toEqual({ projectId: project });
    expect(rows[2]!.metadata).toEqual({ projectId: project });
  });
});
