import { z } from 'zod';
import { plainText } from '@antasphere/chassis-contract';

/**
 * The voice: text to speech and speech to text, through Gradium. No table:
 * nothing is stored, the audio goes and comes back in the body, base64
 * encoded. Client-safe (pure zod).
 */

/** The longest text one speak call voices. */
export const VOICE_TEXT_MAX = 2000;
/** The largest wav one transcribe call takes, decoded. */
export const VOICE_AUDIO_MAX_BYTES = 5 * 1024 * 1024;
/** The same, as base64 characters (4 per 3 bytes, padded). */
export const VOICE_AUDIO_MAX_BASE64 = Math.ceil(VOICE_AUDIO_MAX_BYTES / 3) * 4;

/**
 * The languages Gradium's speech to text takes. `any` asks it to detect the
 * language; Gradium refuses a session without one, so the server sends `any`
 * when none is given.
 */
export const VOICE_LANGUAGES = ['en', 'fr', 'de', 'es', 'pt', 'any'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** How many bytes a base64 string decodes to. */
export function base64DecodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

export const voiceSpeakSchema = z.object({
  /** What to say: free text, kept as typed. */
  text: plainText(1, VOICE_TEXT_MAX).refine((t) => t.trim().length > 0, { error: 'text is empty' })
});
export type VoiceSpeakRequest = z.infer<typeof voiceSpeakSchema>;

export const voiceSpeechSchema = z.object({
  /** The wav file, base64 encoded. */
  audio: z.string(),
  contentType: z.literal('audio/wav')
});
export type VoiceSpeech = z.infer<typeof voiceSpeechSchema>;

export const voiceTranscribeSchema = z.object({
  /** A wav file (16-bit PCM is what the dashboard records), base64 encoded, at most 5 MiB decoded. */
  audio: z
    .base64()
    .min(1)
    .max(VOICE_AUDIO_MAX_BASE64)
    .refine((v) => base64DecodedLength(v) <= VOICE_AUDIO_MAX_BYTES, {
      error: `audio is larger than ${VOICE_AUDIO_MAX_BYTES} bytes`
    }),
  contentType: z.literal('audio/wav'),
  /** The language spoken. Without a language, Gradium detects it (`any`). */
  language: z.enum(VOICE_LANGUAGES).optional()
});
export type VoiceTranscribeRequest = z.infer<typeof voiceTranscribeSchema>;

export const voiceTranscriptSchema = z.object({ text: z.string() });
export type VoiceTranscript = z.infer<typeof voiceTranscriptSchema>;
