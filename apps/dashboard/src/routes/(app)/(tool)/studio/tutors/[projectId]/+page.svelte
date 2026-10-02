<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Play from '@lucide/svelte/icons/play';
  import { errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { itemProjects } from '$lib/tool/projects-client';
  import { TUTOR_JOURNAL_MARKER, isTutorProject, parseTutorJournal } from '$lib/tool/tutors';
  import { buildSkillMarkdown, buildTutorView, sourceUrl, type TutorView } from '$lib/tool/tutor-view';

  const projectId = $derived(page.params.projectId ?? '');
  let view = $state<TutorView | null>(null);
  let progress = $state(0);
  let started = $state(false);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let copied = $state(false);

  const skill = $derived(view ? buildSkillMarkdown(view) : '');

  onMount(async () => {
    try {
      const [project, result] = await Promise.all([
        projects.get(projectId),
        itemProjects.itemsOf(projectId, { limit: 100 })
      ]);
      if (!isTutorProject(project)) throw new Error('This is not a Tutor Studio tutor.');
      view = buildTutorView(project, result.items);
      const journal = result.items.find((item) => item.note.startsWith(TUTOR_JOURNAL_MARKER));
      const saved = journal ? parseTutorJournal(journal.note) : null;
      progress = saved?.progress ?? 0;
      started = Boolean(saved?.messages.length);
    } catch (error) {
      loadError = errorMessage(error, 'This tutor could not be opened.');
    } finally {
      loading = false;
    }
  });

  function downloadSkill() {
    const url = URL.createObjectURL(new Blob([skill], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'SKILL.md';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copySkill() {
    try {
      await navigator.clipboard.writeText(skill);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
    }
  }
</script>

<svelte:head>
  <title>{view?.name ?? 'Tutor'} · Tutor Studio</title>
</svelte:head>

<div class="mx-auto w-full max-w-3xl px-5 pb-20 pt-6 sm:px-6 sm:pt-10">
  <a
    href="/studio/tutors"
    class="-ml-3 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
  >
    <ArrowLeft class="h-4 w-4" /> My tutors
  </a>

  {#if loading}
    <div class="flex justify-center py-24" aria-live="polite">
      <LoaderCircle class="h-8 w-8 animate-spin text-sky-400 motion-reduce:animate-none" />
      <span class="sr-only">Loading the tutor</span>
    </div>
  {:else if loadError || !view}
    <p class="py-24 text-center text-red-600" role="alert">{loadError}</p>
  {:else}
    <!-- Who this tutor is -->
    <section class="mt-4 rounded-[2rem] bg-white p-6 shadow-sm shadow-sky-100 sm:p-8">
      <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
        <span
          class="flex h-20 w-20 shrink-0 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-300 to-sky-500 text-3xl font-bold text-white"
          aria-hidden="true">{view.name.trim()[0]?.toUpperCase()}</span
        >
        <div class="min-w-0">
          <h1 class="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{view.name}</h1>
          <ul class="mt-3 flex flex-wrap gap-1.5">
            {#each view.details as detail (detail)}
              <li class="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">{detail}</li>
            {/each}
          </ul>
        </div>
      </div>

      {#if view.approach}
        <p class="mt-6 leading-7 text-slate-600">{view.approach}</p>
      {/if}

      <div class="mt-6">
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium text-slate-500">Progress</span>
          <span class="font-bold text-sky-700">{progress}%</span>
        </div>
        <div
          class="mt-2 h-2.5 overflow-hidden rounded-full bg-sky-50"
          role="progressbar"
          aria-label="Learning progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div class="h-full rounded-full bg-sky-400" style:width={`${progress}%`}></div>
        </div>
      </div>

      <a
        href={`/studio/tutors/${projectId}/room`}
        class="mt-7 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-sky-500 px-10 text-lg font-bold text-white shadow-lg shadow-sky-200 transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 sm:w-auto"
      >
        <Play class="h-5 w-5" />
        {started ? 'Continue learning' : 'Start learning'}
      </a>
    </section>

    <!-- The course -->
    <section class="mt-10">
      <h2 class="text-xl font-bold text-slate-900">Lessons</h2>
      <ol class="mt-4 grid gap-3">
        {#each view.lessons as lesson (lesson.id)}
          <li class="flex gap-4 rounded-3xl bg-white p-5 shadow-sm shadow-sky-100">
            <span
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-100 font-bold text-sky-700"
              >{lesson.number}</span
            >
            <div class="min-w-0">
              <h3 class="font-bold text-slate-900">{lesson.title}</h3>
              {#if lesson.objective}<p class="mt-1 text-sm leading-6 text-slate-600">
                  {lesson.objective}
                </p>{/if}
              {#if lesson.activity}
                <p class="mt-2 text-sm leading-6 text-slate-500">
                  <span class="font-semibold text-sky-700">Try it:</span>
                  {lesson.activity}
                </p>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    </section>

    <!-- Where H found it -->
    {#if view.sources.length}
      <section class="mt-10">
        <h2 class="text-xl font-bold text-slate-900">Sources</h2>
        <ul class="mt-4 grid gap-2">
          {#each view.sources as source (source)}
            {@const url = sourceUrl(source)}
            <li>
              {#if url}
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex min-h-11 items-center gap-3 rounded-2xl bg-white px-4 py-3 text-sm text-slate-700 shadow-sm shadow-sky-100 hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  <span class="min-w-0 flex-1 truncate"
                    >{source.replace(url, '').replace(/[:\-–\s]+$/, '') || url}</span
                  >
                  <ExternalLink class="h-4 w-4 shrink-0 text-slate-400" />
                </a>
              {:else}
                <p class="rounded-2xl bg-white px-4 py-3 text-sm text-slate-700 shadow-sm shadow-sky-100">
                  {source}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- The portable tutor -->
    <section class="mt-10 rounded-[2rem] bg-gradient-to-br from-sky-500 to-sky-600 p-6 text-white sm:p-8">
      <h2 class="text-xl font-bold">SKILL.md</h2>
      <p class="mt-1 text-sm text-sky-100">Give this tutor to any AI agent.</p>
      <div class="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          class="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-sky-700 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-sky-600"
          onclick={downloadSkill}
        >
          <Download class="h-4 w-4" /> Download
        </button>
        <button
          type="button"
          class="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/15 px-5 text-sm font-bold text-white hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onclick={() => void copySkill()}
        >
          {#if copied}<Check class="h-4 w-4" /> Copied{:else}<Copy class="h-4 w-4" /> Copy{/if}
        </button>
      </div>
    </section>
  {/if}
</div>
