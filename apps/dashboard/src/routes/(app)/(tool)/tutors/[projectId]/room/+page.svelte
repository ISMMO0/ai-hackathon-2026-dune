<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import BookOpen from '@lucide/svelte/icons/book-open';
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

<div class="mx-auto w-full max-w-6xl pb-8">
  {#if loading}
    <div class="flex min-h-[60vh] items-center justify-center" aria-live="polite">
      <LoaderCircle class="h-7 w-7 animate-spin text-primary motion-reduce:animate-none" />
      <span class="ml-3 text-sm text-muted-foreground">Opening Tutor Room…</span>
    </div>
  {:else if loadError || !project}
    <div class="mx-auto max-w-xl py-16 text-center">
      <GraduationCap class="mx-auto h-10 w-10 text-muted-foreground" />
      <h1 class="mt-4 text-xl font-semibold">Tutor Room unavailable</h1>
      <div class="mt-3"><FormError message={loadError} /></div>
      <Button href={`/projects/${projectId}`} variant="outline" class="mt-6 gap-2">
        <ArrowLeft class="h-4 w-4" /> Back to Project
      </Button>
    </div>
  {:else}
    <header class="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <a
          href={`/projects/${project.id}`}
          class="mb-3 inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft class="h-4 w-4" /> Back to Project
        </a>
        <p class="text-sm font-medium text-primary">Tutor Room</p>
        <h1 class="mt-1 truncate text-2xl font-semibold sm:text-3xl">{project.name}</h1>
      </div>
      <div class="flex min-w-44 flex-col gap-2">
        <div class="flex items-center justify-between text-xs">
          <span class="font-medium">Learning progress</span>
          <span>{progress}%</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-muted" aria-label={`Learning progress ${progress}%`}>
          <div class="h-full bg-primary transition-all duration-300" style:width={`${progress}%`}></div>
        </div>
      </div>
    </header>

    <div
      class="mt-6 grid min-h-[620px] overflow-hidden rounded-md border bg-card lg:grid-cols-[280px_minmax(0,1fr)]"
    >
      <aside class="border-b bg-muted/20 p-5 lg:border-b-0 lg:border-r">
        <div class="flex items-center gap-2">
          <BookOpen class="h-4 w-4 text-primary" />
          <h2 class="font-semibold">Learning path</h2>
        </div>
        <ol class="mt-4 space-y-2">
          {#each lessons as lesson, index (lesson.id)}
            <li>
              <button
                type="button"
                class="w-full rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={thinking}
                onclick={() =>
                  void sendMessage(
                    `Let's begin lesson ${index + 1}: ${lesson.name.replace(/^\d+\.\s*/, '')}.`
                  )}
              >
                <span class="text-xs font-medium text-primary">Lesson {index + 1}</span>
                <span class="mt-1 block text-sm font-medium leading-5"
                  >{lesson.name.replace(/^\d+\.\s*/, '')}</span
                >
              </button>
            </li>
          {/each}
        </ol>

        <div class="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
          <p>H prepares each tutor response from this course.</p>
          <p class="mt-2">Gradium reads responses aloud.</p>
        </div>
      </aside>

      <section class="flex min-h-0 flex-col" aria-label="Tutor conversation">
        <div
          class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-7"
          bind:this={messageList}
          aria-live="polite"
          aria-busy={thinking}
          data-testid="tutor-messages"
        >
          {#each messages as message (message.id)}
            <article class:ml-auto={message.role === 'learner'} class="max-w-[88%] sm:max-w-[76%]">
              <p class="mb-1 text-xs font-medium text-muted-foreground">
                {message.role === 'learner' ? 'You' : 'Tutor'}
              </p>
              <div
                class={`rounded-md px-4 py-3 text-sm leading-6 ${
                  message.role === 'learner' ? 'bg-foreground text-background' : 'border bg-muted/30'
                }`}
              >
                {message.text}
              </div>
              {#if message.role === 'tutor'}
                <Button
                  variant="ghost"
                  size="sm"
                  class="mt-1 min-h-11 gap-2 px-2 text-muted-foreground"
                  disabled={speakingId !== null}
                  onclick={() => void speak(message)}
                >
                  {#if speakingId === message.id}
                    <LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" /> Preparing voice…
                  {:else}
                    <Volume2 class="h-4 w-4" /> Listen
                  {/if}
                </Button>
              {/if}
            </article>
          {/each}

          {#if thinking}
            <div class="max-w-[88%] sm:max-w-[76%]">
              <p class="mb-1 text-xs font-medium text-muted-foreground">Tutor</p>
              <div class="flex items-center gap-3 rounded-md border bg-muted/30 px-4 py-3 text-sm">
                <LoaderCircle class="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
                H is preparing the next step…
              </div>
              {#if activeRun?.liveUrl}
                <a
                  href={activeRun.liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="mt-2 inline-flex min-h-11 items-center gap-2 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Watch H work live <ExternalLink class="h-3.5 w-3.5" />
                </a>
              {/if}
            </div>
          {/if}
        </div>

        <div class="border-t bg-card p-4 sm:p-5">
          {#if !learnerHasSpoken}
            <div class="mb-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onclick={() => void sendMessage('Start with a simple explanation.')}>Explain it simply</Button
              >
              <Button
                variant="outline"
                size="sm"
                onclick={() => void sendMessage('Give me a quick exercise.')}>Give me an exercise</Button
              >
            </div>
          {/if}

          <div class="flex items-end gap-2">
            <Textarea
              bind:value={draft}
              rows={2}
              class="min-h-12 resize-none"
              placeholder="Ask your tutor or answer the exercise…"
              aria-label="Message your tutor"
              disabled={thinking}
              onkeydown={handleComposerKeydown}
            />
            <Button
              size="icon"
              class="h-12 w-12 shrink-0"
              aria-label="Send message"
              title="Send message"
              disabled={thinking || !draft.trim()}
              onclick={() => void sendMessage()}
            >
              {#if thinking}
                <LoaderCircle class="h-4 w-4 animate-spin motion-reduce:animate-none" />
              {:else}
                <Send class="h-4 w-4" />
              {/if}
            </Button>
          </div>

          <div
            class="mt-2 flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
          >
            <span>Enter to send · Shift + Enter for a new line</span>
            <span class="inline-flex items-center gap-1.5">
              {#if saveState === 'saving'}
                <LoaderCircle class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Saving…
              {:else if saveState === 'saved'}
                <Check class="h-3.5 w-3.5 text-primary" /> Progress saved
              {:else if saveState === 'failed'}
                Progress could not be saved
              {:else if !canPersist}
                View-only conversation
              {/if}
            </span>
          </div>
          <FormError message={sendError ?? voiceError} class="pt-2" />
          {#if lastRunUrl && !thinking}
            <a
              href={lastRunUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-1 inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              View latest H session <ExternalLink class="h-3.5 w-3.5" />
            </a>
          {/if}
        </div>
      </section>
    </div>
  {/if}
</div>
