<script lang="ts">
  import { page } from '$app/state';
  import GraduationCap from '@lucide/svelte/icons/graduation-cap';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Plus from '@lucide/svelte/icons/plus';
  import Users from '@lucide/svelte/icons/users';
  import { signOutToLogin } from '$lib/session';

  let { children, data } = $props();

  const path = $derived(page.url.pathname);
  const onCreate = $derived(path === '/studio');
  const onTutors = $derived(path.startsWith('/studio/tutors'));
  const initials = $derived(
    (data.me.user.name || data.me.user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
  );
</script>

<div class="studio fixed inset-0 z-10 flex flex-col overflow-hidden">
  <header class="shrink-0 border-b border-sky-100 bg-white/90 backdrop-blur">
    <div class="mx-auto flex h-16 w-full max-w-5xl items-center gap-2 px-4 sm:px-6">
      <a
        href="/studio/tutors"
        class="flex min-h-11 items-center gap-2.5 rounded-xl pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span
          class="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500 text-white shadow-sm shadow-sky-200"
        >
          <GraduationCap class="h-5 w-5" />
        </span>
        <span class="hidden text-lg font-bold tracking-tight text-slate-900 sm:inline">Tutor Studio</span>
      </a>

      <nav class="ml-auto flex items-center gap-1" aria-label="Studio">
        <a
          href="/studio"
          aria-current={onCreate ? 'page' : undefined}
          class="inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 {onCreate
            ? 'bg-sky-100 text-sky-800'
            : 'text-slate-500 hover:bg-sky-50 hover:text-slate-800'}"
        >
          <Plus class="h-4 w-4" /> Create
        </a>
        <a
          href="/studio/tutors"
          aria-current={onTutors ? 'page' : undefined}
          class="inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 {onTutors
            ? 'bg-sky-100 text-sky-800'
            : 'text-slate-500 hover:bg-sky-50 hover:text-slate-800'}"
        >
          <Users class="h-4 w-4" /> My tutors
        </a>
      </nav>

      <details class="relative ml-1">
        <summary
          class="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 [&::-webkit-details-marker]:hidden"
          aria-label="Account"
        >
          <span
            class="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-sky-600 text-xs font-bold text-white"
            >{initials}</span
          >
        </summary>
        <div
          class="absolute right-0 top-12 z-20 w-56 overflow-hidden rounded-2xl border border-sky-100 bg-white p-1.5 shadow-lg shadow-sky-100"
        >
          <p class="truncate px-3 pb-2 pt-1.5 text-xs text-slate-400">{data.me.user.email}</p>
          <a
            href="/"
            class="flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm text-slate-700 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <LayoutGrid class="h-4 w-4 text-slate-400" /> Admin dashboard
          </a>
          <button
            type="button"
            class="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm text-slate-700 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            onclick={() => void signOutToLogin()}
          >
            <LogOut class="h-4 w-4 text-slate-400" /> Sign out
          </button>
        </div>
      </details>
    </div>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto">
    {@render children()}
  </main>
</div>

<style>
  /* The studio's own look: always light, white and light blue, a rounded type. */
  .studio {
    color-scheme: light;
    background: radial-gradient(1200px 500px at 50% -200px, #e0f2fe 0%, transparent 70%), #f8fbff;
    color: #0f172a;
    font-family: ui-rounded, 'SF Pro Rounded', 'Nunito', 'Quicksand', system-ui, sans-serif;
  }
  /* The dashboard's display serif stays out of the studio. */
  .studio :global(:is(h1, h2, h3)) {
    font-family: inherit;
    letter-spacing: -0.01em;
  }
</style>
