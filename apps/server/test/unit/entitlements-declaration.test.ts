import { describe, expect, it } from 'vitest';
import { theTool } from '../../src/tool.js';

/**
 * What the template declares to the billing rail, by the operator's cap
 * (PRDCT-2653, PRDCT-2863): the upload cap's paid tier IS `MAX_FILE_SIZE_MB`
 * and its free value 100 MB or the cap when the cap is smaller, so what
 * discovery advertises is what the instance serves; the two count limits and
 * the feature do not depend on the cap at all. The integration suites read
 * the same values through one boot at one cap; this file walks the caps a
 * boot never tries, where a `min` turned `max` would refuse the boot of
 * every instance capped below 100 MB.
 */
const MB = 1024 * 1024;

function declaredAt(maxFileSizeMb: number) {
  // The slot's context (the database and the late-bound domain) feeds the
  // count hook alone, which this test never calls.
  return theTool.entitlements!({ MAX_FILE_SIZE_MB: maxFileSizeMb } as never, {
    db: null as never,
    getTool: () => null
  });
}

const uploadCapAt = (maxFileSizeMb: number) => declaredAt(maxFileSizeMb).limits['files.maxBytes']!;

describe('the upload cap the template declares, by the operator’s cap (PRDCT-2653)', () => {
  it('capped below 100 MB: free, pro and oss are all the cap', () => {
    expect(uploadCapAt(50)).toEqual({ oss: 50 * MB, free: 50 * MB, pro: 50 * MB });
  });

  it('capped at 100 MB: free equals pro equals the cap', () => {
    expect(uploadCapAt(100)).toEqual({ oss: 100 * MB, free: 100 * MB, pro: 100 * MB });
  });

  it('capped at 500 MB: free stays 100 MB, pro is the cap', () => {
    expect(uploadCapAt(500)).toEqual({ oss: 500 * MB, free: 100 * MB, pro: 500 * MB });
  });

  it('no tier ever advertises more than the operator’s cap', () => {
    for (const cap of [1, 50, 100, 500, 2048]) {
      const { oss, free, pro } = uploadCapAt(cap);
      expect(free).toBeLessThanOrEqual(oss!);
      expect(pro).toBeLessThanOrEqual(oss!);
    }
  });
});

describe('the count limits and the feature do not move with the cap (PRDCT-2863)', () => {
  it('a hundred items per workspace and three members on free, unlimited on pro and self-hosted', () => {
    for (const cap of [1, 100, 2048]) {
      const { limits } = declaredAt(cap);
      expect(limits['items.perWorkspace']).toEqual({ oss: null, free: 100, pro: null });
      expect(limits['workspace.members']).toEqual({ oss: null, free: 3, pro: null });
    }
  });

  it('the premium feature is pro only', () => {
    expect(declaredAt(100).features['items.premium']).toEqual({ free: false, pro: true });
  });
});

describe('the routes carry the declarations', () => {
  // The registry is keyed `METHOD /path`, the contract's own spelling of the route.
  const routes = declaredAt(100).routes;

  it('the item create is metered per call and judged against the count', () => {
    const create = routes.get('POST /items');
    expect(create?.meter?.key).toBe('items.create');
    expect(create?.limit?.key).toBe('items.perWorkspace');
  });

  it('the upload is metered in bytes and judged against the upload cap', () => {
    const upload = routes.get('POST /files');
    expect(upload?.meter?.unit).toBe('bytes');
    expect(upload?.limit?.key).toBe('files.maxBytes');
  });
});
