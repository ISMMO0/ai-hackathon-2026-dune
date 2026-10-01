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
 * PRDCT-1358 — the input-validation 500 family, asserted over HTTP: every
 * enumerated input answers 4xx with a stable machine code, never 5xx. The
 * contract-level halves live in packages/contract/test/input-robustness
 * .test.ts; this file covers what only the running app can prove — the
 * Better Auth mount guard (AF-1 + update-user's NUL), the member PATCH, the
 * edge JSON depth cap, and the domain's own inputs: the item id in the path,
 * the two free-text fields, the list's cursor. (Items carry no jsonb metadata
 * column, no numeric path param and no query filter: those cases come with a
 * tool that has one.)
 */

const OWNER = { email: 'owner@robust.test', name: 'Robust Owner', password: 'robust-owner-pass-1' };
const MEMBER = { email: 'member@robust.test', name: 'Robust Member', password: 'robust-member-pass-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;

let ipCounter = 0;
const nextIp = () => `10.87.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = { k: value };
  return value;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'input_robust'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Robust', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  // Invite + accept a plain member (the PATCH target).
  const inv = await readJson(
    await app.app.request('/api/v1/invitations', json({ email: MEMBER.email, role: 'member' }, { cookie }))
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  const accepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: MEMBER.name, password: MEMBER.password })
  );
  expect(accepted.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the Better Auth mount guard (AF-1)', () => {
  it('malformed JSON on an auth route answers 400 invalid_json, never a Better Auth 500', async () => {
    const res = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: '{broken'
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it('an empty body under a JSON content-type answers 400 invalid_json', async () => {
    const res = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: ''
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it("a NUL in update-user's free-text name answers 400 invalid_characters (was a 22021 500)", async () => {
    const bad = await app.app.request(
      '/api/v1/auth/update-user',
      json({ name: 'Evil\u0000Name' }, { cookie })
    );
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('invalid_characters');
    // Negative control: the same request without the NUL succeeds.
    const ok = await app.app.request('/api/v1/auth/update-user', json({ name: 'Clean Name' }, { cookie }));
    expect(ok.status).toBe(200);
  });
});

describe('member PATCH (FUZZ-5)', () => {
  it('an empty patch answers 400 validation_error instead of an empty SQL SET 500', async () => {
    const members = await readJson(await app.app.request('/api/v1/members', { headers: { cookie } }));
    const member = members.members.find((m: { email: string }) => m.email === MEMBER.email);
    expect(member).toBeTruthy();
    const empty = await app.app.request(`/api/v1/members/${member.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({})
    });
    expect(empty.status).toBe(400);
    expect((await readJson(empty)).error.code).toBe('validation_error');
    // Negative control: a one-field patch still works.
    const ok = await app.app.request(`/api/v1/members/${member.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ role: 'admin' })
    });
    expect(ok.status).toBe(200);
  });
});

describe('JSON nesting depth (SL-B5)', () => {
  it('past the edge cap, any JSON body answers payload_too_deep before its route', async () => {
    const overEdge = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'deep', scopes: ['items:read'], metadata: nested(150) })
    });
    expect(overEdge.status).toBe(400);
    expect((await readJson(overEdge)).error.code).toBe('payload_too_deep');
  });
});

describe('domain inputs: nothing a client sends to /items reaches Postgres unvalidated', () => {
  const NUL = '\u0000';

  it('a NUL inside a free-text field of a domain write answers 400, a clean one 201', async () => {
    for (const body of [{ name: `Evil${NUL}Name` }, { name: 'Clean', note: `evil${NUL}note` }]) {
      const bad = await app.app.request('/api/v1/items', json(body, { cookie }));
      expect(bad.status).toBe(400);
      expect((await readJson(bad)).error.code).toBe('validation_error');
    }
    // Negative control: the same write without the NUL lands (multi-line note included).
    const ok = await app.app.request(
      '/api/v1/items',
      json({ name: 'Clean', note: 'line one\n\tline two' }, { cookie })
    );
    expect(ok.status).toBe(201);
    const id = (await readJson(ok)).item.id as string;

    // The PATCH is a free-text sink too.
    const badPatch = await app.app.request(`/api/v1/items/${id}`, {
      ...json({ note: `evil${NUL}` }, { cookie }),
      method: 'PATCH'
    });
    expect(badPatch.status).toBe(400);
    expect((await readJson(badPatch)).error.code).toBe('validation_error');
    // Nothing of the refused writes was stored.
    const { rows } = await app.db.pool.query<{ name: string; note: string }>(`SELECT name, note FROM items`);
    expect(rows).toEqual([{ name: 'Clean', note: 'line one\n\tline two' }]);
  });

  it('a malformed id in the path answers 400 validation_error before the uuid cast, a real one 200', async () => {
    const created = await app.app.request('/api/v1/items', json({ name: 'By id' }, { cookie }));
    const id = (await readJson(created)).item.id as string;
    for (const bad of ['banana', '42', `${id}x`, '99999999999999999999', "1'--"]) {
      for (const method of ['GET', 'DELETE']) {
        const res = await app.app.request(`/api/v1/items/${encodeURIComponent(bad)}`, {
          method,
          headers: { cookie }
        });
        expect(res.status, `${method} ${bad}`).toBe(400);
        expect((await readJson(res)).error.code, `${method} ${bad}`).toBe('validation_error');
      }
    }
    expect((await app.app.request(`/api/v1/items/${id}`, { headers: { cookie } })).status).toBe(200);
  });

  it('a NUL or a non-uuid in the list cursor is ignored (page 1), never a 22021 or a uuid-cast 500', async () => {
    for (const cursor of ['%00', 'banana', 'a%00b']) {
      const res = await app.app.request(`/api/v1/items?cursor=${cursor}`, { headers: { cookie } });
      expect(res.status, cursor).toBe(200);
      expect((await readJson(res)).items.length, cursor).toBeGreaterThan(0);
    }
    // The limit is bounded by the contract.
    for (const limit of ['0', '101', '1e3', 'banana']) {
      const res = await app.app.request(`/api/v1/items?limit=${limit}`, { headers: { cookie } });
      expect(res.status, limit).toBe(400);
    }
  });
});
