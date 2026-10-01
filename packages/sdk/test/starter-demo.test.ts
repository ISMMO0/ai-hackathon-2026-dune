import { describe, expect, it } from 'vitest';
import type { Run } from '@app/contract';
import { PlatformApiError, PlatformClient } from '../src/index.js';

/**
 * The starter's demo methods (integrations, voice, runs), each pinned by the
 * request it puts on the wire, as `items.test.ts` pins the item methods: the
 * query, the body, the credential, the parsed answer, an API error as a
 * `PlatformApiError` with the API's code.
 */

const ID = '11111111-1111-1111-1111-111111111111';
const RUN: Run = {
  id: ID,
  workspaceId: '44444444-4444-4444-4444-444444444444',
  createdBy: null,
  instruction: 'Read the heading',
  startUrl: 'https://example.com',
  state: 'running',
  liveUrl: 'https://h.example/view',
  answer: null,
  error: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  finishedAt: null
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordingClient(answer: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { client: new PlatformClient({ baseUrl: 'http://x', apiKey: 'key_k_s', fetch: fetchImpl }), calls };
}

describe('SDK: integrations, voice and runs', () => {
  it('integrations() asks without the check, integrations({ check: true }) with it', async () => {
    const answer = { gradium: { configured: false }, h: { configured: true } };
    const { client, calls } = recordingClient(answer);
    expect(await client.integrations()).toEqual(answer);
    await client.integrations({ check: true });
    expect(calls.map((c) => c.url)).toEqual([
      'http://x/api/v1/integrations',
      'http://x/api/v1/integrations?check=true'
    ]);
    expect(calls[0]!.headers.authorization).toBe('Bearer key_k_s');
  });

  it('speak and transcribe POST their bodies', async () => {
    const { client, calls } = recordingClient({ text: 'Bonjour' });
    await client.speak('Bonjour');
    await client.transcribe({ audio: 'UklGRg==', contentType: 'audio/wav', language: 'fr' });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'http://x/api/v1/voice/speak', { text: 'Bonjour' }],
      [
        'POST',
        'http://x/api/v1/voice/transcribe',
        { audio: 'UklGRg==', contentType: 'audio/wav', language: 'fr' }
      ]
    ]);
  });

  it('createRun, listRuns (with its page) and getRun', async () => {
    const { client, calls } = recordingClient({ run: RUN });
    expect(
      await client.createRun({ instruction: 'Read the heading', startUrl: 'https://example.com' })
    ).toEqual({
      run: RUN
    });
    await client.listRuns({ limit: 10, cursor: ID });
    await client.getRun(ID);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'http://x/api/v1/runs', { instruction: 'Read the heading', startUrl: 'https://example.com' }],
      ['GET', `http://x/api/v1/runs?cursor=${ID}&limit=10`, undefined],
      ['GET', `http://x/api/v1/runs/${ID}`, undefined]
    ]);
  });

  it('the 503 of an unconfigured integration surfaces with its code', async () => {
    const { client } = recordingClient(
      { error: { code: 'integration_not_configured', message: 'H is not configured: set HAI_API_KEY' } },
      503
    );
    const err = await client.createRun({ instruction: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect((err as PlatformApiError).status).toBe(503);
    expect((err as PlatformApiError).code).toBe('integration_not_configured');
  });
});
