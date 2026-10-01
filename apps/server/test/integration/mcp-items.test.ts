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
 * The tool's MCP tool set, driven as a real MCP client drives it: raw JSON-RPC
 * POSTs against /mcp (stateless transport, plain JSON answers) authenticated
 * with API keys. The worked example of a tool's MCP proof:
 *
 *  - `tools/list` is EXACTLY the chassis's sixteen plus the tool's seven, with the
 *    right annotations and the `workspace` argument on every one. The names
 *    are literals HERE: a test that read them from the code would pin nothing;
 *  - whoami answers who is connected, the scopes, the organizations;
 *  - create → list → get → update → delete round-trips, and lands the same
 *    audit rows as HTTP (the tools re-enter /api/v1, there is no second path);
 *  - scope UX: a read key is refused the write tools, a key without the read
 *    scope is refused the read tools, both with the actionable sentence;
 *  - an item lives in ONE workspace, chosen by the `workspace` argument;
 *  - a guest lists none, reads not_found, and cannot write.
 */

const OWNER = { email: 'owner@mcp-items.test', name: 'MCP Owner', password: 'mcp-owner-password-1' };
const GUEST = { email: 'guest@mcp-items.test', name: 'MCP Guest', password: 'mcp-guest-password-12' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const CHASSIS_TOOLS = ['get_me', 'list_files'];
/** The chassis's project and team tools, under the tool's prefix, in registration order (their proof is the chassis's). */
const PROJECT_TOOLS = [
  'starter_list_projects',
  'starter_get_project',
  'starter_list_project_members',
  'starter_create_project',
  'starter_update_project',
  'starter_archive_project',
  'starter_add_project_member',
  'starter_set_project_member_role',
  'starter_remove_project_member',
  'starter_set_project_team_role',
  'starter_remove_project_team',
  'starter_list_teams',
  'starter_list_team_members'
];
const READ_TOOLS = ['starter_list_items', 'starter_get_item'];
/** The run reads, registered after the voice tools. */
const RUN_READ_TOOLS = ['starter_run_get', 'starter_list_runs'];
const WRITE_TOOLS = [
  'starter_create_item',
  'starter_update_item',
  'starter_delete_item',
  'starter_link_item_to_project',
  'starter_unlink_item_from_project',
  'starter_voice_speak',
  'starter_voice_transcribe',
  'starter_run_start'
];

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie = '';
let ownerUserId = '';
let wA = '';
let wB = '';
let rwKey = '';
let readKey = '';
let writeKey = '';

// TRUST_PROXY=true in tests: rotate forwarded IPs so the per-IP /mcp bucket never interferes.
let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

let rpcId = 0;

/** One raw JSON-RPC POST to /mcp; returns the JSON-RPC result (a protocol-level error fails the test). */
async function rpc(key: string, method: string, params: unknown = {}) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, `JSON-RPC error for ${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
  return body.result;
}

/** Call one tool; `data` is the parsed JSON text block (null for an error sentence). */
async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(key, 'tools/call', { name, arguments: args });
  const text: string = result.content?.[0]?.text ?? '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // an error sentence, not JSON
  }
  return { isError: result.isError === true, text, data };
}

async function mintKey(cookie: string, name: string, scopes: string[]): Promise<string> {
  const res = await app.app.request('/api/v1/api-keys', json({ name, scopes }, { cookie }));
  expect(res.status).toBe(201);
  return (await readJson(res)).key as string;
}

const signIn = async (who: { email: string; password: string }) =>
  extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );

const itemCount = async (workspaceId: string) =>
  (
    await app.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items WHERE workspace_id = $1`, [
      workspaceId
    ])
  ).rows[0]!.n;

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'mcp_items'));

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Workspace A', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  wA = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER);
  ownerUserId = (await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } })))
    .user.id;

  // A second workspace of the SAME person: the `workspace` argument rules, not the person.
  const created = await app.app.request(
    '/api/v1/workspaces',
    json({ name: 'Workspace B' }, { cookie: ownerCookie })
  );
  expect(created.status).toBe(201);
  wB = (await readJson(created)).workspace.id;

  // User-scoped keys (no pin): each call names its workspace, the default is A.
  rwKey = await mintKey(ownerCookie, 'rw', ['items:read', 'items:write']);
  readKey = await mintKey(ownerCookie, 'read-only', ['items:read']);
  writeKey = await mintKey(ownerCookie, 'write-only', ['items:write']);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the tool list', () => {
  interface ToolInfo {
    name: string;
    description: string;
    inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }
  let tools: ToolInfo[] = [];
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  beforeAll(async () => {
    tools = (await rpc(rwKey, 'tools/list')).tools as ToolInfo[];
  });

  it("is exactly the chassis's two, then whoami, the eleven project tools and the two team reads (the chassis registers them under the tool's prefix), then the tool's seven, in registration order", () => {
    expect(tools.map((t) => t.name)).toEqual([
      ...CHASSIS_TOOLS,
      'starter_whoami',
      ...PROJECT_TOOLS,
      ...READ_TOOLS,
      ...WRITE_TOOLS,
      ...RUN_READ_TOOLS
    ]);
  });

  it('every tool takes the optional `workspace` argument', () => {
    for (const tool of tools) {
      expect(tool.inputSchema?.properties?.workspace, `${tool.name} lacks the workspace arg`).toBeDefined();
      expect(tool.inputSchema?.required ?? []).not.toContain('workspace');
    }
  });

  it('read tools declare readOnlyHint; write tools do not, and say confirm-first; the delete, the unlink, the member removal and the team removal are destructive', () => {
    for (const name of [...CHASSIS_TOOLS, 'starter_whoami', ...READ_TOOLS, ...RUN_READ_TOOLS]) {
      expect(byName(name).annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of WRITE_TOOLS) {
      expect(byName(name).annotations?.readOnlyHint, name).not.toBe(true);
      expect(byName(name).description, name).toContain('Always confirm with the user before calling.');
    }
    expect(tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name)).toEqual([
      'starter_remove_project_member',
      'starter_remove_project_team',
      'starter_delete_item',
      'starter_unlink_item_from_project'
    ]);
  });

  it("the chassis's sentences about whoami name a tool that exists", () => {
    // `get_me` says "(Alias of <prefix>whoami.)" and every `workspace` argument
    // says "see <prefix>whoami": the chassis registers that tool itself, from the identity's prefix.
    const named = byName('get_me').description.match(/Alias of ([a-z_]+)\./)?.[1];
    expect(named).toBe('starter_whoami');
    expect(tools.map((t) => t.name)).toContain(named);
  });

  it('the server instructions start the model on whoami and name the item tools', async () => {
    const init = await rpc(rwKey, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcp-items-suite', version: '0.0.1' }
    });
    expect(init.instructions).toContain('Start with starter_whoami');
    for (const name of [
      'list_items',
      'get_item',
      'create_item',
      'update_item',
      'delete_item',
      'list_projects',
      'link_item_to_project',
      'unlink_item_from_project'
    ]) {
      expect(init.instructions).toContain(name);
    }
  });
});

describe('whoami', () => {
  it('answers the connected user, the scopes of the credential and every organization they can name', async () => {
    const me = await callTool(rwKey, 'starter_whoami');
    expect(me.isError).toBe(false);
    expect(me.data.user).toMatchObject({ id: ownerUserId, email: OWNER.email, name: OWNER.name });
    expect(me.data.via).toBe('api_key');
    expect([...me.data.scopes].sort()).toEqual(['items:read', 'items:write']);
    expect(me.data.workspace.id).toBe(wA);
    expect(me.data.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([wA, wB].sort());
    // No default was ever chosen: no entry is flagged, and the oldest membership (A) is the one used.
    for (const w of me.data.workspaces) expect(w).toMatchObject({ role: 'owner', default: false });
  });

  it('follows the `workspace` argument, and is what get_me answers', async () => {
    const inB = await callTool(rwKey, 'starter_whoami', { workspace: wB });
    expect(inB.data.workspace.id).toBe(wB);
    expect(inB.data.activeWorkspaceId).toBe(wB);
    const alias = await callTool(rwKey, 'get_me', { workspace: wB });
    expect(alias.data).toEqual(inB.data);
  });
});

describe('create, list, get, update, delete', () => {
  it('round-trips one item through the five tools, each answering the wire shape of its route', async () => {
    const created = await callTool(rwKey, 'starter_create_item', { name: '  Through MCP  ', note: 'one' });
    expect(created.isError).toBe(false);
    const item = created.data.item;
    expect(item).toMatchObject({
      workspaceId: wA,
      name: 'Through MCP',
      note: 'one',
      createdBy: ownerUserId
    });

    const listed = await callTool(rwKey, 'starter_list_items');
    expect(listed.data.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
    expect(listed.data.nextCursor).toBeNull();

    const got = await callTool(rwKey, 'starter_get_item', { itemId: item.id });
    expect(got.data).toEqual(item);

    const updated = await callTool(rwKey, 'starter_update_item', { itemId: item.id, note: '' });
    expect(updated.isError).toBe(false);
    expect(updated.data).toMatchObject({ id: item.id, name: 'Through MCP', note: '' });

    const deleted = await callTool(rwKey, 'starter_delete_item', { itemId: item.id });
    expect(deleted.isError).toBe(false);
    expect(deleted.data).toEqual(updated.data);

    const gone = await callTool(rwKey, 'starter_get_item', { itemId: item.id });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('HTTP 404, code: not_found');
    // The item domain's own hint, merged over the chassis's table.
    expect(gone.text).toContain('Next: No such item in this organization');
    expect(gone.text).toContain('starter_list_items');

    // No second path: the three mutations landed the audit rows of the HTTP routes, via the key.
    const { rows } = await app.db.pool.query<{ action: string; actor_via: string }>(
      `SELECT action, actor_via FROM audit_log WHERE resource_type = 'item' AND resource_id = $1 ORDER BY id`,
      [item.id]
    );
    expect(rows).toEqual([
      { action: 'item.create', actor_via: 'api_key' },
      { action: 'item.update', actor_via: 'api_key' },
      { action: 'item.delete', actor_via: 'api_key' }
    ]);
  });

  it('the list pages: limit and cursor are passed through', async () => {
    const ids: string[] = [];
    for (const name of ['p1', 'p2', 'p3']) {
      ids.unshift((await callTool(rwKey, 'starter_create_item', { name })).data.item.id);
    }
    const first = await callTool(rwKey, 'starter_list_items', { limit: 2 });
    expect(first.data.items.map((i: { id: string }) => i.id)).toEqual(ids.slice(0, 2));
    expect(first.data.nextCursor).toBe(ids[1]);
    const second = await callTool(rwKey, 'starter_list_items', { limit: 2, cursor: first.data.nextCursor });
    expect(second.data.items.map((i: { id: string }) => i.id)).toEqual(ids.slice(2));
    expect(second.data.nextCursor).toBeNull();
    for (const id of ids) await callTool(rwKey, 'starter_delete_item', { itemId: id });
  });

  it('an update with neither name nor note is refused by the tool, and a body the contract refuses is its 400', async () => {
    const { item } = (await callTool(rwKey, 'starter_create_item', { name: 'Kept' })).data;
    const empty = await callTool(rwKey, 'starter_update_item', { itemId: item.id });
    expect(empty.isError).toBe(true);
    expect(empty.text).toBe('Nothing to update — pass name and/or note.');

    // The tool's input schema lets spaces through (min 1); the CONTRACT trims first and refuses.
    const blank = await callTool(rwKey, 'starter_update_item', { itemId: item.id, name: '   ' });
    expect(blank.isError).toBe(true);
    expect(blank.text).toContain('HTTP 400');

    expect((await callTool(rwKey, 'starter_get_item', { itemId: item.id })).data.name).toBe('Kept');
    await callTool(rwKey, 'starter_delete_item', { itemId: item.id });
  });
});

describe('scopes', () => {
  it('a read-scope key lists and gets, and is refused the three write tools with the actionable sentence, nothing written', async () => {
    const { item } = (await callTool(rwKey, 'starter_create_item', { name: 'Read only' })).data;
    const before = await itemCount(wA);

    expect((await callTool(readKey, 'starter_list_items')).isError).toBe(false);
    expect((await callTool(readKey, 'starter_get_item', { itemId: item.id })).data.id).toBe(item.id);

    for (const [name, args] of [
      ['starter_create_item', { name: 'Nope' }],
      ['starter_update_item', { itemId: item.id, name: 'Nope' }],
      ['starter_delete_item', { itemId: item.id }]
    ] as const) {
      const refused = await callTool(readKey, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain('Missing scope "items:write"');
      expect(refused.text, name).toContain('permission to create or edit data');
    }
    expect(await itemCount(wA)).toBe(before);
    expect((await callTool(rwKey, 'starter_get_item', { itemId: item.id })).data.name).toBe('Read only');
    await callTool(rwKey, 'starter_delete_item', { itemId: item.id });
  });

  it('a key without the read scope cannot list, get, whoami or get_me; it can still write', async () => {
    for (const [name, args] of [
      ['starter_list_items', {}],
      ['starter_get_item', { itemId: UNKNOWN }],
      ['starter_whoami', {}],
      ['get_me', {}]
    ] as const) {
      const refused = await callTool(writeKey, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain('Missing scope "items:read"');
      expect(refused.text, name).toContain('permission to read data');
    }
    const created = await callTool(writeKey, 'starter_create_item', { name: 'Write only' });
    expect(created.isError).toBe(false);
    await callTool(rwKey, 'starter_delete_item', { itemId: created.data.item.id });
  });
});

describe('an item lives in one workspace, chosen by the `workspace` argument', () => {
  it('created in B it is in B only: absent from the default (A), not_found from A, and A cannot change or delete it', async () => {
    const inB = (await callTool(rwKey, 'starter_create_item', { workspace: wB, name: 'In B' })).data.item;
    expect(inB.workspaceId).toBe(wB);

    expect(
      (await callTool(rwKey, 'starter_list_items', { workspace: wB })).data.items.map(
        (i: { id: string }) => i.id
      )
    ).toEqual([inB.id]);
    // No argument = the default workspace (A); naming A says the same.
    for (const args of [{}, { workspace: wA }]) {
      const listed = await callTool(rwKey, 'starter_list_items', args);
      expect(listed.data.items.map((i: { id: string }) => i.id)).not.toContain(inB.id);
      for (const [name, extra] of [
        ['starter_get_item', {}],
        ['starter_update_item', { name: 'Taken' }],
        ['starter_delete_item', {}]
      ] as const) {
        const res = await callTool(rwKey, name, { ...args, ...extra, itemId: inB.id });
        expect(res.isError, name).toBe(true);
        expect(res.text, name).toContain('code: not_found');
      }
    }
    expect((await callTool(rwKey, 'starter_get_item', { workspace: wB, itemId: inB.id })).data.name).toBe(
      'In B'
    );
  });

  it('a workspace the user is not a member of is refused by the API: an argument grants nothing', async () => {
    const before = await app.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items`);
    for (const [name, args] of [
      ['starter_list_items', {}],
      ['starter_create_item', { name: 'Elsewhere' }]
    ] as const) {
      const res = await callTool(rwKey, name, { ...args, workspace: UNKNOWN });
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toMatch(/HTTP 40[13]/);
    }
    const after = await app.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('a guest, through MCP exactly as through HTTP', () => {
  it('lists none though the workspace has items, reads not_found, and cannot create, update or delete', async () => {
    // A guest membership of A, seeded the way the chassis suite seeds one.
    const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [wA, guestUserId]
    );
    const guestKey = await mintKey(await signIn(GUEST), 'guest-rw', ['items:read', 'items:write']);
    const { item } = (await callTool(rwKey, 'starter_create_item', { name: 'Not for guests' })).data;
    const before = await itemCount(wA);

    const me = await callTool(guestKey, 'starter_whoami');
    expect(me.data.origin).toBe('guest');
    expect(me.data.workspace.id).toBe(wA);

    const listed = await callTool(guestKey, 'starter_list_items');
    expect(listed.isError).toBe(false);
    expect(listed.data).toEqual({ items: [], nextCursor: null });

    const real = await callTool(guestKey, 'starter_get_item', { itemId: item.id });
    const missing = await callTool(guestKey, 'starter_get_item', { itemId: UNKNOWN });
    expect(real.isError).toBe(true);
    expect(real.text).toContain('code: not_found');
    expect(real.text).toBe(missing.text);

    for (const [name, args] of [
      ['starter_create_item', { name: 'From a guest' }],
      ['starter_update_item', { itemId: item.id, name: 'Renamed' }],
      ['starter_delete_item', { itemId: item.id }]
    ] as const) {
      const refused = await callTool(guestKey, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain('HTTP 403, code: guest_forbidden');
    }
    expect(await itemCount(wA)).toBe(before);
    expect((await callTool(rwKey, 'starter_get_item', { itemId: item.id })).data.name).toBe('Not for guests');
  });
});

describe('an item in a project, through MCP exactly as through HTTP', () => {
  it('create_item with projectIds, list_items with projectId, the link and the unlink, and the refusals as hints', async () => {
    // A project, made through the chassis's own tool under this tool's prefix.
    const project = await callTool(rwKey, 'starter_create_project', { name: 'MCP project' });
    expect(project.isError).toBe(false);
    const projectId = project.data.id as string;

    const created = await callTool(rwKey, 'starter_create_item', {
      name: 'In the project from birth',
      projectIds: [projectId]
    });
    expect(created.isError).toBe(false);
    expect(created.data.item.projects).toEqual([{ id: projectId, name: 'MCP project' }]);

    const outside = await callTool(rwKey, 'starter_create_item', { name: 'Outside' });
    const listed = await callTool(rwKey, 'starter_list_items', { projectId });
    expect(listed.data.items.map((i: { id: string }) => i.id)).toEqual([created.data.item.id]);

    const linked = await callTool(rwKey, 'starter_link_item_to_project', {
      itemId: outside.data.item.id,
      projectId
    });
    expect(linked.isError).toBe(false);
    expect(linked.data.projects).toEqual([{ id: projectId, name: 'MCP project' }]);

    const unlinked = await callTool(rwKey, 'starter_unlink_item_from_project', {
      itemId: outside.data.item.id,
      projectId
    });
    expect(unlinked.data.projects).toEqual([]);
    const again = await callTool(rwKey, 'starter_unlink_item_from_project', {
      itemId: outside.data.item.id,
      projectId
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('code: not_linked');
    expect(again.text).toContain('nothing to unlink');

    // A phantom project: not found, with the hint that names the list tool.
    const phantom = await callTool(rwKey, 'starter_list_items', { projectId: UNKNOWN });
    expect(phantom.isError).toBe(true);
    expect(phantom.text).toContain('code: project_not_found');
    expect(phantom.text).toContain('starter_list_projects');

    // A read key lists through the filter and is refused the link.
    expect((await callTool(readKey, 'starter_list_items', { projectId })).isError).toBe(false);
    const refused = await callTool(readKey, 'starter_link_item_to_project', {
      itemId: outside.data.item.id,
      projectId
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('items:write');
  });

  it('a link into an archived project reads the chassis project hint, as the chassis tools do', async () => {
    const project = await callTool(rwKey, 'starter_create_project', { name: 'Archived for MCP' });
    const projectId = project.data.id as string;
    const item = await callTool(rwKey, 'starter_create_item', { name: 'Left outside' });
    expect((await callTool(rwKey, 'starter_archive_project', { projectId })).isError).toBe(false);

    const refused = await callTool(rwKey, 'starter_link_item_to_project', {
      itemId: item.data.item.id,
      projectId
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('HTTP 409, code: project_archived');
    expect(refused.text).toContain('— Next: This project is archived, so it is read-only.');

    const created = await callTool(rwKey, 'starter_create_item', {
      name: 'Born archived',
      projectIds: [projectId]
    });
    expect(created.isError).toBe(true);
    expect(created.text).toContain('code: project_not_found');
  });

  it('a project viewer refused a link or an unlink reads the chassis role hint, as the chassis tools do', async () => {
    // A plain member of A, a viewer on the project: they read it, and may not change what it holds.
    const VIEWER = {
      email: 'viewer@mcp-items.test',
      name: 'MCP Viewer',
      password: 'mcp-viewer-password-12'
    };
    const viewerUserId = (await app.auth.api.signUpEmail({ body: VIEWER })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, is_active) VALUES ($1, $2, 'member', true)`,
      [wA, viewerUserId]
    );
    const viewerKey = await mintKey(await signIn(VIEWER), 'viewer-rw', ['items:read', 'items:write']);
    const project = await callTool(rwKey, 'starter_create_project', { name: 'Viewed only' });
    const projectId = project.data.id as string;
    const added = await callTool(rwKey, 'starter_add_project_member', {
      projectId,
      email: VIEWER.email,
      role: 'viewer'
    });
    expect(added.isError).toBe(false);
    const inside = await callTool(rwKey, 'starter_create_item', { name: 'Inside', projectIds: [projectId] });
    const outside = await callTool(rwKey, 'starter_create_item', { name: 'Outside, still' });

    const hint = '— Next: Your role on this project is below what this needs';
    for (const [name, itemId] of [
      ['starter_unlink_item_from_project', inside.data.item.id],
      ['starter_link_item_to_project', outside.data.item.id]
    ] as const) {
      const refused = await callTool(viewerKey, name, { itemId, projectId });
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain('HTTP 403, code: insufficient_project_role');
      expect(refused.text, name).toContain(hint);
    }
  });
});
