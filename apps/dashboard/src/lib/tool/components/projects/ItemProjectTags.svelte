<script lang="ts">
  /* The projects an item sits in, as small tags on its row (PRDCT-2585).
     Only the projects of the payload, which are the ones the reader can read.

     SECURITY: a project's name is USER-AUTHORED; Tag renders its label as
     text, never as markup. */
  import { Tag } from '$lib/components/ui/tag';
  import Folder from '@lucide/svelte/icons/folder';
  import { namedProjects } from '$lib/tool/projects-client';
  import type { Item } from '@app/contract';

  interface Props {
    item: Pick<Item, 'projects'>;
    /** A project left out: the one whose page the item is already shown on. */
    except?: string;
  }

  let { item, except }: Props = $props();

  const refs = $derived(namedProjects(item, except));
</script>

{#if refs.length}
  <span class="inline-flex min-w-0 flex-wrap gap-1.5" data-testid="item-projects">
    {#each refs as ref (ref.id)}
      <Tag label={ref.name} tone="slate" icon={Folder} />
    {/each}
  </span>
{/if}
