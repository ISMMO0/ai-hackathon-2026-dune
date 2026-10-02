<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Brain from '@lucide/svelte/icons/brain';
  import Check from '@lucide/svelte/icons/check';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Search from '@lucide/svelte/icons/search';
  import Send from '@lucide/svelte/icons/send';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import X from '@lucide/svelte/icons/x';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { projectCan } from '$lib/projects/can';
  import type { Project } from '$lib/projects/types';
  import { itemProjects } from '$lib/tool/projects-client';
  import {
    TUTOR_JOURNAL_MARKER,
    TUTOR_JOURNAL_NAME,
    isTutorProject,
    parseTutorJournal,
    serializeTutorJournal,
    tutorWelcome,
    type TutorChatMessage
  } from '$lib/tool/tutors';
  import {
    applyLearnerPatch,
    applyModuleResearch,
    buildConversationInput,
    buildHTurnInstruction,
    buildModuleResearchInstruction,
    buildTutorSystemPrompt,
    buildWebResearchInstruction,
    compareLessons,
    legacySkill,
    moduleOf,
    moduleToPrepare,
    parseLearnerState,
    parseSkillItems,
    parseTutorTurn,
    renderSkillMarkdown,
    skillKeyOf,
    skillSection,
    type SkillSectionKey,
    type TutorSkill,
    type TutorTurn
  } from '$lib/tool/tutor-skill';
  import { fromBase64 } from '$lib/tool/wav';
  import type { Item, Run } from '@app/contract';

  type BrainMode = 'azure' | 'h';
  type LlmRespond = (req: {
    input: string;
    instructions?: string;
    model?: 'luna' | 'terra';
  }) => Promise<{ text: string }>;

  // The Azure route lands with the LLM integration; until then (or when its key is unset) H is the brain.
  const llmRespond = (api as unknown as { llmRespond?: LlmRespond }).llmRespond?.bind(api);

  const projectId = $derived(page.params.projectId ?? '');
  let project = $state<Project | null>(null);
  let skill = $state<TutorSkill | null>(null);
  let sections = $state<Partial<Record<SkillSectionKey, Item>>>({});
  let journal = $state<Item | null>(null);
  let messages = $state<TutorChatMessage[]>([]);
  let draft = $state('');
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let sendError = $state<string | null>(null);
  let voiceError = $state<string | null>(null);
  let thinking = $state(false);
  let researching = $state<string | null>(null);
  let preparingModule = $state<number | null>(null);
  let speakingId = $state<string | null>(null);
  let saveState = $state<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  let brainMode = $state<BrainMode>(llmRespond ? 'azure' : 'h');
  let brainOpen = $state(false);
  let stateFlash = $state(0);
  let activeRun = $state<Run | null>(null);
  let lastRunUrl = $state<string | null>(null);
  let messageList: HTMLElement | null = $state(null);
  let disposed = false;
  const prepareFailed: number[] = [];
  let playback: { context: AudioContext; source: AudioBufferSourceNode } | null = null;

  const canPersist = $derived(project ? projectCan.write(project) : false);
  const progress = $derived(skill?.state.progress ?? 0);
  const currentModule = $derived(skill ? moduleOf(skill, skill.state.currentLesson) : null);
  const skillMarkdown = $derived(skill ? renderSkillMarkdown(skill) : '');
  const skillFixed = $derived(skillMarkdown.split('## Learner state')[0]);
  const skillLiving = $derived(
    skillMarkdown.includes('## Learner state')
      ? `## Learner state${skillMarkdown.split('## Learner state')[1]}`
      : ''
  );

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
      const found: Partial<Record<SkillSectionKey, Item>> = {};
      for (const item of result.items) {
        const key = skillKeyOf(item.note);
        if (key) found[key] = item;
      }
      sections = found;

      const saved = journal ? parseTutorJournal(journal.note) : null;
      let loaded = parseSkillItems(result.items);
      if (!loaded) {
        // A tutor made before the skill existed: its lesson Items become module 1.
        const lessonItems = result.items
          .filter((item) => !item.note.startsWith(TUTOR_JOURNAL_MARKER) && !skillKeyOf(item.note))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        loaded = legacySkill(loadedProject, lessonItems, saved?.progress ?? 0);
        if (found.state) loaded.state = parseLearnerState(found.state.note);
      }
      skill = loaded;

      messages = saved?.messages.length
        ? saved.messages
        : [
            {
              id: messageId(),
              role: 'tutor',
              text:
                loaded.teacher.welcome || tutorWelcome(loadedProject.name, loadedProject.description ?? '')
            }
          ];
      await scrollToLatest();
      void prepareNextModule();
    } catch (error) {
      loadError = errorMessage(error, 'The Tutor Room could not be opened.');
    } finally {
      loading = false;
    }
  }

  async function saveSection(key: SkillSectionKey) {
    if (!project || !skill || !canPersist) return;
    const draftSection = skillSection(skill, key);
    const existing = sections[key];
    const item = existing
      ? await api.updateItem(existing.id, { name: draftSection.name, note: draftSection.note })
      : (await api.createItem({ name: draftSection.name, note: draftSection.note, projectIds: [project.id] }))
          .item;
    sections = { ...sections, [key]: item };
  }

  async function persistTurn() {
    if (!project || !skill || !canPersist) return;
    saveState = 'saving';
    const note = serializeTutorJournal(messages, skill.state.progress, new Date().toISOString());
    try {
      await Promise.all([
        saveSection('state'),
        journal
          ? api.updateItem(journal.id, { note }).then((item) => (journal = item))
          : api
              .createItem({ name: TUTOR_JOURNAL_NAME, note, projectIds: [project.id] })
              .then(({ item }) => (journal = item))
      ]);
      saveState = 'saved';
    } catch {
      saveState = 'failed';
    }
  }

  /** One H run, polled to its answer. */
  async function runH(instruction: string, track = true): Promise<string> {
    const { run } = await api.createRun({ instruction });
    let current = run;
    if (track) {
      activeRun = current;
      lastRunUrl = current.liveUrl;
    }
    while (!disposed && current.state === 'running') {
      await wait(2500);
      if (disposed) throw new Error('The room was closed.');
      current = await api.getRun(current.id);
      if (track) {
        activeRun = current;
        lastRunUrl = current.liveUrl ?? lastRunUrl;
      }
    }
    if (current.state !== 'completed' || !current.answer) {
      throw new Error(current.error || 'H could not complete this task.');
    }
    return current.answer;
  }

  const llmUnavailable = (error: unknown) =>
    error instanceof PlatformApiError && (error.status === 404 || error.status === 503);

  /** The brain's turn: Azure reads the whole skill.md and may ask H to research; H answers alone otherwise. */
  async function brainTurn(current: TutorSkill): Promise<TutorTurn> {
    if (brainMode === 'azure' && llmRespond) {
      try {
        const first = parseTutorTurn(
          (
            await llmRespond({
              instructions: buildTutorSystemPrompt(current),
              input: buildConversationInput(messages)
            })
          ).text
        );
        if (!first.research) return first;

        // The brain chose the tool: say so, let H research, then answer with what it found.
        messages = [...messages, { id: messageId(), role: 'tutor', text: first.reply }];
        researching = first.research;
        await scrollToLatest();
        const found = await runH(buildWebResearchInstruction(current, first.research));
        const second = parseTutorTurn(
          (
            await llmRespond({
              instructions: buildTutorSystemPrompt(current, false),
              input: buildConversationInput(messages, `Research results for "${first.research}":\n${found}`)
            })
          ).text
        );
        return { ...second, research: null, state: { ...first.state, ...second.state } };
      } catch (error) {
        if (!llmUnavailable(error)) throw error;
        brainMode = 'h';
      } finally {
        researching = null;
      }
    }
    return parseTutorTurn(await runH(buildHTurnInstruction(current, messages)));
  }

  async function sendMessage(text = draft) {
    const learnerText = text.trim();
    if (!learnerText || !project || !skill || thinking) return;

    sendError = null;
    draft = '';
    messages = [...messages, { id: messageId(), role: 'learner', text: learnerText }];
    thinking = true;
    await scrollToLatest();

    try {
      const turn = await brainTurn(skill);
      messages = [...messages, { id: messageId(), role: 'tutor', text: turn.reply }];
      skill = { ...skill, state: applyLearnerPatch(skill.state, turn.state) };
      stateFlash += 1;
      await scrollToLatest();
      await persistTurn();
      void prepareNextModule();
    } catch (error) {
      sendError = errorMessage(error, 'The tutor could not answer. Please try again.');
    } finally {
      thinking = false;
      activeRun = null;
    }
  }

  /** Detail the next module of the roadmap in the background, before the student gets there. */
  async function prepareNextModule() {
    if (!skill || !canPersist || preparingModule !== null) return;
    const module = moduleToPrepare(skill);
    if (!module || prepareFailed.includes(module.number)) return;
    preparingModule = module.number;
    try {
      const answer = await runH(buildModuleResearchInstruction(skill, module), false);
      if (disposed || !skill) return;
      skill = applyModuleResearch(skill, module.number, answer);
      stateFlash += 1;
      await Promise.all([
        saveSection(`module-${module.number}`),
        saveSection('roadmap'),
        saveSection('research')
      ]);
    } catch {
      prepareFailed.push(module.number);
    } finally {
      preparingModule = null;
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

<div class="mx-auto w-full max-w-2xl">
  {#if loading}
    <div class="flex min-h-[60vh] items-center justify-center" aria-live="polite">
      <LoaderCircle class="h-7 w-7 animate-spin text-sky-500 motion-reduce:animate-none" />
      <span class="sr-only">Opening your tutor</span>
    </div>
  {:else if loadError || !project}
    <div class="py-20 text-center">
      <p class="text-sm text-destructive" role="alert">{loadError ?? 'This tutor could not be opened.'}</p>
      <a
        href="/studio/tutors"
        class="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm text-sky-700 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-300 dark:hover:bg-sky-950/60"
      >
        <ArrowLeft class="h-4 w-4" /> My tutors
      </a>
    </div>
  {:else}
    <section
      class="flex h-[calc(100dvh-10rem)] min-h-[480px] flex-col sm:h-[calc(100dvh-7rem)]"
      aria-label="Tutor Room"
    >
      <!-- Header -->
      <header class="flex items-center gap-2 pb-3">
        <a
          href={`/studio/tutors/${project.id}`}
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-sky-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-slate-400 dark:hover:bg-sky-950/60 dark:hover:text-slate-100"
          aria-label="Back to the tutor"
          title="Back to the tutor"
        >
          <ArrowLeft class="h-5 w-5" />
        </a>
        <h1 class="min-w-0 flex-1 truncate text-lg font-semibold">{project.name}</h1>
        {#if lastRunUrl && !thinking}
          <a
            href={lastRunUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-sky-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:bg-sky-950/60"
            aria-label="Open the last H session"
            title="Last H session"
          >
            <ExternalLink class="h-4 w-4" />
          </a>
        {/if}
        <button
          type="button"
          class="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sky-600 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-300 dark:hover:bg-sky-950/60"
          aria-label="Open the tutor's brain"
          title="Tutor's brain"
          onclick={() => (brainOpen = true)}
        >
          <Brain class="h-5 w-5" />
          {#if preparingModule !== null}
            <span class="absolute right-2 top-2 h-2 w-2 animate-pulse rounded-full bg-amber-400"></span>
          {/if}
        </button>
        <span
          class="shrink-0 rounded-full bg-sky-50 px-3 py-1 text-sm font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-200"
          role="progressbar"
          aria-label="Learning progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}>{progress}%</span
        >
      </header>

      <!-- Lessons of the current module -->
      {#if currentModule && skill}
        <nav aria-label={`Module ${currentModule.number}: ${currentModule.title}`}>
          <p class="px-1 pb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            Module {currentModule.number} of {skill.roadmap.length} · {currentModule.title}
          </p>
          <ol class="flex gap-2 overflow-x-auto pb-3 [scrollbar-width:none]">
            {#each currentModule.lessons as lesson (lesson.id)}
              {@const done = compareLessons(lesson.id, skill.state.currentLesson) < 0}
              {@const current = lesson.id === skill.state.currentLesson}
              <li class="shrink-0">
                <button
                  type="button"
                  class="inline-flex min-h-11 max-w-[14rem] items-center gap-2 rounded-full py-1 pl-1 pr-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50 {current
                    ? 'bg-sky-600 text-white dark:bg-sky-500 dark:text-slate-950'
                    : 'bg-sky-50 text-slate-700 hover:bg-sky-100 dark:bg-sky-950/50 dark:text-slate-200 dark:hover:bg-sky-950'}"
                  disabled={thinking}
                  title={lesson.title}
                  onclick={() => void sendMessage(`Let's do lesson ${lesson.id}: ${lesson.title}.`)}
                >
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-200"
                  >
                    {#if done}<Check class="h-4 w-4" />{:else}{lesson.id}{/if}
                  </span>
                  <span class="truncate">{lesson.title}</span>
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
                class="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-sky-600 px-4 py-2.5 text-[15px] leading-6 text-white dark:bg-sky-500 dark:text-slate-950"
              >
                <span class="sr-only">You: </span>{message.text}
              </p>
            </div>
          {:else}
            <div class="max-w-[90%]">
              <p
                class="whitespace-pre-wrap rounded-3xl rounded-bl-lg bg-sky-50 px-4 py-2.5 text-[15px] leading-6 text-slate-800 dark:bg-slate-900 dark:text-slate-100"
              >
                <span class="sr-only">Tutor: </span>{message.text}
              </p>
              <button
                type="button"
                class="ml-1 mt-0.5 inline-flex h-11 w-11 items-center justify-center rounded-full text-sky-600 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-40 dark:text-sky-300 dark:hover:bg-sky-950/60"
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
              class="inline-flex items-center gap-1.5 rounded-3xl rounded-bl-lg bg-sky-50 px-5 py-4 dark:bg-slate-900"
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
            {#if researching}
              <p class="ml-1 mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <Search class="h-3 w-3" /> Looking up: {researching}
              </p>
            {/if}
            {#if activeRun?.liveUrl}
              <a
                href={activeRun.liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="ml-1 mt-1 flex min-h-11 w-fit items-center gap-1.5 rounded-full px-3 text-xs text-slate-500 hover:bg-sky-50 hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:bg-sky-950/60 dark:hover:text-sky-300"
              >
                Watch H live <ExternalLink class="h-3 w-3" />
              </a>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Composer -->
      <div class="pb-2 pt-2">
        {#if sendError || voiceError || saveState === 'failed'}
          <p class="mb-2 px-2 text-sm text-destructive" role="alert">
            {sendError ?? voiceError ?? 'Progress could not be saved.'}
          </p>
        {/if}
        <div
          class="flex items-end gap-2 rounded-3xl border border-sky-200 bg-white p-1.5 pl-5 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-200 dark:border-sky-800 dark:bg-slate-900 dark:focus-within:ring-sky-900"
        >
          <textarea
            bind:value={draft}
            rows={1}
            class="max-h-36 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-[15px] outline-none [field-sizing:content] placeholder:text-slate-400"
            placeholder="Write your answer"
            aria-label="Message your tutor"
            disabled={thinking}
            onkeydown={handleComposerKeydown}
          ></textarea>
          <button
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white transition-colors hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 disabled:bg-sky-200 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 dark:disabled:bg-sky-900 dark:disabled:text-sky-700"
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
</div>

{#if brainOpen && skill}
  <div class="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Tutor's brain">
    <button
      type="button"
      class="absolute inset-0 bg-slate-900/30"
      aria-label="Close the tutor's brain"
      onclick={() => (brainOpen = false)}
    ></button>
    <aside class="relative flex h-full w-full max-w-lg flex-col bg-white shadow-2xl dark:bg-slate-950">
      <header class="flex items-center gap-2 border-b border-sky-100 px-4 py-3 dark:border-sky-900/60">
        <Brain class="h-5 w-5 text-sky-600 dark:text-sky-300" />
        <h2 class="flex-1 font-semibold">Tutor's brain · skill.md</h2>
        <span
          class="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-200"
          title="Who answers in the chat"
        >
          {brainMode === 'azure' ? 'Azure LLM + H tool' : 'H'}
        </span>
        <button
          type="button"
          class="inline-flex h-11 w-11 items-center justify-center rounded-full text-slate-500 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:bg-sky-950/60"
          aria-label="Close"
          onclick={() => (brainOpen = false)}
        >
          <X class="h-5 w-5" />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {#if preparingModule !== null}
          <p
            class="mb-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <LoaderCircle class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            H is researching module {preparingModule} so it is ready in time
          </p>
        {/if}
        {#key stateFlash}
          <pre
            class="brain-flash whitespace-pre-wrap rounded-xl border border-sky-200 bg-sky-50/70 p-3 font-mono text-xs leading-5 text-slate-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-slate-100">{skillLiving}</pre>
        {/key}
        <pre
          class="mt-4 whitespace-pre-wrap font-mono text-xs leading-5 text-slate-600 dark:text-slate-300">{skillFixed}</pre>
      </div>
    </aside>
  </div>
{/if}

<style>
  .brain-flash {
    animation: brain-flash 1.6s ease-out;
  }
  @keyframes brain-flash {
    from {
      box-shadow: 0 0 0 4px rgb(56 189 248 / 0.45);
    }
    to {
      box-shadow: 0 0 0 0 rgb(56 189 248 / 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .brain-flash {
      animation: none;
    }
  }
</style>
