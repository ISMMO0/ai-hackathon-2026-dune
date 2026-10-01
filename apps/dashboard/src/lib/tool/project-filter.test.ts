import { describe, expect, it } from 'vitest';
import {
  projectFilterKey,
  readProjectFilter,
  rememberedListName,
  standingFilter,
  writeProjectFilter
} from './project-filter';

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k]
  };
}
const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  }
};

describe('the remembered project filter', () => {
  it('keeps one key per page, per person and workspace', () => {
    expect(projectFilterKey('items', 'u1:w1')).toBe('items.project:u1:w1');
    expect(projectFilterKey('items', 'u2:w1')).not.toBe(projectFilterKey('items', 'u1:w1'));
    expect(projectFilterKey('items', 'u1:w2')).not.toBe(projectFilterKey('items', 'u1:w1'));
  });

  it('reads back what it wrote, scope by scope', () => {
    const storage = memory();
    writeProjectFilter('items', 'u1:w1', 'p1', storage);
    writeProjectFilter('items', 'u1:w2', 'p2', storage);
    expect(readProjectFilter('items', 'u1:w1', storage)).toBe('p1');
    expect(readProjectFilter('items', 'u1:w2', storage)).toBe('p2');
    expect(readProjectFilter('items', 'u2:w1', storage)).toBeNull();
  });

  it('forgets on null: the key is removed, not emptied', () => {
    const storage = memory({ 'items.project:u1:w1': 'p1' });
    writeProjectFilter('items', 'u1:w1', null, storage);
    expect(storage.data).toEqual({});
    expect(readProjectFilter('items', 'u1:w1', storage)).toBeNull();
  });

  it('reads an empty value as no filter', () => {
    expect(readProjectFilter('items', 'u1:w1', memory({ 'items.project:u1:w1': '' }))).toBeNull();
  });

  it('lives without storage, and with a storage that refuses', () => {
    expect(readProjectFilter('items', 'u1:w1', null)).toBeNull();
    expect(() => writeProjectFilter('items', 'u1:w1', 'p1', null)).not.toThrow();
    expect(readProjectFilter('items', 'u1:w1', refusing)).toBeNull();
    expect(() => writeProjectFilter('items', 'u1:w1', 'p1', refusing)).not.toThrow();
    expect(() => writeProjectFilter('items', 'u1:w1', null, refusing)).not.toThrow();
  });
});

describe('the list a filter is remembered under', () => {
  it('keeps the bare name with no filter, the one the shell warms', () => {
    expect(rememberedListName('items', null)).toBe('items');
  });
  it('is one name per project', () => {
    expect(rememberedListName('items', 'p1')).toBe('items.p1');
    expect(rememberedListName('items', 'p2')).not.toBe(rememberedListName('items', 'p1'));
  });
});

describe('a remembered project the reader no longer reads', () => {
  it('stands while the project is readable', () => {
    expect(standingFilter('p1', [{ id: 'p1' }, { id: 'p2' }])).toBe('p1');
  });
  it('falls back to all projects when it is gone', () => {
    expect(standingFilter('p3', [{ id: 'p1' }])).toBeNull();
    expect(standingFilter('p1', [])).toBeNull();
    expect(standingFilter(null, [{ id: 'p1' }])).toBeNull();
  });
});
