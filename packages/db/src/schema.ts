import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects, user, workspaces } from '@antasphere/chassis-db';

/**
 * The tool's schema module: the tool's own tables go HERE.
 *
 * The chassis tables (workspaces, members, files, audit log, the Better Auth
 * tables, ...) live in `@antasphere/chassis-db` and are never redeclared. This
 * module is merged with the chassis schema in `./client.ts` (the drizzle
 * handle) and listed beside it in `../drizzle.config.ts` (the migration
 * generator), so adding a table is one `export const … = pgTable(…)` here
 * followed by `pnpm --filter @app/db db:generate --name <table>`.
 *
 * The migration chain is the chassis baseline, then every later file in
 * order, the tool's and the chassis's alike (`drizzle/0000_chassis_baseline.sql`,
 * `drizzle/0001_items.sql`, `drizzle/0002_projects.sql`, the chassis's two
 * project tables, `drizzle/0003_item_projects.sql`,
 * `drizzle/0004_teams_and_demo_passes.sql`, the chassis's teams and demo
 * passes, `drizzle/0005_runs.sql`). A committed migration is never edited: a
 * change to a table is a NEW file.
 */

/**
 * Items: the template's placeholder resource, a name and a note per workspace.
 *
 * The three rules every tool table follows:
 *  - `workspace_id` is NOT NULL and cascades: a row belongs to exactly one
 *    workspace, every query carries it, and the row leaves with the workspace.
 *  - `created_by` is nullable and SET NULL, like `files.created_by`: an item is
 *    WORKSPACE data, so it survives the erasure of its author's account and
 *    only loses the attribution (a cascade here would let one departure delete
 *    the team's rows).
 *  - the `(workspace_id, created_at, id)` index serves the keyset list, the
 *    chassis's pagination idiom (newest first, the cursor is a row id).
 */
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    note: text('note').notNull().default(''),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // Serves the list's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('items_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
  ]
);

/**
 * An item's place in the workspace's PROJECTS: the chassis owns the project
 * (`projects`, `project_members` in `@antasphere/chassis-db`), and this table
 * is the tool's own link to it, the shape every tool follows for the resource
 * it links. Many-to-many: an item may sit in several projects.
 *
 *  - `workspace_id` is carried on the link too, so every statement over it
 *    keeps the rule of the tool's tables (the WHERE names the workspace).
 *  - `added_by` is nullable and SET NULL: the link is workspace data and
 *    survives the erasure of whoever made it.
 *  - both sides cascade: a link carries no value once the item or the project
 *    is gone. A project is never deleted in practice; its workspace can be.
 *  - the index on `project_id` serves "the items of this project", the list's
 *    project filter and the project page.
 */
export const itemProjects = pgTable(
  'item_projects',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.projectId] }),
    index('item_projects_project_idx').on(t.projectId)
  ]
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemProject = typeof itemProjects.$inferSelect;

/**
 * Runs: the starter's demo of H, one agent session in a cloud browser per row.
 * Follows the three rules of every tool table (the workspace cascades, the
 * author is SET NULL, the keyset index). `create` asks H FIRST and inserts
 * the row only once H has the session, so a row always names one
 * (`h_session_id`); `state` moves `running` to `completed` or `failed` once,
 * and `finished_at` is set then.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    instruction: text('instruction').notNull(),
    startUrl: text('start_url'),
    /** `running`, `completed` or `failed`. */
    state: text('state', { enum: ['running', 'completed', 'failed'] }).notNull(),
    hSessionId: text('h_session_id').notNull(),
    liveUrl: text('live_url'),
    answer: text('answer'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true })
  },
  (t) => [
    // Serves the list's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('runs_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
  ]
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
