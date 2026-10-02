<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Check from '@lucide/svelte/icons/check';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import GraduationCap from '@lucide/svelte/icons/graduation-cap';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Send from '@lucide/svelte/icons/send';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { api, errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { projectCan } from '$lib/projects/can';
  import type { Project } from '$lib/projects/types';
  import { itemProjects } from '$lib/tool/projects-client';
  import {
    TUTOR_JOURNAL_MARKER,
    TUTOR_JOURNAL_NAME,
    buildTutorChatInstruction,
    isTutorProject,
    parseTutorChatReply,
    parseTutorJournal,
    serializeTutorJournal,
    tutorWelcome,
    type TutorChatMessage
  } from '$lib/tool/tutors';
  import { fromBase64 } from '$lib/tool/wav';
  import type { Item, Run } from '@app/contract';

  let { data } = $props();

  const projectId = $derived(page.params.projectId ?? '');
  let project = $state<Project | null>(null);
  let lessons = $state<Item[]>([]);
  let journal = $state<Item | null>(null);
  let messages = $state<TutorChatMessage[]>([]);
  let progress = $state(0);
  let draft = $state('');
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let sendError = $state<string | null>(null);
  let voiceError = $state<string | null>(null);
  let thinking = $state(false);
  let speakingId = $state<string | null>(null);
  let saveState = $state<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  let activeRun = $state<Run | null>(null);
  let lastRunUrl = $state<string | null>(null);
  let messageList: HTMLElement | null = $state(null);
  let disposed = false;
  let playback: { context: AudioContext; source: AudioBufferSourceNode } | null = null;

  const canPersist = $derived(project ? projectCan.write(project) : false);
  const learnerHasSpoken = $derived(messages.some((message) => message.role === 'learner'));

  // Presentation only: the labels the room shows, read from the Project and its lessons.
  const lessonTitle = (name: string) => name.replace(/^\d+\.\s*/, '').replace(/^Lesson\s+\d+:\s*/i, '');
  const tutorSubtitle = $derived(project?.description?.split('\n')[1] ?? '');

  const messageId = () =>
    globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function scrollToLatest() {
    await tick();
    messageList?.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
  }

  async function loadRoom() {
    loading = true;
    loadError = null;
    try {
      const [loadedProject, result] = await Promise.all([
        projects.get(projectId),
        itemProjects.itemsOf(projectId, { limit: 100 })
      ]);
      if (!isTutorProject(loadedProject)) throw new Error('This Project is not a Tutor Studio tutor.');

      project = loadedProject;
      journal = result.items.find((item) => item.note.startsWith(TUTOR_JOURNAL_MARKER)) ?? null;
      lessons = result.items
        .filter((item) => !item.note.startsWith(TUTOR_JOURNAL_MARKER))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      const saved = journal ? parseTutorJournal(journal.note) : null;
      progress = saved?.progress ?? 0;
      messages = saved?.messages.length
        ? saved.messages
        : [
            {
              id: messageId(),
              role: 'tutor',
              text: tutorWelcome(loadedProject.name, loadedProject.description ?? '')
            }
          ];
      await scrollToLatest();
    } catch (error) {
      loadError = errorMessage(error, 'The Tutor Room could not be opened.');
    } finally {
      loading = false;
    }
  }

  async function persistJournal() {
    if (!project || !canPersist) return;
    saveState = 'saving';
    const note = serializeTutorJournal(messages, progress, new Date().toISOString());
    try {
      if (journal) {
        journal = await api.updateItem(journal.id, { note });
      } else {
        journal = (await api.createItem({ name: TUTOR_JOURNAL_NAME, note, projectIds: [project.id] })).item;
      }
      saveState = 'saved';
    } catch {
      saveState = 'failed';
    }
  }

  async function sendMessage(text = draft) {
    const learnerText = text.trim();
    if (!learnerText || !project || thinking) return;

    sendError = null;
    draft = '';
    messages = [...messages, { id: messageId(), role: 'learner', text: learnerText }];
    thinking = true;
    await scrollToLatest();

    try {
      const { run } = await api.createRun({
        instruction: buildTutorChatInstruction({
          projectId: project.id,
          projectName: project.name,
          projectDescription: project.description ?? '',
          lessons,
          messages,
          progress
        })
      });
      activeRun = run;
      lastRunUrl = run.liveUrl;

      while (!disposed && activeRun.state === 'running') {
        await wait(2500);
        if (disposed) return;
        activeRun = await api.getRun(activeRun.id);
        lastRunUrl = activeRun.liveUrl ?? lastRunUrl;
      }

      if (activeRun.state !== 'completed' || !activeRun.answer) {
        throw new Error(activeRun.error || 'H could not complete this tutor turn.');
      }

      const result = parseTutorChatReply(activeRun.answer, progress);
      progress = result.progress;
      messages = [...messages, { id: messageId(), role: 'tutor', text: result.reply }];
      await scrollToLatest();
      await persistJournal();
    } catch (error) {
      sendError = errorMessage(error, 'The tutor could not answer. Please try again.');
    } finally {
      thinking = false;
      activeRun = null;
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  function stopPlayback() {
    if (!playback) return;
    try {
      playback.source.stop();
    } catch {
      // Playback may already have ended.
    }
    void playback.context.close().catch(() => {});
    playback = null;
  }

  async function speak(message: TutorChatMessage) {
    if (speakingId) return;
    speakingId = message.id;
    voiceError = null;
    try {
      const { audio } = await api.speak(message.text);
      stopPlayback();
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(fromBase64(audio).slice().buffer as ArrayBuffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start();
      playback = { context, source };
    } catch (error) {
      voiceError = errorMessage(error, 'Gradium could not read this response aloud.');
    } finally {
      speakingId = null;
    }
  }

  onMount(() => void loadRoom());
  onDestroy(() => {
    disposed = true;
    stopPlayback();
  });
</script>

<svelte:head>
  <title>{project ? `${project.name} · Tutor Room` : 'Tutor Room'} · {data.instance.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-3xl pb-6">
  {#if loading}
    <div class="flex min-h-[60vh] flex-col items-center justify-center gap-3" aria-live="polite">
      <LoaderCircle class="h-7 w-7 animate-spin text-sky-500 motion-reduce:animate-none" />
      <span class="text-sm text-muted-foreground">Opening your Tutor Room…</span>
    </div>
  {:else if loadError || !project}
    <div class="mx-auto max-w-md py-16 text-center">
      <div
        class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sky-50 text-sky-600 dark:bg-sky-950/60 dark:text-sky-300"
      >
        <GraduationCap class="h-7 w-7" />
      </div>
      <h1 class="mt-5 text-xl font-semibold">This Tutor Room can’t open</h1>
      <div class="mt-3"><FormError message={loadError} /></div>
      <Button href={`/projects/${projectId}`} variant="outline" class="mt-6 min-h-11 gap-2">
        <ArrowLeft class="h-4 w-4" /> Back to Project
      </Button>
    </div>
  {:else}
    <section
      class="flex h-[calc(100dvh-11rem)] min-h-[520px] flex-col overflow-hidden rounded-2xl border border-sky-100 bg-white shadow-sm dark:border-sky-900/50 dark:bg-slate-950 sm:h-[calc(100dvh-8rem)]"
      aria-label="Tutor Room"
    >
      <!-- Header: who you are learning with, and a quiet progress line -->
      <header class="border-b border-sky-100 px-3 pb-3 pt-3 dark:border-sky-900/50 sm:px-5">
        <div class="flex items-center gap-3">
          <a
            href={`/projects/${project.id}`}
            class="-ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-sky-50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:bg-sky-950/60"
            aria-label="Back to Project"
            title="Back to Project"
          >
            <ArrowLeft class="h-5 w-5" />
          </a>
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-200"
            aria-hidden="true"
          >
            <GraduationCap class="h-5 w-5" />
          </div>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-semibold leading-6 sm:text-lg">{project.name}</h1>
            <p class="truncate text-xs text-muted-foreground">{tutorSubtitle || 'Tutor Room'}</p>
          </div>
          <div class="hidden shrink-0 text-right sm:block" aria-hidden="true">
            <p class="text-xs text-muted-foreground">Progress</p>
            <p class="text-sm font-semibold text-sky-700 dark:text-sky-300">{progress}%</p>
          </div>
        </div>
        <div
          class="mt-3 h-1.5 overflow-hidden rounded-full bg-sky-50 dark:bg-sky-950/60"
          role="progressbar"
          aria-label="Learning progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            class="h-full rounded-full bg-sky-400 transition-[width] duration-500 motion-reduce:transition-none"
            style:width={`${progress}%`}
          ></div>
        </div>

        <!-- Lessons: one compact row of chips, scrolls sideways on a phone -->
        {#if lessons.length}
          <nav class="-mx-3 mt-3 sm:-mx-5" aria-label="Lessons">
            <ol class="flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:px-5">
              {#each lessons as lesson, index (lesson.id)}
                <li class="shrink-0">
                  <button
                    type="button"
                    class="inline-flex min-h-11 max-w-[15rem] items-center gap-2 rounded-full border border-sky-100 bg-sky-50/60 py-1.5 pl-1.5 pr-4 text-left text-sm text-slate-700 transition-colors hover:border-sky-300 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:pointer-events-none disabled:opacity-50 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-slate-200 dark:hover:bg-sky-950/70"
                    disabled={thinking}
                    title={`Start lesson ${index + 1}: ${lessonTitle(lesson.name)}`}
                    onclick={() =>
                      void sendMessage(
                        `Let's begin lesson ${index + 1}: ${lesson.name.replace(/^\d+\.\s*/, '')}.`
                      )}
                  >
                    <span
                      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-200"
                      >{index + 1}</span
                    >
                    <span class="truncate">{lessonTitle(lesson.name)}</span>
                  </button>
                </li>
              {/each}
            </ol>
          </nav>
        {/if}
      </header>

      <!-- Conversation -->
      <div
        class="min-h-0 flex-1 space-y-5 overflow-y-auto bg-gradient-to-b from-sky-50/40 to-white px-3 py-5 dark:from-sky-950/20 dark:to-slate-950 sm:px-6"
        bind:this={messageList}
        aria-live="polite"
        aria-busy={thinking}
        data-testid="tutor-messages"
      >
        {#each messages as message (message.id)}
          {#if message.role === 'learner'}
            <article class="ml-auto flex max-w-[85%] flex-col items-end sm:max-w-[75%]">
              <span class="sr-only">You said:</span>
              <div
                class="whitespace-pre-wrap rounded-2xl rounded-br-md bg-sky-600 px-4 py-2.5 text-[15px] leading-6 text-white dark:bg-sky-500 dark:text-slate-950"
              >
                {message.text}
              </div>
            </article>
          {:else}
            <article class="flex max-w-[92%] gap-2.5 sm:max-w-[80%]">
              <div
                class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-200"
                aria-hidden="true"
              >
                <GraduationCap class="h-4 w-4" />
              </div>
              <div class="min-w-0">
                <span class="sr-only">Tutor said:</span>
                <div
                  class="whitespace-pre-wrap rounded-2xl rounded-tl-md border border-sky-100 bg-white px-4 py-2.5 text-[15px] leading-6 text-slate-800 shadow-sm dark:border-sky-900/50 dark:bg-slate-900 dark:text-slate-100"
                >
                  {message.text}
                </div>
                <button
                  type="button"
                  class="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-sky-700 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50 dark:text-sky-300 dark:hover:bg-sky-950/60"
                  disabled={speakingId !== null}
                  aria-label={speakingId === message.id ? 'Preparing voice' : 'Listen to this message'}
                  onclick={() => void speak(message)}
                >
                  {#if speakingId === message.id}
                    <LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" /> Preparing voice…
                  {:else}
                    <Volume2 class="h-4 w-4" /> Listen
                  {/if}
                </button>
              </div>
            </article>
          {/if}
        {/each}

        {#if thinking}
          <div class="flex max-w-[92%] gap-2.5 sm:max-w-[80%]" role="status">
            <div
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-200"
              aria-hidden="true"
            >
              <GraduationCap class="h-4 w-4" />
            </div>
            <div>
              <div
                class="inline-flex items-center gap-2.5 rounded-2xl rounded-tl-md border border-sky-100 bg-white px-4 py-3 text-sm text-muted-foreground shadow-sm dark:border-sky-900/50 dark:bg-slate-900"
              >
                <span class="flex gap-1" aria-hidden="true">
                  <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 motion-reduce:animate-none"
                  ></span>
                  <span
                    class="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms] motion-reduce:animate-none"
                  ></span>
                  <span
                    class="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms] motion-reduce:animate-none"
                  ></span>
                </span>
                Your tutor is thinking…
              </div>
              {#if activeRun?.liveUrl}
                <a
                  href={activeRun.liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground underline-offset-4 hover:text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:text-sky-300"
                >
                  Watch H research live <ExternalLink class="h-3.5 w-3.5" />
                </a>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- Composer: always at the bottom of the room -->
      <footer
        class="border-t border-sky-100 bg-white px-3 pb-3 pt-3 dark:border-sky-900/50 dark:bg-slate-950 sm:px-5"
      >
        {#if !learnerHasSpoken && !thinking}
          <div class="mb-2 flex flex-wrap gap-2">
            <button
              type="button"
              class="inline-flex min-h-11 items-center rounded-full border border-sky-200 px-4 text-sm text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-sky-800 dark:text-sky-200 dark:hover:bg-sky-950/60"
              onclick={() => void sendMessage('Start with a simple explanation.')}>Explain it simply</button
            >
            <button
              type="button"
              class="inline-flex min-h-11 items-center rounded-full border border-sky-200 px-4 text-sm text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-sky-800 dark:text-sky-200 dark:hover:bg-sky-950/60"
              onclick={() => void sendMessage('Give me a quick exercise.')}>Give me an exercise</button
            >
          </div>
        {/if}

        <div
          class="flex items-end gap-2 rounded-2xl border border-sky-200 bg-white p-1.5 pl-3 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-200 dark:border-sky-800 dark:bg-slate-900 dark:focus-within:ring-sky-900"
        >
          <Textarea
            bind:value={draft}
            rows={1}
            class="max-h-36 min-h-11 [field-sizing:content] flex-1 resize-none border-0 bg-transparent px-0 py-2.5 text-[15px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder={thinking ? 'Your tutor is answering…' : 'Write your answer or a question'}
            aria-label="Message your tutor"
            disabled={thinking}
            onkeydown={handleComposerKeydown}
          />
          <button
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition-colors hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-200 disabled:text-white dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 dark:disabled:bg-sky-900 dark:disabled:text-sky-700"
            aria-label="Send message"
            title="Send message"
            disabled={thinking || !draft.trim()}
            onclick={() => void sendMessage()}
          >
            {#if thinking}
              <LoaderCircle class="h-5 w-5 animate-spin motion-reduce:animate-none" />
            {:else}
              <Send class="h-5 w-5" />
            {/if}
          </button>
        </div>

        <FormError message={sendError ?? voiceError} class="pt-2" />

        <div
          class="mt-1.5 flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground"
        >
          <span class="hidden sm:inline">Enter to send · Shift + Enter for a new line</span>
          <span class="inline-flex items-center gap-3">
            {#if lastRunUrl && !thinking}
              <a
                href={lastRunUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex min-h-8 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                Last H session <ExternalLink class="h-3 w-3" />
              </a>
            {/if}
            <span class="inline-flex items-center gap-1.5" aria-live="polite">
              {#if saveState === 'saving'}
                <LoaderCircle class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Saving…
              {:else if saveState === 'saved'}
                <Check class="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" /> Saved
              {:else if saveState === 'failed'}
                <span class="text-destructive">Progress not saved</span>
              {:else if !canPersist}
                View only
              {/if}
            </span>
            <span class="sm:hidden" aria-hidden="true">{progress}%</span>
          </span>
        </div>
      </footer>
    </section>
  {/if}
</div>
