import { test, expect } from '@playwright/test';
import { signInAsOwner } from './accounts';

/**
 * The starter's Try it page, in a real browser against the real stack with
 * NEITHER integration configured (e2e/stack-env.mjs empties both keys, so no
 * test ever reaches Gradium or H): the strip names the key to set for each,
 * and each button answers the server's 503 sentence, which names the key and
 * the .env file. Nothing is written: every POST is refused.
 */

test('Try it without the keys: the chips name the keys, the buttons answer the 503 sentence', async ({
  page
}) => {
  await test.step('sign in as the owner and open Try it from the menu', async () => {
    await signInAsOwner(page);
    await page.getByRole('link', { name: 'Try it', exact: true }).first().click();
    await expect(page).toHaveURL(/\/try$/);
    await expect(page.getByRole('heading', { name: 'Try it', level: 1 })).toBeVisible();
  });

  await test.step('the integrations strip: both not configured, each naming its key', async () => {
    await expect(page.getByTestId('integration-gradium')).toContainText(
      'not configured: set GRADIUM_API_KEY in .env'
    );
    await expect(page.getByTestId('integration-h')).toContainText('not configured: set HAI_API_KEY in .env');
  });

  await test.step('Speak answers the Gradium sentence', async () => {
    await page.getByLabel('Text to speak').fill('Bonjour');
    await page.getByRole('button', { name: 'Speak', exact: true }).click();
    await expect(page.getByTestId('voice-card')).toContainText(
      'Gradium is not configured: set GRADIUM_API_KEY in the .env file and restart the server'
    );
  });

  await test.step('Run in a browser answers the H sentence, and no run is listed', async () => {
    await page.getByLabel('Instruction').fill('What is the heading of example.com?');
    await page.getByRole('button', { name: 'Run in a browser' }).click();
    await expect(page.getByTestId('runs-card')).toContainText(
      'H is not configured: set HAI_API_KEY in the .env file and restart the server'
    );
    await expect(page.getByTestId('runs-empty')).toBeVisible();
    const { runs } = await (await page.request.get('/api/v1/runs')).json();
    expect(runs).toEqual([]);
  });
});
