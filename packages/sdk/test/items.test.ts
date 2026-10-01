import { describe, expect, it } from 'vitest';
import type { Item } from '@app/contract';
import { PlatformApiError, PlatformClient } from '../src/index.js';

/**
 * The five item methods, each pinned by the request it puts on the wire.
 * `route-coverage.test.ts` already proves a method EXISTS for every contract
 * route and hits its method + path; this file proves the rest of a call: the
 * query, the body, the credential and workspace headers, the parsed answer,
 * and an API error surfacing as a `PlatformApiError` with the API's code.
 */

const ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '44444444-4444-4444-4444-444444444444';

const ITEM: Item = {
  id: ID,
  workspaceId: WORKSPACE,
  name: 'First',
  note: 'a note',
  createdBy: '22222222-2222-2222-2222-222222222222',
  /** Every item payload carries its readable projects, `[]` when none. */
  projects: [],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z'
};
const PROJECT = '55555555-5555-4555-8555-555555555555';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A client over a fake fetch that records every call and answers `answer` with `status`. */
function recordingClient(answer: unknown, opts: { status?: number; workspaceId?: string } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    });
    return new Response(JSON.stringify(answer), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  const client = new PlatformClient({
    baseUrl: 'http://x',
    apiKey: 'key_k_s',
    fetch: fetchImpl,
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {})
  });
  return { client, calls };
}

describe('SDK items: the request each method sends', () => {
  it('items() lists without a query, and answers the page as parsed', async () => {
    const page = { items: [ITEM], nextCursor: 'next' };
    const { client, calls } = recordingClient(page);
    expect(await client.items()).toEqual(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('http://x/api/v1/items');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('items({ cursor, limit }) puts both in the query, encoded', async () => {
    const { client, calls } = recordingClient({ items: [], nextCursor: null });
    await client.items({ cursor: 'a b&c', limit: 3 });
    expect(calls[0]!.url).toBe('http://x/api/v1/items?cursor=a+b%26c&limit=3');
  });

  it('createItem() posts the body as JSON and answers { item }', async () => {
    const { client, calls } = recordingClient({ item: ITEM }, { status: 201 });
    expect(await client.createItem({ name: 'First', note: 'a note' })).toEqual({ item: ITEM });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://x/api/v1/items');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({ name: 'First', note: 'a note' });
  });

  it('createItem() may omit the note: the server defaults it, the client does not invent it', async () => {
    const { client, calls } = recordingClient({ item: ITEM }, { status: 201 });
    await client.createItem({ name: 'First' });
    expect(calls[0]!.body).toEqual({ name: 'First' });
  });

  it('item() reads one by id', async () => {
    const { client, calls } = recordingClient(ITEM);
    expect(await client.item(ID)).toEqual(ITEM);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`http://x/api/v1/items/${ID}`);
  });

  it('updateItem() patches with the fields given and nothing else', async () => {
    const { client, calls } = recordingClient({ ...ITEM, note: 'changed' });
    expect((await client.updateItem(ID, { note: 'changed' })).note).toBe('changed');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe(`http://x/api/v1/items/${ID}`);
    expect(calls[0]!.body).toEqual({ note: 'changed' });
  });

  it('deleteItem() sends no body and answers the final snapshot', async () => {
    const { client, calls } = recordingClient(ITEM);
    expect(await client.deleteItem(ID)).toEqual(ITEM);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`http://x/api/v1/items/${ID}`);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers['content-type']).toBeUndefined();
  });

  it('an id is never trusted to be a clean path segment', async () => {
    const { client, calls } = recordingClient(ITEM);
    await client.item('../x#1?y');
    await client.updateItem('../x#1?y', { name: 'n' });
    await client.deleteItem('../x#1?y');
    for (const call of calls) expect(call.url).toBe('http://x/api/v1/items/..%2Fx%231%3Fy');
  });
});

describe('SDK items: credential and workspace', () => {
  const CALLS: Record<string, (c: PlatformClient) => Promise<unknown>> = {
    items: (c) => c.items(),
    createItem: (c) => c.createItem({ name: 'First' }),
    item: (c) => c.item(ID),
    updateItem: (c) => c.updateItem(ID, { name: 'Renamed' }),
    deleteItem: (c) => c.deleteItem(ID)
  };

  it.each(Object.entries(CALLS))(
    '%s carries the key, and X-Workspace-Id when a workspace is given',
    async (_n, call) => {
      const { client, calls } = recordingClient(ITEM, { workspaceId: WORKSPACE });
      await call(client);
      expect(calls[0]!.headers['authorization']).toBe('Bearer key_k_s');
      expect(calls[0]!.headers['x-workspace-id']).toBe(WORKSPACE);
    }
  );

  it.each(Object.entries(CALLS))(
    '%s sends no workspace header without one (the default applies)',
    async (_n, call) => {
      const { client, calls } = recordingClient(ITEM);
      await call(client);
      expect('x-workspace-id' in calls[0]!.headers).toBe(false);
    }
  );
});

describe('SDK items: an API error is a PlatformApiError with the API code', () => {
  it('404 not_found on a read', async () => {
    const { client } = recordingClient(
      { error: { code: 'not_found', message: 'Item not found' } },
      { status: 404 }
    );
    const error = await client.item(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found', message: 'Item not found' });
  });

  it('400 validation_error on a create keeps the details', async () => {
    const details = [{ path: ['name'], message: 'Too small' }];
    const { client } = recordingClient(
      { error: { code: 'validation_error', message: 'Invalid request', details } },
      { status: 400 }
    );
    const error = await client.createItem({ name: '' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect(error).toMatchObject({ status: 400, code: 'validation_error', details });
  });

  it('403 guest_forbidden on a write', async () => {
    const { client } = recordingClient(
      { error: { code: 'guest_forbidden', message: 'Guests cannot' } },
      { status: 403 }
    );
    await expect(client.deleteItem(ID)).rejects.toMatchObject({ status: 403, code: 'guest_forbidden' });
  });
});

describe('the item side of projects', () => {
  it('items({ project }) sends the filter as the `project` query parameter, beside the page', async () => {
    const { client, calls } = recordingClient({ items: [ITEM], nextCursor: null });
    await client.items({ project: PROJECT, limit: 5 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/items');
    expect(url.searchParams.get('project')).toBe(PROJECT);
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('createItem sends projectIds when given', async () => {
    const { client, calls } = recordingClient({ item: ITEM });
    await client.createItem({ name: 'First', projectIds: [PROJECT] });
    expect(calls[0]!.body).toEqual({ name: 'First', projectIds: [PROJECT] });
  });

  it('linkItemProject PUTs and unlinkItemProject DELETEs the link path, answering the item', async () => {
    const linked = { ...ITEM, projects: [{ id: PROJECT, name: 'P' }] };
    const { client, calls } = recordingClient(linked);
    expect(await client.linkItemProject(ID, PROJECT)).toEqual(linked);
    expect(calls[0]!.method).toBe('PUT');
    expect(new URL(calls[0]!.url).pathname).toBe(`/api/v1/items/${ID}/projects/${PROJECT}`);
    expect(await client.unlinkItemProject(ID, PROJECT)).toEqual(linked);
    expect(calls[1]!.method).toBe('DELETE');
  });
});
