<script lang="ts">
  import { onDestroy } from 'svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import GraduationCap from '@lucide/svelte/icons/graduation-cap';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Mic from '@lucide/svelte/icons/mic';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Square from '@lucide/svelte/icons/square';
  import Check from '@lucide/svelte/icons/check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { api, errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import type { Project } from '$lib/projects/types';
  import { downsample, encodeWav, fromBase64, mergeChunks, toBase64 } from '$lib/tool/wav';
  import type { Run } from '@app/contract';
  import {
    TUTOR_QUESTIONS,
    TUTOR_VOICE_STYLES,
    buildTutorResearchInstruction,
    lessonNote,
    parseTutorResearch,
    tutorProjectDescription,
    tutorProjectName,
    type TutorProfile,
    type TutorResearch
  } from '$lib/tool/tutors';

  let { data } = $props();

  type Phase = 'questions' | 'review' | 'researching' | 'ready';

  const emptyProfile = (): TutorProfile => ({
    learnerName: 'Learner',
    age: '',
    gender: '',
    subject: '',
    interests: '',
    level: '',
    learningStyle: '',
    tone: 'Warm and encouraging',
    language: 'English'
  });

  let phase = $state<Phase>('questions');
  let questionIndex = $state(0);
  let draft = $state('');
  let profile = $state<TutorProfile>(emptyProfile());
  let activeRun = $state<Run | null>(null);
  let research = $state<TutorResearch | null>(null);
  let createdProject = $state<Project | null>(null);
  let createError = $state<string | null>(null);
  let speaking = $state(false);
  let voiceError = $state<string | null>(null);
  let answerError = $state<string | null>(null);
  let tutorName = $state('Nova');
  let voiceStyleId = $state<(typeof TUTOR_VOICE_STYLES)[number]['id']>('warm');
  let voiceCandidateId = $state<string | null>(null);
  let savedVoiceId = $state<string | null>(null);
  let designingVoice = $state(false);
  let recording = $state(false);
  let transcribing = $state(false);
  let recorder: {
    context: AudioContext;
    stream: MediaStream;
    node: ScriptProcessorNode;
    chunks: Float32Array[];
  } | null = null;
  let disposed = false;
  let playback: { context: AudioContext; source: AudioBufferSourceNode } | null = null;

  const isGuest = $derived(data.me.origin === 'guest');
  const question = $derived(TUTOR_QUESTIONS[questionIndex]);
  const summary = $derived(
    [
      `${profile.age} years old`,
      profile.subject,
      profile.interests,
      profile.learningStyle,
      profile.level
    ].filter(Boolean)
  );
  const voiceStyle = $derived(
    TUTOR_VOICE_STYLES.find((style) => style.id === voiceStyleId) ?? TUTOR_VOICE_STYLES[0]
  );

  const spokenAges: Record<string, string> = {
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
    ten: '10',
    eleven: '11',
    twelve: '12',
    thirteen: '13',
    fourteen: '14',
    fifteen: '15',
    sixteen: '16',
    seventeen: '17',
    eighteen: '18'
  };

  function submitAnswer(value: string | number = draft) {
    let answer = String(value).trim();
    if (!answer || !question) return;
    answerError = null;
    if (question.field === 'age') {
      answer = spokenAges[answer.toLowerCase().replace(/[^a-z]/g, '')] ?? answer;
      const age = Number(answer);
      if (!Number.isInteger(age) || age < 3 || age > 18) {
        answerError = 'Please enter a whole age from 3 to 18.';
        return;
      }
      answer = String(age);
    }
    if (question.field === 'gender' && answer === 'Prefer to skip') answer = '';
    profile[question.field] = answer;
    draft = '';
    if (questionIndex === TUTOR_QUESTIONS.length - 1) {
      questionIndex = TUTOR_QUESTIONS.length;
      phase = 'review';
      return;
    }
    questionIndex += 1;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submitAnswer();
  }

  function reset() {
    if (recorder) {
      recorder.node.disconnect();
      for (const track of recorder.stream.getTracks()) track.stop();
      void recorder.context.close().catch(() => {});
      recorder = null;
      recording = false;
    }
    stopPlayback();
    phase = 'questions';
    questionIndex = 0;
    draft = '';
    profile = emptyProfile();
    activeRun = null;
    research = null;
    createdProject = null;
    createError = null;
    voiceError = null;
    answerError = null;
    tutorName = 'Nova';
    voiceStyleId = 'warm';
    voiceCandidateId = null;
    savedVoiceId = null;
    designingVoice = false;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function playAudio(audio: string) {
    stopPlayback();
    const context = new AudioContext();
    return context.decodeAudioData(fromBase64(audio).slice().buffer as ArrayBuffer).then((buffer) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start();
      playback = { context, source };
    });
  }

  function selectVoiceStyle(id: (typeof TUTOR_VOICE_STYLES)[number]['id']) {
    voiceStyleId = id;
    voiceCandidateId = null;
    savedVoiceId = null;
    stopPlayback();
  }

  async function designVoice(playPreview = true): Promise<string> {
    const previewText = `Hi! I'm ${tutorName.trim() || 'your tutor'}. We are going to learn together.`;
    if (voiceCandidateId) {
      if (playPreview) {
        const { audio } = await api.speak(previewText, { voiceId: voiceCandidateId });
        await playAudio(audio);
      }
      return voiceCandidateId;
    }
    designingVoice = true;
    voiceError = null;
    try {
      const candidate = await api.designVoice({
        prompt: voiceStyle.prompt,
        language: profile.language.toLowerCase().startsWith('fr') ? 'fr' : 'en',
        previewText
      });
      voiceCandidateId = candidate.candidateId;
      if (playPreview) await playAudio(candidate.audio);
      return candidate.candidateId;
    } catch (error) {
      voiceError = errorMessage(error, 'Gradium could not design this voice. Please try again.');
      throw error;
    } finally {
      designingVoice = false;
    }
  }

  async function createTutor() {
    if (!tutorName.trim()) {
      createError = 'Give your tutor a name first.';
      return;
    }
    phase = 'researching';
    createError = null;
    try {
      const candidateId = await designVoice(false);
      const saved = await api.saveVoice({
        candidateId,
        name: tutorName.trim(),
        description: `${voiceStyle.name} for a personalized ${profile.subject} tutor`
      });
      savedVoiceId = saved.voiceId;
      const { run } = await api.createRun({ instruction: buildTutorResearchInstruction(profile) });
      activeRun = run;

      while (!disposed && activeRun.state === 'running') {
        await wait(3000);
        if (disposed) return;
        activeRun = await api.getRun(activeRun.id);
      }

      if (activeRun.state !== 'completed' || !activeRun.answer) {
        throw new Error(activeRun.error || 'H could not complete the curriculum research.');
      }

      research = parseTutorResearch(activeRun.answer, profile);
      research.tutorName = tutorName.trim();
      const project = await projects.create({
        name: tutorProjectName(profile, tutorName),
        description: tutorProjectDescription(profile, research, {
          tutorName,
          voiceId: savedVoiceId ?? undefined,
          voiceStyle: voiceStyle.name
        }).slice(0, 2000)
      });

      // One after the other, so the lessons keep their order.
      for (const [index, lesson] of research.lessons.entries()) {
        await api.createItem({
          name: `${index + 1}. ${lesson.title}`.slice(0, 200),
          note: lessonNote(lesson, research),
          projectIds: [project.id]
        });
      }

      createdProject = project;
      phase = 'ready';
    } catch (error) {
      createError = errorMessage(error, 'The tutor could not be created.');
      phase = 'review';
    }
  }

  function stopPlayback() {
    if (!playback) return;
    try {
      playback.source.stop();
    } catch {
      // The source may already have ended.
    }
    void playback.context.close().catch(() => {});
    playback = null;
  }

  async function speakWelcome() {
    if (!research) return;
    voiceError = null;
    speaking = true;
    try {
      const { audio } = await api.speak(research.welcome, { voiceId: savedVoiceId ?? undefined });
      await playAudio(audio);
    } catch (error) {
      voiceError = errorMessage(error, 'Gradium could not play the tutor welcome.');
    } finally {
      speaking = false;
    }
  }

  async function transcribeRecording(wav: Uint8Array) {
    transcribing = true;
    voiceError = null;
    try {
      const { text } = await api.transcribe({
        audio: toBase64(wav),
        contentType: 'audio/wav',
        language: 'any'
      });
      const transcript = text.trim();
      if (!transcript) throw new Error("I couldn't hear an answer. Please try again.");
      draft = transcript;
    } catch (error) {
      voiceError = errorMessage(error, 'Your answer could not be transcribed.');
    } finally {
      transcribing = false;
    }
  }

  async function startRecording() {
    voiceError = null;
    answerError = null;
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
    } catch (error) {
      voiceError = `The microphone could not be opened: ${error instanceof Error ? error.message : String(error)}`;
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
    await transcribeRecording(encodeWav(samples, Math.min(rate, 16000)));
  }

  onDestroy(() => {
    disposed = true;
    if (recorder) {
      recorder.node.disconnect();
      for (const track of recorder.stream.getTracks()) track.stop();
      void recorder.context.close().catch(() => {});
    }
    stopPlayback();
  });
</script>

<svelte:head>
  <title>Create a tutor · Tutor Studio</title>
</svelte:head>

<div class="mx-auto w-full max-w-xl px-5 pb-16 pt-10 sm:pt-16" data-testid="tutor-builder">
  {#if isGuest}
    <p class="pt-10 text-center text-slate-500">Only workspace members can create tutors.</p>
  {:else if phase === 'questions' && question}
    <div class="flex h-11 items-center justify-between">
      <div class="flex gap-1.5" aria-label={`Question ${questionIndex + 1} of ${TUTOR_QUESTIONS.length}`}>
        {#each TUTOR_QUESTIONS as q, index (q.field)}
          <span
            class="h-2 rounded-full transition-all duration-300 motion-reduce:transition-none {index <
            questionIndex
              ? 'w-6 bg-sky-400'
              : index === questionIndex
                ? 'w-10 bg-sky-500'
                : 'w-6 bg-sky-100'}"
          ></span>
        {/each}
      </div>
      {#if questionIndex > 0}
        <button
          type="button"
          class="inline-flex h-11 w-11 items-center justify-center rounded-full text-slate-400 hover:bg-white hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Start over"
          title="Start over"
          onclick={reset}
        >
          <RotateCcw class="h-4 w-4" />
        </button>
      {/if}
    </div>

    {#if questionIndex === 0}
      <div class="mt-8 flex items-start gap-3 rounded-2xl bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-900">
        <ShieldCheck class="mt-0.5 h-5 w-5 shrink-0 text-sky-500" />
        <p>
          Let’s find the right way for you to learn. Don’t share your full name, school, or contact details.
        </p>
      </div>
    {/if}

    <p class="mt-9 text-sm font-bold uppercase tracking-widest text-sky-500">A quick question</p>
    <h1 class="mt-3 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
      {question.prompt}
    </h1>

    {#if question.choices}
      <div class="mt-8 grid gap-3 sm:grid-cols-2">
        {#each question.choices as choice (choice)}
          <button
            type="button"
            class="group flex min-h-16 items-center justify-between rounded-3xl border-2 border-white bg-white px-6 text-left text-lg font-semibold text-slate-800 shadow-sm shadow-sky-100 transition-all hover:-translate-y-0.5 hover:border-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            onclick={() => submitAnswer(choice)}
            disabled={recording || transcribing}
          >
            {choice}
            <ArrowRight
              class="h-5 w-5 text-sky-300 transition-colors group-hover:text-sky-500"
              aria-hidden="true"
            />
          </button>
        {/each}
      </div>
      <p class="mt-6 text-center text-xs font-semibold uppercase tracking-wider text-slate-400">
        or answer your way
      </p>
    {/if}

    <div
      class="mt-6 flex items-center gap-2 rounded-3xl border-2 border-white bg-white p-2 pl-5 shadow-sm shadow-sky-100 focus-within:border-sky-300"
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        inputmode={question.field === 'age' ? 'numeric' : undefined}
        bind:value={draft}
        placeholder={recording
          ? 'Listening…'
          : transcribing
            ? 'Writing what you said…'
            : question.placeholder}
        aria-label={question.prompt}
        onkeydown={handleKeydown}
        autofocus
        disabled={recording || transcribing}
        class="min-h-12 min-w-0 flex-1 bg-transparent text-lg text-slate-900 outline-none placeholder:text-slate-300 disabled:opacity-70"
      />
      <button
        type="button"
        class="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 {recording
          ? 'bg-red-50 text-red-600 hover:bg-red-100'
          : 'bg-sky-50 text-sky-600 hover:bg-sky-100'}"
        aria-label={recording ? 'Stop recording' : 'Answer with your voice'}
        title={recording ? 'Stop recording' : 'Answer with your voice'}
        disabled={transcribing}
        onclick={() => (recording ? void stopRecording() : void startRecording())}
      >
        {#if transcribing}
          <LoaderCircle class="h-5 w-5 animate-spin motion-reduce:animate-none" />
        {:else if recording}
          <Square class="h-4 w-4 fill-current" />
        {:else}
          <Mic class="h-5 w-5" />
        {/if}
      </button>
      <button
        type="button"
        class="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-sky-500 text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-100 disabled:text-sky-300"
        aria-label="Next"
        title="Next"
        disabled={!String(draft).trim() || recording || transcribing}
        onclick={() => submitAnswer()}
      >
        <ArrowRight class="h-5 w-5" />
      </button>
    </div>
    {#if recording}
      <p class="mt-3 text-center text-sm font-medium text-red-600" aria-live="polite">
        Recording… tap stop when you’re done.
      </p>
    {:else if voiceError || answerError}
      <p class="mt-3 text-center text-sm text-red-600" role="alert">{voiceError ?? answerError}</p>
    {:else}
      <p class="mt-3 text-center text-sm text-slate-400">Type an answer or use the microphone.</p>
    {/if}
  {:else if phase === 'review'}
    <div>
      <p class="text-sm font-bold uppercase tracking-widest text-sky-500">Tutor identity</p>
      <h1 class="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Make your tutor yours</h1>
      <ul class="mt-6 flex flex-wrap gap-2">
        {#each summary as detail, index (index)}
          <li
            class="rounded-full bg-white px-4 py-2 text-sm font-medium text-sky-800 shadow-sm shadow-sky-100"
          >
            {detail}
          </li>
        {/each}
      </ul>

      <label class="mt-10 block text-sm font-bold text-slate-700" for="tutor-name">Tutor name</label>
      <input
        id="tutor-name"
        bind:value={tutorName}
        maxlength="80"
        class="mt-2 min-h-14 w-full rounded-2xl border-2 border-white bg-white px-5 text-lg font-semibold text-slate-900 shadow-sm shadow-sky-100 outline-none focus:border-sky-300"
        placeholder="For example: Nova"
        oninput={() => {
          voiceCandidateId = null;
          savedVoiceId = null;
        }}
      />

      <fieldset class="mt-8">
        <legend class="text-sm font-bold text-slate-700">How should your tutor sound?</legend>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          {#each TUTOR_VOICE_STYLES as style (style.id)}
            <button
              type="button"
              class="relative min-h-28 rounded-2xl border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 {voiceStyleId ===
              style.id
                ? 'border-sky-400 bg-sky-50'
                : 'border-white bg-white hover:border-sky-200'}"
              aria-pressed={voiceStyleId === style.id}
              onclick={() => selectVoiceStyle(style.id)}
            >
              {#if voiceStyleId === style.id}
                <Check class="absolute right-3 top-3 h-4 w-4 text-sky-600" />
              {/if}
              <span class="block pr-5 font-bold text-slate-900">{style.name}</span>
              <span class="mt-2 block text-sm leading-5 text-slate-500">{style.description}</span>
            </button>
          {/each}
        </div>
      </fieldset>

      <button
        type="button"
        class="mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-sky-700 shadow-sm shadow-sky-100 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60"
        disabled={designingVoice || !tutorName.trim()}
        onclick={() => void designVoice(true)}
      >
        {#if designingVoice}
          <LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" /> Designing voice…
        {:else}
          <Volume2 class="h-4 w-4" /> {voiceCandidateId ? 'Play preview again' : 'Preview voice'}
        {/if}
      </button>
      {#if voiceCandidateId}
        <p class="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
          <Sparkles class="h-4 w-4" /> Unique voice ready
        </p>
      {/if}
      {#if voiceError}
        <p class="mt-3 text-sm text-red-600" role="alert">{voiceError}</p>
      {/if}

      <button
        type="button"
        class="mt-10 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-sky-500 px-10 text-lg font-bold text-white shadow-lg shadow-sky-200 transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-200"
        disabled={designingVoice || !tutorName.trim()}
        onclick={() => void createTutor()}
      >
        Create my tutor
      </button>
      <div>
        <button
          type="button"
          class="mt-3 min-h-11 rounded-full px-4 text-sm text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          onclick={reset}
        >
          Start over
        </button>
      </div>
      {#if createError}
        <p class="mt-4 text-sm text-red-600" role="alert">{createError}</p>
      {/if}
    </div>
  {:else if phase === 'researching'}
    <div class="pt-6 text-center" aria-live="polite">
      <div class="relative mx-auto h-24 w-24">
        <span
          class="absolute inset-0 animate-ping rounded-full bg-sky-200 opacity-60 motion-reduce:animate-none"
        ></span>
        <span
          class="relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-sky-600 text-white shadow-lg shadow-sky-200"
        >
          <GraduationCap class="h-10 w-10" />
        </span>
      </div>
      <h1 class="mt-10 text-3xl font-bold tracking-tight text-slate-900">Creating your tutor…</h1>
      <p class="mt-3 text-slate-500">H is researching lessons. About a minute.</p>
      {#if activeRun?.liveUrl}
        <a
          href={activeRun.liveUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="mt-8 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-white px-5 text-sm font-semibold text-sky-700 shadow-sm shadow-sky-100 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Watch H live <ExternalLink class="h-3.5 w-3.5" />
        </a>
      {/if}
    </div>
  {:else if phase === 'ready' && research && createdProject}
    <div class="text-center">
      <span
        class="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-sky-600 text-white shadow-lg shadow-sky-200"
      >
        <GraduationCap class="h-10 w-10" />
      </span>
      <h1 class="mt-8 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{research.tutorName}</h1>
      <p class="mx-auto mt-4 max-w-md text-lg leading-8 text-slate-600">{research.welcome}</p>
      <div class="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button
          type="button"
          class="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-white px-7 text-lg font-semibold text-sky-700 shadow-sm shadow-sky-100 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60 sm:w-auto"
          disabled={speaking}
          onclick={() => void speakWelcome()}
        >
          {#if speaking}
            <LoaderCircle class="h-5 w-5 animate-spin motion-reduce:animate-none" />
          {:else}
            <Volume2 class="h-5 w-5" />
          {/if}
          Listen
        </button>
        <a
          href={`/studio/tutors/${createdProject.id}/room`}
          class="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-sky-500 px-10 text-lg font-bold text-white shadow-lg shadow-sky-200 transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 sm:w-auto"
        >
          Start learning <ArrowRight class="h-5 w-5" />
        </a>
      </div>
      {#if voiceError}
        <p class="mt-4 text-sm text-red-600" role="alert">{voiceError}</p>
      {/if}
      <a
        href={`/studio/tutors/${createdProject.id}`}
        class="mt-6 inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        See lessons and sources
      </a>
    </div>
  {/if}
</div>
