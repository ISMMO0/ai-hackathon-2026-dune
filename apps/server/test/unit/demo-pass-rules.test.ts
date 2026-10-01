import { describe, expect, it } from 'vitest';
import * as chassisRoutes from '@antasphere/chassis-contract/routes';
import {
  DEMO_SESSION_REFUSED_API_ROUTES,
  type DemoSessionRefusedApiRoute
} from '@antasphere/chassis-server/identity';
import * as toolRoutes from '@app/contract/routes';
import { theTool } from '../../src/tool.js';

/**
 * A session a demo link opened is a visit: it mints no credential for anyone,
 * on the tool's routes as on the chassis's. The chassis refuses its own list
 * (`DEMO_SESSION_REFUSED_API_ROUTES`); the tool declares its own routes of the
 * kind (an invite link, a claim link, a key) in its `demoSessionRefusedRoutes`
 * slot (slot 24), appended at the one mount. This walk goes over the tool's
 * contract and the chassis's and fails on the first route that answers a
 * credential and is not on the list. The placeholder's slot is empty and
 * passes today; the next tool's first such route is caught here. A unit test:
 * no Postgres, no app, the contract and the list alone.
 */

describe('the product’s contract walk: every route that answers a credential is on the list', () => {
  /** Top-level keys of a 2xx JSON answer that carry a credential for someone. */
  const CREDENTIAL_KEYS = new Set([
    'resetUrl',
    'verifyUrl',
    'acceptUrl',
    'claimUrl',
    'secret',
    'apiKey',
    'key'
  ]);
  /** Routes no session reaches, so no demo link's session either (the chassis walk's own). */
  const EXCLUDED: Record<string, string> = {
    'POST /cli/auth/complete': 'no session: the CLI completes an emailed code, signed out',
    'POST /sso/cli-connect':
      'no session: a hub exchange token, and cloud only, where demo sign-in never runs',
    'POST /setup': 'no session: the first boot’s setup token'
  };
  const EXCLUDED_PREFIXES: Record<string, string> = {
    '/auth/': 'the sign-in library’s own mount: DEMO_SESSION_REFUSED_AUTH_PATHS judges it'
  };

  type RouteLike = { method: string; path: string; responses: Record<string, unknown> };
  const isRoute = (value: unknown): value is RouteLike =>
    !!value && typeof value === 'object' && 'method' in value && 'path' in value && 'responses' in value;

  /** Unwrap optional, nullable, default and readonly to the schema underneath. */
  function unwrap(schema: unknown): unknown {
    let current = schema as { _zod?: { def?: { type?: string; innerType?: unknown } } } | undefined;
    for (let i = 0; i < 10; i++) {
      const def = current?._zod?.def;
      if (!def || !['optional', 'nullable', 'default', 'readonly'].includes(def.type ?? '')) break;
      current = def.innerType as typeof current;
    }
    return current;
  }

  function credentialKeys(route: RouteLike): string[] {
    const found = new Set<string>();
    for (const [status, response] of Object.entries(route.responses)) {
      if (!/^2\d\d$/.test(status)) continue;
      const schema = unwrap(
        (response as { content?: Record<string, { schema?: unknown }> })?.content?.['application/json']
          ?.schema
      ) as { shape?: Record<string, unknown> } | undefined;
      const keys = Object.keys(schema?.shape ?? {});
      for (const key of keys) if (CREDENTIAL_KEYS.has(key)) found.add(key);
      if (keys.includes('url') && keys.includes('secret')) found.add('url');
    }
    return [...found];
  }

  /** OpenAPI `{id}` → the router's `:id`, every parameter name normalized so `:id` matches `:userId`. */
  const routerPath = (path: string) => path.replace(/\{[^}]+\}/g, ':p');

  /** The list the one mount installs: the chassis's, then the tool's declared routes. */
  const refused: readonly DemoSessionRefusedApiRoute[] = [
    ...DEMO_SESSION_REFUSED_API_ROUTES,
    ...(theTool.demoSessionRefusedRoutes ?? [])
  ];

  function onTheList(method: string, path: string): boolean {
    const target = routerPath(path);
    return refused.some((rule) => {
      if (rule.method !== 'ALL' && rule.method !== method) return false;
      const rulePath = rule.path.replace(/:[A-Za-z]+/g, ':p');
      if (rulePath.endsWith('/*')) return target.startsWith(rulePath.slice(0, -1));
      return target === rulePath;
    });
  }

  it('finds the credential routes in the product’s contract and the chassis’s, and every one is refused a demo link’s session', () => {
    const exported: unknown[] = [...Object.values(toolRoutes), ...Object.values(chassisRoutes)];
    const routes = exported.filter(isRoute);
    console.log(`contract routes walked: ${routes.length}`);
    expect(routes.length).toBeGreaterThan(50);

    const covered: string[] = [];
    const excluded: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      const method = route.method.toUpperCase();
      const name = `${method} ${route.path}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const keys = credentialKeys(route);
      if (keys.length === 0) continue;
      const prefix = Object.keys(EXCLUDED_PREFIXES).find((p) => route.path.startsWith(p));
      if (EXCLUDED[name] || prefix) {
        excluded.push(`${name} (${EXCLUDED[name] ?? EXCLUDED_PREFIXES[prefix!]})`);
      } else if (onTheList(method, route.path)) {
        covered.push(`${name} [${keys.join(', ')}]`);
      } else {
        missing.push(`${name} [${keys.join(', ')}]`);
      }
    }
    console.log(`demo session refusals, covered:\n  ${covered.join('\n  ')}`);
    console.log(`demo session refusals, excluded:\n  ${excluded.join('\n  ')}`);
    expect(missing).toEqual([]);
  });
});
