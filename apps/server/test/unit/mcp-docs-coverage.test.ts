import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { McpToolContext } from '@antasphere/chassis-server/mcp';
import { ITEM_NAME_MAX, ITEM_NOTE_MAX } from '@app/contract';
import { MCP_TOOL_PREFIX, registerTools } from '../../src/mcp/tools.js';

/**
 * PRDCT-2309: docs/agents/mcp-connector.md is what an MCP host's operator
 * reads to know which tools an instance serves. Its table must list every
 * tool `registerTools` registers, and no other: it keeps the MCP page honest
 * the way `docs-coverage.test.ts` keeps the CLI page honest. Registration is
 * run against a recording stand-in for the server (a tool is one
 * `server.registerTool(name, …)` call and touches nothing else at that point),
 * so the check needs no database and no transport, and a tool added or renamed
 * in code fails here by name.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '../../../../docs');
const DOC_PATH = resolve(DOCS, 'agents/mcp-connector.md');
/** The pages that announce the tool count in prose ("6 `<prefix>` tools"). */
const COUNT_PAGES = ['index.md', 'getting-started/connect-an-agent.md'].map((p) => resolve(DOCS, p));

/**
 * Fourteen tools of the set are not registered by `registerTools`: the
 * chassis registers `<toolPrefix>whoami` itself (`buildMcpServer`,
 * PRDCT-2531), right before the tool's own set, and beside it the eleven
 * PROJECT tools (the nine on a project and its people, plus the two on a
 * team's place on a project) and the two TEAM reads (a project and a team are
 * chassis concepts, so their tools are the chassis's), all built from the
 * prefix at run time. The docs carry them and the count includes them, so
 * they are added here by name. (Their literals are pinned in
 * `test/integration/identity-pins.test.ts`.)
 */
const CHASSIS_REGISTERED = [
  'whoami',
  'list_projects',
  'get_project',
  'list_project_members',
  'create_project',
  'update_project',
  'archive_project',
  'add_project_member',
  'set_project_member_role',
  'remove_project_member',
  'set_project_team_role',
  'remove_project_team',
  'list_teams',
  'list_team_members'
].map((name) => `${MCP_TOOL_PREFIX}${name}`);

function registeredTools(): string[] {
  const names: string[] = [...CHASSIS_REGISTERED];
  const recorder = { registerTool: (name: string) => names.push(name) } as unknown as McpServer;
  registerTools(recorder, {} as McpToolContext);
  return names.sort();
}

/** The table rows that name a tool under the tool's prefix (the chassis's `get_me` and `list_files` carry none). */
function documentedTools(doc: string): string[] {
  return [...doc.matchAll(/^\| `([a-z_]+)`/gm)]
    .map((m) => m[1]!)
    .filter((name) => name.startsWith(MCP_TOOL_PREFIX))
    .sort();
}

describe('docs/agents/mcp-connector.md lists the registered tool set (PRDCT-2309)', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const code = registeredTools();
  const documented = documentedTools(doc);

  it('reads a tool set from the registration at all, every name under the one prefix', () => {
    expect(code.length).toBeGreaterThan(0);
    for (const name of code) expect(name.startsWith(MCP_TOOL_PREFIX), name).toBe(true);
  });

  it('documents every registered tool', () => {
    const missing = code.filter((t) => !documented.includes(t));
    expect(missing, `tools registered but absent from mcp-connector.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents no tool the server does not register', () => {
    const stale = documented.filter((t) => !code.includes(t));
    expect(stale, `tools in mcp-connector.md the server does not register: ${stale.join(', ')}`).toEqual([]);
  });

  it("keeps the chassis's two tools in the table", () => {
    for (const name of ['get_me', 'list_files']) expect(doc).toMatch(new RegExp(`^\\| \`${name}\``, 'm'));
  });

  it('the count the index and the on-ramp announce is the registered count', () => {
    for (const page of COUNT_PAGES) {
      const said = readFileSync(page, 'utf8').match(new RegExp(`(\\d+) \`${MCP_TOOL_PREFIX}\`\\s+tools`));
      expect(said, `${page} names the tool count`).not.toBeNull();
      expect(Number(said![1]), `${page} says ${said![1]} tools`).toBe(code.length);
    }
  });
});

/**
 * Verifier round 1, F1: the `create_item` row quotes the two length caps as
 * facts, and so does the description the tool hands an MCP host. Both are held
 * to the contract's constants: a cap changed in
 * `packages/contract/src/schemas/items.ts` fails here until the row follows.
 * (The numbers themselves are pinned in the contract's own test.)
 */
describe('the item caps the MCP surface states are the ones the contract enforces', () => {
  it('docs/agents/mcp-connector.md quotes both caps on the create row', () => {
    const row = readFileSync(DOC_PATH, 'utf8')
      .split('\n')
      .find((line) => line.startsWith(`| \`${MCP_TOOL_PREFIX}create_item\``));
    expect(row, 'the create_item row').toBeDefined();
    expect(row).toContain(`a \`name\` (1 to ${ITEM_NAME_MAX} characters)`);
    expect(row).toContain(`an optional \`note\` (up to ${ITEM_NOTE_MAX})`);
  });

  it('the create_item description quotes both caps', () => {
    const descriptions = new Map<string, string>();
    const recorder = {
      registerTool: (name: string, config: { description?: string }) =>
        descriptions.set(name, config.description ?? '')
    } as unknown as McpServer;
    registerTools(recorder, {} as McpToolContext);
    const said = descriptions.get(`${MCP_TOOL_PREFIX}create_item`);
    expect(said).toContain(`1 to ${ITEM_NAME_MAX} characters`);
    expect(said).toContain(`up to ${ITEM_NOTE_MAX} characters`);
  });
});
