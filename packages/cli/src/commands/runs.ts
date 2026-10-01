import type { Command } from 'commander';
import { RUN_INSTRUCTION_MAX, type Run } from '@app/contract';
import type { ListParams } from '@app/sdk';
import { CliUsageError, drainPages, printJson, table, type CliIo } from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext } from '../cli.js';

/**
 * The runs: H's agent carrying out a web task in a cloud browser.
 *
 *  - `run <instruction> [--start-url <url>] [--wait]` starts one and prints
 *    its id, its state and the live view; `--wait` asks for it every 3 s
 *    (`GET /runs/{id}`, which asks H) until it is no longer `running`,
 *    printing each state change, then the answer; a failed run ends on its
 *    reason and exit 1.
 *  - `runs list` and `runs show <id>`, the item group's idioms.
 *
 * `--json` prints the wire shape (with `--wait`, the final run).
 */

/** The wait between two reads of a running run. Tests shorten it. */
export const runTiming = { pollMs: 3000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function printRun(io: CliIo, run: Run): void {
  io.out.write(
    `${run.id}\n` +
      `  state:       ${run.state}\n` +
      `  instruction: ${run.instruction.replace(/\n/g, '\n               ')}\n` +
      (run.startUrl ? `  start url:   ${run.startUrl}\n` : '') +
      (run.liveUrl ? `  live view:   ${run.liveUrl}\n` : '') +
      (run.answer !== null ? `  answer:      ${run.answer.replace(/\n/g, '\n               ')}\n` : '') +
      (run.error !== null ? `  error:       ${run.error}\n` : '') +
      `  created:     ${run.createdAt}\n` +
      (run.finishedAt ? `  finished:    ${run.finishedAt}\n` : '')
  );
}

export function registerRunCommands(program: Command, io: CliIo): void {
  program
    .command('run <instruction>')
    .description('Start a run: H carries out the instruction in a cloud browser')
    .option('--start-url <url>', 'the https page the browser starts on')
    .option('--wait', 'follow the run until it finishes, then print the answer', false)
    .action(async (instruction: string, opts: { startUrl?: string; wait: boolean }, cmd: Command) => {
      if (instruction.trim() === '') throw new CliUsageError('Nothing to do: pass an instruction.');
      if (instruction.length > RUN_INSTRUCTION_MAX) {
        throw new CliUsageError(`The instruction is over ${RUN_INSTRUCTION_MAX} characters.`);
      }
      if (opts.startUrl !== undefined && !opts.startUrl.startsWith('https://')) {
        throw new CliUsageError('--start-url must be an https URL.');
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const { run: started } = await ctx.client.createRun({
        instruction,
        ...(opts.startUrl !== undefined ? { startUrl: opts.startUrl } : {})
      });
      if (!opts.wait) {
        if (ctx.json) return printJson(io, { run: started });
        io.out.write(
          `${started.id}\n  state:     ${started.state}\n` +
            (started.liveUrl ? `  live view: ${started.liveUrl}\n` : '')
        );
        return;
      }
      if (!ctx.json) {
        io.out.write(`${started.id}\n`);
        if (started.liveUrl) io.out.write(`live view: ${started.liveUrl}\n`);
        io.out.write(`${started.state}\n`);
      }
      let run = started;
      while (run.state === 'running') {
        await sleep(runTiming.pollMs);
        const next = await ctx.client.getRun(run.id);
        if (next.state !== run.state && !ctx.json) io.out.write(`${next.state}\n`);
        run = next;
      }
      if (ctx.json) printJson(io, run);
      else if (run.state === 'completed') io.out.write(`${run.answer ?? ''}\n`);
      if (run.state === 'failed') throw new Error(`The run failed: ${run.error ?? 'no reason given'}`);
    });

  const runs = program.command('runs').description('The runs of the workspace');

  runs
    .command('list')
    .description('List runs (newest first, cursor-paginated), as last seen')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.listRuns(params);
      const rows = opts.all
        ? await drainPages({ rows: first.runs, nextCursor: first.nextCursor }, async (cursor) => {
            const page = await ctx.client.listRuns({ ...params, cursor });
            return { rows: page.runs, nextCursor: page.nextCursor };
          })
        : first.runs;
      const nextCursor = opts.all ? null : first.nextCursor;
      if (ctx.json) return printJson(io, { runs: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No runs.\n');
        return;
      }
      // The free text is the LAST column.
      io.out.write(table(rows.map((r) => [r.id, r.createdAt, r.state, r.instruction.replace(/\s+/g, ' ')])));
      if (nextCursor) io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
    });

  runs
    .command('show <id>')
    .description('Show one run (asks H where it is while it is running)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const run = await ctx.client.getRun(id);
      if (ctx.json) return printJson(io, run);
      printRun(io, run);
    });
}
