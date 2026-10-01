import { describe, expect, it } from 'vitest';
import {
  GRADIUM_ASR_URL,
  GRADIUM_CREDITS_URL,
  GRADIUM_TTS_URL,
  GRADIUM_VOICE_ID,
  createGradium,
  joinTranscript
} from '../../src/integrations/gradium.js';
import { IntegrationError } from '../../src/integrations/errors.js';

/**
 * The Gradium client against a recording fake `fetch`: the request shapes
 * verified live on 29 September 2026 are pinned here, so no test ever calls
 * Gradium itself.
 */

const KEY = 'gradium-test-key-0123456789';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    );
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('joinTranscript', () => {
  it('joins the text of every text line with a single space, and ignores the other types', () => {
    const ndjson = [
      { type: 'ready' },
      { type: 'text', text: 'Bonjour.' },
      { type: 'step' },
      { type: 'text', text: 'Ceci est un' },
      { type: 'end_text' },
      { type: 'text', text: 'test' },
      { type: 'end_of_stream' }
    ]
      .map((m) => JSON.stringify(m))
      .join('\n');
    expect(joinTranscript(ndjson)).toBe('Bonjour. Ceci est un test');
  });

  it('answers the empty string when nothing was said, and tolerates blank lines', () => {
    expect(joinTranscript('\n{"type":"ready"}\n\n{"type":"end_of_stream"}\n')).toBe('');
  });

  it('an error line is a failure, whatever came before it', () => {
    const ndjson = '{"type":"text","text":"Bonjour"}\n{"type":"error","message":"bad audio"}';
    expect(() => joinTranscript(ndjson)).toThrow(IntegrationError);
    expect(() => joinTranscript(ndjson)).toThrow(/bad audio/);
  });
});

describe('createGradium', () => {
  it('speak: POSTs the TTS body with the key header and answers the wav bytes', async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
    const { fetch, calls } = fakeFetch(
      () => new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } })
    );
    const bytes = await createGradium({ apiKey: KEY, fetch }).speak('Bonjour');
    expect([...bytes]).toEqual([...wav]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GRADIUM_TTS_URL);
    expect(calls[0]!.url).toBe('https://api.gradium.ai/api/post/speech/tts');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      text: 'Bonjour',
      voice_id: GRADIUM_VOICE_ID,
      output_format: 'wav',
      only_audio: true
    });
    expect(GRADIUM_VOICE_ID).toBe('YTpq7expH9539ERJ');
  });

  it('transcribe: POSTs the wav bytes as audio/wav, the language in json_config, and joins the ndjson', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response('{"type":"text","text":"Bonjour."}\n{"type":"text","text":"Merci"}\n', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' }
        })
    );
    const wav = new Uint8Array([1, 2, 3, 4]);
    const text = await createGradium({ apiKey: KEY, fetch }).transcribe(wav, 'fr');
    expect(text).toBe('Bonjour. Merci');
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(GRADIUM_ASR_URL);
    expect(JSON.parse(url.searchParams.get('json_config')!)).toEqual({ language: 'fr' });
    expect(calls[0]!.headers['content-type']).toBe('audio/wav');
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[0]!.body).toBe(wav);
  });

  it('transcribe without a language sends `any`: Gradium refuses a json_config without one', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('{"type":"text","text":"Hello"}', { status: 200 }));
    expect(await createGradium({ apiKey: KEY, fetch }).transcribe(new Uint8Array([1]))).toBe('Hello');
    expect(JSON.parse(new URL(calls[0]!.url).searchParams.get('json_config')!)).toEqual({ language: 'any' });
  });

  it('transcribe passes every given language as is, `any` included', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('{"type":"text","text":"Hola"}', { status: 200 }));
    const gradium = createGradium({ apiKey: KEY, fetch });
    for (const language of ['en', 'fr', 'de', 'es', 'pt', 'any'] as const) {
      await gradium.transcribe(new Uint8Array([1]), language);
      expect(JSON.parse(new URL(calls.at(-1)!.url).searchParams.get('json_config')!)).toEqual({ language });
    }
  });

  it('credits: GETs the credits and reads remaining and allocated', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({ remaining_credits: 4200, allocated_credits: 5000, billing_period: 'x' })
    );
    expect(await createGradium({ apiKey: KEY, fetch }).credits()).toEqual({
      remaining: 4200,
      allocated: 5000
    });
    expect(calls[0]!.url).toBe(GRADIUM_CREDITS_URL);
    expect(calls[0]!.method).toBe('GET');
  });

  it('a refusal is an IntegrationError with the status, at most 200 characters of the body, never the key', async () => {
    const long = `${KEY} ${'x'.repeat(500)}`;
    const { fetch } = fakeFetch(() => new Response(long, { status: 401 }));
    const err = await createGradium({ apiKey: KEY, fetch })
      .speak('Bonjour')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    const failure = err as IntegrationError;
    expect(failure.integration).toBe('gradium');
    expect(failure.providerStatus).toBe(401);
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).toMatch(/^Gradium answered 401/);
    expect(failure.message.length).toBeLessThan(260);
  });

  it('a network failure is an IntegrationError without a status', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await createGradium({ apiKey: KEY, fetch: fetchImpl })
      .credits()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).providerStatus).toBeUndefined();
    expect((err as IntegrationError).message).toMatch(/did not answer/);
  });
});
