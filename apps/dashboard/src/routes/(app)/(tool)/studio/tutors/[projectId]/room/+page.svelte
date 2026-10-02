<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Send from '@lucide/svelte/icons/send';
  import Volume2 from '@lucide/svelte/icons/volume-2';
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
  import { lessonTitle } from '$lib/tool/tutor-view';
  import type { Item, Run } from '@app/contract';

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
  <title>{project ? project.name : 'Tutor Room'} · Tutor Studio</title>
</svelte:head>

{#if loading}
  <div class="flex h-full items-center justify-center" aria-live="polite">
    <LoaderCircle class="h-8 w-8 animate-spin text-sky-400 motion-reduce:animate-none" />
    <span class="sr-only">Opening your tutor</span>
  </div>
{:else if loadError || !project}
  <div class="px-5 py-24 text-center">
    <p class="text-red-600" role="alert">{loadError ?? 'This tutor could not be opened.'}</p>
    <a
      href="/studio/tutors"
      class="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-sky-700 shadow-sm shadow-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <ArrowLeft class="h-4 w-4" /> My tutors
    </a>
  </div>
{:else}
  <section class="mx-auto flex h-full w-full max-w-3xl flex-col px-4 sm:px-6" aria-label="Tutor Room">
    <!-- Header -->
    <header class="flex items-center gap-2 pb-2 pt-4">
      <a
        href={`/studio/tutors/${project.id}`}
        class="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-white hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        aria-label="Back to the tutor"
        title="Back to the tutor"
      >
        <ArrowLeft class="h-5 w-5" />
      </a>
      <h1 class="min-w-0 flex-1 truncate text-lg font-bold text-slate-900">{project.name}</h1>
      {#if lastRunUrl && !thinking}
        <a
          href={lastRunUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-white hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Open the last H session"
          title="Last H session"
        >
          <ExternalLink class="h-4 w-4" />
        </a>
      {/if}
      <span
        class="shrink-0 rounded-full bg-white px-3 py-1 text-sm font-bold text-sky-700 shadow-sm shadow-sky-100"
        role="progressbar"
        aria-label="Learning progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}>{progress}%</span
      >
    </header>

    <!-- Lessons -->
    {#if lessons.length}
      <nav aria-label="Lessons">
        <ol class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 pt-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
          {#each lessons as lesson, index (lesson.id)}
            <li class="shrink-0">
              <button
                type="button"
                class="inline-flex min-h-11 max-w-[15rem] items-center gap-2 rounded-full bg-white py-1 pl-1 pr-4 text-sm font-medium text-slate-700 shadow-sm shadow-sky-100 transition-colors hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50"
                disabled={thinking}
                title={lessonTitle(lesson.name)}
                onclick={() =>
                  void sendMessage(
                    `Let's begin lesson ${index + 1}: ${lesson.name.replace(/^\d+\.\s*/, '')}.`
                  )}
              >
                <span
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-sky-700"
                  >{index + 1}</span
                >
                <span class="truncate">{lessonTitle(lesson.name)}</span>
              </button>
            </li>
          {/each}
        </ol>
      </nav>
    {/if}

    <!-- Conversation -->
    <div
      class="min-h-0 flex-1 space-y-4 overflow-y-auto py-4"
      bind:this={messageList}
      aria-live="polite"
      aria-busy={thinking}
      data-testid="tutor-messages"
    >
      {#each messages as message (message.id)}
        {#if message.role === 'learner'}
          <div class="flex justify-end">
            <p
              class="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-sky-500 px-5 py-3 text-base leading-7 text-white"
            >
              <span class="sr-only">You: </span>{message.text}
            </p>
          </div>
        {:else}
          <div class="flex max-w-[90%] items-end gap-1">
            <p
              class="whitespace-pre-wrap rounded-3xl rounded-bl-lg bg-white px-5 py-3 text-base leading-7 text-slate-800 shadow-sm shadow-sky-100"
            >
              <span class="sr-only">Tutor: </span>{message.text}
            </p>
            <button
              type="button"
              class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sky-500 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-40"
              disabled={speakingId !== null}
              aria-label="Listen"
              title="Listen"
              onclick={() => void speak(message)}
            >
              {#if speakingId === message.id}
                <LoaderCircle class="h-5 w-5 animate-spin motion-reduce:animate-none" />
              {:else}
                <Volume2 class="h-5 w-5" />
              {/if}
            </button>
          </div>
        {/if}
      {/each}

      {#if thinking}
        <div role="status">
          <div
            class="inline-flex items-center gap-1.5 rounded-3xl rounded-bl-lg bg-white px-5 py-4 shadow-sm shadow-sky-100"
          >
            <span class="h-2 w-2 animate-bounce rounded-full bg-sky-400 motion-reduce:animate-none"></span>
            <span
              class="h-2 w-2 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms] motion-reduce:animate-none"
            ></span>
            <span
              class="h-2 w-2 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms] motion-reduce:animate-none"
            ></span>
            <span class="sr-only">Your tutor is thinking</span>
          </div>
          {#if activeRun?.liveUrl}
            <a
              href={activeRun.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-1 flex min-h-11 w-fit items-center gap-1.5 rounded-full px-3 text-xs font-medium text-slate-400 hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Watch H live <ExternalLink class="h-3 w-3" />
            </a>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Composer -->
    <div class="pb-4 pt-2">
      {#if sendError || voiceError || saveState === 'failed'}
        <p class="mb-2 px-2 text-sm text-red-600" role="alert">
          {sendError ?? voiceError ?? 'Progress could not be saved.'}
        </p>
      {/if}
      <div
        class="flex items-end gap-2 rounded-[1.75rem] border-2 border-white bg-white p-2 pl-5 shadow-md shadow-sky-100 focus-within:border-sky-300"
      >
        <textarea
          bind:value={draft}
          rows={1}
          class="max-h-36 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-base text-slate-900 outline-none [field-sizing:content] placeholder:text-slate-300"
          placeholder="Write your answer"
          aria-label="Message your tutor"
          disabled={thinking}
          onkeydown={handleComposerKeydown}
        ></textarea>
        <button
          type="button"
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-100 disabled:text-sky-300"
          aria-label="Send"
          title="Send"
          disabled={thinking || !draft.trim()}
          onclick={() => void sendMessage()}
        >
          <Send class="h-5 w-5" />
        </button>
      </div>
    </div>
  </section>
{/if}
