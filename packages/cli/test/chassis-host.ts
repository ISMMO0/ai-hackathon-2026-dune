import type { PlatformClient } from '@app/sdk';
import type { CliTestHost } from '@antasphere/chassis-cli/testing';
import { cli as toolCli } from '../src/cli.js';
import { run as toolRun } from '../src/index.js';

/**
 * The tool's host of the chassis suite (`packages/chassis-cli/test/suite`,
 * run a second time by this package's vitest config): the real kit
 * (`src/cli.ts`) and the real runner, which binds the tool's command groups
 * and `VERSION` (`src/index.ts`). The identity it carries gives those files
 * the literals they spelled before they moved. `@chassis-cli-test/host`
 * resolves here.
 */
const host: CliTestHost<PlatformClient> = { cli: toolCli, run: toolRun };

export const { cli, run } = host;
