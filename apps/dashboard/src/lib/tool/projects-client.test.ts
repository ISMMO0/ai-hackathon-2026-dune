import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api', () => ({ api: {} }));
const { itemsToLink, namedProjects } = await import('./projects-client');

const item = (id: string, ...projects: string[]) => ({
  id,
  projects: projects.map((p) => ({ id: p, name: `Project ${p}` }))
});

describe('the projects an item names', () => {
  it('are the ones of its payload, in their order', () => {
    expect(namedProjects(item('a', 'p1', 'p2')).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(namedProjects(item('a'))).toEqual([]);
  });

  it('leave out the project whose page the item is shown on', () => {
    expect(namedProjects(item('a', 'p1', 'p2'), 'p1').map((p) => p.id)).toEqual(['p2']);
    expect(namedProjects(item('a', 'p1'), 'p1')).toEqual([]);
    expect(namedProjects(item('a', 'p1'), 'p9').map((p) => p.id)).toEqual(['p1']);
  });
});

describe('the items a project can still take', () => {
  it('are the ones not in it yet, the list left alone', () => {
    const items = [item('a', 'p1'), item('b'), item('c', 'p2', 'p1'), item('d', 'p2')];
    expect(itemsToLink(items, 'p1').map((i) => i.id)).toEqual(['b', 'd']);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is every item when none is in the project, and none when all are', () => {
    expect(itemsToLink([item('a'), item('b')], 'p1').map((i) => i.id)).toEqual(['a', 'b']);
    expect(itemsToLink([item('a', 'p1'), item('b', 'p1')], 'p1')).toEqual([]);
    expect(itemsToLink([], 'p1')).toEqual([]);
  });
});
