import { api } from '$lib/api';
import type { IntegrationName, IntegrationStatus, Run, VoiceLanguage } from '@app/contract';
import { INTEGRATION_ENV_KEYS } from '@app/contract';

/**
 * What the Try it page reads and decides, kept out of the component so it is
 * tested: the runs list's remembered name and its one call, the chip of an
 * integration, and which runs are still worth asking about.
 */

export const RUNS_LIST = 'runs';
/** How often a running run is asked about while the page is open. */
export const RUN_POLL_MS = 3000;

export async function runsPage(p: { cursor?: string; limit?: number }) {
  const { runs, nextCursor } = await api.listRuns(p);
  return { items: runs, nextCursor };
}

/**
 * The language select next to Record, in the order it shows: detection
 * first (the default), then the languages Gradium transcribes.
 */
export const TRANSCRIBE_LANGUAGE_CHOICES: readonly VoiceLanguage[] = ['any', 'fr', 'en', 'de', 'es', 'pt'];
export const TRANSCRIBE_LANGUAGE_DEFAULT: VoiceLanguage = 'any';

/** The i18n key of a language's option. */
export function languageKey(language: VoiceLanguage) {
  return `try.language.${language}` as const;
}

/**
 * What a transcript does to the page: an empty one (nothing was heard) is
 * a sentence and leaves the instruction as it was; any other becomes the
 * transcript shown and the instruction.
 */
export function transcriptOutcome(
  text: string
): { heard: false } | { heard: true; transcript: string; instruction: string } {
  if (text.trim() === '') return { heard: false };
  return { heard: true, transcript: text, instruction: text };
}

export type ChipTone = 'checking' | 'ready' | 'missing' | 'failing';

export interface Chip {
  tone: ChipTone;
  /** The i18n key of the sentence, and its values. */
  key: 'try.checking' | 'try.ready' | 'try.readyDetail' | 'try.notConfigured' | 'try.failing';
  values: Record<string, string>;
}

/** An integration's chip: not yet known, configured and answering, not configured (the key to set), failing. */
export function chipOf(name: IntegrationName, status: IntegrationStatus | undefined): Chip {
  if (!status) return { tone: 'checking', key: 'try.checking', values: {} };
  if (!status.configured) {
    return { tone: 'missing', key: 'try.notConfigured', values: { envKey: INTEGRATION_ENV_KEYS[name] } };
  }
  if (status.ok === false)
    return { tone: 'failing', key: 'try.failing', values: { detail: status.detail ?? '' } };
  return status.detail
    ? { tone: 'ready', key: 'try.readyDetail', values: { detail: status.detail } }
    : { tone: 'ready', key: 'try.ready', values: {} };
}

/** The runs, each as last heard of: a polled copy wins over the list's. */
export function withFresh(runs: readonly Run[], fresh: ReadonlyMap<string, Run>): Run[] {
  return runs.map((r) => fresh.get(r.id) ?? r);
}

/** The ids to ask about on the next tick: the ones still running. */
export function stillRunning(runs: readonly Run[]): string[] {
  return runs.filter((r) => r.state === 'running').map((r) => r.id);
}
