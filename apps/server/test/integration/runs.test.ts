import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { HClient } from '../../src/integrations/index.js';
import type { HPoll } from '../../src/integrations/h.js';
import { IntegrationError } from '../../src/integrations/errors.js';
import { RUN_TIMEOUT_ERROR } from '../../src/runs/service.js';
import {
  SETUP_TOKEN,
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The runs on the real boot, H replaced by a recording fake handed in
 * through the boot overrides (no test calls H): the create asks H first and
 * writes nothing on a refusal, the read of one running run refreshes it, the
 * list asks nothing, the sweep settles and times out, the item's visibility
 * and guest rules, the machine scopes, the audit row, the export entry, the
 * MCP tools, and the 503 of an instance without the key.
 */

const OWNER = { email: 'owner@runs.test', name: 'Runs Owner', password: 'runs-owner-password-1234' };
const GUEST = { email: 'guest@runs.test', name: 'Runs Guest', password: 'runs-guest-password-1234' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let bare: TestApp;
let ownerCookie = '';
let bareCookie = '';
let wA = '';
let wB = '';

/** The fake H: what the next start and polls answer, and what it was asked. */
const fake = {
  startFail: null as IntegrationError | null,
  polls: new Map<string, HPoll>(),
  started: [] as Array<{ instruction: string; startUrl: string | null | undefined }>,
  polled: [] as string[],
  seq: 0
};
const h: HClient = {
  start: async (instruction, startUrl) => {
    if (fake.startFail) throw fake.startFail;
    fake.started.push({ instruction, startUrl });
    const n = ++fake.seq;
    return { sessionId: `sess-${n}`, liveUrl: `https://h.example/view/${n}` };
  },
  poll: async (sessionId) => {
    fake.polled.push(sessionId);
    return fake.polls.get(sessionId) ?? { status: 'running', terminal: false, answer: null, error: null };
  },
  quota: async () => ({ scope: 'org', limit: 1, active: 0, available: 1 })
};

type Headers = Record<string, string>;
let ip = 0;
const send = (target: TestApp, method: string, path: string, headers: Headers, body?: unknown) =>
  target.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': `10.75.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function setUp(target: TestApp) {
  const setup = await send(
    target,
    'POST',
    '/setup',
    {},
    { setupToken: SETUP_TOKEN, instanceName: 'Runs A', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  const signIn = await send(
    target,
    'POST',
    '/auth/sign-in/email',
    {},
    { email: OWNER.email, password: OWNER.password }
  );
  return { cookie: extractCookie(signIn), workspaceId: (await readJson(setup)).workspaceId as string };
}

const inA = (): Headers => ({ cookie: ownerCookie, 'x-workspace-id': wA });
const inB = (): Headers => ({ cookie: ownerCookie, 'x-workspace-id': wB });

async function start(headers: Headers, body: Record<string, unknown> = { instruction: 'Read the heading' }) {
  const res = await send(app, 'POST', '/runs', headers, body);
  expect(res.status).toBe(201);
  return (await readJson(res)).run as {
    id: string;
    state: string;
    liveUrl: string | null;
    startUrl: string | null;
  };
}

const sessionOf = async (runId: string) =>
  (await app.db.pool.query<{ h: string }>(`SELECT h_session_id AS h FROM runs WHERE id = $1`, [runId]))
    .rows[0]!.h;
const runCount = async () =>
  (await app.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs`)).rows[0]!.n;

async function mintKey(scopes: string[]): Promise<Headers> {
  const res = await send(
    app,
    'POST',
    '/api-keys',
    { cookie: ownerCookie },
    { name: scopes.join('+'), scopes }
  );
  expect(res.status).toBe(201);
  return { authorization: `Bearer ${(await readJson(res)).key as string}`, 'x-workspace-id': wA };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'runs_routes'), {}, { tool: { h } });
  ({ cookie: ownerCookie, workspaceId: wA } = await setUp(app));
  const created = await send(app, 'POST', '/workspaces', { cookie: ownerCookie }, { name: 'Runs B' });
  expect(created.status).toBe(201);
  wB = (await readJson(created)).workspace.id;
  bare = await createTestApp(await createDatabase(container, 'runs_no_key'));
  ({ cookie: bareCookie } = await setUp(bare));
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await bare?.stop();
  await container?.stop();
});

describe('POST /runs', () => {
  it('asks H first, then answers the run running, with its live view; the audit row names it, not the instruction', async () => {
    const run = await start(inA(), { instruction: 'Read the heading', startUrl: 'https://example.com' });
    expect(run.state).toBe('running');
    expect(run.startUrl).toBe('https://example.com');
    expect(run.liveUrl).toMatch(/^https:\/\/h\.example\/view\/\d+$/);
    expect(fake.started.at(-1)).toEqual({ instruction: 'Read the heading', startUrl: 'https://example.com' });
    const { rows } = await app.db.pool.query<{ action: string; resource_type: string; metadata: unknown }>(
      `SELECT action, resource_type, metadata FROM audit_log WHERE resource_id = $1`,
      [run.id]
    );
    expect(rows).toEqual([{ action: 'run.create', resource_type: 'run', metadata: { withStartUrl: true } }]);
  });

  it('an H refusal is a 502 and writes no row', async () => {
    const before = await runCount();
    fake.startFail = new IntegrationError('h', 'H answered 429 (start a session): too many sessions', 429);
    const res = await send(app, 'POST', '/runs', inA(), { instruction: 'Read the heading' });
    fake.startFail = null;
    expect(res.status).toBe(502);
    expect((await readJson(res)).error).toEqual({
      code: 'integration_failed',
      message: 'H answered 429 (start a session): too many sessions',
      details: { integration: 'h', status: 429 }
    });
    expect(await runCount()).toBe(before);
  });

  it('refuses an empty instruction and a start URL that is not https, and never asks H', async () => {
    const before = fake.started.length;
    for (const body of [
      { instruction: '' },
      { instruction: '   ' },
      { instruction: 'x'.repeat(2001) },
      { instruction: 'x', startUrl: 'http://example.com' },
      { instruction: 'x', startUrl: 'not a url' }
    ]) {
      expect((await send(app, 'POST', '/runs', inA(), body)).status).toBe(400);
    }
    expect(fake.started.length).toBe(before);
  });

  it('without HAI_API_KEY: 503 naming the key; the list still answers', async () => {
    const res = await send(
      bare,
      'POST',
      '/runs',
      { cookie: bareCookie },
      { instruction: 'Read the heading' }
    );
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(body.error.code).toBe('integration_not_configured');
    expect(body.error.details).toEqual({ integration: 'h', envKey: 'HAI_API_KEY' });
    expect(body.error.message).toContain('HAI_API_KEY');
    expect(body.error.message).toContain('.env');
    expect((await send(bare, 'GET', '/runs', { cookie: bareCookie })).status).toBe(200);
  });
});

describe('GET /runs/{id} refreshes, GET /runs does not', () => {
  it('a running run stays running; on completion it settles with the answer, and is never asked of H again', async () => {
    const run = await start(inA());
    const session = await sessionOf(run.id);

    const still = await readJson(await send(app, 'GET', `/runs/${run.id}`, inA()));
    expect(still.state).toBe('running');
    expect(fake.polled.at(-1)).toBe(session);

    fake.polls.set(session, { status: 'completed', terminal: true, answer: 'Example Domain', error: null });
    const done = await readJson(await send(app, 'GET', `/runs/${run.id}`, inA()));
    expect(done).toMatchObject({ state: 'completed', answer: 'Example Domain', error: null });
    expect(done.finishedAt).not.toBeNull();

    const polls = fake.polled.length;
    await send(app, 'GET', `/runs/${run.id}`, inA());
    await send(app, 'GET', '/runs', inA());
    expect(fake.polled.length).toBe(polls);
  });

  it('a failed H session settles the run failed, its reason on one line', async () => {
    const run = await start(inA());
    fake.polls.set(await sessionOf(run.id), {
      status: 'failed',
      terminal: true,
      answer: null,
      error: 'the browser\ncrashed'
    });
    const failed = await readJson(await send(app, 'GET', `/runs/${run.id}`, inA()));
    expect(failed).toMatchObject({ state: 'failed', error: 'the browser crashed', answer: null });
  });

  it('an idle H session without an answer stays running; once idle with an answer it settles completed', async () => {
    const run = await start(inA());
    const session = await sessionOf(run.id);
    fake.polls.set(session, { status: 'idle', terminal: false, answer: null, error: null });
    const waiting = await readJson(await send(app, 'GET', `/runs/${run.id}`, inA()));
    expect(waiting).toMatchObject({ state: 'running', answer: null, error: null, finishedAt: null });

    fake.polls.set(session, { status: 'idle', terminal: true, answer: 'Example Domain', error: null });
    const done = await readJson(await send(app, 'GET', `/runs/${run.id}`, inA()));
    expect(done).toMatchObject({ state: 'completed', answer: 'Example Domain', error: null });
    expect(done.finishedAt).not.toBeNull();
  });

  it('the list is newest first, paged by cursor, and shows each run as last seen', async () => {
    const page = await readJson(await send(app, 'GET', '/runs?limit=2', inA()));
    expect(page.runs).toHaveLength(2);
    expect(page.nextCursor).toBe(page.runs[1].id);
    const next = await readJson(await send(app, 'GET', `/runs?limit=2&cursor=${page.nextCursor}`, inA()));
    expect(next.runs[0].id).not.toBe(page.runs[1].id);
  });
});

describe('who sees and starts runs', () => {
  it('a run of another workspace is the 404 of a missing one, and absent from the list', async () => {
    const inOther = await start(inB());
    expect((await send(app, 'GET', `/runs/${inOther.id}`, inA())).status).toBe(404);
    expect((await send(app, 'GET', `/runs/${UNKNOWN}`, inA())).status).toBe(404);
    const list = await readJson(await send(app, 'GET', '/runs?limit=100', inA()));
    expect(list.runs.map((r: { id: string }) => r.id)).not.toContain(inOther.id);
  });

  it('a guest lists none, reads the 404 of a missing id, and is refused the create', async () => {
    const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [wA, guestUserId]
    );
    const signIn = await send(
      app,
      'POST',
      '/auth/sign-in/email',
      {},
      { email: GUEST.email, password: GUEST.password }
    );
    const guest = { cookie: extractCookie(signIn), 'x-workspace-id': wA };
    const someRun = (await readJson(await send(app, 'GET', '/runs?limit=1', inA()))).runs[0];
    expect(await readJson(await send(app, 'GET', '/runs', guest))).toEqual({ runs: [], nextCursor: null });
    expect((await send(app, 'GET', `/runs/${someRun.id}`, guest)).status).toBe(404);
    const refused = await send(app, 'POST', '/runs', guest, { instruction: 'Read the heading' });
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error.code).toBe('guest_forbidden');
  });

  it('a read key reads and is refused the create; a write key starts one', async () => {
    const read = await mintKey(['items:read']);
    const write = await mintKey(['items:read', 'items:write']);
    expect((await send(app, 'GET', '/runs', read)).status).toBe(200);
    const refused = await send(app, 'POST', '/runs', read, { instruction: 'Read the heading' });
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error.code).toBe('insufficient_scope');
    expect((await send(app, 'POST', '/runs', write, { instruction: 'Read the heading' })).status).toBe(201);
  });
});

describe('the sweep (the runs-sweep job)', () => {
  it('fails a run H has not finished in 15 minutes, and settles a finished one', async () => {
    const old = await start(inA());
    const fresh = await start(inA());
    await app.db.pool.query(`UPDATE runs SET created_at = now() - interval '16 minutes' WHERE id = $1`, [
      old.id
    ]);
    fake.polls.set(await sessionOf(fresh.id), {
      status: 'completed',
      terminal: true,
      answer: '42',
      error: null
    });

    const outcome = await app.tool.runs.sweep();
    expect(outcome.timedOut).toBeGreaterThanOrEqual(1);

    const oldNow = await readJson(await send(app, 'GET', `/runs/${old.id}`, inA()));
    expect(oldNow).toMatchObject({ state: 'failed', error: RUN_TIMEOUT_ERROR });
    const { rows } = await app.db.pool.query<{ state: string; answer: string }>(
      `SELECT state, answer FROM runs WHERE id = $1`,
      [fresh.id]
    );
    expect(rows[0]).toEqual({ state: 'completed', answer: '42' });
  });
});

describe('the workspace export', () => {
  it('runs.json holds the workspace’s runs, in the wire shape, never another workspace’s', async () => {
    const res = await send(app, 'GET', '/workspace/export', inA());
    expect(res.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names[names.indexOf('item_projects.json') + 1]).toBe('runs.json');
    const rows = JSON.parse(zip.readAsText('runs.json')) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.workspaceId).toBe(wA);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'answer',
      'createdAt',
      'createdBy',
      'error',
      'finishedAt',
      'id',
      'instruction',
      'liveUrl',
      'startUrl',
      'state',
      'updatedAt',
      'workspaceId'
    ]);
  });
});

describe('the MCP run tools re-enter the run routes', () => {
  let rpcId = 0;
  async function callTool(key: string, name: string, args: Record<string, unknown>) {
    const res = await app.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': `10.76.0.${(ip++ % 250) + 1}`,
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    });
    const body = await readJson(res);
    expect(body.error).toBeUndefined();
    const text = body.result.content[0].text as string;
    return {
      isError: body.result.isError === true,
      text,
      data: body.result.isError ? null : JSON.parse(text)
    };
  }

  it('run_start, then run_get until done, and list_runs; a read key is refused run_start', async () => {
    const write = (await mintKey(['items:read', 'items:write'])).authorization!.slice('Bearer '.length);
    const read = (await mintKey(['items:read'])).authorization!.slice('Bearer '.length);

    const started = await callTool(write, 'starter_run_start', {
      instruction: 'Count the links',
      workspace: wA
    });
    expect(started.isError).toBe(false);
    const id = started.data.run.id as string;
    expect(started.data.run.state).toBe('running');

    const running = await callTool(read, 'starter_run_get', { runId: id, workspace: wA });
    expect(running.data.state).toBe('running');
    fake.polls.set(await sessionOf(id), {
      status: 'completed',
      terminal: true,
      answer: '17 links',
      error: null
    });
    const done = await callTool(read, 'starter_run_get', { runId: id, workspace: wA });
    expect(done.data).toMatchObject({ state: 'completed', answer: '17 links' });

    const listed = await callTool(read, 'starter_list_runs', { workspace: wA, limit: 1 });
    expect(listed.data.runs[0].id).toBe(id);

    const before = fake.started.length;
    const refused = await callTool(read, 'starter_run_start', { instruction: 'x', workspace: wA });
    expect(refused.isError).toBe(true);
    expect(fake.started.length).toBe(before);
  });
});
