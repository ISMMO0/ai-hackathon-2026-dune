import Box from '@lucide/svelte/icons/box';
import GraduationCap from '@lucide/svelte/icons/graduation-cap';
import Globe from '@lucide/svelte/icons/globe';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Volume2 from '@lucide/svelte/icons/volume-2';
import type { ToolContribution } from '$lib/contribution';
import { t } from '$lib/i18n';
import { warmList } from '$lib/stores/pagedList.svelte';
import { ITEMS_LIST, itemsPage } from './items';
import { createItemOverview, type ItemOverview } from './overview.svelte';
import RecentItems from './components/overview/RecentItems.svelte';
import AddItemTile from './components/overview/AddItemTile.svelte';
import ProjectItems from './components/projects/ProjectItems.svelte';

/**
 * What the tool gives the shell: the one door into the tool's half
 * (contribution.ts says what each part is for). The words are the other
 * door, `./i18n`. Everything here is about `items`, the template's
 * placeholder resource: a tool replaces it entry by entry with its own.
 */
export const tool: ToolContribution<ItemOverview> = {
  // One section, offered to everyone: a guest opens it too and finds it empty
  // (the server lists a guest no item), without the controls to add one.
  nav: () => [
    {
      id: 'tutors',
      title: t('nav.tutors'),
      blurb: t('nav.blurb.tutors'),
      href: '/tutors',
      icon: GraduationCap,
      pattern: 'orbits'
    },
    {
      id: 'items',
      title: t('nav.items'),
      blurb: t('nav.blurb.items'),
      href: '/items',
      icon: Box,
      pattern: 'diamond'
    },
    // The starter's demo: the voice (Gradium) and the runs (H). A guest opens
    // it too, and finds the strip and no control.
    {
      id: 'try',
      title: t('nav.try'),
      blurb: t('nav.blurb.try'),
      href: '/try',
      icon: Sparkles,
      pattern: 'sonar'
    }
  ],

  // Nothing after the shell's Projects entry: the template has the one section.
  navAfter: () => [],

  // Keep the product itself at the thumb: Items remains available from Workspace.
  phoneTabs: ['tutors'],

  // No signed-out page.
  gateRoutes: [],

  // The same name and the same call as the items page (stores/warmLists.ts).
  warm() {
    void warmList(ITEMS_LIST, () => itemsPage({}));
  },

  audit: {
    // Kept in step with the `c.set('audit', { action })` calls of apps/server/src/api/{items,voice,runs}.ts by hand.
    actions: [
      'item.create',
      'item.delete',
      'item.project_link',
      'item.project_unlink',
      'item.update',
      'run.create',
      'voice.speak',
      'voice.transcribe'
    ],
    resourceTypes: ['item', 'run', 'voice'],
    glyphs: [
      { test: /\bitem\b/, icon: Box },
      { test: /\brun\b/, icon: Globe },
      { test: /\bvoice\b/, icon: Volume2 }
    ]
  },

  project: {
    Resources: ProjectItems
  },

  overview: {
    create: createItemOverview,
    Recent: RecentItems,
    Tile: AddItemTile
  }
};
