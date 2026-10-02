<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import GraduationCap from '@lucide/svelte/icons/graduation-cap';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import { api, errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import type { Project } from '$lib/projects/types';
  import { fromBase64 } from '$lib/tool/wav';
  import type { Run } from '@app/contract';
  import {
    TUTOR_QUESTIONS,
    buildTutorResearchInstruction,
    isTutorProject,
    lessonNote,
    parseTutorResearch,
    tutorProjectDescription,
    tutorProjectName,
    type TutorProfile,
    type TutorResearch
  } from '$lib/tool/tutors';

  let { data } = $props();

  type Mode = 'create' | 'library';
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

  let mode = $state<Mode>('create');
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
  let tutors = $state<Project[]>([]);
  let tutorsLoading = $state(true);
  let tutorsError = $state<string | null>(null);
  let disposed = false;
  let playback: { context: AudioContext; source: AudioBufferSourceNode } | null = null;

  const isGuest = $derived(data.me.origin === 'guest');
  const question = $derived(TUTOR_QUESTIONS[questionIndex]);

  async function loadTutors() {
    tutorsLoading = true;
    tutorsError = null;
    try {
      const result = await projects.list({ archived: 'false', limit: 100 });
      tutors = result.projects.filter(isTutorProject);
    } catch (error) {
      tutorsError = errorMessage(error, 'Your tutors could not be loaded.');
    } finally {
      tutorsLoading = false;
    }
  }

  onMount(() => void loadTutors());

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

      await Promise.all(
        research.lessons.map((lesson, index) =>
          api.createItem({
            name: `${index + 1}. ${lesson.title}`.slice(0, 200),
            note: lessonNote(lesson, research!),
            projectIds: [project.id]
          })
        )
      );

      createdProject = project;
      tutors = [project, ...tutors.filter((row) => row.id !== project.id)];
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
  <title>Tutor Studio · {data.instance.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-xl px-1 pb-12 pt-2 sm:pt-6">
  <!-- Two views, nothing else -->
  <div class="flex justify-center">
    <div
      class="inline-flex rounded-full bg-sky-50 p-1 dark:bg-sky-950/50"
      role="tablist"
      aria-label="Tutor Studio"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'create'}
        class="min-h-11 rounded-full px-5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 {mode ===
        'create'
          ? 'bg-white text-sky-700 shadow-sm dark:bg-sky-900 dark:text-sky-100'
          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}"
        onclick={() => (mode = 'create')}
      >
        Create tutor
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'library'}
        class="min-h-11 rounded-full px-5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 {mode ===
        'library'
          ? 'bg-white text-sky-700 shadow-sm dark:bg-sky-900 dark:text-sky-100'
          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}"
        onclick={() => (mode = 'library')}
      >
        My tutors
      </button>
    </div>
  </div>

  {#if isGuest}
    <p class="mt-16 text-center text-sm text-muted-foreground">Only workspace members can create tutors.</p>
  {:else if mode === 'create'}
    <div class="mt-10" data-testid="tutor-builder">
      {#if phase === 'questions' && question}
        <!-- One question at a time -->
        <div class="flex items-center justify-between">
          <div class="flex gap-1.5" aria-label={`Question ${questionIndex + 1} of ${TUTOR_QUESTIONS.length}`}>
            {#each TUTOR_QUESTIONS as q, index (q.field)}
              <span
                class="h-1.5 w-6 rounded-full {index <= questionIndex
                  ? 'bg-sky-500'
                  : 'bg-sky-100 dark:bg-sky-900/60'}"
              ></span>
            {/each}
          </div>
          {#if questionIndex > 0}
            <button
              type="button"
              class="inline-flex h-11 w-11 items-center justify-center rounded-full text-slate-400 hover:bg-sky-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:bg-sky-950/60"
              aria-label="Start over"
              title="Start over"
              onclick={reset}
            >
              <RotateCcw class="h-4 w-4" />
            </button>
          {/if}
        </div>

        <h1 class="mt-8 text-2xl font-semibold leading-tight sm:text-3xl">{question.prompt}</h1>

        {#if question.choices}
          <div class="mt-8 grid gap-3">
            {#each question.choices as choice (choice)}
              <button
                type="button"
                class="min-h-14 rounded-2xl border border-sky-100 bg-white px-5 text-left text-base font-medium text-slate-800 transition-colors hover:border-sky-300 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-sky-900/60 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-sky-950/60"
                onclick={() => submitAnswer(choice)}
              >
                {choice}
              </button>
            {/each}
          </div>
        {:else}
          <div
            class="mt-8 flex items-center gap-2 rounded-2xl border border-sky-200 bg-white p-1.5 pl-5 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-200 dark:border-sky-800 dark:bg-slate-900 dark:focus-within:ring-sky-900"
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
              class="min-h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
            />
            <button
              type="button"
              class="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition-colors hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-200 dark:bg-sky-500 dark:text-slate-950 dark:disabled:bg-sky-900 dark:disabled:text-sky-700"
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
        <!-- Confirm -->
        <h1 class="text-center text-2xl font-semibold sm:text-3xl">Ready?</h1>
        <ul class="mt-8 flex flex-wrap justify-center gap-2">
          {#each [`${profile.learnerName}, ${profile.age}`, profile.subject, profile.level, profile.learningStyle, profile.tone, profile.language] as detail, index (index)}
            <li
              class="rounded-full bg-sky-50 px-4 py-2 text-sm text-sky-800 dark:bg-sky-950/60 dark:text-sky-100"
            >
              {detail}
            </li>
          {/each}
        </ul>
        <div class="mt-10 flex flex-col items-center gap-2">
          <button
            type="button"
            class="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-sky-600 px-8 text-base font-medium text-white transition-colors hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 sm:w-auto"
            onclick={() => void createTutor()}
          >
            Create my tutor
          </button>
          <button
            type="button"
            class="min-h-11 rounded-full px-4 text-sm text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-slate-400 dark:hover:text-slate-100"
            onclick={reset}
          >
            Start over
          </button>
        </div>
        {#if createError}
          <p class="mt-4 text-center text-sm text-destructive" role="alert">{createError}</p>
        {/if}
      {:else if phase === 'researching'}
        <!-- H at work -->
        <div class="py-10 text-center" aria-live="polite">
          <LoaderCircle class="mx-auto h-10 w-10 animate-spin text-sky-500 motion-reduce:animate-none" />
          <h1 class="mt-6 text-2xl font-semibold">Creating your tutor…</h1>
          <p class="mt-2 text-sm text-muted-foreground">About a minute</p>
          {#if activeRun?.liveUrl}
            <a
              href={activeRun.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-6 inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm text-sky-700 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-300 dark:hover:bg-sky-950/60"
            >
              Watch H research live <ExternalLink class="h-3.5 w-3.5" />
            </a>
          {/if}
        </div>
      {:else if phase === 'ready' && research && createdProject}
        <!-- Done -->
        <div class="text-center">
          <div
            class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-200"
          >
            <GraduationCap class="h-8 w-8" />
          </div>
          <h1 class="mt-5 text-2xl font-semibold sm:text-3xl">{research.tutorName}</h1>
          <p class="mx-auto mt-3 max-w-md leading-7 text-muted-foreground">{research.welcome}</p>
          <div class="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button
              type="button"
              class="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-sky-200 px-6 text-base font-medium text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60 dark:border-sky-800 dark:text-sky-100 dark:hover:bg-sky-950/60 sm:w-auto"
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
              href={`/tutors/${createdProject.id}/room`}
              class="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-sky-600 px-8 text-base font-medium text-white transition-colors hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 sm:w-auto"
            >
              Start learning <ArrowRight class="h-5 w-5" />
            </a>
          </div>
          {#if voiceError}
            <p class="mt-4 text-sm text-destructive" role="alert">{voiceError}</p>
          {/if}
          <button
            type="button"
            class="mt-6 min-h-11 rounded-full px-4 text-sm text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-slate-400 dark:hover:text-slate-100"
            onclick={reset}
          >
            Create another tutor
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <!-- My tutors -->
    <div class="mt-10">
      {#if tutorsLoading}
        <div class="flex justify-center py-16" aria-live="polite">
          <LoaderCircle class="h-7 w-7 animate-spin text-sky-500 motion-reduce:animate-none" />
          <span class="sr-only">Loading your tutors</span>
        </div>
      {:else if tutorsError}
        <p class="py-16 text-center text-sm text-destructive" role="alert">{tutorsError}</p>
      {:else if !tutors.length}
        <div class="py-16 text-center">
          <p class="text-muted-foreground">No tutors yet.</p>
          <button
            type="button"
            class="mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-sky-600 px-6 text-base font-medium text-white hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 dark:bg-sky-500 dark:text-slate-950"
            onclick={() => (mode = 'create')}
          >
            <Plus class="h-5 w-5" /> Create tutor
          </button>
        </div>
      {:else}
        <ul class="grid grid-cols-[minmax(0,1fr)] gap-3">
          {#each tutors as tutor (tutor.id)}
            <li>
              <a
                href={`/tutors/${tutor.id}/room`}
                class="flex min-h-16 items-center gap-4 rounded-2xl border border-sky-100 bg-white p-3 pr-4 transition-colors hover:border-sky-300 hover:bg-sky-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-sky-900/60 dark:bg-slate-900 dark:hover:bg-sky-950/50"
              >
                <span
                  class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-200"
                  aria-hidden="true"
                >
                  <GraduationCap class="h-5 w-5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{tutor.name}</span>
                  <span class="block truncate text-sm text-muted-foreground"
                    >{tutor.description?.split('\n')[1] ?? ''}</span
                  >
                </span>
                <ChevronRight class="h-5 w-5 shrink-0 text-slate-400" />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
