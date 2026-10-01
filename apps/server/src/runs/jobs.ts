import type { Logger } from '@antasphere/chassis-server/logger';
import type { RunService } from './service.js';

/** One pg-boss declaration of the `jobs` slot (the chassis's `JobDeclaration`, structurally). */
export interface RunJobDeclaration {
  queue: string;
  schedule: { cron: string };
  handler: () => Promise<void>;
}

/** The queue of the runs sweep, and its schedule: every minute. */
export const RUNS_SWEEP_QUEUE = 'runs-sweep';
export const RUNS_SWEEP_CRON = '* * * * *';

/**
 * The `jobs` slot's one declaration: every minute, refresh the running runs
 * (every workspace, at most 50, oldest first) and fail the ones H has not
 * finished in 15 minutes (`RunService.sweep`). The slot runs before the
 * services exist, so the handler reads the domain at RUN time.
 */
export function runJobs(getRuns: () => RunService | null, logger: Logger): RunJobDeclaration[] {
  return [
    {
      queue: RUNS_SWEEP_QUEUE,
      schedule: { cron: RUNS_SWEEP_CRON },
      handler: async () => {
        const service = getRuns();
        if (!service) return;
        const outcome = await service.sweep();
        if (outcome.timedOut || outcome.failures) logger.info({ ...outcome }, 'runs sweep');
      }
    }
  ];
}
