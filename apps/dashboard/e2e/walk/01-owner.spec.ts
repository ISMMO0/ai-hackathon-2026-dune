import { readFile } from 'node:fs/promises';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  ENV,
  IDENTITY,
  INSTANCE_NAME,
  OWNER,
  MIA,
  GUEST,
  ZED,
  NOAH_EMAIL,
  TEAM,
  PROJECT,
  ITEMS,
  SECOND_WORKSPACE,
  SMALL_FILE,
  BIG_FILE,
  api,
  createMember,
  failures,
  keep,
  mailTo,
  seatGuest,
  signIn,
  signOut,
  step,
  zipEntries,
  zipRead
} from './lib';

/**
 * Chapter 1, the owner: the instance claimed (or the owner signed in), the
 * account, every People page (members, teams, invitations, a member paused,
 * removed, reactivated, deleted), a project with a person and a team as
 * members and an item linked, files uploaded, refused over the cap,
 * downloaded and deleted, API keys minted and revoked, the audit log
 * filtered, the settings (look, instance, export read back, demo links: a
 * link minted, opened as the person, its session refused on the credential
 * routes, revoked), the default workspace set from the switcher. It leaves
 * MIA an active member seated on the team and on the project, GUEST a guest,
 * the key for the CLI and MCP chapters in the walk's out folder.
 */

const CH = 'owner';
const row = (scope: Page, text: string) =>
  scope.getByRole('row', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
const menuOf = (scope: Page, text: string) => row(scope, text).getByRole('button', { name: 'Open menu' });
// A scope shows as its tag, the resource then the verb ("items write"), in the
// key dialog's switches and in the table alike (`scopeTag`, lib/tags.ts).
const scopeName = (scope: string) => scope.replace(':', ' ');
const scopeShown = (scope: string) => new RegExp(scope.split(':').join('\\s*'));

let context: BrowserContext;
let page: Page;
let firstWorkspaceId = '';
let teamId = '';
let projectId = '';
let miaUserId = '';
let cliKey = '';
let demoLink = '';
let passId = '';
let instanceName = INSTANCE_NAME;

test.describe.configure({ mode: 'serial' });

test.describe('The owner walks every screen', () => {
  test.beforeAll(async ({ browser }) => {
    // Refused before the first write, not at the guest step: the chapter claims, invites
    // and mints before it seats the guest through the compose project's database.
    if (!ENV.compose)
      throw new Error(
        'WALK_COMPOSE_PROJECT is not set: the owner chapter writes nothing until it knows which stack it is on'
      );
    // The docs card writes the agent prompt to the clipboard, and says so only
    // when the write succeeded: a headless browser grants it on request.
    context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
    page = await context.newPage();
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('the instance, the account, the overview', async ({ request }) => {
    await step(CH, page, 'The instance answers, claimed or waiting for its owner', async () => {
      const inst = await api(request, 'GET', '/instance');
      expect(inst.status).toBe(200);
      expect(inst.json.demoSignIn, 'DEMO_SIGN_IN must be on for the walk').toBe(true);
      await page.goto('/');
      if (inst.json.setupRequired) {
        expect(ENV.setupToken, 'WALK_SETUP_TOKEN is needed on an unclaimed instance').not.toBe('');
        await expect(page).toHaveURL(/\/setup$/);
        await page.getByLabel('Instance name').fill(INSTANCE_NAME);
        await page.getByLabel('First name').fill(OWNER.firstName);
        await page.getByLabel('Last name').fill(OWNER.lastName);
        await page.getByLabel('Email').fill(OWNER.email);
        await page.getByLabel('Password').fill(OWNER.password);
        await page.getByLabel('Setup token').fill(ENV.setupToken);
        await page.getByRole('button', { name: 'Create instance' }).click();
        await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
        return `claimed as ${INSTANCE_NAME}`;
      }
      instanceName = inst.json.name;
      await signIn(page, OWNER);
      return `already claimed as ${instanceName}; signed in`;
    });

    await step(CH, page, 'The overview: the demo notice, the docs card and its agent prompt', async () => {
      const me = await api(page.request, 'GET', '/me');
      expect(me.status).toBe(200);
      firstWorkspaceId = me.json.workspace.id;
      expect(me.json.role).toBe('owner');
      await expect(page.getByText(/demo sign-in is on/i)).toBeVisible();
      await expect(page.getByText('Read the docs')).toBeVisible();
      await page.getByRole('button', { name: 'Copy agent prompt' }).click();
      await expect(page.getByText('The agent prompt is on your clipboard')).toBeVisible();
      const prompt = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      return prompt
        ? `prompt names ${IDENTITY.displayName}: ${prompt.includes(IDENTITY.displayName)}`
        : 'clipboard not readable here';
    });

    await step(CH, page, 'My account: the name changed and saved, then put back', async () => {
      await page.goto('/account');
      await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
      const name = page.getByLabel('Name', { exact: true });
      await name.fill('Owner One Walk');
      await page.getByRole('button', { name: 'Save changes' }).first().click();
      await expect(page.getByText('Profile updated')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Owner One Walk' })).toBeVisible();
      await name.fill(OWNER.name);
      await page.getByRole('button', { name: 'Save changes' }).first().click();
      await expect(page.getByText('Profile updated')).toBeVisible();
      await expect(page.getByText('Two-factor authentication is off.')).toBeVisible();
    });
  });

  test('people: members, invitations sent, accepted, revoked, teams', async ({ browser }) => {
    await step(CH, page, 'Members: the roster with the owner alone', async () => {
      await page.getByRole('link', { name: 'People', exact: true }).first().click();
      await expect(page).toHaveURL(/\/members$/);
      await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
      await expect(page.getByRole('cell', { name: OWNER.email })).toBeVisible();
      await expect(page.getByText('1 member', { exact: true })).toBeVisible();
    });

    let inviteUrl = '';
    await step(CH, page, 'Invitations: Mia invited, the link shown once', async () => {
      await page
        .locator('nav[data-section-bar]')
        .getByRole('link', { name: 'Invitations', exact: true })
        .click();
      await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible();
      await page.getByRole('button', { name: 'Invite member' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Invite a member' });
      await dialog.getByLabel('Email').fill(MIA.email);
      await dialog.getByRole('button', { name: 'Create invitation' }).click();
      const linkDialog = page.getByRole('dialog').filter({ hasText: 'Invitation created' });
      inviteUrl = await linkDialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
      expect(inviteUrl).toContain('/invite/');
      await linkDialog.getByRole('button', { name: 'Done' }).click();
      await expect(row(page, MIA.email)).toBeVisible();
    });

    await step(
      CH,
      page,
      'The invitation mail reached Mailpit, its own link to the same invitation',
      async () => {
        const mail = await mailTo(page.request, MIA.email);
        expect(mail, 'a mail to Mia in Mailpit').not.toBeNull();
        const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail!.text)?.[0];
        expect(link, 'the invite link in the mail').toBeTruthy();
        // One invitation, two tokens (ADR 009, invitations/service.ts): the
        // dialog's link is the inviter's, the mail carries its own, the one that
        // proves the mailbox. Both resolve to the same invitation.
        const mailToken = new URL(link!).pathname.split('/invite/')[1];
        const dialogToken = new URL(inviteUrl).pathname.split('/invite/')[1];
        expect(mailToken).not.toBe(dialogToken);
        const viaMail = await api(page.request, 'GET', `/invitations/lookup?token=${mailToken}`);
        expect(viaMail.status, viaMail.text).toBe(200);
        expect(viaMail.json.email).toBe(MIA.email);
        await page.goto(`${ENV.mailpit}/`);
        await expect(page.getByText(MIA.email).first()).toBeVisible({ timeout: 15_000 });
        return `subject: ${mail!.subject}`;
      }
    );

    await step(CH, null, 'Mia accepts in a clean browser and lands on the overview', async () => {
      const clean = await browser.newContext();
      const p = await clean.newPage();
      await p.goto(inviteUrl);
      await expect(p.getByText(`Join ${instanceName}`)).toBeVisible();
      await p.getByLabel('First name').fill(MIA.firstName);
      await p.getByLabel('Last name').fill(MIA.lastName);
      await p.getByLabel('Choose a password').fill(MIA.password);
      await p.getByRole('button', { name: 'Create account and join' }).click();
      await expect(p.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
      await p.screenshot({ path: `${ENV.out}/mia-accepted.png` });
      await clean.close();
      const roster = await api(page.request, 'GET', '/members?limit=100');
      miaUserId = roster.json.members.find((m: { email: string }) => m.email === MIA.email).userId;
      expect(miaUserId).toBeTruthy();
    });

    await step(CH, page, 'A second invitation for Noah, revoked from its row', async () => {
      await page.goto('/invitations');
      await page.getByRole('button', { name: 'Invite member' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Invite a member' });
      await dialog.getByLabel('Email').fill(NOAH_EMAIL);
      await dialog.getByRole('button', { name: 'Create invitation' }).click();
      await page
        .getByRole('dialog')
        .filter({ hasText: 'Invitation created' })
        .getByRole('button', { name: 'Done' })
        .click();
      await menuOf(page, NOAH_EMAIL).click();
      await page.getByRole('menuitem', { name: 'Revoke' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: /revoke/i });
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
      }
      await expect(page.getByText(`Invitation for ${NOAH_EMAIL} revoked`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, NOAH_EMAIL)).toContainText('revoked');
      await expect(row(page, MIA.email)).toContainText('accepted');
    });

    await step(CH, page, 'Teams: a team made from the dialog', async () => {
      await page.goto('/teams');
      await expect(page.getByText('No team yet. Make one with New team.')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'New team', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Name the team' });
      await dialog.getByLabel('Name', { exact: true }).fill(TEAM.name);
      await dialog.getByRole('button', { name: 'Create team', exact: true }).click();
      await expect(page.getByText(`${TEAM.name} created`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, TEAM.name)).toContainText(TEAM.slug);
      const href = await row(page, TEAM.name)
        .getByRole('link', { name: new RegExp(TEAM.name) })
        .getAttribute('href');
      teamId = href?.split('/teams/')[1] ?? '';
      expect(teamId).toMatch(/^[0-9a-f-]{36}$/);
    });

    await step(CH, page, "Teams: renamed from the row's menu", async () => {
      await menuOf(page, TEAM.name).click();
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Rename the team' });
      await dialog.getByLabel('Name', { exact: true }).fill(TEAM.renamed);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(`${TEAM.renamed} renamed`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, TEAM.renamed)).toContainText(TEAM.slug);
    });

    await step(CH, page, "The team's page: Mia seated from the add dialog", async () => {
      await row(page, TEAM.renamed)
        .getByRole('link', { name: new RegExp(TEAM.renamed) })
        .click();
      await expect(page).toHaveURL(new RegExp(`/teams/${teamId}$`));
      await expect(page.getByText('Nobody is in this team yet.')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = page
        .getByRole('dialog')
        .filter({ hasText: `Pick a member of this workspace to add to ${TEAM.renamed}.` });
      await dialog.getByRole('button', { name: new RegExp(MIA.email.replace(/\./g, '\\.')) }).click();
      await dialog.getByRole('button', { name: 'Add to team', exact: true }).click();
      await expect(page.getByText(`${MIA.email} added to ${TEAM.renamed}`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, MIA.email)).toContainText('Active');
      await expect(page.getByText('1 person', { exact: true })).toBeVisible();
    });
  });

  test('a project with a person and a team as members, an item linked', async () => {
    await step(CH, page, 'Projects: a project made from the dialog', async () => {
      await page.goto('/projects');
      await page.getByRole('button', { name: 'New project', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'New project' });
      await dialog.getByLabel('Name', { exact: true }).fill(PROJECT.name);
      await dialog.getByLabel('Description', { exact: true }).fill(PROJECT.description);
      await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      projectId = page.url().split('/projects/')[1];
      await expect(page.getByRole('heading', { name: PROJECT.name, level: 1 })).toBeVisible();
      await expect(row(page, OWNER.email)).toBeVisible({ timeout: 15_000 });
    });

    await step(CH, page, 'Add member: Mia as a viewer', async () => {
      await page.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Add a member' });
      await dialog.getByRole('button', { name: new RegExp(MIA.email.replace(/\./g, '\\.')) }).click();
      await dialog.getByRole('button', { name: 'Role', exact: true }).click();
      await page.getByRole('option', { name: /^Viewer/ }).click();
      await dialog.getByRole('button', { name: 'Add to project', exact: true }).click();
      await expect(row(page, MIA.email)).toContainText('Viewer', { timeout: 15_000 });
    });

    await step(CH, page, 'Add member: the team as an editor, its chip and its size', async () => {
      await page.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Add a member' });
      await dialog.getByRole('button', { name: new RegExp(`${TEAM.renamed}.*${TEAM.slug}`) }).click();
      await dialog.getByRole('button', { name: 'Role', exact: true }).click();
      await page.getByRole('option', { name: /^Editor/ }).click();
      await dialog.getByRole('button', { name: 'Add to project', exact: true }).click();
      await expect(page.getByText(`${TEAM.renamed} is in the project`)).toBeVisible({ timeout: 15_000 });
      const teamRow = row(page, TEAM.renamed);
      await expect(teamRow.getByText('Team', { exact: true })).toBeVisible();
      await expect(teamRow).toContainText('1 person');
      await expect(teamRow).toContainText('Editor');
    });

    await step(CH, page, 'Add an item from the project page: it lands in the project', async () => {
      await page.getByRole('button', { name: 'Add an item', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'New item' });
      await dialog.getByLabel('Name', { exact: true }).fill(ITEMS.one);
      await dialog.getByLabel('Note', { exact: true }).fill('Added from the project page.');
      await dialog.getByRole('button', { name: 'New item', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(
        page.getByTestId('project-items').getByRole('row', { name: new RegExp(ITEMS.one) })
      ).toBeVisible({
        timeout: 15_000
      });
    });

    await step(CH, page, 'Items: a second item made, edited, the project tag and the filter', async () => {
      await page.goto('/items');
      await expect(page.getByRole('heading', { name: 'Items', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'New item' }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(ITEMS.two);
      await dialog.getByLabel('Note').fill('A note.');
      await dialog.getByRole('button', { name: 'New item' }).click();
      await expect(dialog).toBeHidden();
      await expect(row(page, ITEMS.two)).toBeVisible();
      await expect(row(page, ITEMS.one).getByTestId('item-projects')).toContainText(PROJECT.name);
      await expect(row(page, ITEMS.two).getByTestId('item-projects')).toHaveCount(0);
      await menuOf(page, ITEMS.two).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      dialog = page.getByRole('dialog');
      // The dialog puts the focus on Name once it has opened: a fill that
      // starts before lands its text in Name. Wait for the focus first.
      await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
      await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(ITEMS.two);
      await dialog.getByLabel('Note').fill(ITEMS.twoNote);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(row(page, ITEMS.two)).toContainText(ITEMS.twoNote);
      await page.getByRole('button', { name: 'Which project to show' }).click();
      await page.getByRole('option', { name: PROJECT.name, exact: true }).click();
      await expect(row(page, ITEMS.two)).toHaveCount(0, { timeout: 15_000 });
      await expect(row(page, ITEMS.one)).toBeVisible();
      await expect(page.getByText('1 item', { exact: true })).toBeVisible();
    });
  });

  test('files: uploaded, refused over the cap, downloaded, deleted', async () => {
    await step(CH, page, 'Files: a small file uploaded', async () => {
      await page.goto('/files');
      await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles(SMALL_FILE);
      await expect(page.getByText(`${SMALL_FILE.name} uploaded`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, SMALL_FILE.name)).toBeVisible();
    });

    await step(CH, page, 'Files: one over the cap meets the 413 sentence', async () => {
      await page.locator('input[type="file"]').setInputFiles(BIG_FILE);
      const toast = page.getByText(/^Too large: /);
      await expect(toast).toBeVisible({ timeout: 15_000 });
      const text = (await toast.textContent()) ?? '';
      expect(text).toMatch(/Too large: file exceeds MAX_FILE_SIZE_MB \(\d+MB\)/);
      await expect(row(page, BIG_FILE.name)).toHaveCount(0);
      return text;
    });

    await step(CH, page, 'Files: downloaded under its own name, the bytes read back', async () => {
      await menuOf(page, SMALL_FILE.name).click();
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20_000 }),
        page.getByRole('menuitem', { name: 'Download' }).click()
      ]);
      expect(download.suggestedFilename()).toBe(SMALL_FILE.name);
      const bytes = await readFile((await download.path())!);
      expect(bytes.equals(SMALL_FILE.buffer)).toBe(true);
    });

    await step(CH, page, 'Files: deleted through its confirmation', async () => {
      await menuOf(page, SMALL_FILE.name).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Delete file?' });
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByText(`${SMALL_FILE.name} deleted`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, SMALL_FILE.name)).toHaveCount(0);
    });
  });

  test('API keys: minted with the write scope, one revoked; the audit log filtered', async () => {
    await step(CH, page, 'API keys: a key for the CLI, the secret shown once', async () => {
      await page.goto('/api-keys');
      await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
      await page.getByRole('button', { name: 'Create key' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Create API key' });
      await dialog.getByLabel('Name').fill('walk-cli');
      await dialog.getByRole('checkbox', { name: scopeName(IDENTITY.writeScope), exact: true }).check();
      await dialog.getByRole('button', { name: 'Create key' }).click();
      const secretDialog = page.getByRole('dialog').filter({ hasText: 'Copy your API key' });
      cliKey = await secretDialog.getByLabel('API key secret').inputValue();
      expect(cliKey.startsWith(`${IDENTITY.apiKeyPrefix}_`)).toBe(true);
      await secretDialog.getByRole('button', { name: 'I saved it' }).click();
      await expect(row(page, 'walk-cli')).toContainText(scopeShown(IDENTITY.writeScope));
      keep('cli', { key: cliKey, workspaceId: firstWorkspaceId, projectId, teamId, miaUserId });
    });

    await step(CH, page, 'API keys: a second key revoked, and it stops answering', async () => {
      await page.getByRole('button', { name: 'Create key' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Create API key' });
      await dialog.getByLabel('Name').fill('walk-doomed');
      await dialog.getByRole('button', { name: 'Create key' }).click();
      const secretDialog = page.getByRole('dialog').filter({ hasText: 'Copy your API key' });
      const doomed = await secretDialog.getByLabel('API key secret').inputValue();
      await secretDialog.getByRole('button', { name: 'I saved it' }).click();
      const before = await api(page.request, 'GET', '/me', undefined, {
        authorization: `Bearer ${doomed}`,
        cookie: ''
      });
      await menuOf(page, 'walk-doomed').click();
      await page.getByRole('menuitem', { name: 'Revoke' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Revoke API key?' });
      await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(page.getByText('Key "walk-doomed" revoked')).toBeVisible({ timeout: 15_000 });
      const after = await api(page.request, 'GET', '/me', undefined, {
        authorization: `Bearer ${doomed}`,
        cookie: ''
      });
      expect(after.status).toBe(401);
      return `bearer before ${before.status}, after ${after.status}`;
    });

    await step(CH, page, 'The audit log filtered on one action', async () => {
      await page.goto('/audit');
      await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
      await expect(page.getByText('apikey.create').first()).toBeVisible({ timeout: 15_000 });
      // On a desktop width the filters are a popover (the sheet is the phone's):
      // the actions sit folded under their family, and Escape closes it.
      await page.getByRole('button', { name: /^Filters/ }).click();
      const panel = page.locator('.filter-float').filter({ hasText: 'Filter the log' });
      await panel.getByRole('button', { name: 'item', exact: true }).click();
      await panel.getByRole('checkbox', { name: 'item.create', exact: true }).check();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(page.getByText('item.create').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('apikey.create')).toHaveCount(0);
      await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('item.create');
      await expect(page.getByText('2 entries', { exact: true })).toBeVisible();
    });
  });

  test('settings: the look, the instance, the export read back', async () => {
    await step(CH, page, 'Settings: another colour picked and saved', async () => {
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      const colours = page.getByRole('radiogroup', { name: 'Colour' });
      const before = await colours.getByRole('radio', { checked: true }).getAttribute('aria-label');
      await colours.getByRole('radio').nth(2).click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Workspace updated')).toBeVisible({ timeout: 15_000 });
      const after = await colours.getByRole('radio', { checked: true }).getAttribute('aria-label');
      expect(after).not.toBe(before);
      return `${before} to ${after}`;
    });

    await step(CH, page, 'Settings: the instance tab', async () => {
      await page.goto('/settings/instance');
      await expect(page.getByText('What this deployment is running.').first()).toBeVisible();
      await expect(page.getByText('Instance ID')).toBeVisible();
    });

    await step(
      CH,
      page,
      'Settings: the export downloaded and read back, the teams entries inside',
      async () => {
        await page.goto('/settings');
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          page.getByRole('button', { name: 'Download export (.zip)' }).click()
        ]);
        expect(download.suggestedFilename()).toMatch(/^export-.+\.zip$/);
        const path = `${ENV.out}/${download.suggestedFilename()}`;
        await download.saveAs(path);
        const entries = zipEntries(path);
        for (const e of [
          'manifest.json',
          'workspace.json',
          'members.json',
          'invitations.json',
          'api-keys.json',
          'audit-log.ndjson',
          'projects.json',
          'project_members.json',
          'teams.json',
          'team_members.json',
          'project_teams.json',
          'files.json',
          'items.json',
          'item_projects.json'
        ])
          expect(entries, `entry ${e}`).toContain(e);
        const items = JSON.parse(zipRead(path, 'items.json'));
        expect(items.map((i: { name: string }) => i.name).sort()).toEqual([ITEMS.one, ITEMS.two]);
        const teams = JSON.parse(zipRead(path, 'teams.json'));
        expect(teams.map((t: { name: string }) => t.name)).toEqual([TEAM.renamed]);
        const links = JSON.parse(zipRead(path, 'item_projects.json'));
        expect(links).toHaveLength(1);
        return `${entries.length} entries`;
      }
    );
  });

  test('demo links: minted for Mia, opened as her, refused where a credential is minted, revoked', async ({
    browser
  }) => {
    await step(CH, page, 'Demo links: a link for Mia on /items, shown once', async () => {
      await page.goto('/settings/demo');
      await expect(page.getByText('No demo link yet.')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'New demo link' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'The link is shown once' });
      await dialog.getByRole('button', { name: 'Member', exact: true }).click();
      await page.getByRole('option', { name: new RegExp(MIA.email.replace(/\./g, '\\.')) }).click();
      await dialog.getByLabel('Page').fill('/items');
      await dialog.getByRole('button', { name: 'New demo link' }).click();
      const secretDialog = page.getByRole('dialog').filter({ hasText: 'Copy your demo link' });
      await expect(secretDialog.getByText(`It signs ${MIA.email} in and opens /items.`)).toBeVisible();
      demoLink = await secretDialog.getByRole('textbox', { name: 'Demo link' }).inputValue();
      expect(demoLink).toContain('/demo#pass=');
      await secretDialog.getByRole('button', { name: 'I copied it' }).click();
      await expect(row(page, MIA.email)).toContainText('Live');
      const list = await api(page.request, 'GET', '/demo/passes');
      passId = list.json.passes[0].id;
    });

    let pass: BrowserContext | null = null;
    await step(CH, null, 'The link opens Mia on the items page in a clean browser', async () => {
      pass = await browser.newContext();
      const p = await pass.newPage();
      await p.goto(demoLink);
      await expect(p).toHaveURL(/\/items$/, { timeout: 20_000 });
      await expect(p.getByRole('heading', { name: 'Items', level: 1 })).toBeVisible();
      await expect(p.getByRole('button', { name: MIA.name })).toBeVisible();
      await expect(p.getByText(/demo sign-in is on/i)).toBeVisible();
      await p.screenshot({ path: `${ENV.out}/mia-through-the-demo-link.png` });
      const me = await api(p.request, 'GET', '/me');
      expect(me.json.user.email).toBe(MIA.email);
    });

    await step(CH, null, "The pass's session is refused where a credential would be minted", async () => {
      const r = pass!.request;
      const key = await api(r, 'POST', '/api-keys', { name: 'from-a-pass', scopes: [IDENTITY.readScope] });
      const ws = await api(r, 'POST', '/workspaces', { name: 'from-a-pass' });
      const dflt = await api(r, 'PUT', '/me/default-workspace', { workspaceId: firstWorkspaceId });
      const inv = await api(r, 'POST', '/invitations', { email: 'x@example.com', role: 'member' });
      expect(key.status).toBe(403);
      expect(key.json.error.code).toBe('demo_session');
      expect(ws.status).toBe(403);
      expect(dflt.status).toBe(403);
      expect(dflt.json.error.code).toBe('demo_session');
      expect(inv.status).toBe(403);
      return `api-keys ${key.status} ${key.json.error.code}; workspaces ${ws.status} ${ws.json.error.code}; default ${dflt.status}; invitations ${inv.status} ${inv.json.error.code}`;
    });

    await step(CH, page, 'The link revoked: its session ends on the next request', async () => {
      await page.goto('/settings/demo');
      await menuOf(page, MIA.email).click();
      await page.getByRole('menuitem', { name: 'Revoke' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Revoke this demo link?' });
      await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(page.getByText(`Demo link for ${MIA.email} revoked`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, MIA.email)).toContainText('Revoked');
      const me = await api(pass!.request, 'GET', '/me');
      expect(me.status).toBe(401);
      const p = pass!.pages()[0];
      await p.reload();
      await expect(p).toHaveURL(/\/login/, { timeout: 20_000 });
      await pass!.close();
      return `pass ${passId} revoked; /me as the pass answers ${me.status}`;
    });
  });

  test('the default workspace set from the switcher', async () => {
    await step(CH, page, 'A second workspace made from the switcher', async () => {
      await page.goto('/');
      await page.getByTestId('workspace-switcher').click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'New workspace' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Workspace name').fill(SECOND_WORKSPACE);
      await dialog.getByTestId('workspace-step-next').click();
      await dialog.getByTestId('workspace-step-next').click();
      await dialog.getByRole('button', { name: 'Create workspace' }).click();
      await expect(page.getByRole('dialog', { name: `${SECOND_WORKSPACE} is ready` })).toBeVisible();
      await dialog.getByTestId('workspace-open').click();
      await expect(page.getByTestId('workspace-switcher')).toContainText(SECOND_WORKSPACE, {
        timeout: 20_000
      });
    });

    await step(CH, page, 'Make default on the second workspace: the badge moves', async () => {
      await page.getByTestId('workspace-switcher').click();
      const entry = page
        .getByRole('menu')
        .getByTestId('workspace-entry')
        .filter({ hasText: SECOND_WORKSPACE });
      await entry.hover();
      await page.getByTestId('workspace-make-default').click();
      await page.keyboard.press('Escape');
      await page.getByTestId('workspace-switcher').click();
      await expect(
        page
          .getByRole('menu')
          .getByTestId('workspace-entry')
          .filter({ hasText: SECOND_WORKSPACE })
          .getByText('Default', { exact: true })
      ).toBeVisible({ timeout: 10_000 });
      const me = await api(page.request, 'GET', '/me');
      expect(me.json.workspaces.find((w: { name: string }) => w.name === SECOND_WORKSPACE).default).toBe(
        true
      );
    });

    await step(CH, page, 'The first workspace made the default again, and opened again', async () => {
      await page.keyboard.press('Escape');
      const back = await api(page.request, 'PUT', '/me/default-workspace', { workspaceId: firstWorkspaceId });
      expect(back.status).toBe(200);
      await page.getByTestId('workspace-switcher').click();
      await page
        .getByRole('menu')
        .getByTestId('workspace-entry')
        .filter({ hasText: instanceName })
        .first()
        .click();
      await expect(page.getByTestId('workspace-switcher')).toContainText(instanceName, { timeout: 20_000 });
    });
  });

  test('a member paused, reactivated, removed, reactivated again; a guest seated; a member deleted', async ({
    browser
  }) => {
    await step(CH, page, 'Members: Mia deactivated', async () => {
      await page.goto('/members');
      await expect(row(page, MIA.email)).toContainText('Active', { timeout: 20_000 });
      await menuOf(page, MIA.email).click();
      await page.getByRole('menuitem', { name: 'Deactivate' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Deactivate member?' });
      await confirm.getByRole('button', { name: 'Deactivate', exact: true }).click();
      await expect(page.getByText(`${MIA.email} deactivated`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, MIA.email)).toContainText('Inactive');
    });

    await step(CH, page, 'Members: Mia reactivated, her seat and her grant untouched', async () => {
      await menuOf(page, MIA.email).click();
      await page.getByRole('menuitem', { name: 'Reactivate' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Reactivate member?' });
      await confirm.getByRole('button', { name: 'Reactivate', exact: true }).click();
      await expect(page.getByText(`${MIA.email} reactivated`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, MIA.email)).toContainText('Active');
      const seats = await api(page.request, 'GET', `/teams/${teamId}/members`);
      expect(seats.json.members.map((m: { email: string }) => m.email)).toContain(MIA.email);
      const grants = await api(page.request, 'GET', `/projects/${projectId}/members?limit=100`);
      expect(grants.json.members.some((m: { userId?: string }) => m.userId === miaUserId)).toBe(true);
    });

    await step(
      CH,
      page,
      'Members: Mia removed from the workspace, her grant and her seat end with it',
      async () => {
        await menuOf(page, MIA.email).click();
        await page.getByRole('menuitem', { name: 'Remove from workspace' }).click();
        const confirm = page.getByRole('dialog', { name: 'Remove from the workspace?' });
        await confirm.getByRole('button', { name: 'Remove from workspace' }).click();
        await expect(page.getByText(`${MIA.email} was removed from the workspace`)).toBeVisible({
          timeout: 15_000
        });
        await expect(row(page, MIA.email)).toContainText('Inactive');
        const seats = await api(page.request, 'GET', `/teams/${teamId}/members`);
        expect(seats.json.members.map((m: { email: string }) => m.email)).not.toContain(MIA.email);
        const grants = await api(page.request, 'GET', `/projects/${projectId}/members?limit=100`);
        expect(grants.json.members.some((m: { userId?: string }) => m.userId === miaUserId)).toBe(false);
      }
    );

    await step(
      CH,
      page,
      'Members: Mia reactivated after the removal, back as a plain member with nothing',
      async () => {
        await menuOf(page, MIA.email).click();
        await page.getByRole('menuitem', { name: 'Reactivate' }).click();
        const confirm = page.getByRole('dialog').filter({ hasText: 'Reactivate member?' });
        await confirm.getByRole('button', { name: 'Reactivate', exact: true }).click();
        await expect(page.getByText(`${MIA.email} reactivated`)).toBeVisible({ timeout: 15_000 });
        await expect(row(page, MIA.email)).toContainText('Active');
        await expect(row(page, MIA.email)).toContainText('Member');
        // What the next chapters need, given back by the workspace's own act after the removal.
        const seat = await api(page.request, 'POST', `/teams/${teamId}/members`, { email: MIA.email });
        expect(seat.status, seat.text).toBe(201);
        const grant = await api(page.request, 'POST', `/projects/${projectId}/members`, {
          userId: miaUserId,
          role: 'viewer'
        });
        expect(grant.status, grant.text).toBe(201);
        return 'seat and grant given again through the API for the next chapters';
      }
    );

    await step(CH, null, 'A guest seated: a member first, then a guest row on the database', async () => {
      const clean = await browser.newContext();
      await createMember(page.request, clean.request, GUEST);
      await clean.close();
      // The roster carries no origin (memberSchema); the row's own answer
      // (`returning origin`) is the proof, and the guest's /me reads it back
      // in the next chapter.
      const out = seatGuest(GUEST.email);
      expect(out).toContain('UPDATE 1');
      expect(out).toMatch(/^\s*guest\s*$/m);
      const roster = await api(page.request, 'GET', '/members?limit=100');
      const gus = roster.json.members.find((m: { email: string }) => m.email === GUEST.email);
      expect(gus?.isActive).toBe(true);
      return out.replace(/\s+/g, ' ');
    });

    await step(CH, page, 'Members: a throwaway member deleted, the third act', async () => {
      const clean = await browser.newContext();
      await createMember(page.request, clean.request, ZED);
      await clean.close();
      await page.goto('/members');
      await expect(row(page, ZED.email)).toBeVisible({ timeout: 20_000 });
      await menuOf(page, ZED.email).click();
      await page.getByRole('menuitem', { name: 'Delete member' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Delete member?' });
      await confirm.getByRole('button', { name: 'Delete member', exact: true }).click();
      await expect(page.getByText(`${ZED.email} was deleted`)).toBeVisible({ timeout: 15_000 });
      await expect(row(page, ZED.email)).toHaveCount(0);
    });

    await step(CH, page, 'The owner signs out', async () => {
      await signOut(page, OWNER);
    });
  });

  test('the owner chapter recorded no failed step', () => {
    expect(failures).toEqual([]);
  });
});
