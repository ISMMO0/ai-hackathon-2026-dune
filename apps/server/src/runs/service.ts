import { and, asc, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Principal } from '@antasphere/chassis-contract';
import type { Db } from '@antasphere/chassis-db';
import { runs, type Run } from '@app/db';
import { cursorRowId, keysetBefore, pageOf } from '@antasphere/chassis-server/util';
import { completedPoll, type HClient } from '../integrations/h.js';

/**
 * The runs of a workspace: the data half of the resource, no HTTP in it.
 *
 * The item's rules hold here: every statement carries the workspace, a row of
 * another workspace is not found like a missing one, and WHO sees a run is one
 * predicate (`visibleTo`: a member all of the workspace's, a guest none).
 *
 * A run is one H session. `create` asks H FIRST and inserts the row only once
 * H has accepted the session: an H refusal writes nothing. `refresh` asks H
 * once where a running run is and settles it on a terminal status; the read
 * of one run (`GET /runs/{id}`) and the sweep (`sweep`, the `runs-sweep` job,
 * every minute) call it, the list never does.
 */

/** How long a run may stay `running` before the sweep fails it. */
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** The error a run the sweep gave up on carries. */
export const RUN_TIMEOUT_ERROR = 'timed out waiting for H';
/** How many running runs one sweep tick refreshes, oldest first. */
export const RUN_SWEEP_BATCH = 50;
/** An error is kept to one line of at most this many characters. */
export const RUN_ERROR_MAX = 500;

/** One line, bounded: what a failed run says. */
export function oneLine(text: string, max = RUN_ERROR_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class RunService {
  constructor(
    private readonly db: Db,
    private readonly h: HClient | null,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Whether H is configured: the routes answer 503 when it is not. */
  get configured(): boolean {
    return this.h !== null;
  }

  /** A member sees every run of the workspace; a guest none (the template's item rule). */
  private visibleTo(principal: Principal): SQL | undefined {
    return principal.origin === 'guest' ? sql`false` : undefined;
  }

  /** One page, newest first, as last seen: the list asks H nothing. */
  async list(
    principal: Principal,
    opts: { cursor?: string | undefined; limit: number }
  ): Promise<{ page: Run[]; nextCursor: string | null }> {
    const workspaceId = principal.workspaceId;
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          this.visibleTo(principal),
          ...(cursorId
            ? [
                keysetBefore({
                  table: runs,
                  id: runs.id,
                  createdAt: runs.createdAt,
                  workspaceId: runs.workspaceId,
                  cursorId,
                  workspace: workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(opts.limit + 1);
    return pageOf(rows, opts.limit);
  }

  async get(principal: Principal, id: string): Promise<Run | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, id), eq(runs.workspaceId, principal.workspaceId), this.visibleTo(principal)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Start a run: H first (an IntegrationError propagates, nothing written),
   * then the row, `running`, with H's session id and live view.
   */
  async create(
    principal: Pick<Principal, 'userId' | 'workspaceId'>,
    input: { instruction: string; startUrl?: string | undefined }
  ): Promise<Run> {
    if (!this.h) throw new Error('H is not configured');
    const started = await this.h.start(input.instruction, input.startUrl ?? null);
    const [row] = await this.db
      .insert(runs)
      .values({
        workspaceId: principal.workspaceId,
        createdBy: principal.userId,
        instruction: input.instruction,
        startUrl: input.startUrl ?? null,
        state: 'running',
        hSessionId: started.sessionId,
        liveUrl: started.liveUrl
      })
      .returning();
    return row!;
  }

  /**
   * Bring a running run up to date: one poll of H; on a terminal status the
   * run settles, `completed` with the answer (H's `completed`, or `idle`
   * with an answer: `completedPoll`) or `failed` with the reason in one line. A run already settled is returned as it is, H not asked. The
   * update is guarded on `state = 'running'`, so a sweep and a read racing on
   * one run settle it once.
   */
  async refresh(run: Run): Promise<Run> {
    if (run.state !== 'running') return run;
    if (!this.h) throw new Error('H is not configured');
    const polled = await this.h.poll(run.hSessionId);
    if (!polled.terminal) return run;
    const completed = completedPoll(polled);
    const [row] = await this.db
      .update(runs)
      .set(
        completed
          ? { state: 'completed', answer: polled.answer, updatedAt: sql`now()`, finishedAt: sql`now()` }
          : {
              state: 'failed',
              answer: polled.answer,
              error: oneLine(polled.error ?? `the H session ended ${polled.status}`),
              updatedAt: sql`now()`,
              finishedAt: sql`now()`
            }
      )
      .where(and(eq(runs.id, run.id), eq(runs.workspaceId, run.workspaceId), eq(runs.state, 'running')))
      .returning();
    if (row) return row;
    // Settled by someone else in between: answer what is there now.
    const [current] = await this.db.select().from(runs).where(eq(runs.id, run.id)).limit(1);
    return current ?? run;
  }

  /**
   * The `runs-sweep` tick, across every workspace: the running runs older
   * than 15 minutes fail with `timed out waiting for H`; then at most 50 of
   * the others, oldest first, are refreshed. One run H cannot answer for is
   * skipped (the next tick tries again), never the whole tick. Without H,
   * only the timeouts apply.
   */
  async sweep(): Promise<{ timedOut: number; refreshed: number; failures: number }> {
    const cutoff = new Date(this.now().getTime() - RUN_TIMEOUT_MS);
    const timedOut = await this.db
      .update(runs)
      .set({ state: 'failed', error: RUN_TIMEOUT_ERROR, updatedAt: sql`now()`, finishedAt: sql`now()` })
      .where(and(eq(runs.state, 'running'), lt(runs.createdAt, cutoff)))
      .returning({ id: runs.id });
    if (!this.h) return { timedOut: timedOut.length, refreshed: 0, failures: 0 };
    const running = await this.db
      .select()
      .from(runs)
      .where(eq(runs.state, 'running'))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(RUN_SWEEP_BATCH);
    let refreshed = 0;
    let failures = 0;
    for (const run of running) {
      try {
        await this.refresh(run);
        refreshed++;
      } catch {
        failures++;
      }
    }
    return { timedOut: timedOut.length, refreshed, failures };
  }
}
