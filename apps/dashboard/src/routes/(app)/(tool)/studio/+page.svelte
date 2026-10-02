<script lang="ts">
  import { onDestroy } from 'svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import GraduationCap from '@lucide/svelte/icons/graduation-cap';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { api, errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import type { Project } from '$lib/projects/types';
  import { fromBase64 } from '$lib/tool/wav';
  import type { Run } from '@app/contract';
  import {
    TUTOR_QUESTIONS,
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
    learnerName: '',
    age: '',
    subject: '',
    level: '',
    learningStyle: '',
    tone: '',
    language: ''
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
  let disposed = false;
  let playback: { context: AudioContext; source: AudioBufferSourceNode } | null = null;

  const isGuest = $derived(data.me.origin === 'guest');
  const question = $derived(TUTOR_QUESTIONS[questionIndex]);
  const summary = $derived([
    `${profile.learnerName}, ${profile.age}`,
    profile.subject,
    profile.level,
    profile.learningStyle,
    profile.tone,
    profile.language
  ]);

  function submitAnswer(value: string | number = draft) {
    const answer = String(value).trim();
    if (!answer || !question) return;
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
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function createTutor() {
    phase = 'researching';
    createError = null;
    try {
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
      const project = await projects.create({
        name: tutorProjectName(profile),
        description: tutorProjectDescription(profile, research).slice(0, 2000)
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
      const { audio } = await api.speak(research.welcome);
      stopPlayback();
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(fromBase64(audio).slice().buffer as ArrayBuffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start();
      playback = { context, source };
    } catch (error) {
      voiceError = errorMessage(error, 'Gradium could not play the tutor welcome.');
    } finally {
      speaking = false;
    }
  }

  onDestroy(() => {
    disposed = true;
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

    <h1 class="mt-10 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
      {question.prompt}
    </h1>

    {#if question.choices}
      <div class="mt-10 grid gap-3">
        {#each question.choices as choice (choice)}
          <button
            type="button"
            class="group flex min-h-16 items-center justify-between rounded-3xl border-2 border-white bg-white px-6 text-left text-lg font-semibold text-slate-800 shadow-sm shadow-sky-100 transition-all hover:-translate-y-0.5 hover:border-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            onclick={() => submitAnswer(choice)}
          >
            {choice}
            <ArrowRight
              class="h-5 w-5 text-sky-300 transition-colors group-hover:text-sky-500"
              aria-hidden="true"
            />
          </button>
        {/each}
      </div>
    {:else}
      <div
        class="mt-10 flex items-center gap-2 rounded-3xl border-2 border-white bg-white p-2 pl-6 shadow-sm shadow-sky-100 focus-within:border-sky-300"
      >
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          inputmode={question.field === 'age' ? 'numeric' : undefined}
          bind:value={draft}
          placeholder={question.placeholder}
          aria-label={question.prompt}
          onkeydown={handleKeydown}
          autofocus
          class="min-h-12 min-w-0 flex-1 bg-transparent text-lg text-slate-900 outline-none placeholder:text-slate-300"
        />
        <button
          type="button"
          class="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-sky-500 text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-100 disabled:text-sky-300"
          aria-label="Next"
          title="Next"
          disabled={!String(draft).trim()}
          onclick={() => submitAnswer()}
        >
          <ArrowRight class="h-5 w-5" />
        </button>
      </div>
    {/if}
  {:else if phase === 'review'}
    <div class="text-center">
      <h1 class="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Ready?</h1>
      <ul class="mt-10 flex flex-wrap justify-center gap-2">
        {#each summary as detail, index (index)}
          <li
            class="rounded-full bg-white px-4 py-2 text-sm font-medium text-sky-800 shadow-sm shadow-sky-100"
          >
            {detail}
          </li>
        {/each}
      </ul>
      <button
        type="button"
        class="mt-12 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-sky-500 px-10 text-lg font-bold text-white shadow-lg shadow-sky-200 transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 sm:w-auto"
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
