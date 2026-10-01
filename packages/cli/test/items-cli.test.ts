import { describe, expect, it } from 'vitest';
import type { Item } from '@app/contract';
import { run } from '../src/index.js';
import { cli, saveConfig } from '../src/cli.js';
import { routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * The `items` command group through the routed harness: a fake instance that
 * answers the five item routes and records every call. Each command is pinned
 * by the request it sends, by what it prints for a human and under `--json`,
 * and by how a refusal ends (stderr, exit 1).
 */

const URL = 'http://x';
const KEY = `${cli.identity.keyPrefix}_k_secret`;
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-1111-1111-111111111111';
const MISSING = '99999999-9999-4999-8999-999999999999';

const ITEM: Item = {
  id: ID,
  workspaceId: WORKSPACE,
  name: 'First',
  note: 'line one\nline two',
  createdBy: '22222222-2222-2222-2222-222222222222',
  /** Every item payload carries its readable projects, `[]` when none. */
  projects: [],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z'
};
const SECOND: Item = { ...ITEM, id: '33333333-3333-3333-3333-333333333333', name: 'Second', note: '' };

/** The five item routes. `list` is what GET /items answers. */
function instance(list: { items: Item[]; nextCursor: string | null }): Route[] {
  const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Item not found' } } };
  const one = (path: string) => (path.includes(MISSING) ? undefined : ITEM);
  return [
    { method: 'GET', path: /^\/api\/v1\/items$/, reply: () => ({ body: list }) },
    {
      method: 'POST',
      path: /^\/api\/v1\/items$/,
      reply: ({ body }) => ({ status: 201, body: { item: { ...ITEM, note: '', ...(body as object) } } })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/items\/[^/]+$/,
      reply: ({ path }) => (one(path) ? { body: ITEM } : notFound)
    },
    {
      method: 'PATCH',
      path: /^\/api\/v1\/items\/[^/]+$/,
      reply: ({ path, body }) => (one(path) ? { body: { ...ITEM, ...(body as object) } } : notFound)
    },
    {
      method: 'DELETE',
      path: /^\/api\/v1\/items\/[^/]+$/,
      reply: ({ path }) => (one(path) ? { body: ITEM } : notFound)
    }
  ];
}

const PAGE = { items: [ITEM, SECOND], nextCursor: null };

/** A saved profile on the instance: the key and the URL come from the config, as for a real user. */
async function harness(list: { items: Item[]; nextCursor: string | null } = PAGE) {
  const env = await tempConfigEnv();
  saveConfig(env, { activeProfile: 'work', profiles: { work: { apiKey: KEY, baseUrl: URL } } });
  return routedHarness(instance(list), env);
}

describe('items list', () => {
  it('requests GET /items with the key, and prints one row per item', async () => {
    const h = await harness();
    expect(await run(['items', 'list'], h.io)).toBe(0);
    expect(h.wire).toEqual([{ method: 'GET', origin: URL, path: '/api/v1/items', auth: `Bearer ${KEY}` }]);
    expect(h.out()).toBe(
      `${ITEM.id}  ${ITEM.createdAt}  First\n` + `${SECOND.id}  ${SECOND.createdAt}  Second\n`
    );
    expect(h.err()).toBe('');
  });

  it('--limit and --cursor go into the query; a next page is announced with its cursor', async () => {
    const h = await harness({ items: [ITEM], nextCursor: SECOND.id });
    expect(await run(['items', 'list', '--limit', '1', '--cursor', 'abc'], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: '/api/v1/items?cursor=abc&limit=1' }]);
    expect(h.out()).toContain(`More available: rerun with --cursor ${SECOND.id} or --all\n`);
  });

  it('--all follows nextCursor until the last page, prints every item and announces no more', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { activeProfile: 'work', profiles: { work: { apiKey: KEY, baseUrl: URL } } });
    const pages: Record<string, { items: Item[]; nextCursor: string | null }> = {
      '': { items: [ITEM], nextCursor: 'c2' },
      c2: { items: [SECOND], nextCursor: null }
    };
    const h = routedHarness(
      [
        {
          method: 'GET',
          path: /^\/api\/v1\/items(\?.*)?$/,
          reply: ({ path }) => ({ body: pages[path.includes('cursor=c2') ? 'c2' : '']! })
        }
      ],
      env
    );
    expect(await run(['items', 'list', '--all', '--limit', '1'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: '/api/v1/items?limit=1' },
      { method: 'GET', path: '/api/v1/items?cursor=c2&limit=1' }
    ]);
    expect(h.out()).toBe(
      `${ITEM.id}  ${ITEM.createdAt}  First\n` + `${SECOND.id}  ${SECOND.createdAt}  Second\n`
    );
    expect(h.out()).not.toContain('More available');

    const json = routedHarness(
      [
        {
          method: 'GET',
          path: /^\/api\/v1\/items(\?.*)?$/,
          reply: ({ path }) => ({ body: pages[path.includes('cursor=c2') ? 'c2' : '']! })
        }
      ],
      env
    );
    expect(await run(['items', 'list', '--all', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ items: [ITEM, SECOND], nextCursor: null });
  });

  it('--json prints the wire shape, nextCursor included', async () => {
    const h = await harness({ items: [ITEM], nextCursor: SECOND.id });
    expect(await run(['items', 'list', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ items: [ITEM], nextCursor: SECOND.id });
  });

  it('says so when there is none', async () => {
    const h = await harness({ items: [], nextCursor: null });
    expect(await run(['items', 'list'], h.io)).toBe(0);
    expect(h.out()).toBe('No items.\n');
  });

  it("--workspace is the kit's global flag: the request carries X-Workspace-Id", async () => {
    const h = await harness();
    expect(await run(['items', 'list', '--workspace', WORKSPACE], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'GET', origin: URL, path: '/api/v1/items', auth: `Bearer ${KEY}`, workspace: WORKSPACE }
    ]);
  });
});

describe('items create', () => {
  it('posts the name and the note', async () => {
    const h = await harness();
    expect(await run(['items', 'create', '--name', 'First', '--note', 'a note'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'POST', path: '/api/v1/items', body: { name: 'First', note: 'a note' } }
    ]);
    expect(h.out()).toBe(`Created First\n  id: ${ID}\n`);
  });

  it('leaves the note out of the body when --note is not given (the server defaults it)', async () => {
    const h = await harness();
    expect(await run(['items', 'create', '--name', 'First'], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ name: 'First' });
  });

  it('--json prints { item }', async () => {
    const h = await harness();
    expect(await run(['items', 'create', '--name', 'First', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ item: { ...ITEM, note: '', name: 'First' } });
  });

  it('refuses without --name, before any request', async () => {
    const h = await harness();
    expect(await run(['items', 'create'], h.io)).toBe(1);
    expect(h.err()).toContain("required option '--name <name>' not specified");
    expect(h.calls).toEqual([]);
  });
});

describe('items show', () => {
  it('requests GET /items/{id} and prints the item, the note indented under its label', async () => {
    const h = await harness();
    expect(await run(['items', 'show', ID], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: `/api/v1/items/${ID}` }]);
    expect(h.out()).toBe(
      'First\n' +
        `  id:       ${ID}\n` +
        '  note:     line one\n            line two\n' +
        `  author:   ${ITEM.createdBy}\n` +
        `  created:  ${ITEM.createdAt}\n` +
        `  updated:  ${ITEM.updatedAt}\n`
    );
  });

  it('--json prints the item as the API answered it', async () => {
    const h = await harness();
    expect(await run(['items', 'show', ID, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(ITEM);
  });

  it("a 404 is the kit's error line on stderr and exit 1, nothing on stdout", async () => {
    const h = await harness();
    expect(await run(['items', 'show', MISSING], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Item not found\n');
    expect(h.out()).toBe('');
  });
});

describe('items show under a workspace selection', () => {
  it("a 404 carries the kit's hint: the workspace that was looked in, and what selected it", async () => {
    const h = await harness();
    expect(await run(['items', 'show', MISSING, '--workspace', WORKSPACE], h.io)).toBe(1);
    expect(h.err()).toContain('Error: Item not found (looked in the workspace');
    expect(h.err()).toContain(WORKSPACE);
    expect(h.err()).toContain('--workspace');
  });
});

describe('items update', () => {
  it('patches with the fields given and nothing else', async () => {
    const h = await harness();
    expect(await run(['items', 'update', ID, '--note', 'changed'], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'PATCH', path: `/api/v1/items/${ID}`, body: { note: 'changed' } }]);
    expect(h.out()).toContain('  note:     changed\n');
  });

  it('--note "" clears the note: an empty string is a value, not an absence', async () => {
    const h = await harness();
    expect(await run(['items', 'update', ID, '--note', ''], h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ note: '' });
    expect(h.out()).toContain('  note:     (none)\n');
  });

  it('--json prints the updated item', async () => {
    const h = await harness();
    expect(await run(['items', 'update', ID, '--name', 'Renamed', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ ...ITEM, name: 'Renamed' });
  });

  it('refuses when neither --name nor --note is given, before any request', async () => {
    const h = await harness();
    expect(await run(['items', 'update', ID], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Nothing to change: pass --name <name> and/or --note <note>.\n');
    expect(h.calls).toEqual([]);
  });

  it('a 404 exits 1', async () => {
    const h = await harness();
    expect(await run(['items', 'update', MISSING, '--name', 'x'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Item not found\n');
  });
});

describe('items rm', () => {
  it('requests DELETE /items/{id} and names what was deleted', async () => {
    const h = await harness();
    expect(await run(['items', 'rm', ID], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'DELETE', path: `/api/v1/items/${ID}` }]);
    expect(h.out()).toBe(`Deleted First (${ID})\n`);
  });

  it('--json prints the final snapshot', async () => {
    const h = await harness();
    expect(await run(['items', 'rm', ID, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(ITEM);
  });

  it('a 404 exits 1', async () => {
    const h = await harness();
    expect(await run(['items', 'rm', MISSING], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Item not found\n');
  });
});

describe("a name is somebody else's text heading for a terminal", () => {
  // A colour, an OSC 8 hyperlink hiding a URL, and a CSI that scrubs the line above.
  const HOSTILE =
    '\u001b[31mred\u001b[0m \u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007\u001b[1A\u001b[2K!';
  const hostile: Item = { ...ITEM, name: HOSTILE, note: 'n\u0007ote' };

  it('human output loses every control sequence (list, show, rm)', async () => {
    for (const argv of [
      ['items', 'list'],
      ['items', 'show', ID],
      ['items', 'rm', ID]
    ]) {
      const h = routedHarness(
        [
          {
            method: 'GET',
            path: /^\/api\/v1\/items$/,
            reply: () => ({ body: { items: [hostile], nextCursor: null } })
          },
          { method: 'GET', path: /^\/api\/v1\/items\/[^/]+$/, reply: () => ({ body: hostile }) },
          { method: 'DELETE', path: /^\/api\/v1\/items\/[^/]+$/, reply: () => ({ body: hostile }) }
        ],
        {
          ...(await tempConfigEnv()),
          [`${cli.identity.envPrefix}_URL`]: URL,
          [`${cli.identity.envPrefix}_API_KEY`]: KEY
        }
      );
      expect(await run(argv, h.io)).toBe(0);
      // eslint-disable-next-line no-control-regex -- the absence of control characters IS the assertion.
      expect(h.out()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(h.out()).toContain('red link!');
    }
  });

  it('--json keeps the name byte-exact: it is data, and JSON escapes it', async () => {
    const h = routedHarness(
      [{ method: 'GET', path: /^\/api\/v1\/items\/[^/]+$/, reply: () => ({ body: hostile }) }],
      {
        ...(await tempConfigEnv()),
        [`${cli.identity.envPrefix}_URL`]: URL,
        [`${cli.identity.envPrefix}_API_KEY`]: KEY
      }
    );
    expect(await run(['items', 'show', ID, '--json'], h.io)).toBe(0);
    expect(h.out()).not.toContain('\u001b');
    expect((JSON.parse(h.out()) as Item).name).toBe(HOSTILE);
  });
});
