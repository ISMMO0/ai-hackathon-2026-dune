import type { VoiceLanguage } from '@app/contract';
import { IntegrationError, clipDetail } from './errors.js';

/**
 * Gradium, the voice: text to speech and speech to text over its HTTP API.
 * Env-free: the factory takes the key (and, for the tests, a `fetch`), so the
 * server binds it once from `GRADIUM_API_KEY` (`./index.ts`) and a test hands
 * it a fake. Every failure is an `IntegrationError` (the routes answer 502).
 *
 * The key is created in the Gradium console, https://gradium.ai.
 */

export const GRADIUM_API_BASE = 'https://api.gradium.ai';
export const GRADIUM_TTS_URL = `${GRADIUM_API_BASE}/api/post/speech/tts`;
export const GRADIUM_ASR_URL = `${GRADIUM_API_BASE}/api/post/speech/asr`;
export const GRADIUM_CREDITS_URL = `${GRADIUM_API_BASE}/api/usages/credits`;
/** One of Gradium's stock voices; pick another in their console and paste its id here. */
export const GRADIUM_VOICE_ID = 'YTpq7expH9539ERJ';

export type TranscribeLanguage = VoiceLanguage;

export interface GradiumCredits {
  remaining: number;
  allocated: number;
}

export interface GradiumClient {
  /** The text spoken, as the bytes of a wav file. */
  speak(text: string): Promise<Buffer>;
  /** The transcript of a wav file. Without a language, Gradium detects it (`any`). */
  transcribe(wav: Uint8Array, language?: TranscribeLanguage): Promise<string>;
  /** The account's credits: the cheap live check. */
  credits(): Promise<GradiumCredits>;
}

export interface GradiumOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

/**
 * The transcript of an ASR answer: one JSON object per line, the `text` of
 * every `type: "text"` line joined by a single space. A `type: "error"` line
 * is a failure, whatever came before it.
 */
export function joinTranscript(ndjson: string): string {
  const parts: string[] = [];
  for (const raw of ndjson.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let message: { type?: unknown; text?: unknown; message?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      throw new IntegrationError('gradium', `Gradium answered a line that is not JSON: ${clipDetail(line)}`);
    }
    if (message.type === 'error') {
      const why = typeof message.message === 'string' ? message.message : JSON.stringify(message);
      throw new IntegrationError('gradium', `Gradium could not transcribe: ${clipDetail(why)}`);
    }
    if (message.type === 'text' && typeof message.text === 'string') {
      const text = message.text.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(' ');
}

export function createGradium(options: GradiumOptions): GradiumClient {
  const apiKey = options.apiKey;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  /** One call; a network failure and a non-2xx answer both become an IntegrationError. */
  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, headers: { 'x-api-key': apiKey, ...init.headers } });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new IntegrationError('gradium', `Gradium did not answer (${what}): ${clipDetail(why, apiKey)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new IntegrationError(
        'gradium',
        `Gradium answered ${res.status} (${what})${body ? `: ${clipDetail(body, apiKey)}` : ''}`,
        res.status
      );
    }
    return res;
  }

  return {
    async speak(text) {
      const res = await call(
        GRADIUM_TTS_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice_id: GRADIUM_VOICE_ID, output_format: 'wav', only_audio: true })
        },
        'text to speech'
      );
      return Buffer.from(await res.arrayBuffer());
    },

    async transcribe(wav, language) {
      // Gradium refuses a json_config without a language (400 "A language is
      // required"), so none given is `any`: Gradium detects it.
      const config = { language: language ?? 'any' };
      const url = `${GRADIUM_ASR_URL}?json_config=${encodeURIComponent(JSON.stringify(config))}`;
      const res = await call(
        url,
        { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav },
        'speech to text'
      );
      return joinTranscript(await res.text());
    },

    async credits() {
      const res = await call(GRADIUM_CREDITS_URL, { method: 'GET' }, 'credits');
      const body = (await res.json().catch(() => null)) as {
        remaining_credits?: unknown;
        allocated_credits?: unknown;
      } | null;
      const remaining = Number(body?.remaining_credits);
      const allocated = Number(body?.allocated_credits);
      if (!Number.isFinite(remaining)) {
        throw new IntegrationError('gradium', 'Gradium answered the credits call without remaining_credits');
      }
      return { remaining, allocated: Number.isFinite(allocated) ? allocated : 0 };
    }
  };
}
