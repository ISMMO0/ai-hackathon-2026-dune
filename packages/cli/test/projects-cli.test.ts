import { describe, expect, it } from 'vitest';
import type { Item } from '@app/contract';
import { run } from '../src/index.js';
import { routedHarness, type Route } from './harness.js';

/**
 * The ITEM's side of the projects on the command line, through the in-process
 * runner: `projects link|unlink` hung off the chassis's own `projects` group,
 * `--project` on `items list` and `items create`, the `projects:` line of
 * `items show`. Every assertion is on the requests the CLI made (`h.calls`:
 * method, path, body) or on what it printed; the `--json` sinks are asserted
 * byte-exact, and each refusal by its sentence. The chassis's own project
 * commands are proven in the chassis package.
 */

const URL_ = 'http://x';
const KEY = 'ytk_k_s';
const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT = 'aaaaaaaa-2222-4222-8222-222222222222';
const PROJECT_2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const argv = (...rest: string[]) => [...rest, '--url', URL_, '--api-key', KEY];

const ITEM: Item = {
  id: ITEM_ID,
  workspaceId: '44444444-4444-4444-4444-444444444444',
  name: 'The launch plan',
  note: '',
  createdBy: '22222222-2222-2222-2222-222222222222',
  projects: [],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z'
};

/** An item row carrying the projects it is in. */
const itemIn = (projects: Array<{ id: string; name: string }>): Item => ({ ...ITEM, projects });

const ATLAS = { id: PROJECT, name: 'Atlas' };
const BOREALIS = { id: PROJECT_2, name: 'Borealis' };

/**
 * A name the terminal must never see raw: a C1 CSI introducer and a DEL, the
 * bytes `JSON.stringify` leaves as they are (it escapes C0 only). Every
 * `--json` pin carries it, so a sink routed through the sanitizer goes red
 * instead of staying invisible (PRDCT-1353: `--json` is byte-exact).
 */
const RAW_NAME = 'Atlas\u009b2K\u007fHIDDEN';
const RAW_ATLAS = { ...ATLAS, name: RAW_NAME };

/** An error body in the server's shape. */
const refusal = (
  status: number,
  code: string,
  message = 'terse wire message'
): { status: number; body: unknown } => ({
  status,
  body: { error: { code, message } }
});

/** `${method} ${path}` for every recorded call, query string dropped. */
const wire = (calls: Array<{ method: string; path: string }>): string[] =>
  calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);

const LINK_PATH = new RegExp(`^/api/v1/items/${ITEM_ID}/projects/[^/]+$`);

// ── projects link / unlink ───────────────────────────────────────────────────

describe('projects link', () => {
  const route = (answer: { status: number; body: unknown }): Route => ({
    method: 'PUT',
    path: LINK_PATH,
    reply: () => answer
  });

  it('PUTs the item onto the project and names the projects it is in now', async () => {
    const h = routedHarness([route({ status: 200, body: itemIn([ATLAS]) })]);
    const code = await run(argv('projects', 'link', PROJECT, ITEM_ID), h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(wire(h.calls)).toEqual([`PUT /api/v1/items/${ITEM_ID}/projects/${PROJECT}`]);
    expect(h.out()).toBe('"The launch plan" is in 1 project: Atlas\n');
  });

  it('names every project, in the order the server answers them', async () => {
    const h = routedHarness([route({ status: 200, body: itemIn([ATLAS, BOREALIS]) })]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID), h.io)).toBe(0);
    expect(h.out()).toBe('"The launch plan" is in 2 projects: Atlas, Borealis\n');
  });

  it('--json is the item payload, byte-exact', async () => {
    const body = itemIn([RAW_ATLAS]);
    const h = routedHarness([route({ status: 200, body })]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('a human line loses the control sequences of a project name', async () => {
    const h = routedHarness([route({ status: 200, body: itemIn([RAW_ATLAS]) })]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID), h.io)).toBe(0);
    expect(h.out()).not.toContain('\u009b');
    expect(h.out()).not.toContain('\u007f');
  });

  it.each([
    ['project_not_found', 404, 'No such project, or it is not yours to read.'],
    ['not_found', 404, 'No such item, or it is not yours to read.'],
    ['project_archived', 409, 'This project is archived and read-only.'],
    ['guest_forbidden', 403, 'You are a guest of this workspace, and guests do not take part in projects.']
  ])('turns %s into a sentence', async (code, status, sentence) => {
    const h = routedHarness([route(refusal(status, code))]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID), h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain(sentence);
    expect(h.err()).not.toContain('terse wire message');
  });

  it('names the role the wire names on insufficient_project_role, editor when it names none', async () => {
    const named = routedHarness([
      route(refusal(403, 'insufficient_project_role', 'This needs the manager role on the project'))
    ]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID), named.io)).toBe(1);
    expect(named.err()).toBe('Error: You need the manager role on this project to put an item in it.\n');
    const unnamed = routedHarness([route(refusal(403, 'insufficient_project_role'))]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID), unnamed.io)).toBe(1);
    expect(unnamed.err()).toBe('Error: You need the editor role on this project to put an item in it.\n');
  });

  it('a 404 under --workspace says which workspace was asked, like every other command', async () => {
    const h = routedHarness([route(refusal(404, 'project_not_found'))]);
    expect(await run(argv('projects', 'link', PROJECT, ITEM_ID, '--workspace', ITEM.workspaceId), h.io)).toBe(
      1
    );
    expect(h.err()).toContain('No such project, or it is not yours to read.');
    expect(h.err()).toContain(ITEM.workspaceId);
  });
});

describe('projects unlink', () => {
  const route = (answer: { status: number; body: unknown }): Route => ({
    method: 'DELETE',
    path: LINK_PATH,
    reply: () => answer
  });

  it('DELETEs the link and says what is left', async () => {
    const h = routedHarness([route({ status: 200, body: itemIn([BOREALIS]) })]);
    expect(await run(argv('projects', 'unlink', PROJECT, ITEM_ID), h.io)).toBe(0);
    expect(wire(h.calls)).toEqual([`DELETE /api/v1/items/${ITEM_ID}/projects/${PROJECT}`]);
    expect(h.out()).toBe('"The launch plan" is in 1 project: Borealis\n');
  });

  it('says the item is in no project when the last link goes', async () => {
    const h = routedHarness([route({ status: 200, body: itemIn([]) })]);
    expect(await run(argv('projects', 'unlink', PROJECT, ITEM_ID), h.io)).toBe(0);
    expect(h.out()).toBe('"The launch plan" is in no project.\n');
  });

  it('--json is the item payload, byte-exact', async () => {
    const body = itemIn([RAW_ATLAS]);
    const h = routedHarness([route({ status: 200, body })]);
    expect(await run(argv('projects', 'unlink', PROJECT, ITEM_ID, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('reads not_linked as "nothing to unlink"', async () => {
    const h = routedHarness([route(refusal(404, 'not_linked'))]);
    expect(await run(argv('projects', 'unlink', PROJECT, ITEM_ID), h.io)).toBe(1);
    expect(h.err()).toBe('Error: That item is not in this project, so there is nothing to unlink.\n');
  });

  it('says "take an item out" on insufficient_project_role, and the archived sentence on project_archived', async () => {
    const below = routedHarness([route(refusal(403, 'insufficient_project_role'))]);
    expect(await run(argv('projects', 'unlink', PROJECT, ITEM_ID), below.io)).toBe(1);
    expect(below.err()).toBe('Error: You need the editor role on this project to take an item out of it.\n');
    const archived = routedHarness([route(refusal(409, 'project_archived'))]);
    expect(await run(argv('projects', 'unlink', PROJECT, ITEM_ID), archived.io)).toBe(1);
    expect(archived.err()).toContain('This project is archived and read-only.');
  });
});

// ── --project on items list ──────────────────────────────────────────────────

describe('items list --project', () => {
  const list = (answer: { status: number; body: unknown }): Route => ({
    method: 'GET',
    path: /^\/api\/v1\/items(\?.*)?$/,
    reply: () => answer
  });
  const page = (items: Item[]) => ({ status: 200, body: { items, nextCursor: null } });

  it('sends project=<id> beside the page params, and nothing without the flag', async () => {
    const withFlag = routedHarness([list(page([itemIn([ATLAS])]))]);
    expect(await run(argv('items', 'list', '--project', PROJECT, '--limit', '5'), withFlag.io)).toBe(0);
    expect(withFlag.calls.map((c) => c.path)).toEqual([`/api/v1/items?limit=5&project=${PROJECT}`]);
    const without = routedHarness([list(page([ITEM]))]);
    expect(await run(argv('items', 'list'), without.io)).toBe(0);
    expect(without.calls.map((c) => c.path)).toEqual(['/api/v1/items']);
  });

  it('names the projects in a column, and only when a row has some', async () => {
    const plain = routedHarness([list(page([ITEM]))]);
    expect(await run(argv('items', 'list'), plain.io)).toBe(0);
    expect(plain.out()).toBe(`${ITEM.id}  ${ITEM.createdAt}  The launch plan\n`);
    const mixed = routedHarness([
      list(page([itemIn([ATLAS, BOREALIS]), { ...ITEM, id: '33333333-3333-3333-3333-333333333333' }]))
    ]);
    expect(await run(argv('items', 'list'), mixed.io)).toBe(0);
    expect(mixed.out()).toBe(
      `${ITEM.id}  ${ITEM.createdAt}  Atlas, Borealis  The launch plan\n` +
        `33333333-3333-3333-3333-333333333333  ${ITEM.createdAt}  -                The launch plan\n`
    );
  });

  it('threads the project across every page of --all', async () => {
    let n = 0;
    const h = routedHarness([
      {
        method: 'GET',
        path: /^\/api\/v1\/items(\?.*)?$/,
        reply: () => ({ body: { items: [itemIn([ATLAS])], nextCursor: n++ === 0 ? 'c2' : null } })
      }
    ]);
    expect(await run(argv('items', 'list', '--project', PROJECT, '--all'), h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      `/api/v1/items?project=${PROJECT}`,
      `/api/v1/items?cursor=c2&project=${PROJECT}`
    ]);
    expect(h.out()).not.toContain('More available');
  });

  it('reads a refusal on a later page of --all as the project refusal too', async () => {
    let n = 0;
    const h = routedHarness([
      {
        method: 'GET',
        path: /^\/api\/v1\/items(\?.*)?$/,
        reply: () =>
          n++ === 0
            ? { body: { items: [itemIn([ATLAS])], nextCursor: 'c2' } }
            : refusal(404, 'project_not_found')
      }
    ]);
    expect(await run(argv('items', 'list', '--project', PROJECT, '--all'), h.io)).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.err()).toContain('No such project, or it is not yours to read.');
  });

  it('reads a project it cannot see as the project refusal, not an empty page', async () => {
    const h = routedHarness([list(refusal(404, 'project_not_found'))]);
    expect(await run(argv('items', 'list', '--project', PROJECT), h.io)).toBe(1);
    expect(h.err()).toContain('No such project, or it is not yours to read.');
  });

  it("without --project the server's own refusal stands: the project sentence is for the flag alone", async () => {
    const h = routedHarness([list(refusal(404, 'project_not_found', 'the wire message'))]);
    expect(await run(argv('items', 'list'), h.io)).toBe(1);
    expect(h.err()).toContain('the wire message');
  });
});

// ── --project on items create ────────────────────────────────────────────────

describe('items create --project', () => {
  const create = (answer: { status: number; body: unknown }): Route => ({
    method: 'POST',
    path: /^\/api\/v1\/items$/,
    reply: () => answer
  });

  it('carries projectIds in the create itself, repeatable and in order, and prints the projects', async () => {
    const h = routedHarness([create({ status: 201, body: { item: itemIn([ATLAS, BOREALIS]) } })]);
    expect(
      await run(
        argv('items', 'create', '--name', 'The launch plan', '--project', PROJECT, '--project', PROJECT_2),
        h.io
      )
    ).toBe(0);
    expect(h.calls[0]!.body).toEqual({ name: 'The launch plan', projectIds: [PROJECT, PROJECT_2] });
    expect(h.out()).toBe(`Created The launch plan\n  id: ${ITEM_ID}\n  projects: Atlas, Borealis\n`);
  });

  it('sends no projectIds at all without the flag', async () => {
    const h = routedHarness([create({ status: 201, body: { item: ITEM } })]);
    expect(await run(argv('items', 'create', '--name', 'The launch plan'), h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ name: 'The launch plan' });
    expect(h.out()).toBe(`Created The launch plan\n  id: ${ITEM_ID}\n`);
  });

  it('a project the create refuses is the create sentence: read, editor, archived, all in one', async () => {
    const h = routedHarness([create(refusal(404, 'project_not_found'))]);
    expect(await run(argv('items', 'create', '--name', 'X', '--project', PROJECT), h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: No such project, or it is not yours to read, or you are not an editor of it, or it is archived: a new item goes into a project you may link into.\n'
    );
  });
});

// ── items show ───────────────────────────────────────────────────────────────

describe('items show', () => {
  const show = (item: Item): Route => ({
    method: 'GET',
    path: new RegExp(`^/api/v1/items/${ITEM_ID}$`),
    reply: () => ({ status: 200, body: item })
  });

  it('prints a projects line when the item sits in some, and none otherwise', async () => {
    const some = routedHarness([show(itemIn([ATLAS]))]);
    expect(await run(argv('items', 'show', ITEM_ID), some.io)).toBe(0);
    expect(some.out()).toContain('  projects: Atlas\n');
    const none = routedHarness([show(ITEM)]);
    expect(await run(argv('items', 'show', ITEM_ID), none.io)).toBe(0);
    expect(none.out()).not.toContain('projects:');
  });

  it('reads an answer without the field as "no projects": an older instance never crashes the CLI', async () => {
    const { projects: _projects, ...older } = ITEM;
    const h = routedHarness([show(older as Item)]);
    expect(await run(argv('items', 'show', ITEM_ID), h.io)).toBe(0);
    expect(h.out()).not.toContain('projects:');
  });
});
