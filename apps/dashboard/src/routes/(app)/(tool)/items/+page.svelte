<!-- The items page: the template's worked example of a tool's page. A list the
     shell's way (the remembered paged list, the table, its toolbar), one dialog
     to add and to edit, one confirmation to delete. It lives in the tool's
     half and imports the shell freely; the shell never imports it. -->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import ItemDialog from '$lib/tool/components/items/ItemDialog.svelte';
  import ProjectFilter from '$lib/tool/components/projects/ProjectFilter.svelte';
  import ItemProjectTags from '$lib/tool/components/projects/ItemProjectTags.svelte';
  import { ITEMS_LIST, noteExcerpt } from '$lib/tool/items';
  import { isNotFound, itemProjects } from '$lib/tool/projects-client';
  import { createProjectFilter } from '$lib/tool/project-filter.svelte';
  import { filterScope } from '$lib/projects/filter';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatDate, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Item } from '@app/contract';

  let { data } = $props();

  // A guest is an external person granted one object of the tool: the server
  // lists them no item and refuses their writes (403), so the page shows its
  // empty state and none of the controls.
  const isGuest = $derived(data.me.origin === 'guest');

  // The project filter (PRDCT-2585), remembered across reloads. The list is
  // made anew for each choice and remembered per choice; with no filter it
  // keeps the name `items`, the one the shell warms. A remembered project that
  // is gone or no longer readable answers 404: the filter falls back to all
  // projects and forgets itself, without a word. A guest is in no project
  // (D2), so the projects are not even asked for.
  // the page is made anew for each person and workspace (the layout reloads on a switch)
  // svelte-ignore state_referenced_locally
  const filter = createProjectFilter('items', filterScope(data.me));
  const list = $derived.by(() => {
    const projectId = filter.projectId;
    return createPagedList<Item>(
      async (p) => {
        try {
          return await itemProjects.itemsOf(projectId, p);
        } catch (e) {
          if (projectId && isNotFound(e)) filter.forget();
          throw e;
        }
      },
      { remember: filter.listName(ITEMS_LIST) }
    );
  });

  // The filter settles first, then the list loads: a remembered project the
  // reader no longer reads is dropped by the filter, so the list is never
  // built twice for one page open (nor fetched once for a 404 nobody shows).
  let filterReady = $state(false);
  $effect(() => {
    if (isGuest) {
      filterReady = true;
      return;
    }
    void filter.load().finally(() => (filterReady = true));
  });
  $effect(() => {
    if (filterReady) void list.load();
  });

  const items = $derived(list.items);
  // the toolbar's quiet line: how many items, once they are all here
  const itemCount = $derived(list.nextCursor ? undefined : rowCount('items.countOne', 'items.count'));

  // ── Add and edit: one dialog, `editTarget` null for a new item ─────────
  let showItemDialog = $state(false);
  let editTarget = $state<Item | null>(null);

  function openDialog(item: Item | null) {
    editTarget = item;
    showItemDialog = true;
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);
  let deleteTarget = $state<Item | null>(null);

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteItem(deleteTarget.id);
      toast.success(t('items.deletedToast', { name: deleteTarget.name }));
      showDeleteDialog = false;
      deleteTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      deleteLoading = false;
    }
  }

  const columns: ColumnDef<Item, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('items.colName') }),
      // SECURITY: names and notes are USER-AUTHORED. Returning the plain string
      // renders through FlexRender's text interpolation, always escaped. Never
      // wrap these values in createRawSnippet / {@html}.
      cell: ({ row }) => row.getValue('name'),
      meta: { title: t('items.colName') }
    },
    {
      accessorKey: 'note',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('items.colNote') }),
      cell: ({ row }) => noteExcerpt(row.original.note) || '—',
      meta: { title: t('items.colNote') }
    },
    {
      id: 'projects',
      header: () => t('items.colProjects'),
      // SECURITY: project names are USER-AUTHORED; the tags render them as text.
      cell: ({ row }) => renderComponent(ItemProjectTags, { item: row.original }),
      meta: { title: t('items.colProjects'), width: '200px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('items.colCreated') }),
      cell: ({ row }) => formatDate(row.getValue('createdAt') as string),
      meta: { title: t('items.colCreated'), width: '112px' }
    },
    {
      accessorKey: 'updatedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('items.colUpdated') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('updatedAt') as string),
      meta: { title: t('items.colUpdated'), width: '130px' }
    },
    ...(isGuest
      ? []
      : [
          {
            id: 'actions',
            cell: ({ row }) =>
              renderComponent(DataTableActions, {
                actions: [
                  { label: t('items.actionEdit'), onclick: () => openDialog(row.original) },
                  {
                    label: t('items.actionDelete'),
                    onclick: () => {
                      deleteTarget = row.original;
                      showDeleteDialog = true;
                    },
                    variant: 'destructive' as const
                  }
                ]
              }),
            meta: { width: '60px' }
          } satisfies ColumnDef<Item, unknown>
        ])
  ]);
</script>

<svelte:head>
  <title>{t('items.title')} · {data.instance.name}</title>
</svelte:head>

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('items.title')}
  lede={t('items.description')}
  drawing="apollonian"
/>

{#snippet createAction()}
  {#if !isGuest}
    <Button onclick={() => openDialog(null)} size="sm" class="h-8 gap-1.5">
      <Plus class="h-4 w-4" />
      {t('items.create')}
    </Button>
  {/if}
{/snippet}

{#snippet projectFilter()}
  <ProjectFilter {filter} id="items-project-filter" />
{/snippet}

<FormError
  message={list.error && items.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={5} />
{:else if list.error && !items.length}
  <p class="text-sm text-destructive" in:appear>{t('items.loadFailed', { error: list.error })}</p>
{:else if !items.length && !filter.projectId}
  <Card.Root class="mx-auto mt-6 max-w-xl" data-testid="items-empty">
    <Card.Header>
      <Card.Title class="text-base">{t('items.emptyTitle')}</Card.Title>
      <Card.Description>{isGuest ? t('items.emptyBodyGuest') : t('items.emptyBody')}</Card.Description>
    </Card.Header>
    {#if !isGuest}
      <Card.Content>
        {@render createAction()}
      </Card.Content>
    {/if}
  </Card.Root>
{:else}
  <!-- a project with no item keeps the table and its toolbar, so the filter can be changed -->
  <DataTable
    data={items}
    {columns}
    showViewOptions={false}
    count={itemCount}
    toolbar={projectFilter}
    actions={createAction}
    emptyMessage={t('items.projectEmpty')}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<ItemDialog bind:open={showItemDialog} item={editTarget} onSaved={() => void list.refresh()} />

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={t('items.deleteConfirmTitle')}
  description={t('items.deleteConfirmDescription', { name: deleteTarget?.name ?? '' })}
  confirmLabel={t('items.actionDelete')}
  onClose={() => {
    showDeleteDialog = false;
    deleteTarget = null;
  }}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>
