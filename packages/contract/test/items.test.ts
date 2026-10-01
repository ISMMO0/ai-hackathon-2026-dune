import { describe, expect, it } from 'vitest';
import {
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  itemCreateSchema,
  itemUpdateSchema,
  type ItemCreate
} from '../src/index.js';

/**
 * The item schemas are the only gate a body passes before the database: the
 * limits, the trim, the control-character refusal and the empty-patch refusal
 * are proven here, on the schemas alone, so the server tests only have to
 * prove that a refusal comes back as a 400.
 */
const NUL = '\u0000';

/**
 * The caps are written here as LITERALS, never read from the constants: a test
 * built on `ITEM_NAME_MAX` only says "the cap is whatever the cap is" and stays
 * green when the constant changes (verifier round 1, F1). The reference pages
 * quote the same two numbers; their coverage tests hold the pages to the
 * constants, and this file holds the constants to the numbers.
 */
const NAME_CAP = 200;
const NOTE_CAP = 2000;

describe('the item caps', () => {
  it('are 200 characters for the name and 2000 for the note', () => {
    expect(ITEM_NAME_MAX).toBe(200);
    expect(ITEM_NOTE_MAX).toBe(2000);
  });
});

describe('itemCreateSchema', () => {
  it('accepts a name alone and gives the note its empty default', () => {
    const body: ItemCreate = { name: 'First' };
    expect(itemCreateSchema.parse(body)).toEqual({ name: 'First', note: '' });
  });

  it('trims the name BEFORE it measures it: spaces alone are an empty name', () => {
    expect(itemCreateSchema.parse({ name: '  First  ' }).name).toBe('First');
    expect(itemCreateSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(itemCreateSchema.safeParse({}).success).toBe(false);
  });

  it('bounds the name at 200 characters once trimmed', () => {
    expect(itemCreateSchema.safeParse({ name: 'n'.repeat(NAME_CAP) }).success).toBe(true);
    expect(itemCreateSchema.safeParse({ name: ` ${'n'.repeat(NAME_CAP)} ` }).success).toBe(true);
    expect(itemCreateSchema.safeParse({ name: 'n'.repeat(NAME_CAP + 1) }).success).toBe(false);
  });

  it('bounds the note at 2000 characters and keeps it as typed', () => {
    expect(itemCreateSchema.safeParse({ name: 'n', note: 'x'.repeat(NOTE_CAP) }).success).toBe(true);
    expect(itemCreateSchema.safeParse({ name: 'n', note: 'x'.repeat(NOTE_CAP + 1) }).success).toBe(false);
    expect(itemCreateSchema.parse({ name: 'n', note: ' line one\n\tline two ' }).note).toBe(
      ' line one\n\tline two '
    );
  });

  it('refuses NUL and the other control characters in both fields', () => {
    expect(itemCreateSchema.safeParse({ name: `First${NUL}` }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ name: 'First\u001b[31m' }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ name: 'First', note: `a${NUL}b` }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ name: 'First', note: 'bell\u0007' }).success).toBe(false);
  });
});

describe('itemUpdateSchema', () => {
  it('accepts the name, the note, or both', () => {
    expect(itemUpdateSchema.parse({ name: ' Renamed ' })).toEqual({ name: 'Renamed' });
    expect(itemUpdateSchema.parse({ note: '' })).toEqual({ note: '' });
    expect(itemUpdateSchema.parse({ name: 'Renamed', note: 'why' })).toEqual({
      name: 'Renamed',
      note: 'why'
    });
  });

  it('refuses an empty patch: at least one field is required', () => {
    expect(itemUpdateSchema.safeParse({}).success).toBe(false);
    // An unknown key is stripped, so it does not count as a field.
    expect(itemUpdateSchema.safeParse({ title: 'x' }).success).toBe(false);
  });

  it('applies the same limits and refusals as the create', () => {
    expect(itemUpdateSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ name: 'n'.repeat(NAME_CAP + 1) }).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ note: 'x'.repeat(NOTE_CAP + 1) }).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ name: `Renamed${NUL}` }).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ note: `why${NUL}` }).success).toBe(false);
  });
});
