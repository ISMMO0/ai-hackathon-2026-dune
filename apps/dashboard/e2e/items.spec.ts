import { test, expect } from '@playwright/test';
import { signInAsOwner } from './accounts';

/**
 * The tool's page, in a real browser against the real stack (`dependencies:
 * ['smoke']`, so the owner exists): an item lives its whole life through the
 * dashboard. Opened from the menu, added, seen in the list and on the
 * overview, edited, deleted. In English; the words are the tool's own
 * (src/lib/tool/i18n).
 */

const NAME = 'First item E2E';
const RENAMED = 'First item E2E, renamed';
const NOTE = 'A note written by the browser suite.';

test('an item is added from the items page, shows on the overview, is edited and deleted', async ({
  page
}) => {
  await test.step('sign in as the owner', async () => {
    await signInAsOwner(page);
  });

  await test.step('open Items from the menu: the empty state', async () => {
    await page.getByRole('link', { name: 'Items', exact: true }).first().click();
    await expect(page).toHaveURL(/\/items$/);
    await expect(page.getByRole('heading', { name: 'Items', level: 1 })).toBeVisible();
    await expect(page.getByTestId('items-empty')).toBeVisible();
  });

  await test.step('add an item: the dialog, the toast, the row', async () => {
    await page.getByRole('button', { name: 'New item' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(NAME);
    await dialog.getByLabel('Note').fill(NOTE);
    await dialog.getByRole('button', { name: 'New item' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(NOTE);
    await expect(page.getByText('1 item', { exact: true })).toBeVisible();
  });

  await test.step('the overview counts it and shows it among the recent ones', async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).first().click();
    await expect(page.getByText('1 item in')).toBeVisible();
    await expect(page.getByTestId('recent-items')).toContainText(NAME);
    await expect(page.getByTestId('add-item-tile')).toBeVisible();
  });

  await test.step('edit it: the same dialog, filled', async () => {
    await page.getByTestId('recent-items').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/items$/);
    await page
      .getByRole('row', { name: new RegExp(NAME) })
      .getByRole('button', { name: 'Open menu' })
      .click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Name')).toHaveValue(NAME);
    await expect(dialog.getByLabel('Note')).toHaveValue(NOTE);
    await dialog.getByLabel('Name').fill(RENAMED);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(RENAMED) })).toBeVisible();
  });

  await test.step('delete it: the confirmation, then the empty state again', async () => {
    await page
      .getByRole('row', { name: new RegExp(RENAMED) })
      .getByRole('button', { name: 'Open menu' })
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(confirm).toContainText(RENAMED);
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('items-empty')).toBeVisible();
    const { items } = await (await page.request.get('/api/v1/items')).json();
    expect(items).toEqual([]);
  });
});
