<!-- Under the overview's figures: the items changed last, each one a way to
     the items page. Nothing while there is none (the tile below invites). -->
<script lang="ts">
  import { noteExcerpt } from '$lib/tool/items';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { ItemOverview } from '$lib/tool/overview.svelte';

  let { model }: { model: ItemOverview } = $props();
</script>

{#if model.recentItems.length}
  <div class="section-head mt-10 !mb-5 items-center justify-between">
    <h2>{t('items.overviewRecent')}</h2>
    <a
      href="/items"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      {t('items.overviewBrowse')}
    </a>
  </div>
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="recent-items">
    {#each model.recentItems as item (item.id)}
      <a href="/items" class="sheet tile flex flex-col gap-1.5 p-5">
        <!-- SECURITY: a name and a note are USER-AUTHORED: text interpolation only, never {@html}. -->
        <span class="truncate font-medium">{item.name}</span>
        {#if item.note}
          <span class="line-clamp-2 text-sm text-muted-foreground">{noteExcerpt(item.note)}</span>
        {/if}
        <span class="mt-auto pt-1 text-xs text-muted-foreground">{formatTimeAgo(item.updatedAt)}</span>
      </a>
    {/each}
  </div>
{/if}
