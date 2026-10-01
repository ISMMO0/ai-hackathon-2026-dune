import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { pino } from 'pino';
import { requestId } from '@antasphere/chassis-server/middleware';

/**
 * PRIV-1. A public route that carries a capability IN ITS PATH (a secret
 * link, `/v/:secret` here) is the case that makes this critical: the old
 * `path: c.req.path` wrote every live capability into the log stream (and,
 * via the OTel span attribute, into whatever trace backend the operator
 * points at). Redaction cannot help: pino keys off object PROPERTIES and
 * `path` is one opaque string.
 *
 * The completion log line must therefore carry the MATCHED ROUTE PATTERN.
 */
function appWithCapturedLogs() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (chunk: string) => {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      }
    }
  );
  const app = new Hono();
  app.use('*', requestId(logger));
  app.get('/v/:secret', (c) => c.text('ok'));
  app.get('/v/:secret/*', (c) => c.text('ok'));
  app.get('/orgs/:orgId/members/:memberId', (c) => c.text('ok'));
  return { app, lines };
}

describe('request completion logging', () => {
  it('logs the route pattern, not the LIVE SECRET carried in the path', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/v/s3cr3t-path-token');
    const line = lines.find((l) => l.msg === 'request');
    expect(line).toBeDefined();
    expect(line?.path).toBe('/v/:secret');
    expect(JSON.stringify(line)).not.toContain('s3cr3t-path-token');
  });

  it('templates the sub-path route too (/v/:secret/*)', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/v/s3cr3t-path-token/pages/3.html');
    const line = lines.find((l) => l.msg === 'request');
    expect(line?.path).toBe('/v/:secret/*');
    expect(JSON.stringify(line)).not.toContain('s3cr3t-path-token');
  });

  it('keeps every dynamic segment templated', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/orgs/11111111-2222-3333-4444-555555555555/members/deadbeef');
    const line = lines.find((l) => l.msg === 'request');
    expect(line?.path).toBe('/orgs/:orgId/members/:memberId');
    expect(JSON.stringify(line)).not.toContain('deadbeef');
  });

  it('reports an unmatched request without echoing the probed URL', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/does-not-exist/?token=leaked-value');
    const line = lines.find((l) => l.msg === 'request');
    // Hono reports the wildcard for a non-match; either way the probed URL
    // (and the token riding it) never reaches the log stream.
    expect(line?.path).toBe('/*');
    expect(JSON.stringify(line)).not.toContain('does-not-exist');
    expect(JSON.stringify(line)).not.toContain('leaked-value');
  });

  it('still records method, status and latency', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/v/abc');
    const line = lines.find((l) => l.msg === 'request');
    expect(line?.method).toBe('GET');
    expect(line?.status).toBe(200);
    expect(typeof line?.latencyMs).toBe('number');
  });
});

/**
 * The block above pins `requestId` against a SYNTHETIC root app whose
 * capability routes are declared inline. A tool's public app is a SEPARATE
 * Hono sub-app (the chassis mounts the `publicRoutes` slot with
 * `app.route('/', …)`), so the question that actually decides PRIV-1 is
 * whether `c.req.routePath` survives that composition — if it did not, the
 * middleware would be correct and the deployed app would still log live
 * secrets. Same class of gap as the PLT-39 / PLT-3 tests that passed while
 * their fixes were broken: assert against the composed shape, not an isolated one.
 */
describe('the route label survives a public sub-app composition', () => {
  const SECRET = 'Zq7-LIVE-PATH-SECRET-abc123';

  function composed() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: 'info' },
      { write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>) }
    );
    // A public app in its own sub-app, itself composed of a nested one.
    const embed = new Hono();
    embed.get('/embed.js', (c) => c.text('//'));
    const publicApp = new Hono();
    publicApp.route('/', embed);
    publicApp.post('/v/:secret', (c) => c.text('ok'));
    publicApp.post('/v/:secret/', (c) => c.text('ok'));
    publicApp.post('/v/:secret/*', (c) => c.text('ok'));
    publicApp.on(['GET', 'HEAD'], '/v/:secret', (c) => c.text('ok'));
    publicApp.on(['GET', 'HEAD'], '/v/:secret/', (c) => c.text('ok'));
    publicApp.on(['GET', 'HEAD'], '/v/:secret/*', (c) => c.text('ok'));

    const api = new Hono();
    api.post('/public/:secret/notes', (c) => c.json({ ok: true }));

    const app = new Hono();
    app.use('*', requestId(logger));
    app.route('/api/v1', api);
    app.route('/', publicApp);
    return { app, lines };
  }

  const probes: ReadonlyArray<readonly [string, string, string]> = [
    ['GET', `/v/${SECRET}`, '/v/:secret'],
    ['GET', `/v/${SECRET}/`, '/v/:secret/'],
    ['GET', `/v/${SECRET}/pages/3.html`, '/v/:secret/*'],
    // HEAD is rewritten to GET before routing (PLT-39) — the pattern must
    // still be what gets logged, not the raw path.
    ['HEAD', `/v/${SECRET}`, '/v/:secret'],
    ['HEAD', `/v/${SECRET}/assets/a.png`, '/v/:secret/*'],
    // A form posts back to the same capability-bearing URL.
    ['POST', `/v/${SECRET}`, '/v/:secret'],
    ['POST', `/v/${SECRET}/x`, '/v/:secret/*'],
    // A token-authed API route carries the secret under /api/v1 too.
    ['POST', `/api/v1/public/${SECRET}/notes`, '/api/v1/public/:secret/notes']
  ];

  for (const [method, path, expected] of probes) {
    it(`${method} ${path} logs ${expected}, never the secret`, async () => {
      const { app, lines } = composed();
      await app.request(path, { method });
      const line = lines.find((l) => l.msg === 'request');
      expect(line?.path).toBe(expected);
      expect(JSON.stringify(line)).not.toContain(SECRET);
    });
  }
});
