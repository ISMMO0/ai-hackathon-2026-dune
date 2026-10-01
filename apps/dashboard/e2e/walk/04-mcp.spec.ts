import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ENV, IDENTITY, MIA, OWNER, REPO_ROOT, failures, kept, step, terminalCard } from './lib';

/**
 * Chapter 4, the MCP endpoint: the handshake, the tool list checked against
 * the table of the MCP connector page, then every tool called once with the
 * key the owner chapter minted (read and write), on the data it left. The
 * endpoint is stateless streamable HTTP answering JSON, so each call is one
 * self-contained POST. The project tools act on a project of the chapter's
 * own (a person and the owner chapter's team put on it, their roles changed,
 * taken off, the project archived and brought back); the item tools make one
 * item in the owner chapter's project, move it out and back, and delete it.
 * One refusal is asked on purpose: an item that does not exist. Each card
 * shows the calls (name and arguments) and the first text of each answer.
 */

const CH = 'mcp';
const T = (name: string) => `${IDENTITY.toolPrefix}${name}`;
const UNKNOWN = '11111111-1111-4111-8111-111111111111';

interface Answer {
  isError: boolean;
  text: string;
  json: unknown;
}
interface Card {
  cmd: string;
  out: string;
}

let context: BrowserContext;
let page: Page;
let key = '';
let projectId = '';
let teamId = '';
let miaUserId = '';
let rpcId = 0;
const called: { tool: string; isError: boolean }[] = [];

async function rpc(
  method: string,
  params?: unknown,
  notification = false
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ENV.base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(
      notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params }
    )
  });
  const text = await res.text();
  if (!text.trim()) return { status: res.status, body: null };
  let payload = text;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    payload = data[data.length - 1] ?? '';
  }
  return { status: res.status, body: JSON.parse(payload) };
}

/** One tools/call, drawn on the card; an MCP error answer or a JSON-RPC error is an isError answer. */
async function call(card: Card[], name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const { status, body } = await rpc('tools/call', { name, arguments: args });
  const b = body as {
    result?: { isError?: boolean; content?: { type: string; text?: string }[] };
    error?: { message: string };
  } | null;
  const isError = !b?.result || b.result.isError === true;
  const text =
    b?.result?.content?.find((x) => x.type === 'text')?.text ?? b?.error?.message ?? `HTTP ${status}`;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a sentence, not JSON */
  }
  called.push({ tool: name, isError });
  const shown = text.length > 600 ? `${text.slice(0, 600)} …` : text;
  card.push({
    cmd: `tools/call ${name} ${JSON.stringify(args)}`,
    out: (isError ? '[isError] ' : '') + shown
  });
  return { isError, text, json };
}

const good = (a: Answer, name: string) => {
  expect(a.isError, `${name}: ${a.text.slice(0, 300)}`).toBe(false);
  return a;
};

async function card(title: string, fn: (c: Card[]) => Promise<string | void>) {
  await step(CH, page, title, async () => {
    const c: Card[] = [];
    try {
      return await fn(c);
    } finally {
      await terminalCard(page, title, c);
    }
  });
}

/** The tool names of the connector page's table, in its order. */
function documentedTools(): string[] {
  const doc = readFileSync(join(REPO_ROOT, 'docs/agents/mcp-connector.md'), 'utf8');
  return [...doc.matchAll(/^\| `([a-z_]+)`\s+\|/gm)].map((m) => m[1]);
}

test.describe.configure({ mode: 'serial' });

test.describe('The MCP endpoint answers every tool once', () => {
  test.beforeAll(async ({ browser }) => {
    const k = kept('cli');
    key = k.key;
    projectId = k.projectId;
    teamId = k.teamId;
    miaUserId = k.miaUserId;
    context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    page = await context.newPage();
  });
  test.afterAll(async () => {
    writeFileSync(join(ENV.out, 'mcp-calls.json'), JSON.stringify(called, null, 2) + '\n');
    await context?.close();
  });

  let newProjectId = '';
  let itemId = '';

  test('the handshake and the tool list', async () => {
    await card('MCP: initialize and the 23 tools of the connector page', async (c) => {
      const init = await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'walk', version: '0' }
      });
      const server = (init.body as { result?: { serverInfo?: { name: string; version: string } } }).result
        ?.serverInfo;
      expect(server?.name, JSON.stringify(init.body)).toBeTruthy();
      c.push({ cmd: 'initialize', out: JSON.stringify(server) });
      const note = await rpc('notifications/initialized', undefined, true);
      c.push({ cmd: 'notifications/initialized', out: `HTTP ${note.status}` });
      const list = await rpc('tools/list', {});
      const tools = ((list.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map(
        (t) => t.name
      );
      const documented = documentedTools();
      c.push({ cmd: 'tools/list', out: `${tools.length} tools\n${tools.join('\n')}` });
      expect(documented).toHaveLength(23);
      for (const d of documented)
        if (d !== 'get_me' && d !== 'list_files') expect(d.startsWith(IDENTITY.toolPrefix)).toBe(true);
      expect(tools).toHaveLength(23);
      expect([...tools].sort()).toEqual([...documented].sort());
      return `server ${server?.name} ${server?.version}; ${tools.length} tools`;
    });
  });

  test('identity, files, teams, projects', async () => {
    await card('MCP: who is connected, the files, the teams', async (c) => {
      const me = good(await call(c, 'get_me'), 'get_me');
      expect(me.text).toContain(OWNER.email);
      expect(good(await call(c, T('whoami')), 'whoami').text).toContain(OWNER.email);
      good(await call(c, 'list_files', { limit: 5 }), 'list_files');
      expect(good(await call(c, T('list_teams')), 'list_teams').text).toContain(teamId);
      expect(good(await call(c, T('list_team_members'), { teamId }), 'list_team_members').text).toContain(
        MIA.email
      );
    });

    await card('MCP: the projects read, one created, renamed, archived and back', async (c) => {
      expect(good(await call(c, T('list_projects')), 'list_projects').text).toContain(projectId);
      expect(good(await call(c, T('get_project'), { projectId }), 'get_project').text).toContain('myRole');
      good(await call(c, T('list_project_members'), { projectId }), 'list_project_members');
      const made = good(await call(c, T('create_project'), { name: 'MCP project' }), 'create_project');
      newProjectId = ((made.json as { project?: { id: string }; id?: string }).project?.id ??
        (made.json as { id?: string }).id) as string;
      expect(newProjectId, made.text).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        good(
          await call(c, T('update_project'), { projectId: newProjectId, name: 'MCP project renamed' }),
          'update_project'
        ).text
      ).toContain('MCP project renamed');
      const archived = good(
        await call(c, T('archive_project'), { projectId: newProjectId }),
        'archive_project'
      );
      expect(archived.text).toMatch(/"archivedAt":\s*"/);
      const back = good(
        await call(c, T('archive_project'), { projectId: newProjectId, archived: false }),
        'archive_project (back)'
      );
      expect(back.text).toMatch(/"archivedAt":\s*null/);
    });

    await card('MCP: a person and a team on the project, their roles, taken off', async (c) => {
      good(
        await call(c, T('add_project_member'), { projectId: newProjectId, email: MIA.email, role: 'viewer' }),
        'add_project_member (person)'
      );
      good(
        await call(c, T('set_project_member_role'), {
          projectId: newProjectId,
          userId: miaUserId,
          role: 'editor'
        }),
        'set_project_member_role'
      );
      good(
        await call(c, T('remove_project_member'), { projectId: newProjectId, userId: miaUserId }),
        'remove_project_member'
      );
      good(
        await call(c, T('add_project_member'), { projectId: newProjectId, teamId, role: 'viewer' }),
        'add_project_member (team)'
      );
      good(
        await call(c, T('set_project_team_role'), { projectId: newProjectId, teamId, role: 'editor' }),
        'set_project_team_role'
      );
      good(
        await call(c, T('remove_project_team'), { projectId: newProjectId, teamId }),
        'remove_project_team'
      );
      const left = good(
        await call(c, T('list_project_members'), { projectId: newProjectId }),
        'list_project_members'
      );
      expect(left.text).not.toContain(miaUserId);
      expect(left.text).not.toContain(teamId);
    });
  });

  test('items', async () => {
    await card('MCP: an item made in the project, listed, read, edited', async (c) => {
      const made = good(
        await call(c, T('create_item'), { name: 'MCP item', note: 'made over MCP', projectIds: [projectId] }),
        'create_item'
      );
      itemId = ((made.json as { item?: { id: string }; id?: string }).item?.id ??
        (made.json as { id?: string }).id) as string;
      expect(itemId, made.text).toMatch(/^[0-9a-f-]{36}$/);
      expect(good(await call(c, T('list_items'), { limit: 10 }), 'list_items').text).toContain(itemId);
      expect(good(await call(c, T('list_items'), { projectId }), 'list_items (project)').text).toContain(
        itemId
      );
      expect(good(await call(c, T('get_item'), { itemId }), 'get_item').text).toContain(projectId);
      expect(
        good(await call(c, T('update_item'), { itemId, note: 'edited over MCP' }), 'update_item').text
      ).toContain('edited over MCP');
    });

    await card('MCP: the item out of the project and back, deleted, and a refusal', async (c) => {
      const out = good(
        await call(c, T('unlink_item_from_project'), { itemId, projectId }),
        'unlink_item_from_project'
      );
      expect(out.text).not.toContain(projectId);
      expect(
        good(await call(c, T('link_item_to_project'), { itemId, projectId }), 'link_item_to_project').text
      ).toContain(projectId);
      expect(good(await call(c, T('delete_item'), { itemId }), 'delete_item').text).toContain('MCP item');
      const missing = await call(c, T('get_item'), { itemId: UNKNOWN });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('not_found');
      const distinct = new Set(called.map((x) => x.tool));
      expect(distinct.size, [...distinct].join(', ')).toBe(23);
      return `${distinct.size} tools called, ${called.length} calls`;
    });
  });

  test('the MCP chapter recorded no failed step', () => {
    expect(failures).toEqual([]);
  });
});
