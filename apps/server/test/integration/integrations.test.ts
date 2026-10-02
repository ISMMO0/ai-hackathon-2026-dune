import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GradiumClient, HClient } from '../../src/integrations/index.js';
import { IntegrationError } from '../../src/integrations/errors.js';
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
 * `GET /integrations` through the real boot: the env slot's two keys reach
 * the domain (`BootResult.tool.integrations`), the report says which are
 * configured, and `?check=true` makes the live calls. No provider is ever
 * reached: a key set in the env is only ever reported (no check), and every
 * check runs against the fakes handed in through the boot overrides.
 */

const APP = 'http://localhost:3000';
const OWNER = { email: 'owner@integrations.test', name: 'Owner', password: 'integrations-owner-password-1' };

let container: StartedPostgreSqlContainer;
const apps: TestApp[] = [];

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

async function signedIn(app: TestApp): Promise<string> {
  const setup = await app.app.request(
    `${APP}/api/v1/setup`,
    json({ setupToken: SETUP_TOKEN, instanceName: 'Integrations', owner: OWNER })
  );
  expect(setup.status).toBeLessThan(300);
  const signIn = await app.app.request(
    `${APP}/api/v1/auth/sign-in/email`,
    json({ email: OWNER.email, password: OWNER.password })
  );
  expect(signIn.status).toBe(200);
  return extractCookie(signIn);
}

async function boot(
  name: string,
  env: Record<string, string>,
  tool?: { gradium?: GradiumClient; h?: HClient }
) {
  const app = await createTestApp(await createDatabase(container, name), env, tool ? { tool } : undefined);
  apps.push(app);
  return app;
}

const unused = async (): Promise<never> => {
  throw new Error('not called in this test');
};

beforeAll(async () => {
  container = await startPostgres();
}, 240_000);

afterAll(async () => {
  for (const app of apps) await app.stop();
  await container?.stop();
});

describe('GET /integrations', () => {
  it('without keys: neither is configured, a check reaches nothing, and the anonymous caller is 401', async () => {
    const app = await boot('integrations_none', {});
    expect(app.tool.integrations).toEqual({ gradium: null, h: null });
    const cookie = await signedIn(app);

    for (const path of ['/api/v1/integrations', '/api/v1/integrations?check=true']) {
      const res = await app.app.request(`${APP}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ gradium: { configured: false }, h: { configured: false } });
    }
    expect((await app.app.request(`${APP}/api/v1/integrations`)).status).toBe(401);
  });

  it('the env slot hands the two keys to the domain: both configured, and reported without a live call', async () => {
    const app = await boot('integrations_env', {
      GRADIUM_API_KEY: 'g-key-never-used',
      HAI_API_KEY: 'h-key-never-used'
    });
    expect(app.tool.integrations.gradium).not.toBeNull();
    expect(app.tool.integrations.h).not.toBeNull();
    const cookie = await signedIn(app);
    const res = await app.app.request(`${APP}/api/v1/integrations`, { headers: { cookie } });
    const body = await readJson(res);
    expect(body).toEqual({ gradium: { configured: true }, h: { configured: true } });
    expect(JSON.stringify(body)).not.toContain('never-used');
  });

  it('?check=true: one live call to each, ok and one line of detail; a failure is ok:false with the reason', async () => {
    let creditsCalls = 0;
    const gradium: GradiumClient = {
      speak: unused,
      designVoice: unused,
      saveVoice: unused,
      transcribe: unused,
      credits: async () => {
        creditsCalls++;
        return { remaining: 4200, allocated: 5000 };
      }
    };
    const h: HClient = {
      start: unused,
      poll: unused,
      quota: async () => {
        throw new IntegrationError('h', 'H answered 401 (read the quota): invalid key', 401);
      }
    };
    const app = await boot('integrations_check', {}, { gradium, h });
    const cookie = await signedIn(app);

    const plain = await readJson(
      await app.app.request(`${APP}/api/v1/integrations`, { headers: { cookie } })
    );
    expect(plain).toEqual({ gradium: { configured: true }, h: { configured: true } });
    expect(creditsCalls).toBe(0);

    const checked = await app.app.request(`${APP}/api/v1/integrations?check=true`, { headers: { cookie } });
    expect(checked.status).toBe(200);
    expect(await readJson(checked)).toEqual({
      gradium: { configured: true, ok: true, detail: '4200 credits remaining' },
      h: { configured: true, ok: false, detail: 'H answered 401 (read the quota): invalid key' }
    });
    expect(creditsCalls).toBe(1);

    // Machines: a read key reads it.
    const key = (
      await readJson(
        await app.app.request(
          `${APP}/api/v1/api-keys`,
          json({ name: 'ro', scopes: ['items:read'] }, { cookie })
        )
      )
    ).key as string;
    const byKey = await app.app.request(`${APP}/api/v1/integrations`, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(byKey.status).toBe(200);
  });
});
