import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildMcpServer as buildChassisMcpServer,
  type McpServerInfo,
  type McpToolContext,
  type McpToolDefinition
} from '@antasphere/chassis-server/mcp';
import { IDENTITY } from '@app/contract';
import { ITEM_ERROR_HINTS, ITEM_MCP_SCOPES, MCP_TOOL_PREFIX, registerTools } from './tools.js';

/**
 * The MCP definition handed to the chassis (`mcpRoutes({ …, tool })`). The
 * chassis registers its own tools first (`get_me`, the whoami proof,
 * `list_files`, `<prefix>whoami`, the eleven project tools and the two team
 * reads), gated on the scopes named below; the tool's own set (`./tools.ts`:
 * the seven item tools, then the voice and run tools) comes after them. The
 * instructions name the tools through the ONE prefix constant, never a copy.
 */
export const toolMcp: McpToolDefinition = {
  registerTools,
  instructions: (info) =>
    `MCP endpoint of the "${info.instanceName}" instance. Every tool acts as the connected ` +
    'user, with the scopes granted on the consent screen (or on the API key). The credential ' +
    'is the USER; the organization (workspace) is a per-call parameter — every tool accepts ' +
    `an optional \`workspace\` id, defaulting to your default org. Start with ${MCP_TOOL_PREFIX}whoami ` +
    'to see who is connected and which organizations you can name; the items of an ' +
    `organization live behind the ${MCP_TOOL_PREFIX} tools (list_items, get_item, create_item, ` +
    'update_item, delete_item), its projects behind the project tools (list_projects to ' +
    'remove_project_team), its teams behind list_teams and list_team_members, and an item ' +
    'goes in and out of a project with ' +
    'link_item_to_project and unlink_item_from_project. The voice (Gradium) is voice_speak and ' +
    'voice_transcribe; a web task in a cloud browser (H) is run_start, then run_get until it ' +
    'is done, and list_runs.',
  errorHints: ITEM_ERROR_HINTS,
  scopes: ITEM_MCP_SCOPES
};

/** The bundled MCP server exactly as `/mcp` builds it: the chassis builder with the definition above. */
export function buildMcpServer(ctx: McpToolContext, info: McpServerInfo): McpServer {
  return buildChassisMcpServer(ctx, info, toolMcp, IDENTITY.mcp);
}
