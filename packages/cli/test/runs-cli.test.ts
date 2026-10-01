import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '@app/contract';
import { run as runCli } from '../src/index.js';
import { cli, saveConfig } from '../src/cli.js';
import { runTiming } from '../src/commands/runs.js';
import { routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * `run`, `runs list` and `runs show` through the routed harness: a fake
 * instance answering the three run routes. Pinned: the requests, `--wait`
 * following the run to its end (each state change, then the answer; a
 * failure ends on exit 1), the human and `--json` outputs, the refusals
 * sent with no request.
 */

const URL = 'http://x';
const KEY = `${cli.identity.keyPrefix}_k_secret`;
const ID = '11111111-1111-1111-1111-111111111111';

const RUNNING: Run = {
  id: ID,
  workspaceId: '44444444-4444-4444-4444-444444444444',
  createdBy: null,
  instruction: 'Read the heading',
  startUrl: null,
  state: 'running',
  liveUrl: 'https://h.example/view/1',
  answer: null,
  error: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  finishedAt: null
};
const DONE: Run = {
  ...RUNNING,
  state: 'completed',
  answer: 'Example Domain',
  finishedAt: '2026-09-29T10:00:26.000Z'
};
const FAILED: Run = {
  ...RUNNING,
  state: 'failed',
  error: 'timed out waiting for H',
  finishedAt: '2026-09-29T10:15:00.000Z'
};

/** The three routes; `reads` is what each successive GET /runs/{id} answers. */
function instance(reads: Run[]): Route[] {
  let i = 0;
  return [
    {
      method: 'POST',
      path: /^\/api\/v1\/runs$/,
      reply: ({ body }) => ({ status: 201, body: { run: { ...RUNNING, ...(body as object) } } })
    },
    { method: 'GET', path: /^\/api\/v1\/runs$/, reply: () => ({ body: { runs: [DONE], nextCursor: null } }) },
    {
      method: 'GET',
      path: /^\/api\/v1\/runs\/[^/]+$/,
      reply: () => ({ body: reads[Math.min(i++, reads.length - 1)] })
    }
  ];
}

async function harness(reads: Run[] = [DONE]) {
  const env = await tempConfigEnv();
  saveConfig(env, { activeProfile: 'work', profiles: { work: { apiKey: KEY, baseUrl: URL } } });
  return routedHarness(instance(reads), env);
}

const saved = runTiming.pollMs;
beforeEach(() => {
  runTiming.pollMs = 0;
});
afterEach(() => {
  runTiming.pollMs = saved;
});

describe('run', () => {
  it('POSTs the instruction and the start URL, prints the id, the state and the live view', async () => {
    const h = await harness();
    expect(await runCli(['run', 'Read the heading', '--start-url', 'https://example.com'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/runs',
        body: { instruction: 'Read the heading', startUrl: 'https://example.com' }
      }
    ]);
    expect(h.out()).toBe(`${ID}\n  state:     running\n  live view: https://h.example/view/1\n`);
  });

  it('--wait follows the run, printing each state change, then the answer', async () => {
    const h = await harness([RUNNING, RUNNING, DONE]);
    expect(await runCli(['run', 'Read the heading', '--wait'], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/runs',
      `GET /api/v1/runs/${ID}`,
      `GET /api/v1/runs/${ID}`,
      `GET /api/v1/runs/${ID}`
    ]);
    expect(h.out()).toBe(`${ID}\nlive view: https://h.example/view/1\nrunning\ncompleted\nExample Domain\n`);
  });

  it('--wait on a failed run ends on the reason and exit 1', async () => {
    const h = await harness([FAILED]);
    expect(await runCli(['run', 'Read the heading', '--wait'], h.io)).toBe(1);
    expect(h.out()).toContain('failed\n');
    expect(h.err()).toBe('Error: The run failed: timed out waiting for H\n');
  });

  it('--wait --json prints the final run only', async () => {
    const h = await harness([DONE]);
    expect(await runCli(['run', 'Read the heading', '--wait', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(DONE);
  });

  it('refuses an empty instruction and a start URL that is not https, before any request', async () => {
    const h = await harness();
    expect(await runCli(['run', '  '], h.io)).toBe(1);
    expect(await runCli(['run', 'x', '--start-url', 'http://example.com'], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
  });
});

describe('runs list and runs show', () => {
  it('list prints one row per run; --json the wire shape', async () => {
    const h = await harness();
    expect(await runCli(['runs', 'list'], h.io)).toBe(0);
    expect(h.out()).toBe(`${ID}  ${DONE.createdAt}  completed  Read the heading\n`);
    const j = await harness();
    expect(await runCli(['runs', 'list', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toEqual({ runs: [DONE], nextCursor: null });
  });

  it('show prints the run with its answer', async () => {
    const h = await harness([DONE]);
    expect(await runCli(['runs', 'show', ID], h.io)).toBe(0);
    expect(h.out()).toContain('  state:       completed\n');
    expect(h.out()).toContain('  answer:      Example Domain\n');
    expect(h.out()).toContain('  live view:   https://h.example/view/1\n');
  });

  it('prints an answer full of terminal control characters clean', async () => {
    const h = await harness([{ ...DONE, answer: 'hi\u001b[2J there\u0007' }]);
    expect(await runCli(['runs', 'show', ID], h.io)).toBe(0);
    expect(h.out()).not.toContain('\u001b');
  });
});
