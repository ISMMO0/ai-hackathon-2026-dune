import { describe, expect, it, vi } from 'vitest';
import { VOICE_LANGUAGES, type Run } from '@app/contract';

const listRuns = vi.fn();
vi.mock('$lib/api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: { listRuns }
}));

const {
  TRANSCRIBE_LANGUAGE_CHOICES,
  TRANSCRIBE_LANGUAGE_DEFAULT,
  chipOf,
  languageKey,
  runsPage,
  transcriptOutcome,
  stillRunning,
  withFresh
} = await import('./try');
const { en, fr } = await import('./i18n');

const run = (id: string, state: Run['state']): Run => ({
  id,
  workspaceId: 'w',
  createdBy: null,
  instruction: 'x',
  startUrl: null,
  state,
  liveUrl: null,
  answer: null,
  error: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  finishedAt: null
});

describe('chipOf', () => {
  it('not yet known: checking', () => {
    expect(chipOf('gradium', undefined).tone).toBe('checking');
  });

  it('not configured: names the env key to set', () => {
    expect(chipOf('gradium', { configured: false })).toEqual({
      tone: 'missing',
      key: 'try.notConfigured',
      values: { envKey: 'GRADIUM_API_KEY' }
    });
    expect(chipOf('h', { configured: false }).values).toEqual({ envKey: 'HAI_API_KEY' });
  });

  it('configured and answering: ready, with the detail when the check gave one', () => {
    expect(chipOf('h', { configured: true }).key).toBe('try.ready');
    expect(chipOf('gradium', { configured: true, ok: true, detail: '4200 credits remaining' })).toEqual({
      tone: 'ready',
      key: 'try.readyDetail',
      values: { detail: '4200 credits remaining' }
    });
  });

  it('configured and failing: the detail', () => {
    expect(chipOf('h', { configured: true, ok: false, detail: 'H answered 401' })).toEqual({
      tone: 'failing',
      key: 'try.failing',
      values: { detail: 'H answered 401' }
    });
  });
});

describe('the runs', () => {
  it('runsPage asks the list once and answers it as a page', async () => {
    listRuns.mockResolvedValue({ runs: [run('a', 'running')], nextCursor: null });
    expect(await runsPage({})).toEqual({ items: [run('a', 'running')], nextCursor: null });
    expect(listRuns).toHaveBeenCalledWith({});
  });

  it('a polled copy wins over the list’s, and only running runs are asked about again', () => {
    const list = [run('a', 'running'), run('b', 'completed'), run('c', 'running')];
    const fresh = new Map([['a', run('a', 'completed')]]);
    const shown = withFresh(list, fresh);
    expect(shown.map((r) => r.state)).toEqual(['completed', 'completed', 'running']);
    expect(stillRunning(shown)).toEqual(['c']);
  });
});

describe('the language select', () => {
  it('detection first and by default, then every language the contract takes, each with its en and fr words', () => {
    expect(TRANSCRIBE_LANGUAGE_DEFAULT).toBe('any');
    expect(TRANSCRIBE_LANGUAGE_CHOICES[0]).toBe('any');
    expect([...TRANSCRIBE_LANGUAGE_CHOICES].sort()).toEqual([...VOICE_LANGUAGES].sort());
    for (const language of TRANSCRIBE_LANGUAGE_CHOICES) {
      expect(en[languageKey(language)]).toBeTruthy();
      expect(fr[languageKey(language)]).toBeTruthy();
    }
  });
});

describe('transcriptOutcome', () => {
  it('an empty or blank transcript was not heard: the instruction is left as it was', () => {
    expect(transcriptOutcome('')).toEqual({ heard: false });
    expect(transcriptOutcome('  \n ')).toEqual({ heard: false });
  });

  it('a transcript is shown and becomes the instruction', () => {
    expect(transcriptOutcome('Bonjour')).toEqual({
      heard: true,
      transcript: 'Bonjour',
      instruction: 'Bonjour'
    });
  });

  it('the sentence exists in en and fr', () => {
    expect(en['try.nothingHeard']).toBe('Nothing was heard in the recording.');
    expect(fr['try.nothingHeard']).toBe('Rien n’a été entendu dans l’enregistrement.');
  });
});
