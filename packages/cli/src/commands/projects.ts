import type { Command } from 'commander';
import { PlatformApiError } from '@app/sdk';
import type { Item, ItemProjectRef } from '@app/contract';
import {
  CliApiRefusal,
  explainProjectRefusal,
  printJson,
  roleNamedBy,
  type CliIo
} from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext } from '../cli.js';

/**
 * The ITEM's side of the projects. The chassis owns the concept and its
 * commands (`projects list|get|create|update|archive|unarchive`, `projects
 * members *`); what a project HOLDS is the tool's, so these two verbs hang
 * off the same `projects` group:
 *
 *   projects link <project> <item>     put an item in the project
 *   projects unlink <project> <item>   take it back out
 *
 * Every refusal the server has a code for becomes a sentence; anything else
 * is rethrown and the runner prints it unchanged. `--json` is the API
 * payload verbatim through `printJson`, every human line through the
 * sanitizing sinks the runner installed.
 */

/** The group the chassis registered, found by name on the program. */
function projectsGroup(program: Command): Command {
  const group = program.commands.find((c) => c.name() === 'projects');
  if (!group) {
    // The chassis registers it before the tool's groups (program.ts); a
    // rename there must fail loudly here, not silently drop two commands.
    throw new Error('The chassis `projects` command group is missing — cannot register the item verbs.');
  }
  return group;
}

/**
 * The link/unlink/list refusals as sentences. The chassis has the project
 * ones (`explainProjectRefusal`); these are the codes the item side adds,
 * where the same code means something different depending on the verb.
 */
export type ItemProjectVerb = 'link' | 'unlink' | 'list' | 'create';

export function explainItemProjectRefusal(e: PlatformApiError, verb: ItemProjectVerb): string | null {
  switch (e.code) {
    case 'project_not_found':
      return verb === 'create'
        ? 'No such project, or it is not yours to read, or you are not an editor of it, or it is archived: a new item goes into a project you may link into.'
        : 'No such project, or it is not yours to read. (A project you are not a member of answers the same way: its existence is not probeable.)';
    case 'not_found':
      return 'No such item, or it is not yours to read.';
    case 'not_linked':
      return 'That item is not in this project, so there is nothing to unlink.';
    case 'insufficient_project_role': {
      // The wire names the role the route gates on, read where the chassis
      // reads it; the verb only says what the role would have allowed.
      const role = roleNamedBy(e) ?? 'editor';
      const act = verb === 'unlink' ? 'to take an item out of it' : 'to put an item in it';
      return `You need the ${role} role on this project ${act}.`;
    }
    case 'project_archived':
      return 'This project is archived and read-only. Unarchive it first to change what it holds.';
    case 'guest_forbidden':
      return 'You are a guest of this workspace, and guests do not take part in projects.';
    default:
      return explainProjectRefusal(e, 'project');
  }
}

/**
 * A listing with `--project`: a project the caller cannot read answers 404
 * like the project itself, and without the sentence it reads as "no such
 * listing". Without the flag the call runs as it always has.
 */
export function withProjectRefusal<T>(project: string | undefined, run: () => Promise<T>): Promise<T> {
  return project === undefined ? run() : explainedItemProject('list', run);
}

/** Run an item-side project call, turning the known refusals into sentences. */
export async function explainedItemProject<T>(verb: ItemProjectVerb, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError) {
      const line = explainItemProjectRefusal(e, verb);
      if (line) throw new CliApiRefusal(line, e.status);
    }
    throw e;
  }
}

/**
 * The projects of an item payload. The field is in the contract, but an
 * instance older than this CLI answers without it, and the CLI treats the
 * instance's answer as untrusted input everywhere else: a missing or
 * malformed field reads as "no projects", never as a crash.
 */
export function projectsOf(item: { projects?: readonly ItemProjectRef[] }): ItemProjectRef[] {
  return Array.isArray(item.projects) ? [...item.projects] : [];
}

/** The projects of an item, as a human line: `Atlas, Borealis`, or nothing. */
export function projectsLine(projects: readonly ItemProjectRef[]): string {
  return projects.map((p) => p.name).join(', ');
}

/** `"<name>" is in 2 projects: Atlas, Borealis`, or `… is in no project.` */
function inProjectsLine(item: Item): string {
  const now = projectsOf(item);
  return now.length === 0
    ? `"${item.name}" is in no project.\n`
    : `"${item.name}" is in ${now.length} project${now.length === 1 ? '' : 's'}: ${projectsLine(now)}\n`;
}

export function registerProjectItemCommands(program: Command, io: CliIo): void {
  const projects = projectsGroup(program);

  projects
    .command('link <project> <item>')
    .description('Put an item in a project (the editor role or more on the project)')
    .action(async (project: string, item: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const updated = await explainedItemProject('link', () => ctx.client.linkItemProject(item, project));
      if (ctx.json) return printJson(io, updated);
      io.out.write(inProjectsLine(updated));
    });

  projects
    .command('unlink <project> <item>')
    .description('Take an item out of a project (the editor role or more on the project)')
    .action(async (project: string, item: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const updated = await explainedItemProject('unlink', () => ctx.client.unlinkItemProject(item, project));
      if (ctx.json) return printJson(io, updated);
      io.out.write(inProjectsLine(updated));
    });
}
