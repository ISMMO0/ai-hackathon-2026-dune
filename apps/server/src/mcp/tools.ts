import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  IDENTITY,
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  ITEM_PROJECT_IDS_MAX,
  VOICE_AUDIO_MAX_BASE64,
  VOICE_LANGUAGES,
  VOICE_TEXT_MAX,
  RUN_INSTRUCTION_MAX,
  itemProjectIdsSchema
} from '@app/contract';
import {
  callApi,
  createScopeCheck,
  deny,
  forWorkspace,
  composeErrorHints,
  jsonText,
  mcpInputs,
  pageQuery,
  wrapToolErrors,
  type ErrorHints,
  type McpToolContext,
  type ToolTextResult
} from '@antasphere/chassis-server/mcp';

/**
 * The tool's MCP tool set: what the `mcp.registerTools` slot registers, AFTER
 * the chassis's own (`get_me`, `list_files`, `<prefix>whoami`, the identity
 * tool under this tool's prefix: it reads `/api/v1/me` and nothing of a
 * domain, so the chassis owns it; then the eleven project tools, since a
 * project is a chassis concept: `list_projects` to `remove_project_team`, and
 * the two team reads, `list_teams` and `list_team_members`, all under the same
 * prefix). Every tool is a thin shim
 * over the instance's own /api/v1, called IN-PROCESS with the caller's bearer
 * forwarded verbatim (`callApi`). MCP is one more API client: there is no
 * privileged path and no MCP-only behaviour. That is what makes every rule of
 * the item routes hold here without being written twice: the contract's
 * validation, the fail-closed scope allowlist, the workspace checked against
 * the caller's live memberships, the guest rule (a guest lists none, reads the
 * 404 of a missing id, is refused the writes), the audit rows. A tool never
 * imports a service: new behaviour lands in the API first.
 *
 * Conventions (the chassis patterns, `@antasphere/chassis-server/mcp`):
 *  - a READ tool: `readOnlyHint: true` + a pre-check on the read scope;
 *  - a WRITE tool: a confirm-first description + a pre-check on the write
 *    scope, + `destructiveHint: true` for a delete;
 *  - the pre-check is UX only (a clean, actionable sentence for the model);
 *    the API's allowlist is the enforcement point;
 *  - every tool takes the optional `workspace` argument and threads it through
 *    `forWorkspace`, so the selection rides the ONE header the platform
 *    authorizes: an argument can never reach a workspace the user is not in;
 *  - one JSON text block out, the API's wire shape untouched; an API failure
 *    becomes `isError` + the code + a `Next:` hint (`wrapToolErrors`).
 */

/**
 * The prefix of every tool name of this tool. It is part of the tool's
 * identity (`IDENTITY.mcp.toolPrefix`, `@app/contract`), the same value the
 * chassis builds `<prefix>whoami` from: a rename changes the identity and
 * nothing in this module.
 */
export const MCP_TOOL_PREFIX = IDENTITY.mcp.toolPrefix;

/** The two scope names the tools pre-check (and the chassis's tools with them), from the identity. */
export const ITEM_MCP_SCOPES = { read: IDENTITY.scopes.read, write: IDENTITY.scopes.write } as const;

/**
 * The hints of the item domain's API codes. The chassis's ONE composition
 * (`composeErrorHints`) lays them over its own table: the domain hints, then
 * the project codes every tool shares (`project_archived` and
 * `insufficient_project_role` among them), then these, so only the codes the
 * item side adds, or reads differently, are here. The item tools and the
 * chassis's tools read the same table.
 */
export const ITEM_ERROR_HINTS: ErrorHints = {
  not_found:
    'No such item in this organization: an item of another organization answers the same. Check ' +
    `the id with ${MCP_TOOL_PREFIX}list_items, and the \`workspace\` argument with ${MCP_TOOL_PREFIX}whoami.`,
  project_not_found:
    'No such project, or this credential cannot read it, or the create named a project it may not ' +
    `link into (the editor role or more, not archived). List yours with ${MCP_TOOL_PREFIX}list_projects.`,
  not_linked: 'This item is not in that project, so there is nothing to unlink.',
  integration_not_configured:
    'The instance has no key for this service: the operator sets it in the .env file (the message ' +
    'names it) and restarts the server. Tell the user; retrying will not help.',
  integration_failed:
    'The provider refused or did not answer (its status is in the details). Retry once later, then tell the user.'
};

const checkScope = createScopeCheck(ITEM_MCP_SCOPES);
const hints = composeErrorHints(ITEM_ERROR_HINTS, MCP_TOOL_PREFIX);

const jsonBody = (method: 'POST' | 'PATCH', body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

export function registerTools(server: McpServer, ctx: McpToolContext): void {
  const run = (
    scope: (typeof ITEM_MCP_SCOPES)['read' | 'write'],
    workspace: string | undefined,
    fn: (c: McpToolContext) => Promise<ToolTextResult>
  ): Promise<ToolTextResult> | ToolTextResult => {
    const denied = checkScope(ctx.principal, scope);
    if (denied) return denied;
    return wrapToolErrors(() => fn(forWorkspace(ctx, workspace)), hints);
  };
  const read = (workspace: string | undefined, fn: (c: McpToolContext) => Promise<ToolTextResult>) =>
    run(ITEM_MCP_SCOPES.read, workspace, fn);
  const write = (workspace: string | undefined, fn: (c: McpToolContext) => Promise<ToolTextResult>) =>
    run(ITEM_MCP_SCOPES.write, workspace, fn);

  const tool = (name: string) => `${MCP_TOOL_PREFIX}${name}`;
  const itemPath = (id: string) => `/api/v1/items/${encodeURIComponent(id)}`;

  // The inputs every tool of the instance shares are the chassis's ONE
  // definition, so `workspace`, `cursor` and `limit` read the same in the
  // chassis tools and in these.
  const { workspaceInput, cursorInput, limitInput } = mcpInputs(IDENTITY.mcp);
  const itemIdInput = z.uuid().describe('Item id.');
  // The bounds are the contract's constants; the API validates again (trim, control characters).
  const nameInput = z.string().min(1).max(ITEM_NAME_MAX);
  const noteInput = z.string().max(ITEM_NOTE_MAX);
  // A project is named by its opaque id, never by its name (the chassis's
  // project tools): a project the caller cannot read answers not found, so
  // being refused is not proof that it exists.
  const projectIdInput = z
    .uuid()
    .describe('The project id, from the project list or the create answer (never the project name).');
  const projectFilterInput = z
    .uuid()
    .optional()
    .describe(
      'Only the items in this project (the project id, never its name). A project you cannot read ' +
        'answers not found.'
    );
  const projectIdsInput = itemProjectIdsSchema
    .optional()
    .describe(
      `Project ids to put the new item in, in the same transaction (at most ${ITEM_PROJECT_IDS_MAX}). ` +
        'You must be an editor or manager of each and none may be archived, else the whole create ' +
        'is refused and nothing is created.'
    );
  const linkPath = (itemId: string, projectId: string) =>
    `${itemPath(itemId)}/projects/${encodeURIComponent(projectId)}`;

  // Identity: `<prefix>whoami` is registered by the chassis (right before this
  // set), since it reads `/api/v1/me` and nothing of the items.

  // ── Items: reads ───────────────────────────────────────────────────────────

  server.registerTool(
    tool('list_items'),
    {
      description:
        'List the items of the organization, newest first; projectId keeps the items in one project ' +
        '(a project you cannot read answers not found). Returns { items: [{ id, workspaceId, name, ' +
        'note, createdBy, projects, createdAt, updatedAt }], nextCursor }, each item carrying ' +
        'projects: [{ id, name }] (only the projects you can read); when nextCursor is non-null, call ' +
        'again with cursor set to it for the next page.',
      inputSchema: {
        workspace: workspaceInput,
        projectId: projectFilterInput,
        cursor: cursorInput,
        limit: limitInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, projectId, cursor, limit }) =>
      read(workspace, async (c) =>
        jsonText(await callApi(c, pageQuery('/api/v1/items', { cursor, limit }, { project: projectId })))
      )
  );

  server.registerTool(
    tool('get_item'),
    {
      description:
        'One item by id: name, note, createdBy (null once its author was erased), projects ' +
        '([{ id, name }], only the ones you can read), timestamps. Answers not_found for an id ' +
        'that is not in this organization.',
      inputSchema: { workspace: workspaceInput, itemId: itemIdInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, itemId }) =>
      read(workspace, async (c) => jsonText(await callApi(c, itemPath(itemId))))
  );

  // ── Items: writes ──────────────────────────────────────────────────────────

  server.registerTool(
    tool('create_item'),
    {
      description:
        `Create an item in the organization: a name (one line, 1 to ${ITEM_NAME_MAX} characters) and an ` +
        `optional free-text note (up to ${ITEM_NOTE_MAX} characters). projectIds puts the new item in those ` +
        'projects in the same transaction (you must be an editor or manager of each and none may be ' +
        'archived, else the whole create is refused and nothing is created). Returns { item }. Always ' +
        'confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        name: nameInput.describe('The name of the item (one line).'),
        note: noteInput.optional().describe('A free-text note. Omitted = empty.'),
        projectIds: projectIdsInput
      }
    },
    async ({ workspace, name, note, projectIds }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            '/api/v1/items',
            jsonBody('POST', {
              name,
              ...(note !== undefined ? { note } : {}),
              ...(projectIds?.length ? { projectIds } : {})
            })
          )
        )
      )
  );

  server.registerTool(
    tool('update_item'),
    {
      description:
        'Change the name and/or the note of an item; a field left out keeps its value, and ' +
        'note: "" clears the note. Returns the updated item. Always confirm with the user before ' +
        'calling.',
      inputSchema: {
        workspace: workspaceInput,
        itemId: itemIdInput,
        name: nameInput.optional().describe('The new name.'),
        note: noteInput.optional().describe('The new note ("" clears it).')
      }
    },
    async ({ workspace, itemId, name, note }) =>
      write(workspace, async (c) => {
        if (name === undefined && note === undefined) {
          return deny('Nothing to update — pass name and/or note.');
        }
        return jsonText(
          await callApi(
            c,
            itemPath(itemId),
            jsonBody('PATCH', {
              ...(name !== undefined ? { name } : {}),
              ...(note !== undefined ? { note } : {})
            })
          )
        );
      })
  );

  server.registerTool(
    tool('delete_item'),
    {
      description:
        'DELETE an item: it is removed for every member of the organization and cannot be ' +
        'restored. Returns the deleted item (its final snapshot). Always confirm with the user ' +
        'before calling.',
      inputSchema: { workspace: workspaceInput, itemId: itemIdInput },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, itemId }) =>
      write(workspace, async (c) => jsonText(await callApi(c, itemPath(itemId), { method: 'DELETE' })))
  );

  // ── Items in projects ──────────────────────────────────────────────────────
  // A project is a chassis concept (its eleven tools are the chassis's,
  // registered before this set); the LINK between an item and a project is
  // the item domain's. The tiered answer of the API holds through both
  // tools: a project the caller cannot read answers not found (404, never
  // 403), then the role refusal, then the archived refusal.

  server.registerTool(
    tool('link_item_to_project'),
    {
      description:
        'Put an item in a project: the project’s members then find it under the project. Needs the ' +
        'editor or manager role on the project (a workspace owner or admin has it everywhere); ' +
        'linking twice is the same answer. Returns the item, with the project among its projects. ' +
        'An item or a project you cannot read answers not found; below editor on the project is ' +
        'refused; an archived project is refused until brought back. Always confirm with the user ' +
        'before calling.',
      inputSchema: { workspace: workspaceInput, itemId: itemIdInput, projectId: projectIdInput }
    },
    async ({ workspace, itemId, projectId }) =>
      write(workspace, async (c) =>
        jsonText(await callApi(c, linkPath(itemId, projectId), { method: 'PUT' }))
      )
  );

  server.registerTool(
    tool('unlink_item_from_project'),
    {
      description:
        'Take an item out of a project: the project’s members no longer find it there (the item ' +
        'itself stays). Needs the editor or manager role on the project, like the link. Returns the ' +
        'item, without the project. An item or a project you cannot read answers not found; an item ' +
        'not in the project answers not_linked; an archived project is refused until brought back. ' +
        'Always confirm with the user before calling.',
      inputSchema: { workspace: workspaceInput, itemId: itemIdInput, projectId: projectIdInput },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, itemId, projectId }) =>
      write(workspace, async (c) =>
        jsonText(await callApi(c, linkPath(itemId, projectId), { method: 'DELETE' }))
      )
  );

  // ── Voice ──────────────────────────────────────────────────────────────────
  // Gradium through the instance's own routes. Both spend the workspace's
  // Gradium credits: write tools, confirm-first.

  server.registerTool(
    tool('voice_speak'),
    {
      description:
        `Speak a text (1 to ${VOICE_TEXT_MAX} characters) with Gradium's voice. Returns the audio: a ` +
        'wav file, base64 encoded, as an audio content block, with a text line saying its type and ' +
        'size. Spends the organization’s Gradium credits. Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        text: z.string().min(1).max(VOICE_TEXT_MAX).describe('What to say.')
      }
    },
    async ({ workspace, text }) =>
      write(workspace, async (c) => {
        const speech = (await callApi(c, '/api/v1/voice/speak', jsonBody('POST', { text }))) as {
          audio: string;
          contentType: 'audio/wav';
        };
        const bytes = Buffer.from(speech.audio, 'base64').length;
        // The audio block is the MCP content type for sound; the text line
        // is what a host that shows no audio still reads.
        return {
          content: [
            { type: 'text', text: `${speech.contentType}, ${bytes} bytes` },
            { type: 'audio', data: speech.audio, mimeType: speech.contentType }
          ]
        } as unknown as ToolTextResult;
      })
  );

  server.registerTool(
    tool('voice_transcribe'),
    {
      description:
        'Transcribe a wav file with Gradium: pass the file base64 encoded (at most 5 MiB decoded) and, ' +
        `optionally, the language spoken (${VOICE_LANGUAGES.join(', ')}). Without a language, Gradium detects it (\`any\`). ` +
        'Returns { text }. Spends the organization’s Gradium credits. Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        audio: z.string().min(1).max(VOICE_AUDIO_MAX_BASE64).describe('The wav file, base64 encoded.'),
        language: z
          .enum(VOICE_LANGUAGES)
          .optional()
          .describe(`The language spoken: ${VOICE_LANGUAGES.join(', ')}. Omitted, Gradium detects it (any).`)
      }
    },
    async ({ workspace, audio, language }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            '/api/v1/voice/transcribe',
            jsonBody('POST', { audio, contentType: 'audio/wav', ...(language ? { language } : {}) })
          )
        )
      )
  );

  // ── Runs ───────────────────────────────────────────────────────────────────
  // H's agent in a cloud browser, through the instance's own run routes.

  const runIdInput = z.uuid().describe('Run id, from run_start or list_runs.');

  server.registerTool(
    tool('run_start'),
    {
      description:
        'Start a run: H’s agent carries out a web task in a cloud browser. `instruction` says what to ' +
        `do in plain words (1 to ${RUN_INSTRUCTION_MAX} characters); \`startUrl\` (https) is where the ` +
        'browser starts. Answers at once with { run } in state running and its liveUrl (the live view ' +
        `of the browser); follow it with ${MCP_TOOL_PREFIX}run_get. Spends the organization’s H ` +
        'credits. Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        instruction: z.string().min(1).max(RUN_INSTRUCTION_MAX).describe('What the agent should do.'),
        startUrl: z.string().optional().describe('The https page the browser starts on.')
      }
    },
    async ({ workspace, instruction, startUrl }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            '/api/v1/runs',
            jsonBody('POST', { instruction, ...(startUrl !== undefined ? { startUrl } : {}) })
          )
        )
      )
  );

  server.registerTool(
    tool('run_get'),
    {
      description:
        'One run by id, brought up to date with H: state (running, completed, failed), liveUrl, ' +
        'answer once completed, error once failed. A run takes from 20 seconds to several minutes: ' +
        'call this again, a few seconds apart, until `state` is not `running`, then give the user ' +
        'the answer.',
      inputSchema: { workspace: workspaceInput, runId: runIdInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, runId }) =>
      read(workspace, async (c) => jsonText(await callApi(c, `/api/v1/runs/${encodeURIComponent(runId)}`)))
  );

  server.registerTool(
    tool('list_runs'),
    {
      description:
        'List the runs of the organization, newest first, as last seen (use run_get to bring a ' +
        'running one up to date). Returns { runs, nextCursor }; when nextCursor is non-null, call ' +
        'again with cursor set to it for the next page.',
      inputSchema: { workspace: workspaceInput, cursor: cursorInput, limit: limitInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, cursor, limit }) =>
      read(workspace, async (c) => jsonText(await callApi(c, pageQuery('/api/v1/runs', { cursor, limit }))))
  );
}
