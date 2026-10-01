import { sql, type SQL } from 'drizzle-orm';
import { files } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';

/**
 * READ access to a BLOB, as a WHERE predicate over a `files` row (SL-B1): the
 * policy the generic `/files` surface applies to its list, metadata, content
 * and delete routes. The chassis has no default, because a blob read is never
 * authorized on `workspace_id` alone.
 *
 *  1. a workspace **admin/owner** keeps the operator view (predicate
 *     `undefined` = no extra WHERE, every blob in the workspace), and
 *  2. everyone else sees a blob iff they **uploaded** it (`file_uploaders`,
 *     which unlike `files.created_by` survives content-addressed dedupe).
 *
 * The domain references no blob yet, so there is no second way to a blob: when
 * the items series binds bytes to an item, the clause "or it is referenced by
 * an item this principal can read" is added HERE, and the same predicate then
 * guards the bind (a sha the caller may not read resolves as missing). A blob
 * a principal cannot read answers 404, never 403 — it must not be probeable.
 */
export function blobReadScope(principal: Principal): SQL | undefined {
  if (principal.role === 'owner' || principal.role === 'admin') return undefined;
  return sql`EXISTS (
    SELECT 1 FROM file_uploaders fu
    WHERE fu.file_id = ${files.id} AND fu.user_id = ${principal.userId}
  )`;
}
