/* The public docs, and the one prompt that sets an agent up on this
   instance. Every place the dashboard points a person at the documentation
   reads the address here (the first-run welcome, the sidebar's card), so
   the site can move once. The prompt is what a person pastes into their
   agent: it names THIS instance (the origin the dashboard is served from),
   the two ways in and the page to read first, in English whatever the
   dashboard's language, because it is written for the agent.

   Everything that names the tool here is read from IDENTITY: the docs
   section is the tool's slug on the Antasphere docs site (the hub's is
   `antasphere`; another tool's is its own slug), the CLI package is
   `@antasphere/<slug>`, the binary, the key prefix, the MCP server name and
   the write scope are the identity's own. A tool says what it is for in
   the first line of the prompt, and nowhere else in this file. */
import { IDENTITY } from '@app/contract';

export const DOCS_URL = `https://docs.antasphere.com/${IDENTITY.slug}`;

export const docsPage = (path: string) => `${DOCS_URL}/${path.replace(/^\//, '')}`;

export function agentPrompt(origin: string): string {
  const key = `${IDENTITY.apiKeyPrefix}_...`;
  return [
    `You are working with ${IDENTITY.displayName}, an Antasphere tool: one workspace per team,`,
    'reached from the dashboard, the command line and an agent alike.',
    '',
    `My instance: ${origin}`,
    `Docs: ${DOCS_URL} — read ${docsPage('getting-started/connect-an-agent')} first,`,
    `then ${docsPage('agents/cli')} and ${docsPage('agents/mcp-connector')}.`,
    '',
    'Two ways in, both on this instance only:',
    `- MCP: ${origin}/mcp as a connector (OAuth, sign in on the dashboard), or with an API key:`,
    `  claude mcp add --transport http ${IDENTITY.mcp.serverName} ${origin}/mcp --header "Authorization: Bearer ${key}"`,
    `- CLI: npm i -g @antasphere/${IDENTITY.slug}, then`,
    `  ${IDENTITY.cli.bin} login --api-url ${origin} --api-key ${key}`,
    `  (mint the key in the dashboard under API keys, with ${IDENTITY.scopes.write}).`,
    '',
    `Then \`${IDENTITY.cli.bin} --help\` lists every command, and the docs above say what each one does.`
  ].join('\n');
}
