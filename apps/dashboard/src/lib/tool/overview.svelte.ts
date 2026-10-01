import { THEMES } from '$lib/brand/recipe.js';
import { createPagedList } from '$lib/stores/pagedList.svelte';
import { t } from '$lib/i18n';
import type { Item } from '@app/contract';
import type { OverviewFacts, OverviewStat, ToolOverview } from '$lib/contribution';
import { itemsPage, latestItems } from './items';

/** What the overview page shows of the items: the model its pieces read. */
export interface ItemOverview extends ToolOverview {
  readonly recentItems: Item[];
  readonly isGuest: boolean;
}

export function createItemOverview(facts: OverviewFacts): ItemOverview {
  const list = createPagedList<Item>(itemsPage, { limit: 100, remember: 'overview.itemsList' });

  // The API gives no total: the figure is the length of ONE page (limit 100),
  // and a trailing "+" keeps it honest when the list goes on. null while it
  // loads, and when the load failed with nothing to show.
  const count = $derived(
    list.loading || (list.error && !list.items.length)
      ? null
      : `${list.items.length}${list.nextCursor ? '+' : ''}`
  );
  const recentItems = $derived(latestItems(list.items, 3));

  // A guest lists no item and may add none: the tool has nothing to tell them,
  // so the shell says its own sentence.
  const lede = $derived(
    count === null || facts.isGuest()
      ? null
      : !list.items.length
        ? t('items.overviewLedeEmpty')
        : count === '1'
          ? t('items.overviewLedeOne', { workspace: facts.workspaceName() })
          : t('items.overviewLede', { n: count, workspace: facts.workspaceName() })
  );

  const stats = $derived<OverviewStat[]>([
    {
      id: 'items',
      label: t('items.title'),
      value: count,
      href: '/items',
      hint: t('items.overviewHint'),
      // the shell's drawings are a closed set; this one (marks along a line, the last one lit) says no more than "several, and a latest"
      drawing: 'fresh',
      color: THEMES.dawn.accent
    }
  ]);

  return {
    load() {
      void list.load();
    },
    get lede() {
      return lede;
    },
    get stats() {
      return stats;
    },
    get recentItems() {
      return recentItems;
    },
    get isGuest() {
      return facts.isGuest();
    }
  };
}
