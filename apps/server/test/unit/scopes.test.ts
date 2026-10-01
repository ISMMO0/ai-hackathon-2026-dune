import { describe, expect, it } from 'vitest';
import { requiredScopeFor } from '../../src/middleware/scopes.js';

/**
 * The fail-closed machine allowlist, pinned: the /items tree is the ONE tool
 * surface open to keys and tokens (reads under items:read, mutations under
 * items:write), and everything the tool has not listed dies at the gate.
 */
const ITEM = '/api/v1/items/11111111-2222-3333-4444-555555555555';

describe('requiredScopeFor — the items tree', () => {
  it('opens reads under items:read, for the list and for any path below it', () => {
    expect(requiredScopeFor('/api/v1/items', 'GET')).toBe('items:read');
    expect(requiredScopeFor(ITEM, 'GET')).toBe('items:read');
    expect(requiredScopeFor(`${ITEM}/anything/below`, 'HEAD')).toBe('items:read');
  });

  it('never opens a mutation to a read key: every mutation is items:write', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor('/api/v1/items', method)).toBe('items:write');
      expect(requiredScopeFor(ITEM, method)).toBe('items:write');
    }
  });

  it('the item side of projects rides the same tree: a link is items:write (the list filter is a query, so the list rule covers it)', () => {
    const LINK = `${ITEM}/projects/66666666-7777-8888-9999-aaaaaaaaaaaa`;
    expect(requiredScopeFor(LINK, 'PUT')).toBe('items:write');
    expect(requiredScopeFor(LINK, 'DELETE')).toBe('items:write');
    expect(requiredScopeFor(LINK, 'GET')).toBe('items:read');
  });

  it('keeps a neighbouring spelling and an unlisted surface fail-closed', () => {
    expect(requiredScopeFor('/api/v1/itemsx', 'GET')).toBeNull();
    expect(requiredScopeFor('/api/v1/item', 'GET')).toBeNull();
    expect(requiredScopeFor('/api/v1/not-a-listed-surface', 'GET')).toBeNull();
  });
});

describe('requiredScopeFor — the integrations report', () => {
  it('GET /integrations is a read; no other method is opened on it, and a neighbour stays closed', () => {
    expect(requiredScopeFor('/api/v1/integrations', 'GET')).toBe('items:read');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor('/api/v1/integrations', method)).toBeNull();
    }
    expect(requiredScopeFor('/api/v1/integrations/gradium', 'GET')).toBeNull();
  });
});

describe('requiredScopeFor — the voice', () => {
  it('speak and transcribe are writes; a read method opens nothing on the tree', () => {
    expect(requiredScopeFor('/api/v1/voice/speak', 'POST')).toBe('items:write');
    expect(requiredScopeFor('/api/v1/voice/transcribe', 'POST')).toBe('items:write');
    expect(requiredScopeFor('/api/v1/voice/speak', 'GET')).toBeNull();
    expect(requiredScopeFor('/api/v1/voice', 'POST')).toBeNull();
    expect(requiredScopeFor('/api/v1/voicex/speak', 'POST')).toBeNull();
  });
});

describe('requiredScopeFor — the runs', () => {
  const RUN = '/api/v1/runs/11111111-2222-3333-4444-555555555555';
  it('reads under items:read, the create under items:write, a neighbour closed', () => {
    expect(requiredScopeFor('/api/v1/runs', 'GET')).toBe('items:read');
    expect(requiredScopeFor(RUN, 'GET')).toBe('items:read');
    expect(requiredScopeFor('/api/v1/runs', 'POST')).toBe('items:write');
    expect(requiredScopeFor('/api/v1/runsx', 'GET')).toBeNull();
  });
});

describe('requiredScopeFor — teams (PRDCT-2813, the chassis rules under the tool’s scope names)', () => {
  const TEAM = '/api/v1/teams/11111111-2222-3333-4444-555555555555';

  it('the list: GET under items:read, POST under items:write', () => {
    expect(requiredScopeFor('/api/v1/teams', 'GET')).toBe('items:read');
    expect(requiredScopeFor('/api/v1/teams', 'POST')).toBe('items:write');
  });

  it('the seat of one person: DELETE under items:write, every other method closed', () => {
    const seat = `${TEAM}/members/user-abc`;
    expect(requiredScopeFor(seat, 'DELETE')).toBe('items:write');
    expect(requiredScopeFor(seat, 'POST')).toBeNull();
    expect(requiredScopeFor(seat, 'PUT')).toBeNull();
    expect(requiredScopeFor(seat, 'PATCH')).toBeNull();
  });

  it('the roster: GET under items:read, PUT closed', () => {
    expect(requiredScopeFor(`${TEAM}/members`, 'GET')).toBe('items:read');
    expect(requiredScopeFor(`${TEAM}/members`, 'PUT')).toBeNull();
  });

  it('a team id that is not a uuid is not a listed shape', () => {
    expect(requiredScopeFor('/api/v1/teams/not-a-uuid', 'GET')).toBeNull();
  });
});

describe('requiredScopeFor — workspace creation (PRDCT-2444 / PRDCT-2443)', () => {
  it('stays UNLISTED for every method and every neighbouring spelling: sessions only', () => {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(requiredScopeFor('/api/v1/workspaces', method)).toBeNull();
      expect(requiredScopeFor('/api/v1/workspaces/', method)).toBeNull();
      expect(requiredScopeFor('/api/v1/workspaces/11111111-2222-3333-4444-555555555555', method)).toBeNull();
    }
    // The export keeps its own singular path and its own scope — the new
    // plural route must never ride it.
    expect(requiredScopeFor('/api/v1/workspace/export', 'GET')).toBe('data:export');
  });
});

describe('requiredScopeFor — members stay closed to machines (ADR 014, PRDCT-2816)', () => {
  const MEMBER = '/api/v1/members/11111111-2222-3333-4444-555555555555';

  it('the account deletion and the removal are UNLISTED for every method: sessions only', () => {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(MEMBER, method)).toBeNull();
      expect(requiredScopeFor(`${MEMBER}/remove`, method)).toBeNull();
    }
  });
});

describe('requiredScopeFor — the default workspace (PRDCT-2815)', () => {
  const PATH = '/api/v1/me/default-workspace';

  it('PUT is listed under items:write', () => {
    expect(requiredScopeFor(PATH, 'PUT')).toBe('items:write');
  });

  it('every other method on the path stays unlisted', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(PATH, method)).toBeNull();
    }
  });

  it('a longer path and any other path under /me stay unlisted for PUT', () => {
    expect(requiredScopeFor(`${PATH}/x`, 'PUT')).toBeNull();
    expect(requiredScopeFor('/api/v1/me/anything', 'PUT')).toBeNull();
  });
});

describe('requiredScopeFor — the chassis’s project routes, opened by the chassis rules', () => {
  const PROJECT = '/api/v1/projects/11111111-2222-3333-4444-555555555555';

  it('reads under items:read, writes under items:write, by exact shape', () => {
    expect(requiredScopeFor('/api/v1/projects', 'GET')).toBe('items:read');
    expect(requiredScopeFor('/api/v1/projects', 'POST')).toBe('items:write');
    expect(requiredScopeFor(PROJECT, 'GET')).toBe('items:read');
    expect(requiredScopeFor(PROJECT, 'PATCH')).toBe('items:write');
    expect(requiredScopeFor(`${PROJECT}/archive`, 'POST')).toBe('items:write');
    expect(requiredScopeFor(`${PROJECT}/members`, 'GET')).toBe('items:read');
    expect(requiredScopeFor(`${PROJECT}/members`, 'POST')).toBe('items:write');
    expect(requiredScopeFor(`${PROJECT}/members/usr_1`, 'DELETE')).toBe('items:write');
  });

  it('an unknown shape under /projects stays fail-closed: the tool has no route there', () => {
    expect(requiredScopeFor(`${PROJECT}/items`, 'GET')).toBeNull();
    expect(requiredScopeFor(PROJECT, 'DELETE')).toBeNull();
  });
});

describe('requiredScopeFor — the admin surfaces stay closed to machines (lane E1, verifier gap)', () => {
  // A one-line rule opening one of these hands an owner's read key the audit log, the key list or
  // a mint: none is listed, for any method. Pinned here because no test named them before.
  const ADMIN = [
    '/api/v1/audit',
    '/api/v1/api-keys',
    '/api/v1/api-keys/11111111-2222-3333-4444-555555555555',
    '/api/v1/demo/passes',
    '/api/v1/invitations',
    '/api/v1/members/11111111-2222-3333-4444-555555555555/reset-link',
    '/api/v1/members/11111111-2222-3333-4444-555555555555/change-email-link',
    '/api/v1/admin/break-glass/claim-ownership'
  ];
  it('every admin path is unlisted for every method', () => {
    for (const path of ADMIN) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(requiredScopeFor(path, method), `${method} ${path}`).toBeNull();
      }
    }
  });
});
