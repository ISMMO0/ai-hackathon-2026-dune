import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { itemProjects, items } from '../src/schema.js';

/**
 * The two deletion rules of a tool table (`src/schema.ts`, "the three rules
 * every tool table follows"), pinned where they are written, in both places:
 *
 *  - the migration, which is what a database gets (`schema.ts` drives the
 *    generator, never a live database);
 *  - the table declaration, which the next `db:generate` diffs against, so a
 *    rule changed there alone would come back as a migration nobody meant.
 *
 * The behaviour is proven on a real Postgres in
 * `apps/server/test/integration/items.test.ts` (an item survives its author,
 * an item leaves with its workspace). This test needs no database and fails by
 * naming the rule (verifier round 1, F2).
 */
const migration = (file: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../drizzle/${file}`), 'utf8');
const SQL = migration('0001_items.sql');
const LINK_SQL = migration('0003_item_projects.sql');

/** The `ON DELETE` rule the migration gives the foreign key on `column`. */
function onDeleteInMigration(column: string, sql = SQL): string | undefined {
  const m = sql.match(
    new RegExp(
      `FOREIGN KEY \\("${column}"\\) REFERENCES [^;]*? ON DELETE (cascade|set null|no action|restrict|set default)`
    )
  );
  return m?.[1];
}

/** The `onDelete` the table declaration gives the foreign key on `column`. */
function onDeleteInSchema(column: string, table = items): string | undefined {
  const fk = getTableConfig(table).foreignKeys.find((k) => k.reference().columns[0]!.name === column);
  return fk?.onDelete;
}

describe('the deletion rules of the items table', () => {
  it('workspace_id cascades: the row leaves with its workspace', () => {
    expect(onDeleteInMigration('workspace_id')).toBe('cascade');
    expect(onDeleteInSchema('workspace_id')).toBe('cascade');
  });

  it('created_by is SET NULL: the row survives its author', () => {
    expect(onDeleteInMigration('created_by')).toBe('set null');
    expect(onDeleteInSchema('created_by')).toBe('set null');
  });

  it('workspace_id is NOT NULL, created_by is nullable', () => {
    expect(SQL).toMatch(/"workspace_id" uuid NOT NULL/);
    expect(SQL).toMatch(/"created_by" text,/);
  });
});

/**
 * The link table follows the same two rules, and adds the third of a link:
 * both ends cascade, so a row never outlives the item or the project it joins.
 */
describe('the deletion rules of the item_projects table', () => {
  it.each(['item_id', 'project_id', 'workspace_id'])('%s cascades', (column) => {
    expect(onDeleteInMigration(column, LINK_SQL)).toBe('cascade');
    expect(onDeleteInSchema(column, itemProjects)).toBe('cascade');
  });

  it('added_by is SET NULL: the link survives whoever made it', () => {
    expect(onDeleteInMigration('added_by', LINK_SQL)).toBe('set null');
    expect(onDeleteInSchema('added_by', itemProjects)).toBe('set null');
  });

  it('one row per (item, project): the primary key', () => {
    expect(LINK_SQL).toMatch(/PRIMARY KEY\("item_id","project_id"\)/);
  });
});
