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
 * The PRDCT-1374 / PRDCT-1375 battery, driven against the REAL booted app.
 *
 * A tool that opens a public, token-authed surface (one the cross-site gate
 * must NOT touch, because the secret in the path is the credential and no
 * cookie is) declares it in `api.csrfExempt` and brings the "stays open" half
 * of the battery with it. Items have no such surface: the slot is empty, and
 * every items mutation sits behind the gate like any generic one.
 */

const OWNER = { email: 'owner@hard.test', name: 'Hard Owner', password: 'hard-owner-password-123' };
const NUL = '\u0000';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let httpsApp: TestApp;
let dcrOffApp: TestApp;
let cookie: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const nest = (depth: number) => '['.repeat(depth) + '1' + ']'.repeat(depth);

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'hardening'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Hard', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  httpsApp = await createTestApp(await createDatabase(container, 'hardening_https'), {
    PUBLIC_BASE_URL: 'https://secure.example'
  });
  dcrOffApp = await createTestApp(await createDatabase(container, 'hardening_dcr_off'), {
    OAUTH_DYNAMIC_CLIENT_REGISTRATION: 'false'
  });
}, 240_000);

/** RFC 7591 dynamic client registration — the PLT-29 switch's only sink. */
const registerClient = (target: TestApp) =>
  target.app.request('/api/v1/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'plt-29-probe',
      redirect_uris: ['https://plt29.example/cb'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    })
  });

afterAll(async () => {
  await app?.stop();
  await dcrOffApp?.stop();
  await httpsApp?.stop();
  await container?.stop();
});

// ── BROW-2 ──────────────────────────────────────────────────────────────────

describe('cross-site writes are refused before the handler', () => {
  const createKey = (headers: Record<string, string>) =>
    app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify({ name: 'csrf-probe', scopes: ['items:read'] })
    });

  it('rejects a credentialed POST whose Sec-Fetch-Site is cross-site, and creates nothing', async () => {
    const before = await readJson(await app.app.request('/api/v1/api-keys', { headers: { cookie } }));
    const res = await createKey({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('cross_site_forbidden');
    const after = await readJson(await app.app.request('/api/v1/api-keys', { headers: { cookie } }));
    expect(after.apiKeys.length).toBe(before.apiKeys.length);
  });

  it('rejects an untrusted Origin with no Sec-Fetch metadata', async () => {
    const res = await createKey({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site workspace rename, and the name is unchanged', async () => {
    const res = await app.app.request('/api/v1/workspace', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ name: 'pwned' })
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('cross_site_forbidden');
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(JSON.stringify(me)).not.toContain('pwned');
  });

  it('rejects a cross-site sign-in POST (login CSRF / session fixation)', async () => {
    const res = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password }, { origin: 'https://evil.example' })
    );
    expect(res.status).toBe(403);
  });

  it('lets the dashboard through: same-origin POST', async () => {
    const res = await createKey({ origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(201);
  });

  it('never refuses a bearer-authenticated call, whatever origin it claims', async () => {
    const res = await app.app.request(
      '/api/v1/items',
      json(
        {},
        {
          authorization: 'Bearer sl_definitely_not_valid',
          origin: 'https://x.example',
          'sec-fetch-site': 'cross-site'
        }
      )
    );
    expect(res.status).not.toBe(403);
  });

  it('rejects a cross-site item creation with a session cookie, and nothing is written', async () => {
    const res = await app.app.request(
      '/api/v1/items',
      json({ name: 'pwned' }, { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('cross_site_forbidden');
    const list = await readJson(await app.app.request('/api/v1/items', { headers: { cookie } }));
    expect(JSON.stringify(list)).not.toContain('pwned');
  });
});

// ── PLT-3 ───────────────────────────────────────────────────────────────────

describe('the OpenAPI document', () => {
  it('serves the same cacheable buffer on every hit, and stays responsive under a burst', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => app.app.request('/api/v1/openapi.json'))
    );
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      openapi: expect.any(String),
      paths: expect.any(Object)
    });
    const health = await app.app.request('/healthz');
    expect(health.status).toBe(200);
  });
});

// ── SL-B4 / SL-B5 ───────────────────────────────────────────────────────────

describe('malformed input from an ANONYMOUS client is 4xx, never 5xx', () => {
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    [
      'NUL in the setup instance name',
      () =>
        app.app.request(
          '/api/v1/setup',
          json({ setupToken: 'integration-test-setup-token', instanceName: `Acme${NUL}`, owner: OWNER })
        ),
      'validation_error'
    ],
    [
      'NUL in the invitation accept name',
      () =>
        app.app.request(
          '/api/v1/invitations/accept',
          json({ token: 'x'.repeat(20), name: `Ann${NUL}`, password: 'correct horse battery' })
        ),
      'validation_error'
    ],
    [
      'NUL in the CLI key name',
      () =>
        app.app.request(
          '/api/v1/cli/auth/complete',
          json({ email: 'a@b.io', otp: '123456', keyName: `laptop${NUL}` })
        ),
      'validation_error'
    ],
    [
      'deeply nested JSON on a public route',
      () =>
        app.app.request('/api/v1/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: nest(6000)
        }),
      'payload_too_deep'
    ],
    [
      'deeply nested JSON on the credential surface',
      () =>
        app.app.request('/api/v1/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: nest(6000)
        }),
      'payload_too_deep'
    ]
  ];

  for (const [label, run, expectedCode] of cases) {
    it(label, async () => {
      const res = await run();
      // The specific status AND code: a bare "4xx" would be satisfied by a 404
      // or a 410 that never reached validation at all, which makes the case
      // prove nothing about the fix.
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe(expectedCode);
    });
  }

  it('deep JSON on an authenticated route is 400 payload_too_deep', async () => {
    const res = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: nest(6000)
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('payload_too_deep');
  });
});

// ── DASH-5 + PLT-28 ─────────────────────────────────────────────────────────

describe('response headers', () => {
  it('marks authenticated JSON no-store', async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks the items listing no-store too', async () => {
    const res = await app.app.request('/api/v1/items', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sends HSTS when the instance declares an https public origin', async () => {
    const res = await httpsApp.app.request('/healthz');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
  });

  it('sends no HSTS on an http instance (a browser would ignore it anyway)', async () => {
    const res = await app.app.request('/healthz');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});

// ── PLT-39 ──────────────────────────────────────────────────────────────────

describe('HEAD on file content', () => {
  it('answers the metadata headers with no body — the headOnly path really runs', async () => {
    const upload = await app.app.request('/api/v1/files?name=head-probe.txt', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'hello head'
    });
    expect(upload.status).toBe(201);
    const fileId = (await readJson(upload)).file.id;

    const head = await app.app.request(`/api/v1/files/${fileId}/content`, {
      method: 'HEAD',
      headers: { cookie }
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(await head.text()).toBe('');

    const get = await app.app.request(`/api/v1/files/${fileId}/content`, { headers: { cookie } });
    expect(await get.text()).toBe('hello head');
  });
});

// ── AF-4 ────────────────────────────────────────────────────────────────────

describe('the login wall no longer bills successful sign-ins to the account', () => {
  it('lets one account sign in far past the bucket size from one IP', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': '198.51.100.7' })
      );
      expect(res.status).toBe(200);
    }
  });

  it('still walls off a brute-force run on the same account', async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 15 && !sawRateLimit; i++) {
      const res = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: 'brute@hard.test', password: `guess-${i}` }, { 'x-forwarded-for': '198.51.100.8' })
      );
      if (res.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});

// ── PLT-29 ──────────────────────────────────────────────────────────────────

/**
 * The switch has to DO something. `env.test.ts` only proves the variable
 * parses and defaults to true — with that as the whole coverage, replacing
 * `env.OAUTH_DYNAMIC_CLIENT_REGISTRATION` in identity/better-auth.ts with a
 * hardcoded `true` leaves the entire suite green (verified by mutation), i.e.
 * an operator setting it to false would get no protection and no warning.
 * These two cases pin the wiring at the endpoint, in both positions.
 */
describe('dynamic client registration honours the env switch', () => {
  it('mints a client with the default (unchanged) posture', async () => {
    const res = await registerClient(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { client_id?: string }).client_id).toBeTruthy();
  });

  it('refuses every caller when the switch is off', async () => {
    const res = await registerClient(dcrOffApp);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toMatchObject({ error: 'access_denied' });
  });
});
