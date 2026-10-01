import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { OWNER, signInAsOwner } from './accounts';

/**
 * PRDCT-2864 — the Teams pages of the shell, end to end against the real
 * stack, self-hosted, as the owner (`dependencies: ['smoke']`, so the
 * instance and the owner exist).
 *
 *  - The Teams tab of the People section: reached from the section's tab bar,
 *    the empty state, a team made from the New team dialog (the slug left
 *    empty, made from the name), the toast, the row with its count.
 *  - Rename and Delete are the ROW MENU's of the list (`/teams`): the team's
 *    own page carries no rename and no delete. The team's page (`/teams/<id>`)
 *    is walked for what it has: the heading that follows the rename, the Teams
 *    tab lit and the path `People / Teams / <team>`, a person seated from the
 *    add dialog, the members table, the person removed again.
 *  - A team as a project member (PRDCT-2794): a project made from `/projects`,
 *    the team picked from the Teams group of the Add-member dialog with a
 *    role, the team row with its chip and its size, its role changed from the
 *    row menu, the team removed from the project through its confirm dialog.
 *  - The team deleted: the list is back to its empty state, and the team's
 *    own address is the calm not-found page.
 *
 * WHAT THIS FILE READS OF AN EARLIER PROJECT: the person it seats is
 * `proj-viewer@example.com` (Vera), whom `projects` (projects.spec.ts) made
 * and left an ACTIVE workspace member (she left that file's project, not the
 * workspace), so the file spends none of the instance's ten invitation calls
 * an hour. When she is not on the roster (this project run on its own, with
 * `smoke` alone), the file invites her itself: ONE invitation call at most.
 * It also reads that `proj-editor@example.com` (Edie), when present, is an
 * INACTIVE member (removed at the end of projects.spec.ts) and asserts the
 * add dialog does not offer her.
 *
 * WHAT IT LEAVES BEHIND: one project (`E2E Shared with a team`) holding the
 * owner alone, and no team. Declared LAST in playwright.config.ts.
 *
 * BUDGET: one sign-in (the owner's), reused by every test through one context.
 */

const TEAM_NAME = 'E2E Design crew';
const TEAM_SLUG = 'e2e-design-crew'; // made from the name: the slug field is left empty
const TEAM_RENAMED = 'E2E Design studio';
const PROJECT_NAME = 'E2E Shared with a team';

const SEATED = { name: 'Vera Proj', email: 'proj-viewer@example.com', password: 'proj-viewer-password-123' };
const REMOVED_EDITOR_EMAIL = 'proj-editor@example.com';

const DESK = { width: 1280, height: 860 };

/** A DataTable row named by its text (the `Open menu` button of DataTableActions sits in it). */
function row(scope: Page, text: string) {
  return scope.getByRole('row', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
}

/** The People section's tab bar (SectionTabs): a nav named for the section. */
function tabBar(page: Page) {
  return page.locator('nav[data-section-bar]');
}

/**
 * The team page's heading. The band's words are keyed on the title
 * (HeroBand `wordsKey`): when the team arrives the title turns from "Teams"
 * to the team's name and the band crossfades, so for a beat two <h1> carry
 * the name. Wait for the crossfade to settle on one.
 */
async function teamHeading(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: TEAM_RENAMED, level: 1 });
  await expect(heading).toHaveCount(1, { timeout: 20_000 });
  await expect(heading).toBeVisible();
}

let context: BrowserContext;
let owner: Page;
let teamId = '';
let projectId = '';

test.describe.configure({ mode: 'serial' });

test.describe('Teams — the People tab, a team page, a team on a project', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: DESK });
    owner = await context.newPage();
    await signInAsOwner(owner);

    // The person to seat: Vera from projects.spec.ts, or made here when that
    // project did not run (one invitation, asserted like projects.spec.ts's).
    const roster = await owner.request.get('/api/v1/members?limit=100');
    expect(roster.status(), 'roster').toBe(200);
    const { members } = await roster.json();
    const vera = members.find((m: { email: string }) => m.email.toLowerCase() === SEATED.email);
    if (!vera) {
      const invite = await owner.request.post('/api/v1/invitations', {
        data: { email: SEATED.email, role: 'member' }
      });
      expect(invite.status(), `invite ${SEATED.email}`).toBe(201);
      const { acceptUrl } = await invite.json();
      const token = new URL(acceptUrl).pathname.split('/invite/')[1];
      expect(token, 'invite token').toBeTruthy();
      const clean = await browser.newContext();
      const accepted = await clean.request.post('/api/v1/invitations/accept', {
        data: { token, name: SEATED.name, password: SEATED.password }
      });
      expect(accepted.status(), `accept ${SEATED.email}`).toBe(200);
      await clean.close();
    } else {
      expect(vera.isActive, `${SEATED.email} is an active member`).toBe(true);
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('the Teams tab: reached from the People bar, empty, then a team made from the dialog', async () => {
    await test.step('People opens Members; its bar carries Members, Teams and Invitations', async () => {
      await owner.goto('/');
      await expect(owner.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
      await owner.getByRole('link', { name: 'People', exact: true }).first().click();
      await expect(owner).toHaveURL(/\/members$/, { timeout: 20_000 });
      const bar = tabBar(owner);
      await expect(bar).toBeVisible();
      await expect(bar.getByRole('link')).toHaveText(['Members', 'Teams', 'Invitations']);
      await expect(bar.getByRole('link', { name: 'Members', exact: true })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });

    await test.step('the Teams tab: the lit tab, the empty state, the New team action', async () => {
      await tabBar(owner).getByRole('link', { name: 'Teams', exact: true }).click();
      await expect(owner).toHaveURL(/\/teams$/, { timeout: 20_000 });
      await expect(tabBar(owner).getByRole('link', { name: 'Teams', exact: true })).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(tabBar(owner).getByRole('link', { name: 'Members', exact: true })).not.toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(owner.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
      await expect(owner.getByText('No team yet. Make one with New team.')).toBeVisible({ timeout: 20_000 });
      await expect(owner.getByRole('button', { name: 'New team', exact: true })).toBeVisible();
    });

    await test.step('New team: a name, the slug left empty, the toast, the row with its slug and count', async () => {
      await owner.getByRole('button', { name: 'New team', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Name the team' });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText('Lowercase letters, digits and dashes. Leave it empty to make it from the name.')
      ).toBeVisible();
      await dialog.getByLabel('Name', { exact: true }).fill(TEAM_NAME);
      await expect(dialog.getByLabel('Slug', { exact: true })).toHaveValue('');
      await dialog.getByRole('button', { name: 'Create team', exact: true }).click();

      await expect(owner.getByText(`${TEAM_NAME} created`)).toBeVisible({ timeout: 15_000 });
      await expect(dialog).toBeHidden();
      const teamRow = row(owner, TEAM_NAME);
      await expect(teamRow).toBeVisible({ timeout: 15_000 });
      await expect(teamRow).toContainText(TEAM_SLUG);
      // Members column: nobody in it yet
      await expect(teamRow.getByRole('cell').nth(1)).toHaveText('0');
      await expect(owner.getByText('1 team', { exact: true })).toBeVisible();
      await expect(owner.getByText('No team yet. Make one with New team.')).toHaveCount(0);

      const href = await teamRow.getByRole('link', { name: new RegExp(TEAM_NAME) }).getAttribute('href');
      teamId = href?.split('/teams/')[1] ?? '';
      expect(teamId, 'the team id from its link').toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  test("the team: renamed from the list's menu, its page, a person seated and shown", async () => {
    await owner.goto('/teams');
    await expect(row(owner, TEAM_NAME)).toBeVisible({ timeout: 20_000 });

    await test.step('Rename (the row menu): the dialog, the toast, the row follows', async () => {
      await row(owner, TEAM_NAME).getByRole('button', { name: 'Open menu' }).click();
      await expect(owner.getByRole('menuitem', { name: 'Delete team', exact: true })).toBeVisible();
      await owner.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Rename the team' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`A new name or slug for ${TEAM_NAME}.`);
      await expect(dialog.getByLabel('Slug', { exact: true })).toHaveValue(TEAM_SLUG);
      await dialog.getByLabel('Name', { exact: true }).fill(TEAM_RENAMED);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(owner.getByText(`${TEAM_RENAMED} renamed`)).toBeVisible({ timeout: 15_000 });
      await expect(row(owner, TEAM_RENAMED)).toBeVisible({ timeout: 15_000 });
      // the name changed, the slug did not
      await expect(row(owner, TEAM_RENAMED)).toContainText(TEAM_SLUG);
      await expect(row(owner, TEAM_NAME)).toHaveCount(0);
    });

    await test.step("the team's page: the renamed heading, the Teams tab lit, the path under it", async () => {
      await row(owner, TEAM_RENAMED)
        .getByRole('link', { name: new RegExp(TEAM_RENAMED) })
        .click();
      await expect(owner).toHaveURL(new RegExp(`/teams/${teamId}$`), { timeout: 20_000 });
      await teamHeading(owner);
      await expect(owner.getByText(TEAM_SLUG, { exact: true })).toBeVisible();
      await expect(tabBar(owner).getByRole('link', { name: 'Teams', exact: true })).toHaveAttribute(
        'aria-current',
        'page'
      );
      // The top bar's path, People / Teams / <the team> (it shows once the band
      // scrolls away; its words are in the page from the start).
      const path = owner.locator('[data-crumbs]');
      await expect(path).toHaveText(new RegExp(`People\\s*/\\s*Teams\\s*/\\s*${TEAM_RENAMED}`));
      await expect(path.locator('a[href="/teams"]')).toHaveText('Teams');
      await expect(path.locator('a[href="/members"]')).toHaveText('People');
      await expect(owner.getByRole('link', { name: 'All teams' })).toHaveAttribute('href', '/teams');
      await expect(owner.getByText('Nobody is in this team yet.')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('Add member: the workspace people are offered, an inactive one is not; Vera is seated', async () => {
      await owner.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = owner
        .getByRole('dialog')
        .filter({ hasText: `Pick a member of this workspace to add to ${TEAM_RENAMED}.` });
      await expect(dialog).toBeVisible();
      const pick = dialog.getByRole('button', { name: new RegExp(SEATED.email.replace(/\./g, '\\.')) });
      await expect(pick).toBeVisible({ timeout: 15_000 });
      // the owner is offered too; the editor projects.spec.ts removed from the workspace is not
      await expect(
        dialog.getByRole('button', { name: new RegExp(OWNER.email.replace(/\./g, '\\.')) })
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: new RegExp(REMOVED_EDITOR_EMAIL.replace(/\./g, '\\.')) })
      ).toHaveCount(0);
      await pick.click();
      await expect(pick).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: 'Add to team', exact: true }).click();
      await expect(owner.getByText(`${SEATED.email} added to ${TEAM_RENAMED}`)).toBeVisible({
        timeout: 15_000
      });
      await expect(dialog).toBeHidden();
    });

    await test.step('the members table shows them, Active, with the count', async () => {
      const seated = row(owner, SEATED.email);
      await expect(seated).toBeVisible({ timeout: 15_000 });
      await expect(seated).toContainText(SEATED.name);
      await expect(seated).toContainText('Member');
      await expect(seated).toContainText('Active');
      await expect(owner.getByText('1 person', { exact: true })).toBeVisible();
      await expect(owner.getByText('Nobody is in this team yet.')).toHaveCount(0);
    });

    await test.step('the list counts them too', async () => {
      await owner.goto('/teams');
      await expect(row(owner, TEAM_RENAMED).getByRole('cell').nth(1)).toHaveText('1', { timeout: 20_000 });
    });
  });

  test('a team as a project member: added with a role, its chip and size, its role changed, removed', async () => {
    await test.step('a project made from /projects, the owner its first manager', async () => {
      await owner.goto('/projects');
      await owner.getByRole('button', { name: 'New project', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'New project' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Name', { exact: true }).fill(PROJECT_NAME);
      await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(owner).toHaveURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      projectId = owner.url().split('/projects/')[1];
      await expect(owner.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible();
      await expect(row(owner, OWNER.email)).toBeVisible({ timeout: 15_000 });
    });

    await test.step('Add member: the team in the Teams group, picked as Editor', async () => {
      await owner.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Add a member' });
      await expect(dialog).toBeVisible();
      // two groups: the people, then the teams
      await expect(dialog.getByText('People', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByText('Teams', { exact: true })).toBeVisible();
      const team = dialog.getByRole('button', { name: new RegExp(`${TEAM_RENAMED}.*${TEAM_SLUG}`) });
      await expect(team).toBeVisible();
      await team.click();
      await expect(team).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: 'Role', exact: true }).click();
      await owner.getByRole('option', { name: /^Editor/ }).click();
      await dialog.getByRole('button', { name: 'Add to project', exact: true }).click();
      await expect(owner.getByText(`${TEAM_RENAMED} is in the project`)).toBeVisible({ timeout: 15_000 });
      await expect(dialog).toBeHidden();
    });

    await test.step('the team row: its chip, its slug, its size, its role, its Manage link', async () => {
      const teamRow = row(owner, TEAM_RENAMED);
      await expect(teamRow).toBeVisible({ timeout: 15_000 });
      await expect(teamRow.getByText('Team', { exact: true })).toBeVisible();
      await expect(teamRow).toContainText(TEAM_SLUG);
      await expect(teamRow).toContainText('1 person');
      await expect(teamRow).toContainText('Editor');
      await expect(teamRow.getByRole('link', { name: 'Manage team', exact: true })).toHaveAttribute(
        'href',
        `/teams/${teamId}`
      );
      // A team is not a person row: Vera herself is not listed on the project.
      await expect(row(owner, SEATED.email)).toHaveCount(0);
      // Once on the project, the team is not offered again.
      await owner.getByRole('button', { name: 'Add member', exact: true }).click();
      const again = owner.getByRole('dialog').filter({ hasText: 'Add a member' });
      await expect(
        again.getByRole('button', { name: new RegExp(SEATED.email.replace(/\./g, '\\.')) })
      ).toBeVisible({
        timeout: 15_000
      });
      await expect(again.getByRole('button', { name: new RegExp(TEAM_SLUG) })).toHaveCount(0);
      await owner.keyboard.press('Escape');
      await expect(again).toBeHidden();
    });

    await test.step("Change role from the team row's menu: Editor to Manager", async () => {
      await row(owner, TEAM_RENAMED).getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Change role', exact: true }).click();
      const dialog = owner.getByRole('dialog').filter({ hasText: 'Change role' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`Choose the role of ${TEAM_RENAMED} in this project.`);
      await dialog.getByRole('button', { name: 'Role', exact: true }).click();
      await owner.getByRole('option', { name: /^Manager/ }).click();
      await dialog.getByRole('button', { name: 'Change role', exact: true }).click();
      await expect(owner.getByText(`${TEAM_RENAMED} is now Manager`)).toBeVisible({ timeout: 15_000 });
      await expect(row(owner, TEAM_RENAMED)).toContainText('Manager', { timeout: 15_000 });

      // the server reads the same role
      const res = await owner.request.get(`/api/v1/projects/${projectId}/members?limit=100`);
      expect(res.status()).toBe(200);
      const { members } = await res.json();
      const onProject = members.find(
        (m: { kind: string; teamId?: string }) => m.kind === 'team' && m.teamId === teamId
      );
      expect(onProject?.role).toBe('manager');
    });

    await test.step('Remove from project: the confirm dialog, the row goes, the owner stays', async () => {
      await row(owner, TEAM_RENAMED).getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Remove from project', exact: true }).click();
      const confirm = owner.getByRole('dialog').filter({ hasText: 'Remove this team?' });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(`${TEAM_RENAMED} loses its role in this project.`);
      await confirm.getByRole('button', { name: 'Remove from project', exact: true }).click();
      await expect(owner.getByText(`${TEAM_RENAMED} removed from the project`)).toBeVisible({
        timeout: 15_000
      });
      await expect(row(owner, TEAM_RENAMED)).toHaveCount(0, { timeout: 15_000 });
      await expect(row(owner, OWNER.email)).toBeVisible();
    });
  });

  test('the person leaves the team, the team is deleted, the list is back to empty', async () => {
    await test.step("the team's page: Vera removed from the team through its confirm", async () => {
      await owner.goto(`/teams/${teamId}`);
      await teamHeading(owner);
      const seated = row(owner, SEATED.email);
      await expect(seated).toBeVisible({ timeout: 15_000 });
      await seated.getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Remove from team', exact: true }).click();
      const confirm = owner.getByRole('dialog').filter({ hasText: 'Remove from the team?' });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(
        `${SEATED.email} leaves ${TEAM_RENAMED}. They stay in the workspace.`
      );
      await confirm.getByRole('button', { name: 'Remove from team', exact: true }).click();
      await expect(owner.getByText(`${SEATED.email} removed from ${TEAM_RENAMED}`)).toBeVisible({
        timeout: 15_000
      });
      await expect(row(owner, SEATED.email)).toHaveCount(0, { timeout: 15_000 });
      await expect(owner.getByText('Nobody is in this team yet.')).toBeVisible();
    });

    await test.step('Delete team (the list row menu): the confirm, the toast, the empty state again', async () => {
      await owner.getByRole('link', { name: 'All teams' }).click();
      await expect(owner).toHaveURL(/\/teams$/, { timeout: 20_000 });
      await row(owner, TEAM_RENAMED).getByRole('button', { name: 'Open menu' }).click();
      await owner.getByRole('menuitem', { name: 'Delete team', exact: true }).click();
      const confirm = owner.getByRole('dialog').filter({ hasText: 'Delete the team?' });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(`${TEAM_RENAMED} and its list of 0 people are deleted.`);
      await confirm.getByRole('button', { name: 'Delete team', exact: true }).click();
      await expect(owner.getByText(`${TEAM_RENAMED} deleted`)).toBeVisible({ timeout: 15_000 });
      await expect(row(owner, TEAM_RENAMED)).toHaveCount(0, { timeout: 15_000 });
      await expect(owner.getByText('No team yet. Make one with New team.')).toBeVisible();
    });

    await test.step("the deleted team's address is the calm not-found page", async () => {
      await owner.goto(`/teams/${teamId}`);
      await expect(owner.getByText('Team not found')).toBeVisible({ timeout: 20_000 });
      await expect(owner.getByText('This team does not exist in this workspace.')).toBeVisible();
      await expect(owner.getByText(TEAM_RENAMED)).toHaveCount(0);
      // Vera is still a member of the workspace: leaving a team is not leaving it
      const roster = await owner.request.get('/api/v1/members?limit=100');
      const { members } = await roster.json();
      expect(members.find((m: { email: string }) => m.email.toLowerCase() === SEATED.email)?.isActive).toBe(
        true
      );
    });
  });
});
