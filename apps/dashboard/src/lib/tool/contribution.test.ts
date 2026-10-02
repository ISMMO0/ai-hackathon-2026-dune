import { beforeEach, describe, expect, it, vi } from 'vitest';
import Box from '@lucide/svelte/icons/box';
import GraduationCap from '@lucide/svelte/icons/graduation-cap';
import Globe from '@lucide/svelte/icons/globe';
import Volume2 from '@lucide/svelte/icons/volume-2';

// Plain vitest has no SvelteKit runtime; the components the contribution carries may import it.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/'), params: {} } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn(), onNavigate: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false }));

const items = vi.fn();
vi.mock('$lib/api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: { items }
}));

const { tool } = await import('./index');
const { default: ProjectItems } = await import('./components/projects/ProjectItems.svelte');
const { behindWorkspace, buildNav, phoneTabs } = await import('$lib/nav');
const { actionFamilies } = await import('$lib/components/audit/audit-filters');
const { createItemOverview } = await import('./overview.svelte');
const { listScope } = await import('$lib/stores/pagedList.svelte');

/**
 * What the tool hands the shell. The boundary test holds the shape of the
 * split; this one holds its content: an entry, a tab, a route or an action
 * dropped from the contribution changes a page and nothing else would say so.
 */
describe('the menu', () => {
  it('a member gets Tutor Studio first, then items, Try it and the shell’s projects', () => {
    const nav = buildNav({ role: 'member', origin: 'local' });
    expect(nav.primary.map((i) => [i.id, i.href, i.pattern])).toEqual([
      ['overview', '/', 'rings'],
      ['tutors', '/tutors', 'orbits'],
      ['items', '/items', 'diamond'],
      ['try', '/try', 'sonar'],
      ['projects', '/projects', 'truss']
    ]);
    expect(nav.primary[1].icon).toBe(GraduationCap);
    expect(nav.primary[2].icon).toBe(Box);
    for (const item of nav.primary.slice(1)) expect(item.title && item.blurb).toBeTruthy();
  });

  it('nothing comes after the projects', () => {
    expect(tool.navAfter({ role: 'member', origin: 'local' })).toEqual([]);
    expect(tool.navAfter({ role: 'member', origin: 'guest' })).toEqual([]);
  });

  it('a guest gets the same entries, and no projects: the pages open for them, empty and without their controls', () => {
    expect(tool.nav({ role: 'member', origin: 'guest' }).map((i) => [i.id, i.href])).toEqual([
      ['tutors', '/tutors'],
      ['items', '/items'],
      ['try', '/try']
    ]);
    expect(buildNav({ role: 'member', origin: 'guest' }).primary.map((i) => i.id)).toEqual([
      'overview',
      'tutors',
      'items',
      'try'
    ]);
  });

  it('a phone keeps Tutor Studio and projects as thumb tabs, while Items folds behind Workspace', () => {
    expect(tool.phoneTabs).toEqual(['tutors']);
    const nav = buildNav({ role: 'owner', origin: 'local' });
    expect(phoneTabs(nav).map((i) => i.id)).toEqual([
      'overview',
      'tutors',
      'projects',
      'workspace',
      'settings'
    ]);
    expect(behindWorkspace(nav).map((i) => i.id)).not.toContain('tutors');
    expect(behindWorkspace(nav).map((i) => i.id)).not.toContain('projects');
    expect(behindWorkspace(nav).map((i) => i.id)).toContain('items');
    // Try it is no thumb tab: on a phone it folds behind the workspace entry.
    expect(behindWorkspace(nav).map((i) => i.id)).toContain('try');
    const workspace = phoneTabs(nav).find((i) => i.id === 'workspace')!;
    expect(workspace.also).not.toContain('/tutors');
    expect(workspace.also).not.toContain('/projects');
  });
});

describe('the gate', () => {
  it('the tool has no signed-out page', () => {
    expect(tool.gateRoutes).toEqual([]);
  });
});

describe('the project page', () => {
  it('gives the shell a piece for what a project holds here: its items', () => {
    expect(tool.project.Resources).toBe(ProjectItems);
  });
});

describe('the audit vocabulary', () => {
  it('names the eight actions the items, runs and voice routes write, as the server writes them, sorted', () => {
    expect(tool.audit.actions).toEqual([
      'item.create',
      'item.delete',
      'item.project_link',
      'item.project_unlink',
      'item.update',
      'run.create',
      'voice.speak',
      'voice.transcribe'
    ]);
    expect(tool.audit.actions).toEqual([...tool.audit.actions].sort());
  });

  it('the filter panel offers the item family before a single row has loaded', () => {
    const families = actionFamilies([...tool.audit.actions]);
    expect(families.find((f) => f.family === 'item')?.actions).toEqual([
      'item.create',
      'item.delete',
      'item.project_link',
      'item.project_unlink',
      'item.update'
    ]);
  });

  it('the filter panel offers the run and voice families too', () => {
    const families = actionFamilies([...tool.audit.actions]);
    // a family of one action is a single row (family null)
    expect(families.some((f) => f.actions.includes('run.create'))).toBe(true);
    expect(families.find((f) => f.family === 'voice')?.actions).toEqual(['voice.speak', 'voice.transcribe']);
  });

  it('names its resource types', () => {
    expect(tool.audit.resourceTypes).toEqual(['item', 'run', 'voice']);
  });

  it('draws an item line with the menu entry’s icon, and not a shell line', () => {
    const glyph = (kind: string) => tool.audit.glyphs.find((g) => g.test.test(kind))?.icon;
    expect(glyph('item item.create')).toBe(Box);
    expect(glyph('item item.delete')).toBe(Box);
    expect(glyph('workspace workspace.update')).toBeUndefined();
    expect(glyph('file file.upload')).toBeUndefined();
  });

  it('draws a run line and a voice line with their icons', () => {
    const glyph = (kind: string) => tool.audit.glyphs.find((g) => g.test.test(kind))?.icon;
    expect(glyph('run run.create')).toBe(Globe);
    expect(glyph('voice voice.speak')).toBe(Volume2);
  });
});

describe('the list to warm', () => {
  beforeEach(() => items.mockReset());

  it('asks for the first page of items, the call the items page remembers', () => {
    items.mockResolvedValue({ items: [], nextCursor: null });
    tool.warm();
    expect(items).toHaveBeenCalledTimes(1);
    expect(items).toHaveBeenCalledWith({});
  });
});

describe('the overview’s item pieces', () => {
  const item = (id: string, updatedAt: string) => ({ id, name: id, note: '', updatedAt });
  const facts = (isGuest = false) => ({ isGuest: () => isGuest, workspaceName: () => 'Northwind' });

  let scope = 0;
  beforeEach(() => {
    items.mockReset();
    // the store remembers a list under its name for the next visit: a new scope forgets it
    listScope(`overview-test-${++scope}`);
  });

  it('loading: says nothing, so the shell says its own sentence, and the figure waits', () => {
    items.mockReturnValue(new Promise(() => {}));
    const model = createItemOverview(facts());
    model.load();
    expect(model.lede).toBeNull();
    expect(model.stats.map((s) => [s.id, s.value, s.href, s.drawing])).toEqual([
      ['items', null, '/items', 'fresh']
    ]);
    expect(model.recentItems).toEqual([]);
  });

  it('loaded: counts the items and keeps the three changed last', async () => {
    items.mockResolvedValue({
      items: [
        item('a', '2026-09-01T00:00:00Z'),
        item('b', '2026-09-04T00:00:00Z'),
        item('c', '2026-09-02T00:00:00Z'),
        item('d', '2026-09-03T00:00:00Z')
      ],
      nextCursor: null
    });
    const model = createItemOverview(facts());
    model.load();
    await vi.waitFor(() => expect(model.lede).not.toBeNull());
    expect(items).toHaveBeenCalledWith({ limit: 100 });
    expect(model.lede).toBe('4 items in Northwind.');
    expect(model.stats[0].value).toBe('4');
    expect(model.recentItems.map((i) => i.id)).toEqual(['b', 'd', 'c']);
  });

  it('a list that goes on past its first page is counted with a "+", never guessed', async () => {
    items.mockResolvedValue({ items: [item('a', '2026-09-01T00:00:00Z')], nextCursor: 'next' });
    const model = createItemOverview(facts());
    model.load();
    await vi.waitFor(() => expect(model.stats[0].value).not.toBeNull());
    expect(model.stats[0].value).toBe('1+');
    expect(model.lede).toBe('1+ items in Northwind.');
  });

  it('one item is said in the singular', async () => {
    items.mockResolvedValue({ items: [item('a', '2026-09-01T00:00:00Z')], nextCursor: null });
    const model = createItemOverview(facts());
    model.load();
    await vi.waitFor(() => expect(model.lede).not.toBeNull());
    expect(model.lede).toBe('1 item in Northwind.');
  });

  it('empty: a member gets the invitation to add one', async () => {
    items.mockResolvedValue({ items: [], nextCursor: null });
    const model = createItemOverview(facts());
    model.load();
    await vi.waitFor(() => expect(model.lede).not.toBeNull());
    expect(model.lede).toBe('Nothing here yet. Your first item is one click away.');
    expect(model.stats[0].value).toBe('0');
    expect(model.isGuest).toBe(false);
  });

  it('a guest lists none and may add none: the figure says 0 and the tool says nothing', async () => {
    items.mockResolvedValue({ items: [], nextCursor: null });
    const model = createItemOverview(facts(true));
    model.load();
    await vi.waitFor(() => expect(model.stats[0].value).toBe('0'));
    expect(model.lede).toBeNull();
    expect(model.isGuest).toBe(true);
  });
});
