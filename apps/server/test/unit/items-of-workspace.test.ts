import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EntitlementRequest, Principal } from '@antasphere/chassis-contract';
import { itemsOfWorkspace } from '../../src/items/items-of-workspace.js';
import type { ToolDomain } from '../../src/tool.js';

/**
 * The `items.perWorkspace` hook on its own, against a fake domain: what it
 * answers for a caller the handler would refuse (null, so the route answers
 * on its own), for a body the create's validator will refuse (null, before
 * any lookup: the verifier's round 1 found the hook querying once per
 * element of an unbounded list), and for a caller the handler would let
 * create (the workspace's count plus this one). The integration suite
 * (plan-limits.test.ts) proves the same through the real boot; this file
 * names each branch.
 */

interface Calls {
  mayCreate: Array<readonly string[]>;
  count: string[];
}

function fakeDomain(opts: { count: number; mayCreate: boolean }): { domain: ToolDomain; calls: Calls } {
  const calls: Calls = { mayCreate: [], count: [] };
  const items = {
    async mayCreate(_principal: unknown, projectIds: readonly string[]) {
      calls.mayCreate.push(projectIds);
      return opts.mayCreate;
    },
    async count(workspaceId: string) {
      calls.count.push(workspaceId);
      return opts.count;
    }
  };
  return { domain: { items } as unknown as ToolDomain, calls };
}

const principal = (origin: 'member' | 'guest' = 'member'): Principal =>
  ({
    userId: 'u1',
    workspaceId: 'ws1',
    role: 'member',
    origin,
    via: 'session'
  }) as unknown as Principal;

function request(p: Principal | null, body: unknown): EntitlementRequest {
  return {
    method: 'POST',
    path: '/api/v1/items',
    headers: new Headers(),
    params: {},
    principal: p,
    body: async () => body
  };
}

describe('the items.perWorkspace hook', () => {
  it('no domain yet: null, and nothing is asked', async () => {
    const hook = itemsOfWorkspace(() => null);
    expect(await hook(request(principal(), { name: 'x' }))).toBeNull();
  });

  it('no principal: null, and nothing is asked', async () => {
    const { domain, calls } = fakeDomain({ count: 5, mayCreate: true });
    expect(await itemsOfWorkspace(() => domain)(request(null, { name: 'x' }))).toBeNull();
    expect(calls.mayCreate).toEqual([]);
    expect(calls.count).toEqual([]);
  });

  it('a guest: null before any lookup (the handler refuses a guest itself)', async () => {
    const { domain, calls } = fakeDomain({ count: 500, mayCreate: true });
    expect(await itemsOfWorkspace(() => domain)(request(principal('guest'), { name: 'x' }))).toBeNull();
    expect(calls.mayCreate).toEqual([]);
    expect(calls.count).toEqual([]);
  });

  it('a caller the create would refuse on a project: null, the count never read', async () => {
    const { domain, calls } = fakeDomain({ count: 500, mayCreate: false });
    const id = randomUUID();
    expect(
      await itemsOfWorkspace(() => domain)(request(principal(), { name: 'x', projectIds: [id] }))
    ).toBeNull();
    expect(calls.mayCreate).toEqual([[id]]);
    expect(calls.count).toEqual([]);
  });

  it('a caller the create would let in: the workspace’s items plus this one, on the principal’s workspace', async () => {
    const { domain, calls } = fakeDomain({ count: 99, mayCreate: true });
    const id = randomUUID();
    expect(await itemsOfWorkspace(() => domain)(request(principal(), { name: 'x', projectIds: [id] }))).toBe(
      100
    );
    expect(calls.mayCreate).toEqual([[id]]);
    expect(calls.count).toEqual(['ws1']);
  });

  it('a body naming no project counts as a create with no project; an empty list too', async () => {
    const { domain, calls } = fakeDomain({ count: 3, mayCreate: true });
    const hook = itemsOfWorkspace(() => domain);
    expect(await hook(request(principal(), { name: 'x' }))).toBe(4);
    expect(await hook(request(principal(), { name: 'x', projectIds: [] }))).toBe(4);
    expect(calls.mayCreate).toEqual([[], []]);
  });

  it('a body the create’s validator refuses is null before any lookup: no body, no name, a name too long, a note too long, a null list', async () => {
    const { domain, calls } = fakeDomain({ count: 3, mayCreate: true });
    const hook = itemsOfWorkspace(() => domain);
    expect(await hook(request(principal(), undefined))).toBeNull();
    expect(await hook(request(principal(), {}))).toBeNull();
    expect(await hook(request(principal(), { name: '' }))).toBeNull();
    expect(await hook(request(principal(), { name: 'x'.repeat(201) }))).toBeNull();
    expect(await hook(request(principal(), { name: 'x', note: 'n'.repeat(2001) }))).toBeNull();
    expect(await hook(request(principal(), { name: 'x', projectIds: null }))).toBeNull();
    expect(calls.mayCreate).toEqual([]);
    expect(calls.count).toEqual([]);
  });

  it('a project list the validator will refuse (over twenty, not uuids, not a list) is null before any lookup', async () => {
    const { domain, calls } = fakeDomain({ count: 3, mayCreate: true });
    const hook = itemsOfWorkspace(() => domain);
    const twentyOne = Array.from({ length: 21 }, () => randomUUID());
    expect(await hook(request(principal(), { name: 'x', projectIds: twentyOne }))).toBeNull();
    expect(await hook(request(principal(), { name: 'x', projectIds: ['not-a-uuid'] }))).toBeNull();
    expect(await hook(request(principal(), { name: 'x', projectIds: 'p1' }))).toBeNull();
    expect(calls.mayCreate).toEqual([]);
    expect(calls.count).toEqual([]);
  });

  it('twenty uuids, the schema’s most, are looked up as one list', async () => {
    const { domain, calls } = fakeDomain({ count: 0, mayCreate: true });
    const twenty = Array.from({ length: 20 }, () => randomUUID());
    expect(
      await itemsOfWorkspace(() => domain)(request(principal(), { name: 'x', projectIds: twenty }))
    ).toBe(1);
    expect(calls.mayCreate).toEqual([twenty]);
  });
});
