import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { compareMigrations, migrationHash, onDiskMigrationHashes } from '@antasphere/chassis-db/migrate';

/**
 * OPS-6 (PRDCT-1357): migration status is hash-based. A count-based status
 * called a database migrated by a NEWER image "current" (n applied, n on
 * disk) — the `:next`-behind-`:latest` downgrade that leaves this image's
 * schema expectations silently wrong.
 */
const drizzleDir = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

describe('compareMigrations', () => {
  it('a database ahead of the image is a DOWNGRADE, not "current", even when the counts match', () => {
    const status = compareMigrations(['a', 'b', 'c'], ['a', 'b', 'd']);
    expect(status.applied).toBe(3);
    expect(status.onDisk).toBe(3);
    expect(status.downgrade).toBe(true);
    expect(status.unknownApplied).toBe(1);
    // …and the image's own unapplied file is still pending.
    expect(status.pending).toBe(true);
  });

  it('strictly more applied than on disk is a downgrade too', () => {
    const status = compareMigrations(['a', 'b'], ['a', 'b', 'c']);
    expect(status).toMatchObject({ downgrade: true, unknownApplied: 1, pending: false });
  });

  it('the exact set is current; a strict subset is pending', () => {
    expect(compareMigrations(['a', 'b'], ['a', 'b'])).toMatchObject({ pending: false, downgrade: false });
    expect(compareMigrations(['a', 'b'], ['a'])).toMatchObject({ pending: true, downgrade: false });
    expect(compareMigrations(['a'], [])).toMatchObject({ pending: true, downgrade: false, applied: 0 });
  });
});

describe('the on-disk hashes are exactly what drizzle records', () => {
  it('hashes the WHOLE .sql file with sha256, in journal order', async () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const hashes = await onDiskMigrationHashes(drizzleDir);
    expect(hashes).toHaveLength(journal.entries.length);
    expect(hashes[0]).toBe(
      migrationHash(readFileSync(join(drizzleDir, `${journal.entries[0]!.tag}.sql`), 'utf8'))
    );
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the chain: 0000_chassis_baseline.sql, 0001_items.sql, 0002_projects.sql, 0003_item_projects.sql, 0004_teams_and_demo_passes.sql, 0005_runs.sql', async () => {
    const hashes = await onDiskMigrationHashes(drizzleDir);
    expect(hashes).toEqual([
      migrationHash(readFileSync(join(drizzleDir, '0000_chassis_baseline.sql'), 'utf8')),
      migrationHash(readFileSync(join(drizzleDir, '0001_items.sql'), 'utf8')),
      migrationHash(readFileSync(join(drizzleDir, '0002_projects.sql'), 'utf8')),
      migrationHash(readFileSync(join(drizzleDir, '0003_item_projects.sql'), 'utf8')),
      migrationHash(readFileSync(join(drizzleDir, '0004_teams_and_demo_passes.sql'), 'utf8')),
      migrationHash(readFileSync(join(drizzleDir, '0005_runs.sql'), 'utf8'))
    ]);
    // A database migrated with this chain is current; one that still carries
    // another history (the 46 migrations of the product the template was cut from) is refused as a downgrade.
    expect(compareMigrations(hashes, hashes)).toMatchObject({ pending: false, downgrade: false });
    expect(compareMigrations(hashes, ['not-this-chain'])).toMatchObject({ pending: true, downgrade: true });
    // A database that stopped at the baseline is PENDING, never a downgrade:
    // the tool's first migration applies on top of it. So is one that stopped
    // before the chassis's projects migration: the two project tables apply on top.
    expect(compareMigrations(hashes, hashes.slice(0, 1))).toMatchObject({ pending: true, downgrade: false });
    expect(compareMigrations(hashes, hashes.slice(0, 2))).toMatchObject({ pending: true, downgrade: false });
    // And one that booted on 0003 (the template before the chassis at 0.13.0):
    // the five tables of 0004 apply on top, an upgrade and never a downgrade.
    expect(compareMigrations(hashes, hashes.slice(0, 4))).toMatchObject({ pending: true, downgrade: false });
    // And one that booted on 0004 (the starter before its runs): the runs
    // table applies on top.
    expect(compareMigrations(hashes, hashes.slice(0, 5))).toMatchObject({ pending: true, downgrade: false });
  });
});
