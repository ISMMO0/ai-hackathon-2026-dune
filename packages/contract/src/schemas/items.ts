import { z } from 'zod';
import { cursorPageQuerySchema, noControlChars, plainText } from '@antasphere/chassis-contract';

/**
 * Items: the template's placeholder resource, a name and a note per workspace.
 * Client-safe (pure zod): the server validates with these schemas, the SDK and
 * the dashboard type against them.
 *
 * Every free-text field a client may send goes through the chassis helpers
 * (`plainText` / `noControlChars`): a NUL cannot be stored in a Postgres `text`
 * column and would come back as a 500, so it is refused here as an ordinary
 * 400. Every length is bounded here too: the contract is the only gate a body
 * passes before it reaches the database.
 */

export const ITEM_NAME_MAX = 200;
export const ITEM_NOTE_MAX = 2000;

/** One line: trimmed FIRST, so a name of spaces is refused as empty. */
const itemNameSchema = noControlChars(z.string().trim().min(1).max(ITEM_NAME_MAX));
/** Free text, kept as typed (newlines and tabs are allowed); may be empty. */
const itemNoteSchema = plainText(0, ITEM_NOTE_MAX);

/** One project an item is linked to, as its payload names it. */
export const itemProjectRefSchema = z.object({ id: z.string(), name: z.string() });
export type ItemProjectRef = z.infer<typeof itemProjectRefSchema>;

/** At most this many projects named on one create. */
export const ITEM_PROJECT_IDS_MAX = 20;
export const itemProjectIdsSchema = z.array(z.uuid()).max(ITEM_PROJECT_IDS_MAX);

/** The wire shape. Timestamps are ISO strings; `createdBy` is null once its author's account is erased. */
export const itemSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  note: z.string(),
  createdBy: z.string().nullable(),
  /**
   * The projects this item is linked to THAT THE CALLER CAN READ, never the
   * others: an item may sit in a project the caller is not a member of, and
   * that project's existence is not theirs to learn from the item.
   */
  projects: z.array(itemProjectRefSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Item = z.infer<typeof itemSchema>;

export const itemsListQuerySchema = cursorPageQuerySchema.extend({
  /**
   * Keeps only the items linked to this project. A project the caller cannot
   * read answers 404, like the project itself.
   */
  project: z.uuid().optional()
});
export type ItemsListQuery = z.infer<typeof itemsListQuerySchema>;

export const itemsListSchema = z.object({
  items: z.array(itemSchema),
  nextCursor: z.string().nullable()
});
export type ItemsList = z.infer<typeof itemsListSchema>;

export const itemCreateSchema = z.object({
  name: itemNameSchema,
  note: itemNoteSchema.default(''),
  /**
   * Links the new item to these projects in the same transaction. The caller
   * is asked the project side only: the editor role or more on each, none
   * archived. One project that does not qualify refuses the whole create
   * with 404 `project_not_found`.
   */
  projectIds: itemProjectIdsSchema.optional()
});
/** What a CLIENT sends: `note` may be omitted (the parsed value always carries it). */
export type ItemCreate = z.input<typeof itemCreateSchema>;

// A creation answers an envelope, `{ item }`, where a read or an update answers the
// bare item: a tool's create often yields something only the creation has (an upload
// URL, a secret shown once, as `POST /api-keys` answers `{ key, apiKey }`), and the
// envelope takes that field later without breaking a client.
export const itemCreatedSchema = z.object({ item: itemSchema });
export type ItemCreated = z.infer<typeof itemCreatedSchema>;

// Both fields optional, so an empty body must be refused HERE: `{}` would
// otherwise reach the service as a patch that changes nothing (the chassis's
// `memberUpdateSchema` states the same rule).
export const itemUpdateSchema = z
  .object({
    name: itemNameSchema.optional(),
    note: itemNoteSchema.optional()
  })
  .refine((v) => v.name !== undefined || v.note !== undefined, {
    error: 'at least one of name or note is required'
  });
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;

/** `PUT|DELETE /items/{id}/projects/{projectId}`: the item, and the project it goes in or out of. */
export const itemProjectParamsSchema = z.object({ id: z.uuid(), projectId: z.uuid() });
