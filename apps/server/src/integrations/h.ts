import {
  HaiAgentsClient,
  HaiAgentsEnvironment,
  HaiAgentsError,
  TERMINAL_SESSION_STATUSES,
  type HaiAgents
} from 'hai-agents';
import { IntegrationError, clipDetail } from './errors.js';

/**
 * H, the agent in a cloud browser, over its SDK (`hai-agents`, EU region). A
 * run is one H session: `start` creates it and answers at once (H queues the
 * work), `poll` asks where it is, once, without waiting. Env-free: the
 * factory takes the key, and a test hands it a fake `sessions` object in
 * place of the SDK's.
 *
 * The key is created at https://platform.hcompany.ai/settings/api-keys.
 */

/** Groups every session this tool creates in H's platform. */
export const H_GROUP_ID = 'starter';
export const H_MAX_TIME_S = 480;
export const H_MAX_STEPS = 60;
export const H_MODEL = 'holo3-122b-a10b';
export const H_SKILLS = ['h/company', 'h/user-collaboration', 'h/answering', 'h/planning'];

/**
 * The agent, INLINE: a catalog agent with a skills override fails at step 0
 * on H's side, the same list inline works.
 */
export const H_AGENT: HaiAgents.Agent = {
  name: 'starter-web-task',
  description: 'Hackathon Starter: carries out a web task in a cloud browser.',
  environments: ['h/browser'],
  model: H_MODEL,
  skills: [...H_SKILLS],
  tools: []
};

export const H_RULES =
  'Never buy anything, never change account settings, never delete data. When you are done, answer in plain text with exactly what was asked.';

/** What the agent is told: the instruction, then a blank line, the start page when there is one, the rules. */
export function taskMessage(instruction: string, startUrl?: string | null): string {
  return [instruction.trim(), '', ...(startUrl ? [`Start from ${startUrl}.`] : []), H_RULES].join('\n');
}

/** The part of the SDK's `sessions` the starter calls: the seam a test fakes. */
export type HSessions = Pick<
  HaiAgentsClient['sessions'],
  'createSession' | 'getSessionChanges' | 'getSession' | 'getSessionQuota'
>;

export interface HStarted {
  sessionId: string;
  /** H's Agent View page of the session (live view and replay), when H gave one. */
  liveUrl: string | null;
}

export interface HPoll {
  /** H's status, as H spells it (`pending`, `running`, `idle`, `completed`, `failed`, …). */
  status: string;
  /**
   * True once the status is one of the SDK's `TERMINAL_SESSION_STATUSES`, or
   * the session is `idle` with an answer (`settledIdle`).
   */
  terminal: boolean;
  /** The agent's answer as text: the changes' `answer`, else the session's `latestAnswer`. */
  answer: string | null;
  error: string | null;
}

export interface HQuota {
  scope: string;
  limit: number;
  active: number;
  available: number;
}

export interface HClient {
  start(instruction: string, startUrl?: string | null): Promise<HStarted>;
  poll(sessionId: string): Promise<HPoll>;
  quota(): Promise<HQuota>;
}

export interface HOptions {
  apiKey: string;
  /** The SDK's sessions client by default; a test passes a fake. */
  sessions?: HSessions;
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

/**
 * An `idle` session that has answered is done: H leaves a session that
 * finished its turn `idle` (waiting for another message) rather than
 * `completed`. `idle` without an answer is still running.
 */
export function settledIdle(status: string, answer: string | null): boolean {
  return status === 'idle' && answer !== null;
}

/** Whether a settled poll completed the run (else it failed): `completed`, or `idle` with an answer. */
export function completedPoll(polled: Pick<HPoll, 'status' | 'answer'>): boolean {
  return polled.status === 'completed' || settledIdle(polled.status, polled.answer);
}

/** An answer as text: a string as is, structured data as JSON. */
function answerText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * A session's status as the SDK types it (an object carrying `status` and
 * `error`) or as the API has been seen to answer it (the bare string).
 */
function sessionStatusOf(value: unknown): { status: string; error: string | null } {
  if (typeof value === 'string') return { status: value, error: null };
  const envelope = (value ?? {}) as { status?: unknown; error?: unknown };
  return {
    status: typeof envelope.status === 'string' ? envelope.status : 'unknown',
    error: typeof envelope.error === 'string' ? envelope.error : null
  };
}

/** An SDK failure as an IntegrationError: the status, at most 200 characters of the body, never the key. */
export function hFailure(err: unknown, what: string, apiKey?: string): IntegrationError {
  if (err instanceof IntegrationError) return err;
  if (err instanceof HaiAgentsError) {
    const body =
      err.body === undefined ? '' : typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    const detail = clipDetail(body || err.message, apiKey);
    return new IntegrationError(
      'h',
      `H answered ${err.statusCode ?? 'an error'} (${what})${detail ? `: ${detail}` : ''}`,
      err.statusCode
    );
  }
  const why = err instanceof Error ? err.message : String(err);
  return new IntegrationError('h', `H did not answer (${what}): ${clipDetail(why, apiKey)}`);
}

export function createH(options: HOptions): HClient {
  const apiKey = options.apiKey;
  const sessions =
    options.sessions ?? new HaiAgentsClient({ apiKey, environment: HaiAgentsEnvironment.Eu }).sessions;

  return {
    async start(instruction, startUrl) {
      try {
        const session = await sessions.createSession({
          body: {
            agent: H_AGENT,
            messages: taskMessage(instruction, startUrl),
            maxTimeS: H_MAX_TIME_S,
            maxSteps: H_MAX_STEPS,
            groupId: H_GROUP_ID,
            ...(startUrl ? { overrides: { 'agent.environments[kind=web].start_url': startUrl } } : {})
          }
        });
        return { sessionId: session.id, liveUrl: session.agentViewUrl ?? null };
      } catch (err) {
        throw hFailure(err, 'start a session', apiKey);
      }
    },

    async poll(sessionId) {
      try {
        const changes = await sessions.getSessionChanges({
          id: sessionId,
          fromIndex: 0,
          includeEvents: false,
          waitForSeconds: 0
        });
        let status: string | undefined = changes?.status;
        let answer = answerText(changes?.answer);
        let error = changes?.error ?? null;
        // No changes answer, or a finished (or idle) session without its
        // answer on the changes: the session itself carries the status and
        // `latestAnswer`.
        if (status === undefined || ((isTerminalStatus(status) || status === 'idle') && answer === null)) {
          const session = await sessions.getSession({ id: sessionId });
          const envelope = sessionStatusOf(session.status);
          status = status ?? envelope.status;
          error = error ?? envelope.error;
          answer = answer ?? answerText(session.latestAnswer);
        }
        return { status, terminal: isTerminalStatus(status) || settledIdle(status, answer), answer, error };
      } catch (err) {
        throw hFailure(err, 'read a session', apiKey);
      }
    },

    async quota() {
      try {
        const q = await sessions.getSessionQuota();
        return { scope: q.scope, limit: q.limit, active: q.active, available: q.available };
      } catch (err) {
        throw hFailure(err, 'read the quota', apiKey);
      }
    }
  };
}
