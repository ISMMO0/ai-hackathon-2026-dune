import { describe, expect, it } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { en as shellEn } from '$lib/i18n/en';

const keys = Object.keys(en) as (keyof typeof en)[];

describe('the tool’s words', () => {
  it('has the same keys in both languages, none empty', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const key of keys) {
      expect(en[key], key).not.toBe('');
      expect(fr[key], key).not.toBe('');
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys) expect(holes(fr[key]), key).toEqual(holes(en[key]));
  });

  it('shares no key with the shell (the merge proves it at compile time; this says it at run time)', () => {
    for (const key of keys) expect(shellEn, key).not.toHaveProperty([key]);
  });
});

describe('the French typography rule', () => {
  // fr.ts states it in its header: U+2019 apostrophes, U+00A0 before ? ! : ;

  it('uses the typographic apostrophe, never the ASCII one', () => {
    for (const key of keys) expect(fr[key], key).not.toContain("'");
  });

  it('puts a non-breaking space before ? ! : ; and inside guillemets', () => {
    for (const key of keys) {
      expect(fr[key], key).not.toMatch(/ [?!:;]/);
      expect(fr[key], key).not.toMatch(/« |\S»/);
    }
  });
});
