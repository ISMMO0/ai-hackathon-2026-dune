import type { Command } from 'commander';
import { ITEM_NAME_MAX, ITEM_NOTE_MAX, type Item, type ItemUpdate } from '@app/contract';
import type { ItemListParams } from '@app/sdk';
import { CliUsageError, drainPages, printJson, table, type CliIo } from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext } from '../cli.js';
import { explainedItemProject, projectsLine, projectsOf, withProjectRefusal } from './projects.js';

/**
 * The `items` command group: list / create / show / update / rm, one command
 * per SDK method. What a tool's command module respects:
 *
 *  - The context comes from the kit (`resolveContext`, `requireApiKey`, bound
 *    to the tool in `../cli.ts`): the instance, the key, the workspace and
 *    `--json` are the kit's GLOBAL options. A command never redeclares them and
 *    never builds a client of its own, so `--workspace`, `--profile` and the
 *    environment variables work here exactly as on the generic commands.
 *  - `--json` prints the WIRE shape, untouched, through `printJson` (the raw
 *    sink: data, not display).
 *  - Human output goes through `io.out`, which the runner has wrapped once in
 *    the kit's terminal sanitizer: a name or a note is somebody else's text
 *    heading for a terminal, and the escape sequences in it are stripped there.
 *    A command therefore never writes to `process.stdout` itself.
 *  - A refusal the command can know without the server (`update` with nothing
 *    to change) is a `CliUsageError` thrown BEFORE any request. Every other
 *    error is left to the runner: it prints `Error: <the API's message>` on
 *    stderr and exits 1, with the kit's hints (403, 401, a 404 under a
 *    workspace selection).
 *  - The item's side of the projects (`--project` on `list` and `create`, the
 *    `projects:` line of `show`) is `./projects.ts`, where the project
 *    refusals become sentences; `projects link|unlink` live there too.
 */

function printItem(io: CliIo, item: Item): void {
  io.out.write(
    `${item.name}\n` +
      `  id:       ${item.id}\n` +
      `  note:     ${item.note === '' ? '(none)' : item.note.replace(/\n/g, '\n            ')}\n` +
      (projectsOf(item).length > 0 ? `  projects: ${projectsLine(projectsOf(item))}\n` : '') +
      `  author:   ${item.createdBy ?? '(deleted user)'}\n` +
      `  created:  ${item.createdAt}\n` +
      `  updated:  ${item.updatedAt}\n`
  );
}

export function registerItemCommands(program: Command, io: CliIo): void {
  const items = program.command('items').description('Manage the items of the workspace');

  items
    .command('list')
    .description('List items (newest first, cursor-paginated)')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .option('--project <id>', 'only the items in this project')
    .action(
      async (opts: { cursor?: string; limit?: number; all: boolean; project?: string }, cmd: Command) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const params: ItemListParams = {};
        if (opts.cursor) params.cursor = opts.cursor;
        if (opts.limit !== undefined) params.limit = opts.limit;
        if (opts.project !== undefined) params.project = opts.project;
        // Every page goes through the project refusal, so `--all --project`
        // reads a project it cannot see the same way on any page.
        const listed = (p: ItemListParams) => withProjectRefusal(opts.project, () => ctx.client.items(p));
        const first = await listed(params);
        const rows = opts.all
          ? await drainPages({ rows: first.items, nextCursor: first.nextCursor }, async (cursor) => {
              const page = await listed({ ...params, cursor });
              return { rows: page.items, nextCursor: page.nextCursor };
            })
          : first.items;
        const nextCursor = opts.all ? null : first.nextCursor;
        // The wire shape, so scripts can thread nextCursor (--all drains it to null).
        if (ctx.json) return printJson(io, { items: rows, nextCursor });
        if (rows.length === 0) {
          io.out.write('No items.\n');
          return;
        }
        // The free text is the LAST column: `table` pads every column but the
        // last. The projects column appears only when a row has something in
        // it: a workspace that uses no project keeps the table it always had.
        const anyProjects = rows.some((i) => projectsOf(i).length > 0);
        io.out.write(
          table(
            rows.map((i) => [
              i.id,
              i.createdAt,
              ...(anyProjects ? [projectsLine(projectsOf(i)) || '-'] : []),
              i.name
            ])
          )
        );
        if (nextCursor) {
          io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
        }
      }
    );

  items
    .command('create')
    .description('Create an item in the workspace')
    .requiredOption('--name <name>', `the name (1-${ITEM_NAME_MAX} characters)`)
    .option('--note <note>', `a free-text note (up to ${ITEM_NOTE_MAX} characters)`)
    .option(
      '--project <id>',
      'put the new item in this project (repeatable; the editor role or more on each)',
      (id: string, all: string[]) => [...all, id],
      [] as string[]
    )
    .action(async (opts: { name: string; note?: string; project: string[] }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      // The links ride in the create itself: one transaction, and a project
      // that does not qualify refuses the whole create, so an item is never
      // half-placed.
      const created = await explainedItemProject('create', () =>
        ctx.client.createItem({
          name: opts.name,
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(opts.project.length > 0 ? { projectIds: opts.project } : {})
        })
      );
      if (ctx.json) return printJson(io, created);
      const projects = projectsOf(created.item);
      io.out.write(
        `Created ${created.item.name}\n  id: ${created.item.id}\n` +
          (projects.length > 0 ? `  projects: ${projectsLine(projects)}\n` : '')
      );
    });

  items
    .command('show <id>')
    .description('Show one item')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const item = await ctx.client.item(id);
      if (ctx.json) return printJson(io, item);
      printItem(io, item);
    });

  items
    .command('update <id>')
    .description('Change the name and/or the note of an item')
    .option('--name <name>', 'the new name')
    .option('--note <note>', 'the new note (an empty string clears it)')
    .action(async (id: string, opts: { name?: string; note?: string }, cmd: Command) => {
      const patch: ItemUpdate = {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {})
      };
      // Known without the server, so refused before the context is even resolved.
      if (Object.keys(patch).length === 0) {
        throw new CliUsageError('Nothing to change: pass --name <name> and/or --note <note>.');
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const item = await ctx.client.updateItem(id, patch);
      if (ctx.json) return printJson(io, item);
      printItem(io, item);
    });

  items
    .command('rm <id>')
    .description('Delete an item by id')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const item = await ctx.client.deleteItem(id);
      if (ctx.json) return printJson(io, item);
      io.out.write(`Deleted ${item.name} (${item.id})\n`);
    });
}
