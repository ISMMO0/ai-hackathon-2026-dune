import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { GUEST, MIA, PROJECT, TEAM, ITEMS, api, failures, kept, signIn, step } from './lib';

/**
 * Chapter 2, a plain member and a guest: what each reaches and what each is
 * refused, on the pages and on the API. Reads what the owner chapter left:
 * MIA an active member seated on the team (an editor of the project) and a
 * viewer of the project in her own name, GUEST a guest row.
 */

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.describe('A plain member', () => {
  const CH = 'member';
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    page = await context.newPage();
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('Mia signs in and walks what a member reaches', async () => {
    const { projectId, teamId } = kept('cli');

    await step(CH, page, 'Mia signs in: the overview, the menu without the admin pages', async () => {
      await signIn(page, MIA);
      await expect(page.getByRole('link', { name: 'Items', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Projects', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'People', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    });

    await step(
      CH,
      page,
      'Projects: an editor through her team, the page without the manager controls',
      async () => {
        // Her own grant says viewer, her team's says editor: the effective role
        // is the higher of the two (projectGrantPredicate), and an editor gets
        // neither Edit nor Add member (projectCan: a manager's).
        await page.goto('/projects');
        await expect(page.getByRole('row', { name: new RegExp(PROJECT.name) })).toContainText('Editor', {
          timeout: 20_000
        });
        await page.goto(`/projects/${projectId}`);
        await expect(page.getByRole('heading', { name: PROJECT.name, level: 1 })).toBeVisible({
          timeout: 20_000
        });
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
        await expect(
          page.getByTestId('project-items').getByRole('row', { name: new RegExp(ITEMS.one) })
        ).toBeVisible({
          timeout: 15_000
        });
      }
    );

    await step(
      CH,
      page,
      'Items: she reads the workspace items, with the project tag she can read',
      async () => {
        await page.goto('/items');
        await expect(page.getByRole('row', { name: new RegExp(ITEMS.one) })).toBeVisible({ timeout: 20_000 });
        await expect(
          page.getByRole('row', { name: new RegExp(ITEMS.one) }).getByTestId('item-projects')
        ).toContainText(PROJECT.name);
      }
    );

    await step(
      CH,
      page,
      'People: the roster readable, no Invite; the team page readable, no New team',
      async () => {
        await page.goto('/members');
        await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole('cell', { name: MIA.email })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
        await page.goto('/teams');
        await expect(page.getByRole('row', { name: new RegExp(TEAM.renamed) })).toBeVisible({
          timeout: 20_000
        });
        await expect(page.getByRole('button', { name: 'New team', exact: true })).toHaveCount(0);
        await page.goto(`/teams/${teamId}`);
        await expect(
          page.getByRole('row', { name: new RegExp(MIA.email.replace(/\./g, '\\.')) })
        ).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
      }
    );

    await step(CH, page, 'Settings: the workspace tab without the demo links tab; her account', async () => {
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 20_000 });
      const bar = page.locator('nav[data-section-bar]');
      await expect(bar.getByRole('link', { name: 'Demo links' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
      await page.goto('/account');
      await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
    });

    await step(
      CH,
      null,
      'The API says the same: no invitation, no audit log, no demo link, no team write',
      async () => {
        const r = page.request;
        const inv = await api(r, 'POST', '/invitations', { email: 'y@example.com', role: 'member' });
        const audit = await api(r, 'GET', '/audit');
        const demo = await api(r, 'POST', '/demo/passes', { email: MIA.email, path: '/items' });
        const team = await api(r, 'POST', '/teams', { name: 'Mia team' });
        const roster = await api(r, 'GET', '/members?limit=5');
        expect(inv.status).toBe(403);
        expect(audit.status).toBe(403);
        expect(demo.status).toBe(403);
        expect(team.status).toBe(403);
        expect(roster.status).toBe(200);
        return `invitations ${inv.status}, audit ${audit.status}, demo/passes ${demo.status} ${demo.json?.error?.code ?? ''}, teams ${team.status} ${team.json?.error?.code ?? ''}, members ${roster.status}`;
      }
    );
  });

  test('the member chapter recorded no failed step', () => {
    expect(failures).toEqual([]);
  });
});

test.describe('A guest', () => {
  const CH = 'guest';
  let guestContext: BrowserContext;
  let guest: Page;
  test.beforeAll(async ({ browser }) => {
    guestContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    guest = await guestContext.newPage();
  });
  test.afterAll(async () => {
    await guestContext?.close();
  });

  test('Gus signs in and reaches no workspace-level page', async () => {
    const { projectId } = kept('cli');

    await step(CH, guest, 'Gus signs in: the menu without People, Files and Audit log', async () => {
      await signIn(guest, GUEST);
      const me = await api(guest.request, 'GET', '/me');
      expect(me.json.origin).toBe('guest');
      await expect(guest.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
      await expect(guest.getByRole('link', { name: 'Files', exact: true })).toHaveCount(0);
      await expect(guest.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    });

    await step(CH, guest, 'Items: a guest lists no item', async () => {
      await guest.goto('/items');
      await expect(guest.getByRole('heading', { name: 'Items', level: 1 })).toBeVisible({ timeout: 20_000 });
      await expect(guest.getByRole('row', { name: new RegExp(ITEMS.one) })).toHaveCount(0);
      const items = await api(guest.request, 'GET', '/items');
      expect(items.status).toBe(200);
      expect(items.json.items).toEqual([]);
    });

    await step(CH, guest, 'Projects: not available to a guest, the whole subtree refused flat', async () => {
      await guest.goto('/projects');
      await expect(guest.getByText(/not available to a guest/i)).toBeVisible({ timeout: 20_000 });
      // A guest is refused the projects surface as a whole (requireNonGuest on
      // /projects and /projects/*, docs/security/security.md "a guest is
      // refused"), the same answer for a real project and an unknown one, so
      // nothing is probeable through it.
      const project = await api(guest.request, 'GET', `/projects/${projectId}`);
      const unknown = await api(guest.request, 'GET', '/projects/00000000-0000-4000-8000-000000000000');
      expect(project.status).toBe(403);
      expect(project.json.error.code).toBe('guest_forbidden');
      expect(unknown.status).toBe(project.status);
      expect(unknown.json.error.code).toBe(project.json.error.code);
      return `project ${project.status} ${project.json.error.code}; unknown id ${unknown.status} ${unknown.json.error.code}`;
    });

    await step(CH, guest, 'The members page, the files page, the teams page: refused', async () => {
      await guest.goto('/members');
      await guest.waitForTimeout(1500);
      const members = await api(guest.request, 'GET', '/members');
      const files = await api(guest.request, 'GET', '/files');
      const teams = await api(guest.request, 'GET', '/teams');
      const exp = await api(guest.request, 'GET', '/workspace/export');
      expect(members.status).toBe(403);
      expect(members.json.error.code).toBe('guest_forbidden');
      expect(files.status).toBe(403);
      expect(teams.status).toBe(403);
      expect(exp.status).toBe(403);
      return `members ${members.status} ${members.json.error.code}; files ${files.status}; teams ${teams.status}; export ${exp.status}; the page landed on ${new URL(guest.url()).pathname}`;
    });
  });

  test('the guest chapter recorded no failed step', () => {
    expect(failures).toEqual([]);
  });
});
