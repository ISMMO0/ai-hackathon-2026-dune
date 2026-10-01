import { z } from 'zod';
import { cursorPageQuerySchema, plainText } from '@antasphere/chassis-contract';

/**
 * Runs: one web task carried out by H's agent in a cloud browser. A run is
 * created `running`, and moves once to `completed` (with the agent's answer)
 * or `failed` (with the reason). Client-safe (pure zod).
 */

export const RUN_INSTRUCTION_MAX = 2000;
export const RUN_START_URL_MAX = 2000;
export const RUN_STATES = ['running', 'completed', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** An https URL, one line, bounded. */
const startUrlSchema = z
  .url({ protocol: /^https$/, error: 'startUrl must be an https URL' })
  .max(RUN_START_URL_MAX);

export const runCreateSchema = z.object({
  /** What the agent should do, in plain words. */
  instruction: plainText(1, RUN_INSTRUCTION_MAX).refine((t) => t.trim().length > 0, {
    error: 'instruction is empty'
  }),
  /** Where the browser starts; omitted, the agent finds its way. */
  startUrl: startUrlSchema.optional()
});
export type RunCreate = z.infer<typeof runCreateSchema>;

/** The wire shape. Timestamps are ISO strings; `createdBy` is null once its author's account is erased. */
export const runSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string().nullable(),
  instruction: z.string(),
  startUrl: z.string().nullable(),
  state: z.enum(RUN_STATES),
  /** H's live view of the session (watch it, then replay it), when H gave one. */
  liveUrl: z.string().nullable(),
  /** The agent's answer, once `completed`. */
  answer: z.string().nullable(),
  /** Why it failed, once `failed`: one line. */
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable()
});
export type Run = z.infer<typeof runSchema>;

export const runsListQuerySchema = cursorPageQuerySchema;
export type RunsListQuery = z.infer<typeof runsListQuerySchema>;

export const runsListSchema = z.object({
  runs: z.array(runSchema),
  nextCursor: z.string().nullable()
});
export type RunsList = z.infer<typeof runsListSchema>;

/** A creation answers an envelope, `{ run }`, like the item's. */
export const runCreatedSchema = z.object({ run: runSchema });
export type RunCreated = z.infer<typeof runCreatedSchema>;
