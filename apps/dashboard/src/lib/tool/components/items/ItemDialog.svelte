<!-- The one form of an item, for a new one and for an existing one: a name
     and a note, bounded as the contract bounds them (the server refuses what
     passes here by mistake; this only saves the round trip). -->
<script lang="ts">
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { api } from '$lib/api';
  import { toastApiError } from '$lib/billing-refusal';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { ITEM_NAME_MAX, ITEM_NOTE_MAX, type Item } from '@app/contract';

  interface Props {
    open: boolean;
    /** The item to edit, or null for a new one. */
    item: Item | null;
    /**
     * For a new item: the projects it is linked to as it is made, in the same
     * transaction (the project's page hands its own id). The server asks the
     * editor role or more on each; a refusal creates nothing.
     */
    projectIds?: string[];
    /** Called once the server has answered, with what it stored. */
    onSaved: (item: Item) => void;
  }

  let { open = $bindable(), item, projectIds, onSaved }: Props = $props();

  let name = $state('');
  let note = $state('');
  let loading = $state(false);

  // the fields start from the item each time the dialog opens
  $effect(() => {
    if (open) {
      name = item?.name ?? '';
      note = item?.note ?? '';
    }
  });

  async function submit() {
    // the contract trims the name before it measures it: a name of spaces is no name
    if (!name.trim()) {
      toast.error(t('items.errorNameEmpty'));
      return;
    }
    loading = true;
    try {
      const saved = item
        ? await api.updateItem(item.id, { name, note })
        : (await api.createItem({ name, note, ...(projectIds?.length ? { projectIds } : {}) })).item;
      toast.success(t(item ? 'items.updatedToast' : 'items.createdToast', { name: saved.name }));
      open = false;
      onSaved(saved);
    } catch (e) {
      // A billing refusal (402 top-up, 403 plan_required upgrade) is its card, as on the files page.
      toastApiError(e, t(item ? 'common.updateFailed' : 'items.createFailed'));
    } finally {
      loading = false;
    }
  }
</script>

<FormDialog
  bind:open
  title={t(item ? 'items.editTitle' : 'items.createTitle')}
  description={t('items.dialogDescription')}
  onClose={() => (open = false)}
  onSubmit={() => void submit()}
  {loading}
  submitLabel={t(item ? 'common.save' : 'items.create')}
>
  <div class="space-y-2">
    <Label for="item-name">{t('items.nameLabel')}</Label>
    <Input id="item-name" bind:value={name} maxlength={ITEM_NAME_MAX} required />
  </div>
  <div class="space-y-2">
    <Label for="item-note">{t('items.noteLabel')}</Label>
    <Textarea id="item-note" bind:value={note} maxlength={ITEM_NOTE_MAX} rows={5} />
    <p class="text-xs text-muted-foreground">{t('items.noteHint', { max: ITEM_NOTE_MAX })}</p>
  </div>
</FormDialog>
