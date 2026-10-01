import type { OpenAPIHono } from '@hono/zod-openapi';
import { voiceSpeakRoute, voiceTranscribeRoute } from '@app/contract/routes';
import { requireAuth, requireNonGuest } from '@antasphere/chassis-server/middleware';
import type { BodyCap } from '@antasphere/chassis-server';
import type { Integrations } from '../integrations/index.js';
import { notConfigured, providerFailed } from './integrations.js';

/** The one path whose body is larger than the 1 MiB default: a wav, base64 encoded. */
export const VOICE_TRANSCRIBE_PATH = '/api/v1/voice/transcribe';
export const VOICE_TRANSCRIBE_BODY_MAX = 8 * 1024 * 1024;

/**
 * The `api.bodyLimit` cap of the transcribe route: 8 MiB, room for a 5 MiB
 * wav in base64 (about 6.7 MiB) and its JSON envelope. Declared ONCE: the
 * chassis builds the middleware per cap object.
 */
export const voiceTranscribeBodyCap: BodyCap = {
  maxBytes: VOICE_TRANSCRIBE_BODY_MAX,
  onError: (c) =>
    c.json({ error: { code: 'payload_too_large', message: 'Request body exceeds the 8 MiB limit' } }, 413)
};

/**
 * The voice routes: text to speech and speech to text through Gradium.
 *
 *  - WHO: signed in; a guest is refused both (403 `guest_forbidden`): each
 *    call spends the workspace's credits at Gradium, a workspace act.
 *    Machines need the write scope (`middleware/scopes.ts`).
 *  - The key not set: 503 `integration_not_configured`; Gradium refusing or
 *    silent: 502 `integration_failed` (`./integrations.ts`).
 *  - Audit: `voice.speak` and `voice.transcribe`, resource type `voice`, with
 *    sizes only: never the text, never the transcript.
 */
export function registerVoiceRoutes(api: OpenAPIHono, integrations: Integrations): void {
  api.use('/voice/*', requireAuth());
  api.use('/voice/*', requireNonGuest());

  api.openapi(voiceSpeakRoute, async (c) => {
    const { text } = c.req.valid('json');
    const gradium = integrations.gradium;
    if (!gradium) return notConfigured(c, 'gradium');
    let wav: Buffer;
    try {
      wav = await gradium.speak(text);
    } catch (err) {
      return providerFailed(c, err);
    }
    c.set('audit', {
      action: 'voice.speak',
      resourceType: 'voice',
      metadata: { characters: text.length, bytes: wav.length }
    });
    return c.json({ audio: wav.toString('base64'), contentType: 'audio/wav' as const }, 200);
  });

  api.openapi(voiceTranscribeRoute, async (c) => {
    const { audio, language } = c.req.valid('json');
    const gradium = integrations.gradium;
    if (!gradium) return notConfigured(c, 'gradium');
    const wav = Buffer.from(audio, 'base64');
    let text: string;
    try {
      text = await gradium.transcribe(wav, language);
    } catch (err) {
      return providerFailed(c, err);
    }
    c.set('audit', {
      action: 'voice.transcribe',
      resourceType: 'voice',
      metadata: { bytes: wav.length, ...(language ? { language } : {}) }
    });
    return c.json({ text }, 200);
  });
}
