<!-- The first of the overview's two lower tiles: the invitation to add an
     item. A guest may add none, so a guest gets no tile. The second tile, the
     team, is the shell's (routes/(app)/+page.svelte). Each half writes its tile
     in place with its own scoped `.lower` rules: keep the two in step. -->
<script lang="ts">
  import Box from '@lucide/svelte/icons/box';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { t } from '$lib/i18n';
  import type { ItemOverview } from '$lib/tool/overview.svelte';

  let { model }: { model: ItemOverview } = $props();
</script>

{#if !model.isGuest}
  <a href="/items" class="sheet tile lower" data-testid="add-item-tile">
    <div class="seat" aria-hidden="true"><Box class="size-7" strokeWidth={1.5} /></div>
    <div class="lower-copy">
      <h2 class="lower-title">{t('items.tileTitle')}</h2>
      <p class="lower-body">{t('items.tileBody')}</p>
      <span class="lower-cta">{t('items.tileCta')}<ArrowRight class="size-3.5" /></span>
    </div>
  </a>
{/if}

<style>
  .lower {
    display: grid;
    grid-template-columns: 1fr;
    gap: 18px;
    align-items: center;
    padding: 20px;
    overflow: hidden;
  }
  @media (min-width: 640px) {
    .lower {
      grid-template-columns: 210px 1fr;
      gap: 24px;
      padding: 22px 24px;
    }
  }
  .lower-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .lower-title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 20px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .lower-body {
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }
  .lower:hover .lower-cta :global(svg) {
    transform: translateX(3px);
  }
  .lower-cta :global(svg) {
    transition: transform var(--motion-duration) var(--motion-ease);
  }
  .lower-cta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 13.5px;
    color: var(--accent-deep);
  }
  /* an empty place waiting for an item: the dashed seat of the team tile, squared */
  .seat {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 96px;
    border: 1.5px dashed color-mix(in oklab, var(--accent) 50%, var(--hairline));
    border-radius: 10px;
    background: var(--ground);
    color: var(--accent-deep);
  }
</style>
