import { cliIdentity, defineCli, type CliContext as ChassisCliContext } from '@antasphere/chassis-cli';
import { IDENTITY } from '@app/contract';
import { PlatformClient } from '@app/sdk';

/**
 * The ONE instantiation of the CLI chassis for this tool. What the tool is
 * called is its identity, so it is spelled ONCE, in `@app/contract`
 * (`IDENTITY`), read here and spelled nowhere in `@antasphere/chassis-cli`;
 * every generic function that carries it (the
 * config namespace, the environment variables, the hints that name the
 * binary, the key prefix) is built from it and exported under the name it
 * has always had. The command modules import this file, and it imports none
 * of them.
 */
export const cli = defineCli({
  identity: cliIdentity(IDENTITY),
  description: `Command-line client for a ${IDENTITY.displayName} instance`,
  createClient: (options) => new PlatformClient(options)
  // `errorHint` is the tool's slot for a hint on one of its OWN error codes (a
  // quota, a conflict, a state the caller can act on). It stays empty: the item
  // routes answer only codes the runner already explains (400, 403, 404).
});

/** The context every command resolves: the chassis's, over the tool's client. */
export type CliContext = ChassisCliContext<PlatformClient>;

export const loadConfig = cli.loadConfig;
export const saveConfig = cli.saveConfig;

export const resolveContext = cli.resolveContext;
export const requireApiKey = cli.requireApiKey;
