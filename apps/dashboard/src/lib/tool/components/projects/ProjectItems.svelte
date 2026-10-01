<!-- What a project holds in this tool (PRDCT-2585): its items. The shell's
     project page renders it under the members, through the contribution's
     `project.Resources` door. The shell owns the project and its roles; this
     piece reads them (`projectCan`) to show a control only to who may use
     it, and an archived project shows none: its list stays readable. Every
     project fact comes through `$lib/tool/projects-client`.

     SECURITY: item names, notes and the project's name are USER-AUTHORED;
     they render through text interpolation only, never {@html}. -->
<script lang="ts">
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import ItemDialog from '$lib/tool/components/items/ItemDialog.svelte';
  import PickList from './PickList.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import Link from '@lucide/svelte/icons/link';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { errorMessage } from '$lib/api';
  import { itemProjects, itemsToLink } from '$lib/tool/projects-client';
  import { noteExcerpt } from '$lib/tool/items';
  import { projectCan } from '$lib/projects/can';
  import type { Project } from '$lib/projects/types';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Item } from '@app/contract';

  let { project }: { project: Project } = $props();

  // The route keys the page on the id: one project for this piece's life. The
  // list below reads it once, and the controls follow the prop, which the
  // page hands over anew after every change.
  // svelte-ignore state_referenced_locally
  const projectId = project.id;

  // An editor adds an item here, links one and takes one out; a viewer reads.
  const canWrite = $derived(projectCan.write(project));

  // ── The items ──────────────────────────────────────────────────────────
  const list = createPagedList<Item>((p) => itemProjects.itemsOf(projectId, p));
  $effect(() => {
    void list.load();
  });

  const items = $derived(list.items);
  const itemCount = $derived(list.nextCursor ? undefined : rowCount('items.countOne', 'items.count'));

  // ── Add: the items page's own dialog, the new item linked as it is made ─
  let showAddDialog = $state(false);

  // ── Link an item the workspace already has ─────────────────────────────
  let showLinkDialog = $state(false);
  let linkChoices = $state<Item[] | null>(null);
  // the offer is one page: a workspace with more items than that says so
  let linkOfferPartial = $state(false);
  let linkOfferEmpty = $state(false);
  let linkChoicesError = $state<string | null>(null);
  let linkChoice = $state<string | null>(null);
  let linking = $state(false);

  async function openLinkDialog() {
    linkChoice = null;
    linkChoices = null;
    linkChoicesError = null;
    showLinkDialog = true;
    try {
      const { items, nextCursor } = await itemProjects.itemsOf(null, { limit: 100 });
      linkChoices = itemsToLink(items, projectId);
      linkOfferPartial = nextCursor !== null;
      linkOfferEmpty = items.length === 0;
    } catch (e) {
      linkChoicesError = errorMessage(e);
    }
  }

  async function linkItem() {
    if (!linkChoice || linking) return;
    const chosen = linkChoices?.find((i) => i.id === linkChoice);
    linking = true;
    try {
      await itemProjects.link(linkChoice, projectId);
      showLinkDialog = false;
      toast.success(t('items.linkedToast', { name: chosen?.name ?? '', project: project.name }));
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      linking = false;
    }
  }

  // ── Unlink: the item stays, the project is one place fewer it shows ────
  let showUnlinkDialog = $state(false);
  let unlinking = $state(false);
  let unlinkTarget = $state<Item | null>(null);

  async function unlinkItem() {
    if (!unlinkTarget) return;
    unlinking = true;
    try {
      await itemProjects.unlink(unlinkTarget.id, projectId);
      toast.success(t('items.unlinkedToast', { name: unlinkTarget.name, project: project.name }));
      showUnlinkDialog = false;
      unlinkTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      unlinking = false;
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
      accessorKey: 'updatedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('items.colUpdated') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('updatedAt') as string),
      meta: { title: t('items.colUpdated'), width: '130px' }
    },
    ...(canWrite
      ? [
          {
            id: 'actions',
            cell: ({ row }) =>
              renderComponent(DataTableActions, {
                actions: [
                  {
                    label: t('items.actionUnlink'),
                    onclick: () => {
                      unlinkTarget = row.original;
                      showUnlinkDialog = true;
                    }
                  }
                ]
              }),
            meta: { width: '60px' }
          } satisfies ColumnDef<Item, unknown>
        ]
      : [])
  ]);
</script>

{#snippet writeActions()}
  <Button variant="outline" size="sm" class="h-8 gap-1.5" onclick={() => void openLinkDialog()}>
    <Link class="h-4 w-4" />
    {t('items.projectLink')}
  </Button>
  <Button size="sm" class="h-8 gap-1.5" onclick={() => (showAddDialog = true)}>
    <Plus class="h-4 w-4" />
    {t('items.projectAdd')}
  </Button>
{/snippet}

<section data-testid="project-items" data-project={projectId}>
  <h2 class="font-display text-[19px] font-normal leading-tight tracking-[-0.01em]">
    {t('items.projectTitle')}
  </h2>
  <p class="mb-4 mt-1 max-w-[62ch] text-sm text-muted-foreground">{t('items.projectDescription')}</p>

  <FormError
    message={list.error && items.length ? t('common.refreshFailedCached', { error: list.error }) : null}
    class="pb-3"
  />
  {#if list.loading}
    <TableSkeleton columns={3} rows={3} />
  {:else if list.error && !items.length}
    <p class="text-sm text-destructive" in:appear>{t('items.loadFailed', { error: list.error })}</p>
  {:else}
    <DataTable
      data={items}
      {columns}
      searchColumns={['name', 'note']}
      count={itemCount}
      actions={canWrite ? writeActions : undefined}
      emptyMessage={t('items.projectEmpty')}
      showViewOptions={false}
      sticky={false}
    />
    {#if list.nextCursor}
      <div class="flex justify-center py-4" transition:reveal>
        <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? t('common.loading') : t('common.loadMore')}
        </Button>
      </div>
    {/if}
  {/if}
</section>

<ItemDialog
  bind:open={showAddDialog}
  item={null}
  projectIds={[projectId]}
  onSaved={() => void list.refresh()}
/>

<FormDialog
  bind:open={showLinkDialog}
  title={t('items.linkTitle')}
  description={t('items.linkDescription')}
  onClose={() => (showLinkDialog = false)}
  onSubmit={() => void linkItem()}
  loading={linking}
  submitLabel={t('items.linkSubmit')}
>
  {#if linkChoicesError}
    <p class="text-sm text-destructive">{t('items.loadFailed', { error: linkChoicesError })}</p>
  {:else if linkChoices === null}
    <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
  {:else if !linkChoices.length}
    <p class="text-sm text-muted-foreground">{t(linkOfferEmpty ? 'items.linkNone' : 'items.linkAllIn')}</p>
  {:else}
    <PickList
      bind:value={linkChoice}
      label={t('items.linkTitle')}
      items={linkChoices.map((i) => ({ id: i.id, title: i.name, detail: noteExcerpt(i.note) || undefined }))}
      searchPlaceholder={t('items.linkSearchPlaceholder')}
      noMatch={t('items.linkNoMatch')}
    />
    {#if linkOfferPartial}
      <p class="text-xs text-muted-foreground">{t('items.linkPartial')}</p>
    {/if}
  {/if}
</FormDialog>

<ConfirmDialog
  bind:open={showUnlinkDialog}
  title={t('items.unlinkConfirmTitle')}
  description={t('items.unlinkConfirmDescription', { name: unlinkTarget?.name ?? '', project: project.name })}
  confirmLabel={t('items.actionUnlink')}
  variant="default"
  onClose={() => {
    showUnlinkDialog = false;
    unlinkTarget = null;
  }}
  onConfirm={() => void unlinkItem()}
  loading={unlinking}
/>
