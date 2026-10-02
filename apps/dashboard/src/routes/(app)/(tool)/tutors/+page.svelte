<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Check from '@lucide/svelte/icons/check';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import GraduationCap from '@lucide/svelte/icons/graduation-cap';
  import Library from '@lucide/svelte/icons/library';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Send from '@lucide/svelte/icons/send';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
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
  const progress = $derived(Math.round((questionIndex / TUTOR_QUESTIONS.length) * 100));
  const answeredQuestions = $derived(TUTOR_QUESTIONS.slice(0, questionIndex));

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

<div class="mx-auto w-full max-w-6xl pb-12">
  <header class="flex flex-col gap-5 border-b pb-6 pt-2 sm:flex-row sm:items-end sm:justify-between">
    <div class="max-w-2xl">
      <div class="mb-3 flex items-center gap-2 text-sm font-medium text-primary">
        <Sparkles class="h-4 w-4" />
        Tutor Factory
      </div>
      <h1 class="text-3xl font-semibold tracking-normal sm:text-4xl">Build a tutor made for you</h1>
      <p class="mt-3 text-base leading-7 text-muted-foreground">
        Tell us how you learn. H researches the curriculum, and Gradium gives your tutor a voice.
      </p>
    </div>

    <div class="inline-flex self-start rounded-md border bg-muted/40 p-1" aria-label="Tutor Studio view">
      <Button
        size="sm"
        variant={mode === 'create' ? 'default' : 'ghost'}
        class="gap-2"
        onclick={() => (mode = 'create')}
      >
        <GraduationCap class="h-4 w-4" />
        Create tutor
      </Button>
      <Button
        size="sm"
        variant={mode === 'library' ? 'default' : 'ghost'}
        class="gap-2"
        onclick={() => (mode = 'library')}
      >
        <Library class="h-4 w-4" />
        My tutors
      </Button>
    </div>
  </header>

  {#if isGuest}
    <div class="py-16 text-center">
      <GraduationCap class="mx-auto h-10 w-10 text-muted-foreground" />
      <h2 class="mt-4 text-xl font-semibold">Tutor creation is for workspace members</h2>
      <p class="mt-2 text-sm text-muted-foreground">Ask a workspace member to create and share a tutor.</p>
    </div>
  {:else if mode === 'create'}
    <div
      class="mx-auto mt-8 max-w-3xl overflow-hidden rounded-md border bg-card shadow-sm"
      data-testid="tutor-builder"
    >
      <div class="flex items-center justify-between border-b px-5 py-4">
        <div>
          <p class="text-sm font-semibold">New personalized tutor</p>
          <p class="text-xs text-muted-foreground">
            {phase === 'questions'
              ? `Question ${Math.min(questionIndex + 1, TUTOR_QUESTIONS.length)} of ${TUTOR_QUESTIONS.length}`
              : phase === 'review'
                ? 'Ready to create'
                : phase === 'researching'
                  ? 'Research in progress'
                  : 'Tutor ready'}
          </p>
        </div>
        {#if phase !== 'questions'}
          <Button size="icon" variant="ghost" aria-label="Start over" title="Start over" onclick={reset}>
            <RotateCcw class="h-4 w-4" />
          </Button>
        {/if}
      </div>

      <div class="h-1 bg-muted" aria-hidden="true">
        <div
          class="h-full bg-primary transition-all duration-300 motion-reduce:transition-none"
          style:width={`${phase === 'ready' ? 100 : phase === 'researching' || phase === 'review' ? 92 : progress}%`}
        ></div>
      </div>

      {#if phase === 'questions'}
        <div class="min-h-[430px] space-y-5 px-5 py-6 sm:px-8" aria-live="polite">
          <div class="flex gap-3">
            <div
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <GraduationCap class="h-5 w-5" />
            </div>
            <div class="max-w-[85%] rounded-md bg-muted px-4 py-3 text-sm leading-6">
              Let’s create a tutor that fits you. I’ll ask seven quick questions.
            </div>
          </div>

          {#each answeredQuestions as answered (answered.field)}
            <div class="space-y-3">
              <div class="flex gap-3">
                <div
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                >
                  <GraduationCap class="h-5 w-5" />
                </div>
                <div class="max-w-[85%] rounded-md bg-muted px-4 py-3 text-sm leading-6">
                  {answered.prompt}
                </div>
              </div>
              <div class="flex justify-end">
                <div class="max-w-[85%] rounded-md bg-foreground px-4 py-3 text-sm leading-6 text-background">
                  {profile[answered.field]}
                </div>
              </div>
            </div>
          {/each}

          {#if question}
            <div class="flex gap-3">
              <div
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
              >
                <GraduationCap class="h-5 w-5" />
              </div>
              <div class="max-w-[85%] rounded-md bg-muted px-4 py-3 text-sm font-medium leading-6">
                {question.prompt}
              </div>
            </div>

            {#if question.choices}
              <div class="flex flex-wrap gap-2 pl-12">
                {#each question.choices as choice (choice)}
                  <Button
                    variant="outline"
                    class="h-auto min-h-11 whitespace-normal py-2 text-left"
                    onclick={() => submitAnswer(choice)}
                  >
                    {choice}
                  </Button>
                {/each}
              </div>
            {:else}
              <div class="flex items-center gap-2 border-t pt-5">
                <Input
                  type="text"
                  inputmode={question.field === 'age' ? 'numeric' : undefined}
                  bind:value={draft}
                  placeholder={question.placeholder}
                  aria-label={question.prompt}
                  onkeydown={handleKeydown}
                  autofocus
                />
                <Button
                  size="icon"
                  aria-label="Send answer"
                  title="Send answer"
                  disabled={!String(draft).trim()}
                  onclick={() => submitAnswer()}
                >
                  <Send class="h-4 w-4" />
                </Button>
              </div>
            {/if}
          {/if}
        </div>
      {:else if phase === 'review'}
        <div class="px-5 py-8 sm:px-8">
          <div class="mx-auto max-w-xl text-center">
            <div
              class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <GraduationCap class="h-6 w-6" />
            </div>
            <h2 class="mt-4 text-2xl font-semibold">Meet your future tutor</h2>
            <p class="mt-2 leading-7 text-muted-foreground">
              A {profile.tone.toLowerCase()}
              {profile.subject} tutor for {profile.learnerName}, using
              {profile.learningStyle.toLowerCase()} in {profile.language}.
            </p>
          </div>

          <dl class="mx-auto mt-7 grid max-w-xl grid-cols-2 gap-x-6 gap-y-4 border-y py-5 text-sm">
            <div>
              <dt class="text-muted-foreground">Learner</dt>
              <dd class="mt-1 font-medium">{profile.learnerName}, {profile.age}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Subject</dt>
              <dd class="mt-1 font-medium">{profile.subject}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Level</dt>
              <dd class="mt-1 font-medium">{profile.level}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Style</dt>
              <dd class="mt-1 font-medium">{profile.learningStyle}</dd>
            </div>
          </dl>

          <div class="mx-auto mt-7 flex max-w-xl flex-col gap-3 sm:flex-row sm:justify-center">
            <Button class="min-h-11 gap-2" onclick={() => void createTutor()}>
              <Sparkles class="h-4 w-4" />
              Research and create tutor
            </Button>
            <Button variant="outline" class="min-h-11" onclick={reset}>Start again</Button>
          </div>
          <div class="mx-auto mt-4 max-w-xl"><FormError message={createError} /></div>
        </div>
      {:else if phase === 'researching'}
        <div class="px-5 py-14 text-center sm:px-8" aria-live="polite">
          <LoaderCircle class="mx-auto h-10 w-10 animate-spin text-primary motion-reduce:animate-none" />
          <h2 class="mt-5 text-2xl font-semibold">H is building the curriculum</h2>
          <p class="mx-auto mt-2 max-w-lg leading-7 text-muted-foreground">
            Researching age-appropriate teaching methods, creating three lessons, and preparing the project.
          </p>
          <ol class="mx-auto mt-8 max-w-md space-y-3 text-left text-sm">
            <li class="flex items-center gap-3">
              <Check class="h-4 w-4 text-primary" /> Student profile prepared
            </li>
            <li class="flex items-center gap-3">
              <LoaderCircle class="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" /> Researching
              with H
            </li>
            <li class="flex items-center gap-3 text-muted-foreground">
              <BookOpen class="h-4 w-4" /> Creating Project and lesson Items
            </li>
          </ol>
          {#if activeRun?.liveUrl}
            <a
              href={activeRun.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-7 inline-flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Watch H work live
              <ExternalLink class="h-4 w-4" />
            </a>
          {/if}
        </div>
      {:else if phase === 'ready' && research && createdProject}
        <div class="px-5 py-8 sm:px-8" data-testid="tutor-created">
          <div class="flex flex-col gap-5 border-b pb-7 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <Badge variant="latest">Tutor ready</Badge>
              <h2 class="mt-3 text-2xl font-semibold">{research.tutorName}</h2>
              <p class="mt-2 max-w-xl leading-7 text-muted-foreground">{research.welcome}</p>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" class="gap-2" disabled={speaking} onclick={() => void speakWelcome()}>
                <Volume2 class="h-4 w-4" />
                {speaking ? 'Preparing voice…' : 'Hear welcome'}
              </Button>
              <Button class="gap-2" onclick={() => void goto(`/tutors/${createdProject!.id}/room`)}>
                Start first lesson
                <ArrowRight class="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div class="py-7">
            <h3 class="text-sm font-semibold uppercase tracking-normal text-muted-foreground">
              First learning path
            </h3>
            <ol class="mt-4 divide-y border-y">
              {#each research.lessons as lesson, index (lesson.title)}
                <li class="grid gap-2 py-5 sm:grid-cols-[3rem_1fr]">
                  <span class="text-2xl font-semibold text-primary">0{index + 1}</span>
                  <div>
                    <h4 class="font-semibold">{lesson.title}</h4>
                    <p class="mt-1 text-sm leading-6 text-muted-foreground">{lesson.objective}</p>
                  </div>
                </li>
              {/each}
            </ol>
          </div>

          <div class="flex flex-wrap items-center gap-3 border-t pt-5">
            {#if activeRun?.liveUrl}
              <a
                href={activeRun.liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-sm underline"
              >
                View H research session <ExternalLink class="h-3.5 w-3.5" />
              </a>
            {/if}
            <span class="text-sm text-muted-foreground"
              >Project and 3 lesson Items created automatically.</span
            >
          </div>
          <FormError message={voiceError} />
        </div>
      {/if}
    </div>
  {:else}
    <div class="pt-8" data-testid="tutor-library">
      <div class="mb-5 flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold">My tutors</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            Every tutor is stored as a Project with its lessons inside.
          </p>
        </div>
        <Button size="sm" class="gap-2" onclick={() => (mode = 'create')}>
          <GraduationCap class="h-4 w-4" /> New tutor
        </Button>
      </div>

      {#if tutorsLoading}
        <div class="flex min-h-52 items-center justify-center border-y">
          <LoaderCircle class="h-6 w-6 animate-spin text-primary motion-reduce:animate-none" />
        </div>
      {:else if tutorsError}
        <div class="border-y py-8"><FormError message={tutorsError} /></div>
      {:else if !tutors.length}
        <div class="border-y py-14 text-center">
          <GraduationCap class="mx-auto h-9 w-9 text-muted-foreground" />
          <h3 class="mt-4 font-semibold">No tutors yet</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            Create your first personalized tutor in a few questions.
          </p>
          <Button class="mt-5" onclick={() => (mode = 'create')}>Create a tutor</Button>
        </div>
      {:else}
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each tutors as tutor (tutor.id)}
            <button
              type="button"
              class="group min-h-44 rounded-md border bg-card p-5 text-left transition-colors hover:border-primary/60 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onclick={() => void goto(`/projects/${tutor.id}`)}
            >
              <div class="flex items-start justify-between gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <GraduationCap class="h-5 w-5" />
                </div>
                <ArrowRight
                  class="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 motion-reduce:transition-none"
                />
              </div>
              <h3 class="mt-5 font-semibold">{tutor.name}</h3>
              <p class="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                {tutor.description?.split('\n').slice(1, 3).join(' · ') || 'Personalized tutor'}
              </p>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
