import type { Command } from 'commander';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli } from './cli.js';
import { registerItemCommands } from './commands/items.js';
import { registerProjectItemCommands } from './commands/projects.js';
import { registerVoiceCommands } from './commands/voice.js';
import { registerRunCommands } from './commands/runs.js';

export type { CliIo } from '@antasphere/chassis-cli';

/**
 * `starter` — the typed CLI over @app/sdk; the primary human/agent
 * face of an instance. Multi-profile (the `starter` namespace of the
 * shared Antasphere config home: $XDG_CONFIG_HOME/antasphere/tools/
 * starter.json, default ~/.config/antasphere/; pre-cli-core configs at
 * ~/.config/starter/config.json are imported once, non-destructively),
 * instance-portable, human tables by default and `--json` everywhere; any
 * error prints to stderr and exits non-zero.
 *
 * Resolution order (documented in docs/agents/cli.md):
 *   base URL: --api-url (alias --url) → STARTER_URL → profile baseUrl → error
 *   API key:  --api-key → STARTER_API_KEY → profile apiKey
 *             → cached hub-connect key (cloud instances; user-scoped —
 *               one per hub profile, valid for every org)
 *             → connect-on-demand: `antasphere login` exchanged for a ytk_ key
 *   workspace: --workspace → STARTER_WORKSPACE → profile activeWorkspaceId
 *             → none sent (the server's default membership)
 */

const VERSION = '0.4.1';

/**
 * The tool's command groups, handed to the chassis program, which places
 * them after the auth and workspace groups and before instance/export/files
 * and the completion command (`@antasphere/chassis-cli` program.ts).
 */
function registerTool(program: Command, io: CliIo): void {
  // One `register<Resource>Commands(program, io)` per command module of the tool.
  registerItemCommands(program, io);
  // The item's side of the projects, hung off the chassis's own `projects`
  // group (registered before the tool's groups): projects link / unlink.
  registerProjectItemCommands(program, io);
  // The starter's demo: the voice (Gradium), then the runs (H).
  registerVoiceCommands(program, io);
  registerRunCommands(program, io);
}

/**
 * The command tree, built once per run. Exported for the docs-coverage test
 * (test/docs-coverage.test.ts), which walks it to prove every command and
 * every flag appears in docs/agents/cli.md — the reference an agent reads.
 */
export function buildProgram(io: CliIo): Command {
  return cli.buildProgram(io, registerTool, VERSION);
}

/**
 * Run the CLI with injected I/O and return a process exit code. The bin calls
 * this with real process streams; tests call it in-process.
 */
export async function run(argv: string[], rawIo: CliIo): Promise<number> {
  return cli.run(argv, rawIo, registerTool, VERSION);
}
