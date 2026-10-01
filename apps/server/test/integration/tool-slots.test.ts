import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
 * PRDCT-2529 — the HAND-OVERS of the tool definition (`src/tool.ts`) to the
 * chassis composition (`createPlatform(tool)`), each pinned through the REAL
 * boot. A behaviour may have a test of its own body; what that test cannot see
 * is `tool.ts` no longer handing the thing over, because it passes it in by
 * hand. These tests only ever reach it through `boot()`.
 *
 * What the placeholder resource (items) fills, and what is pinned here:
 *
 *  - `services`: the booted domain (`BootResult.tool`) carries the ItemService,
 *    and it is THE instance the routes write through;
 *  - `api.routes`: the items routes are mounted, behind `requireAuth`;
 *  - `scopes.requiredScopeFor`: the booted gate reads the tool's allowlist;
 *  - no `api.untrustedOrigins`: nothing is denied, every serving hostname is
 *    trusted as served;
 *  - `entitlements`: the booted `GET /instance` shows the tool's declaration
 *    (its behaviour on both editions is `items-metering.test.ts`);
 *  - `api.bodyLimit` (the starter): 8 MiB on the transcribe route, the 1 MiB
 *    default everywhere else;
 *  - `jobs` (the starter): the `runs-sweep` queue, scheduled every minute,
 *    its handler reaching the booted domain.
 *
 * The optional slots items leave EMPTY (`api.untrustedOrigins`,
 * `api.auditExempt`, `api.rateLimits`, `jobs`, …; the list is in `src/tool.ts`)
 * have no hand-over to pin. A tool that fills one adds its case HERE, through
 * the real boot: an exempt path that lands no audit row, a wall that answers
 * 429, a queue that exists after boot and runs its handler.
 */

const APP = 'http://localhost:3000';
/** Any other hostname a proxy or a preview may serve the app on: trusted as the serving origin. */
const PREVIEW = 'http://preview.test';
const OWNER = { email: 'owner@slots.test', name: 'Slots Owner', password: 'slots-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'tool_slots_plain'));
  const setup = await app.app.request(
    `${APP}/api/v1/setup`,
    json({ setupToken: SETUP_TOKEN, instanceName: 'Slots', owner: OWNER })
  );
  expect(setup.status).toBeLessThan(300);
  const signIn = await app.app.request(
    `${APP}/api/v1/auth/sign-in/email`,
    json({ email: OWNER.email, password: OWNER.password })
  );
  expect(signIn.status).toBe(200);
  cookie = extractCookie(signIn);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ── services ────────────────────────────────────────────────────────────────

describe('tool.services reaches the boot result and the routes', () => {
  it('BootResult.tool carries the ItemService, and a row written through it is the row the route serves', async () => {
    const me = await readJson(await app.app.request(`${APP}/api/v1/me`, { headers: { cookie } }));
    // The service takes the principal the chassis resolved: the workspace and
    // the author come from it, never from a body.
    const result = await app.tool.items.create(
      { userId: me.user.id, workspaceId: me.workspace.id, role: me.workspace.role, origin: 'local' },
      { name: 'Through the service', note: '' }
    );
    if (!result.ok) throw new Error(`create refused: ${result.failure.code}`);
    const written = result.item;
    const res = await app.app.request(`${APP}/api/v1/items/${written.id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await readJson(res)).name).toBe('Through the service');
    // Leave the table as the next case expects it.
    expect(await app.tool.items.delete(me.workspace.id, written.id)).not.toBeNull();
  });
});

// ── api.routes ──────────────────────────────────────────────────────────────

describe('tool.api.routes reaches the booted API app', () => {
  it('the items list answers a session with the empty page, and an anonymous caller with 401', async () => {
    const res = await app.app.request(`${APP}/api/v1/items`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ items: [], nextCursor: null });

    const anonymous = await app.app.request(`${APP}/api/v1/items`);
    expect(anonymous.status).toBe(401);
  });

  it('the served OpenAPI document lists the five item routes, generated from the contract', async () => {
    const res = await app.app.request(`${APP}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    const doc = await readJson(res);
    // The document's paths are relative to the API base (`/api/v1`).
    const methodsOf = (path: string) => Object.keys(doc.paths[path] ?? {}).sort();
    expect(methodsOf('/items')).toEqual(['get', 'post']);
    expect(methodsOf('/items/{id}')).toEqual(['delete', 'get', 'patch']);
    expect(doc.paths['/items'].post.tags).toEqual(['items']);
  });
});

// ── scopes.requiredScopeFor ─────────────────────────────────────────────────

describe('tool.scopes.requiredScopeFor reaches the booted machine gate', () => {
  it('a read key reaches the items list and is refused a mutation on the tree; the write key passes the gate', async () => {
    const mint = async (name: string, scopes: string[]) =>
      (await readJson(await app.app.request(`${APP}/api/v1/api-keys`, json({ name, scopes }, { cookie }))))
        .key as string;
    const readOnly = await mint('ro', ['items:read']);
    const readWrite = await mint('rw', ['items:read', 'items:write']);

    const read = await app.app.request(`${APP}/api/v1/items`, {
      headers: { authorization: `Bearer ${readOnly}` }
    });
    expect(read.status).toBe(200);

    const denied = await app.app.request(`${APP}/api/v1/items`, {
      ...json({}, { authorization: `Bearer ${readOnly}` })
    });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('insufficient_scope');

    // The write key passes the gate: what answers is the ROUTE (its contract
    // refuses the empty body), never the scope refusal.
    const passed = await app.app.request(`${APP}/api/v1/items`, {
      ...json({}, { authorization: `Bearer ${readWrite}` })
    });
    expect(passed.status).toBe(400);
    expect((await readJson(passed)).error.code).toBe('validation_error');
  });
});

// ── api.untrustedOrigins ────────────────────────────────────────────────────

describe('tool.api.untrustedOrigins: the slot is empty, nothing is denied', () => {
  it('any hostname the app is served on is trusted as the serving origin', async () => {
    const configured = app.auth.options.trustedOrigins;
    expect(typeof configured).toBe('function');
    if (typeof configured !== 'function') throw new Error('trustedOrigins is not the per-request function');
    expect(await configured(new Request(`${PREVIEW}/api/v1/auth/get-session`))).toContain(PREVIEW);
  });
});

// ── entitlements ────────────────────────────────────────────────────────────

describe('tool.entitlements reaches discovery', () => {
  it('GET /instance shows the declaration the slot handed over: the two actions, the three limits, the one feature', async () => {
    const info = await readJson(await app.app.request(`${APP}/api/v1/instance`));
    expect(info.entitlements.actions.map((a: { key: string }) => a.key)).toEqual([
      'items.create',
      'files.upload'
    ]);
    expect(Object.keys(info.entitlements.limits)).toEqual([
      'files.maxBytes',
      'items.perWorkspace',
      'workspace.members'
    ]);
    expect(Object.keys(info.entitlements.features)).toEqual(['items.premium']);
  });
});

// ── api.bodyLimit ───────────────────────────────────────────────────────────

describe('tool.api.bodyLimit raises the cap on the transcribe route only', () => {
  const MiB = 1024 * 1024;
  /** A JSON body of about `bytes` bytes: a base64 string of zeros in the audio field. */
  const bodyOf = (bytes: number) =>
    JSON.stringify({ audio: 'A'.repeat(bytes - 60), contentType: 'audio/wav' });
  const post = (path: string, body: string) =>
    app.app.request(`${APP}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body
    });

  it('7 MiB passes the cap on /voice/transcribe (the contract then refuses the 5 MiB wav), and is 413 on /voice/speak', async () => {
    const passed = await post('/voice/transcribe', bodyOf(7 * MiB));
    expect(passed.status).toBe(400);
    expect((await readJson(passed)).error.code).toBe('validation_error');

    const capped = await post('/voice/speak', bodyOf(7 * MiB));
    expect(capped.status).toBe(413);
  });

  it('over 8 MiB is 413 payload_too_large on /voice/transcribe too', async () => {
    const res = await post('/voice/transcribe', bodyOf(9 * MiB));
    expect(res.status).toBe(413);
    expect((await readJson(res)).error.code).toBe('payload_too_large');
  });
});

// ── jobs ────────────────────────────────────────────────────────────────────

describe('tool.jobs installs the runs sweep, and its handler runs the domain', () => {
  it('the runs-sweep queue is scheduled every minute, and a job sent to it fails a run older than 15 minutes', async () => {
    const { rows: schedules } = await app.db.pool.query<{ name: string; cron: string }>(
      `SELECT name, cron FROM pgboss.schedule WHERE name = 'runs-sweep'`
    );
    expect(schedules).toEqual([{ name: 'runs-sweep', cron: '* * * * *' }]);

    // A run the instance has been waiting on for 16 minutes (this app has no
    // H key: the sweep only times out, it asks H nothing).
    const me = await readJson(await app.app.request(`${APP}/api/v1/me`, { headers: { cookie } }));
    const { rows } = await app.db.pool.query<{ id: string }>(
      `INSERT INTO runs (workspace_id, instruction, state, h_session_id, created_at)
       VALUES ($1, 'stale', 'running', 'sess-stale', now() - interval '16 minutes') RETURNING id`,
      [me.workspace.id]
    );
    const id = rows[0]!.id;
    await app.jobs.boss.send('runs-sweep', {});
    const deadline = Date.now() + 20_000;
    let state = 'running';
    while (state === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      state = (await app.db.pool.query<{ state: string }>(`SELECT state FROM runs WHERE id = $1`, [id]))
        .rows[0]!.state;
    }
    expect(state).toBe('failed');
    await app.db.pool.query(`DELETE FROM runs WHERE id = $1`, [id]);
  }, 30_000);
});
