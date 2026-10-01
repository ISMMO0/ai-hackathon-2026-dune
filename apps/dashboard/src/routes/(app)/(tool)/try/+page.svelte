<!-- The Try it page: the starter's demo of its two integrations, built from the
     shell's parts. The integrations strip (GET /integrations?check=true), the
     voice (speak, record or pick a wav, transcribe) and the runs (start one,
     watch it live, read the answer, hear it). A guest sees the page and the
     runs list (empty for them) with none of the controls. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import Mic from '@lucide/svelte/icons/mic';
  import Square from '@lucide/svelte/icons/square';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Globe from '@lucide/svelte/icons/globe';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { appear } from '$lib/components/ui/reveal/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import {
    RUNS_LIST,
    RUN_POLL_MS,
    TRANSCRIBE_LANGUAGE_CHOICES,
    TRANSCRIBE_LANGUAGE_DEFAULT,
    chipOf,
    languageKey,
    transcriptOutcome,
    runsPage,
    stillRunning,
    withFresh,
    type ChipTone
  } from '$lib/tool/try';
  import { downsample, encodeWav, fromBase64, mergeChunks, toBase64 } from '$lib/tool/wav';
  import {
    INTEGRATION_NAMES,
    RUN_INSTRUCTION_MAX,
    VOICE_TEXT_MAX,
    type Integrations,
    type Run,
    type VoiceLanguage
  } from '@app/contract';

  let { data } = $props();

  // A guest may not spend the workspace's credits: the server refuses their
  // POSTs (403) and lists them no run, so the page shows neither controls nor runs.
  const isGuest = $derived(data.me.origin === 'guest');

  // ── The integrations strip ─────────────────────────────────────────────
  let integrations = $state<Integrations | null>(null);
  let integrationsError = $state<string | null>(null);
  const toneVariant: Record<ChipTone, 'secondary' | 'latest' | 'old' | 'destructive'> = {
    checking: 'secondary',
    ready: 'latest',
    missing: 'old',
    failing: 'destructive'
  };
  $effect(() => {
    api
      .integrations({ check: true })
      .then((v) => (integrations = v))
      .catch((e) => (integrationsError = errorMessage(e)));
  });

  // ── Voice ──────────────────────────────────────────────────────────────
  let speakText = $state('');
  let speaking = $state(false);
  // The last wav spoken, played through the Web Audio API: the chassis's
  // Content-Security-Policy has no media-src, so an <audio> element on a
  // blob: URL is blocked by default-src 'self'; decoded bytes are not a load.
  let lastWav = $state<Uint8Array | null>(null);
  let playback: { context: AudioContext; source: AudioBufferSourceNode } | null = null;
  let voiceError = $state<string | null>(null);
  let transcript = $state('');
  let transcribing = $state(false);
  // Set when the last transcript came back empty: nothing was heard.
  let nothingHeard = $state(false);
  // The language spoken, for Record and the .wav input alike; `any` = Gradium detects it.
  let language = $state<VoiceLanguage>(TRANSCRIBE_LANGUAGE_DEFAULT);

  function stopPlayback() {
    if (!playback) return;
    try {
      playback.source.stop();
    } catch {
      // already ended
    }
    void playback.context.close().catch(() => {});
    playback = null;
  }

  async function playWav(bytes: Uint8Array) {
    stopPlayback();
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    playback = { context, source };
  }

  function play(base64: string) {
    lastWav = fromBase64(base64);
    void playWav(lastWav).catch((e) => (voiceError = errorMessage(e)));
  }

  async function speak(text: string) {
    voiceError = null;
    if (!text.trim()) {
      voiceError = t('try.emptyText');
      return;
    }
    speaking = true;
    try {
      play((await api.speak(text)).audio);
    } catch (e) {
      voiceError = errorMessage(e);
    } finally {
      speaking = false;
    }
  }

  async function transcribe(wav: Uint8Array) {
    voiceError = null;
    nothingHeard = false;
    transcribing = true;
    try {
      const { text } = await api.transcribe({ audio: toBase64(wav), contentType: 'audio/wav', language });
      const outcome = transcriptOutcome(text);
      if (outcome.heard) {
        transcript = outcome.transcript;
        instruction = outcome.instruction;
      } else {
        transcript = '';
        nothingHeard = true;
      }
    } catch (e) {
      voiceError = errorMessage(e);
    } finally {
      transcribing = false;
    }
  }

  // The microphone, through the Web Audio API: float samples collected while
  // recording, then one 16 kHz, 16-bit mono PCM WAV (`$lib/tool/wav`).
  let recording = $state(false);
  let recorder: {
    context: AudioContext;
    stream: MediaStream;
    node: ScriptProcessorNode;
    chunks: Float32Array[];
  } | null = null;

  async function startRecording() {
    voiceError = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const node = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(context.destination);
      recorder = { context, stream, node, chunks };
      recording = true;
    } catch (e) {
      voiceError = t('try.micDenied', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function stopRecording() {
    const current = recorder;
    recorder = null;
    recording = false;
    if (!current) return;
    current.node.disconnect();
    for (const track of current.stream.getTracks()) track.stop();
    const rate = current.context.sampleRate;
    await current.context.close().catch(() => {});
    const samples = downsample(mergeChunks(current.chunks), rate, 16000);
    await transcribe(encodeWav(samples, Math.min(rate, 16000)));
  }

  async function transcribeFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await transcribe(new Uint8Array(await file.arrayBuffer()));
  }

  onDestroy(() => {
    if (recorder) {
      recorder.node.disconnect();
      for (const track of recorder.stream.getTracks()) track.stop();
      void recorder.context.close().catch(() => {});
    }
    stopPlayback();
  });

  // ── Runs ───────────────────────────────────────────────────────────────
  let instruction = $state('');
  let startUrl = $state('');
  let starting = $state(false);
  let runError = $state<string | null>(null);

  const list = createPagedList<Run>(runsPage, { remember: RUNS_LIST });
  $effect(() => {
    void list.load();
  });

  // The copies the poll brought back: a running run is asked about every 3 s
  // while the page is open (`GET /runs/{id}` asks H), until it settles.
  const fresh = new SvelteMap<string, Run>();
  const runs = $derived(withFresh(list.items, fresh));

  $effect(() => {
    const timer = setInterval(() => {
      for (const id of stillRunning(runs)) {
        void api
          .getRun(id)
          .then((r) => fresh.set(r.id, r))
          .catch(() => {});
      }
    }, RUN_POLL_MS);
    return () => clearInterval(timer);
  });

  async function startRun() {
    runError = null;
    if (!instruction.trim()) {
      runError = t('try.emptyInstruction');
      return;
    }
    starting = true;
    try {
      await api.createRun({ instruction, ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}) });
      await list.refresh();
    } catch (e) {
      runError = errorMessage(e);
    } finally {
      starting = false;
    }
  }

  const stateLabel = (state: Run['state']) =>
    state === 'running'
      ? t('try.stateRunning')
      : state === 'completed'
        ? t('try.stateCompleted')
        : t('try.stateFailed');
  const stateVariant = (state: Run['state']) =>
    state === 'running' ? 'old' : state === 'completed' ? 'latest' : 'destructive';
</script>

<svelte:head>
  <title>{t('try.title')} · {data.instance.name}</title>
</svelte:head>

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('try.title')}
  lede={t('try.description')}
  drawing="harmonic"
/>

<div class="space-y-6 pb-10">
  <!-- The integrations strip -->
  <div class="flex flex-wrap items-center gap-2" data-testid="integrations-strip">
    <span class="text-sm text-muted-foreground">{t('try.integrationsLabel')}</span>
    {#each INTEGRATION_NAMES as name (name)}
      {@const chip = chipOf(name, integrations?.[name])}
      <Badge variant={toneVariant[chip.tone]} data-testid="integration-{name}">
        {t(name === 'gradium' ? 'try.gradium' : 'try.h')} · {t(chip.key, chip.values)}
      </Badge>
    {/each}
    <FormError message={integrationsError} />
  </div>

  {#if isGuest}
    <p class="text-sm text-muted-foreground" data-testid="try-guest-note">{t('try.guestNote')}</p>
  {:else}
    <!-- Voice -->
    <Card.Root data-testid="voice-card">
      <Card.Header>
        <Card.Title class="text-base">{t('try.voiceTitle')}</Card.Title>
        <Card.Description>{t('try.voiceDescription')}</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="space-y-2">
          <Label for="try-speak-text">{t('try.speakLabel')}</Label>
          <Textarea
            id="try-speak-text"
            bind:value={speakText}
            maxlength={VOICE_TEXT_MAX}
            placeholder={t('try.speakPlaceholder')}
            rows={2}
          />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" class="gap-1.5" onclick={() => void speak(speakText)} disabled={speaking}>
            <Volume2 class="h-4 w-4" />
            {speaking ? t('try.speaking') : t('try.speak')}
          </Button>
          {#if recording}
            <Button size="sm" variant="destructive" class="gap-1.5" onclick={() => void stopRecording()}>
              <Square class="h-4 w-4" />
              {t('try.stop')}
            </Button>
          {:else}
            <Button
              size="sm"
              variant="outline"
              class="gap-1.5"
              onclick={() => void startRecording()}
              disabled={transcribing}
            >
              <Mic class="h-4 w-4" />
              {transcribing ? t('try.transcribing') : t('try.record')}
            </Button>
          {/if}
          <Select.Root
            type="single"
            value={language}
            onValueChange={(v) => (language = v as VoiceLanguage)}
            disabled={recording || transcribing}
          >
            <Select.Trigger class="h-8 w-52" aria-label={t('try.languageLabel')} data-testid="try-language">
              <span class="truncate">{t(languageKey(language))}</span>
            </Select.Trigger>
            <Select.Content>
              {#each TRANSCRIBE_LANGUAGE_CHOICES as choice (choice)}
                <Select.Item value={choice} label={t(languageKey(choice))} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        {#if lastWav}
          <Button
            variant="outline"
            size="sm"
            data-testid="speech-replay"
            onclick={() => void playWav(lastWav!).catch((e) => (voiceError = errorMessage(e)))}
          >
            {t('try.playAgain')}
          </Button>
        {/if}
        <div class="space-y-2">
          <Label for="try-wav-file">{t('try.fileLabel')}</Label>
          <Input
            id="try-wav-file"
            type="file"
            accept=".wav,audio/wav"
            onchange={(e) => void transcribeFile(e)}
            disabled={transcribing}
          />
        </div>
        {#if nothingHeard}
          <p class="text-sm text-muted-foreground" data-testid="nothing-heard" in:appear>
            {t('try.nothingHeard')}
          </p>
        {/if}
        {#if transcript}
          <div class="space-y-1" in:appear>
            <p class="text-sm font-medium">{t('try.transcriptLabel')}</p>
            <!-- USER CONTENT (a transcript): text interpolation only. -->
            <p class="text-sm" data-testid="transcript">{transcript}</p>
            <p class="text-xs text-muted-foreground">{t('try.transcriptHint')}</p>
          </div>
        {/if}
        <FormError message={voiceError} />
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Runs -->
  <Card.Root data-testid="runs-card">
    <Card.Header>
      <Card.Title class="text-base">{t('try.runsTitle')}</Card.Title>
      <Card.Description>{t('try.runsDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#if !isGuest}
        <div class="space-y-2">
          <Label for="try-instruction">{t('try.instructionLabel')}</Label>
          <Textarea
            id="try-instruction"
            bind:value={instruction}
            maxlength={RUN_INSTRUCTION_MAX}
            placeholder={t('try.instructionPlaceholder')}
            rows={2}
          />
        </div>
        <div class="space-y-2">
          <Label for="try-start-url">{t('try.startUrlLabel')}</Label>
          <Input
            id="try-start-url"
            type="url"
            bind:value={startUrl}
            placeholder={t('try.startUrlPlaceholder')}
          />
        </div>
        <Button size="sm" class="gap-1.5" onclick={() => void startRun()} disabled={starting}>
          <Globe class="h-4 w-4" />
          {starting ? t('try.starting') : t('try.run')}
        </Button>
        <FormError message={runError} />
      {/if}

      {#if list.error && !runs.length}
        <p class="text-sm text-destructive">{t('try.runsLoadFailed', { error: list.error })}</p>
      {:else if !list.loading && !runs.length}
        <p class="text-sm text-muted-foreground" data-testid="runs-empty">{t('try.runsEmpty')}</p>
      {:else}
        <ul class="divide-y" data-testid="runs-list">
          {#each runs as run (run.id)}
            <li class="space-y-2 py-3" data-testid="run-row">
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant={stateVariant(run.state)}>{stateLabel(run.state)}</Badge>
                <span class="text-xs text-muted-foreground">{formatTimeAgo(run.createdAt)}</span>
                {#if run.state === 'running' && run.liveUrl}
                  <a
                    href={run.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-xs underline"
                  >
                    {t('try.watchLive')}
                    <ExternalLink class="h-3 w-3" />
                  </a>
                {/if}
              </div>
              <!-- USER CONTENT (an instruction, an answer): text interpolation only. -->
              <p class="text-sm">{run.instruction}</p>
              {#if run.state === 'completed' && run.answer !== null}
                <div class="space-y-1">
                  <p class="text-xs font-medium text-muted-foreground">{t('try.answerLabel')}</p>
                  <p class="whitespace-pre-wrap text-sm" data-testid="run-answer">{run.answer}</p>
                  {#if !isGuest}
                    <Button
                      size="sm"
                      variant="outline"
                      class="gap-1.5"
                      onclick={() => void speak(run.answer ?? '')}
                      disabled={speaking}
                    >
                      <Volume2 class="h-4 w-4" />
                      {t('try.readAloud')}
                    </Button>
                  {/if}
                </div>
              {/if}
              {#if run.state === 'failed' && run.error}
                <p class="text-xs text-destructive">{t('try.failedBecause', { error: run.error })}</p>
              {/if}
            </li>
          {/each}
        </ul>
        {#if list.nextCursor}
          <Button
            variant="outline"
            size="sm"
            onclick={() => void list.loadMore()}
            disabled={list.loadingMore}
          >
            {list.loadingMore ? t('common.loading') : t('common.loadMore')}
          </Button>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</div>
