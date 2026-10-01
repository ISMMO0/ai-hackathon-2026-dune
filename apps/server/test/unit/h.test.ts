import { describe, expect, it } from 'vitest';
import { HaiAgentsError, TERMINAL_SESSION_STATUSES } from 'hai-agents';
import {
  H_AGENT,
  completedPoll,
  createH,
  isTerminalStatus,
  taskMessage,
  type HSessions
} from '../../src/integrations/h.js';
import { IntegrationError } from '../../src/integrations/errors.js';

/**
 * The H client against a fake `sessions` object in place of the SDK's: the
 * request shapes verified live on 29 September 2026 are pinned here, so no
 * test ever calls H itself.
 */

const KEY = 'hai-test-key-0123456789';

interface Recorded {
  method: string;
  arg: unknown;
}

function fakeSessions(impl: Partial<Record<keyof HSessions, (arg: unknown) => unknown>>): {
  sessions: HSessions;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const method =
    (name: keyof HSessions) =>
    async (arg: unknown): Promise<unknown> => {
      calls.push({ method: name, arg });
      const fn = impl[name];
      if (!fn) throw new Error(`unexpected call: ${name}`);
      return fn(arg);
    };
  const sessions = {
    createSession: method('createSession'),
    getSessionChanges: method('getSessionChanges'),
    getSession: method('getSession'),
    getSessionQuota: method('getSessionQuota')
  } as unknown as HSessions;
  return { sessions, calls };
}

describe('taskMessage', () => {
  it('the instruction, a blank line, then the rules', () => {
    expect(taskMessage('Find the heading of example.com')).toBe(
      'Find the heading of example.com\n\nNever buy anything, never change account settings, never delete data. When you are done, answer in plain text with exactly what was asked.'
    );
  });

  it('with a start URL: the instruction, a blank line, "Start from <url>.", then the rules', () => {
    expect(taskMessage('  Read the title  ', 'https://example.com')).toBe(
      'Read the title\n\nStart from https://example.com.\nNever buy anything, never change account settings, never delete data. When you are done, answer in plain text with exactly what was asked.'
    );
  });
});

describe('createH', () => {
  it('start: creates the session with the inline agent, the budget and the group, and answers its id and live view', async () => {
    const { sessions, calls } = fakeSessions({
      createSession: () => ({ id: 'sess-1', status: 'pending', agentViewUrl: 'https://h.example/view/1' })
    });
    const started = await createH({ apiKey: KEY, sessions }).start('Find the heading');
    expect(started).toEqual({ sessionId: 'sess-1', liveUrl: 'https://h.example/view/1' });
    expect(calls).toHaveLength(1);
    const body = (calls[0]!.arg as { body: Record<string, unknown> }).body;
    expect(body).toEqual({
      agent: H_AGENT,
      messages: taskMessage('Find the heading'),
      maxTimeS: 480,
      maxSteps: 60,
      groupId: 'starter'
    });
    expect(H_AGENT).toEqual({
      name: 'starter-web-task',
      description: 'Hackathon Starter: carries out a web task in a cloud browser.',
      environments: ['h/browser'],
      model: 'holo3-122b-a10b',
      skills: ['h/company', 'h/user-collaboration', 'h/answering', 'h/planning'],
      tools: []
    });
  });

  it('start with a start URL: the message names it and the web environment is overridden', async () => {
    const { sessions, calls } = fakeSessions({ createSession: () => ({ id: 's', status: 'pending' }) });
    const started = await createH({ apiKey: KEY, sessions }).start('Read it', 'https://example.com');
    expect(started.liveUrl).toBeNull();
    const body = (calls[0]!.arg as { body: Record<string, unknown> }).body;
    expect(body.messages).toBe(taskMessage('Read it', 'https://example.com'));
    expect(body.overrides).toEqual({ 'agent.environments[kind=web].start_url': 'https://example.com' });
  });

  it('poll: one changes read, from index 0, no events, no wait', async () => {
    const { sessions, calls } = fakeSessions({ getSessionChanges: () => ({ status: 'running' }) });
    expect(await createH({ apiKey: KEY, sessions }).poll('sess-1')).toEqual({
      status: 'running',
      terminal: false,
      answer: null,
      error: null
    });
    expect(calls).toEqual([
      {
        method: 'getSessionChanges',
        arg: { id: 'sess-1', fromIndex: 0, includeEvents: false, waitForSeconds: 0 }
      }
    ]);
  });

  it('poll on a completed session with its answer on the changes: no second call', async () => {
    const { sessions, calls } = fakeSessions({
      getSessionChanges: () => ({ status: 'completed', answer: 'Example Domain' })
    });
    expect(await createH({ apiKey: KEY, sessions }).poll('s')).toEqual({
      status: 'completed',
      terminal: true,
      answer: 'Example Domain',
      error: null
    });
    expect(calls).toHaveLength(1);
  });

  it('poll on a finished session without an answer on the changes reads latestAnswer from the session', async () => {
    const { sessions, calls } = fakeSessions({
      getSessionChanges: () => ({ status: 'completed' }),
      getSession: () => ({ id: 's', status: 'completed', latestAnswer: { heading: 'Example Domain' } })
    });
    const polled = await createH({ apiKey: KEY, sessions }).poll('s');
    expect(polled.answer).toBe('{"heading":"Example Domain"}');
    expect(calls.map((c) => c.method)).toEqual(['getSessionChanges', 'getSession']);
  });

  it('poll on a failed session carries the error', async () => {
    const { sessions } = fakeSessions({
      getSessionChanges: () => ({ status: 'failed', error: 'environment crashed' }),
      getSession: () => ({ id: 's', status: 'failed', latestAnswer: null })
    });
    expect(await createH({ apiKey: KEY, sessions }).poll('s')).toEqual({
      status: 'failed',
      terminal: true,
      answer: null,
      error: 'environment crashed'
    });
  });

  it('poll with no changes answer falls back to the session, its status as the SDK types it (an envelope)', async () => {
    const { sessions } = fakeSessions({
      getSessionChanges: () => undefined,
      getSession: () => ({
        id: 's',
        status: { status: 'timed_out', error: 'ran out of time' },
        latestAnswer: null
      })
    });
    expect(await createH({ apiKey: KEY, sessions }).poll('s')).toEqual({
      status: 'timed_out',
      terminal: true,
      answer: null,
      error: 'ran out of time'
    });
  });

  it('poll on an idle session with its answer on the changes: settled, terminal, no second call', async () => {
    const { sessions, calls } = fakeSessions({
      getSessionChanges: () => ({ status: 'idle', answer: 'Example Domain' })
    });
    const polled = await createH({ apiKey: KEY, sessions }).poll('s');
    expect(polled).toEqual({ status: 'idle', terminal: true, answer: 'Example Domain', error: null });
    expect(completedPoll(polled)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('poll on an idle session without an answer on the changes reads latestAnswer: settled when there is one', async () => {
    const { sessions, calls } = fakeSessions({
      getSessionChanges: () => ({ status: 'idle' }),
      getSession: () => ({ id: 's', status: 'idle', latestAnswer: 'Example Domain' })
    });
    const polled = await createH({ apiKey: KEY, sessions }).poll('s');
    expect(polled).toEqual({ status: 'idle', terminal: true, answer: 'Example Domain', error: null });
    expect(completedPoll(polled)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['getSessionChanges', 'getSession']);
  });

  it('poll on an idle session with no answer anywhere: still running', async () => {
    const { sessions } = fakeSessions({
      getSessionChanges: () => ({ status: 'idle' }),
      getSession: () => ({ id: 's', status: 'idle', latestAnswer: null })
    });
    const polled = await createH({ apiKey: KEY, sessions }).poll('s');
    expect(polled).toEqual({ status: 'idle', terminal: false, answer: null, error: null });
    expect(completedPoll(polled)).toBe(false);
  });

  it('completedPoll: completed, or idle with an answer; never a failure status', () => {
    expect(completedPoll({ status: 'completed', answer: null })).toBe(true);
    expect(completedPoll({ status: 'idle', answer: 'x' })).toBe(true);
    expect(completedPoll({ status: 'idle', answer: null })).toBe(false);
    expect(completedPoll({ status: 'failed', answer: 'x' })).toBe(false);
    expect(completedPoll({ status: 'timed_out', answer: 'x' })).toBe(false);
  });

  it('quota: the SDK quota answer', async () => {
    const { sessions } = fakeSessions({
      getSessionQuota: () => ({ scope: 'org', limit: 5, active: 1, available: 4 })
    });
    expect(await createH({ apiKey: KEY, sessions }).quota()).toEqual({
      scope: 'org',
      limit: 5,
      active: 1,
      available: 4
    });
  });

  it('an SDK refusal is an IntegrationError with the status, the body clipped, never the key', async () => {
    const { sessions } = fakeSessions({
      createSession: () => {
        throw new HaiAgentsError({ statusCode: 429, body: { detail: `${KEY} ${'y'.repeat(400)}` } });
      }
    });
    const err = await createH({ apiKey: KEY, sessions })
      .start('x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    const failure = err as IntegrationError;
    expect(failure.integration).toBe('h');
    expect(failure.providerStatus).toBe(429);
    expect(failure.message).toMatch(/^H answered 429/);
    expect(failure.message).not.toContain(KEY);
    expect(failure.message.length).toBeLessThan(260);
  });

  it('the terminal statuses are the SDK’s', () => {
    expect([...TERMINAL_SESSION_STATUSES]).toEqual(['completed', 'failed', 'timed_out', 'interrupted']);
    for (const s of TERMINAL_SESSION_STATUSES) expect(isTerminalStatus(s)).toBe(true);
    for (const s of ['pending', 'running', 'idle', 'queued']) expect(isTerminalStatus(s)).toBe(false);
  });
});
