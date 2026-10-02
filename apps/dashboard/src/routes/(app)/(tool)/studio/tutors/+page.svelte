<script lang="ts">
  import { onMount } from 'svelte';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import type { Project } from '$lib/projects/types';
  import { isTutorProject, tutorIdentity } from '$lib/tool/tutors';
  import { readTutorDescription } from '$lib/tool/tutor-view';

  let tutors = $state<Project[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // A soft colour per tutor, so the cards are told apart at a glance.
  const TINTS = [
    'from-sky-300 to-sky-500',
    'from-cyan-300 to-sky-500',
    'from-blue-300 to-indigo-400',
    'from-teal-300 to-cyan-500'
  ];

  onMount(async () => {
    try {
      const result = await projects.list({ archived: 'false', limit: 100 });
      tutors = result.projects.filter(isTutorProject);
    } catch (error) {
      loadError = errorMessage(error, 'Your tutors could not be loaded.');
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>My tutors · Tutor Studio</title>
</svelte:head>

<div class="mx-auto w-full max-w-5xl px-5 pb-16 pt-10 sm:px-6 sm:pt-14">
  <h1 class="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">My tutors</h1>

  {#if loading}
    <div class="flex justify-center py-24" aria-live="polite">
      <LoaderCircle class="h-8 w-8 animate-spin text-sky-400 motion-reduce:animate-none" />
      <span class="sr-only">Loading your tutors</span>
    </div>
  {:else if loadError}
    <p class="py-24 text-center text-red-600" role="alert">{loadError}</p>
  {:else}
    <ul class="mt-8 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
      {#each tutors as tutor, index (tutor.id)}
        {@const details = readTutorDescription(tutor.description).details}
        {@const displayName = tutorIdentity(tutor.description).tutorName ?? tutor.name}
        <li
          class="relative flex flex-col rounded-3xl bg-white p-5 shadow-sm shadow-sky-100 transition-shadow focus-within:ring-2 focus-within:ring-sky-400 hover:shadow-md hover:shadow-sky-100"
        >
          <div class="flex items-center gap-4">
            <span
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-xl font-bold text-white {TINTS[
                index % TINTS.length
              ]}"
              aria-hidden="true">{displayName.trim()[0]?.toUpperCase()}</span
            >
            <div class="min-w-0">
              <!-- The whole card opens the tutor's page -->
              <a
                href={`/studio/tutors/${tutor.id}`}
                class="block truncate text-lg font-bold text-slate-900 outline-none after:absolute after:inset-0 after:rounded-3xl"
                >{displayName}</a
              >
              <p class="truncate text-sm text-slate-500">{details.slice(0, 3).join(' · ')}</p>
            </div>
          </div>
          <div class="mt-5 flex items-center justify-between gap-3">
            <ul class="flex min-w-0 flex-wrap gap-1.5">
              {#each details.slice(3) as detail (detail)}
                <li class="truncate rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">
                  {detail}
                </li>
              {/each}
            </ul>
            <a
              href={`/studio/tutors/${tutor.id}/room`}
              class="relative z-10 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-sky-500 px-5 text-sm font-bold text-white hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2"
            >
              <Play class="h-4 w-4" /> Learn
            </a>
          </div>
        </li>
      {/each}

      <li>
        <a
          href="/studio"
          class="flex h-full min-h-36 flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-sky-200 text-sky-600 transition-colors hover:border-sky-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <Plus class="h-6 w-6" />
          <span class="font-semibold">New tutor</span>
        </a>
      </li>
    </ul>
  {/if}
</div>
