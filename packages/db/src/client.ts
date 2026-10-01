import * as chassisSchema from '@antasphere/chassis-db/schema';
import { createDb as createChassisDb, type DbHandle } from '@antasphere/chassis-db';
import * as toolSchema from './schema.js';

/**
 * The one place the chassis tables and the tool's tables are merged: the full
 * schema object drizzle is constructed with. It is NOT re-exported — a chassis
 * table is imported from `@antasphere/chassis-db`, a tool table from here.
 * A table exported from `./schema.ts` lands in the handle with no change
 * here.
 */
const schema = { ...chassisSchema, ...toolSchema };

export function createDb(connectionString: string): DbHandle {
  return createChassisDb(connectionString, schema);
}
