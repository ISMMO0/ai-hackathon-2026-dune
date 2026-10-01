import { describe, expect, it } from 'vitest';
import {
  cliAuthCompleteSchema,
  fileUploadQuerySchema,
  hasControlChars,
  invitationAcceptSchema,
  plainText,
  setupRequestSchema
} from '@antasphere/chassis-contract';
import { apiKeyCreateSchema } from '../src/chassis.js';

/**
 * SL-B4: Postgres cannot store a NUL in a text value — it raises SQLSTATE
 * 22021 from inside the driver, which surfaced as an anonymous 500 whose
 * error-level log line printed the failing SQL and its bound parameters.
 * Every free-text sink now refuses it at the contract, so the caller gets the
 * ordinary 400 validation_error and nothing reaches the database.
 */
const NUL = '\u0000';

describe('hasControlChars', () => {
  it('flags NUL and the invisible C0 controls', () => {
    expect(hasControlChars(`acme${NUL}`)).toBe(true);
    expect(hasControlChars('acme\u0007')).toBe(true);
    expect(hasControlChars('acme\u001b[31m')).toBe(true);
    expect(hasControlChars('acme\u007f')).toBe(true);
  });

  it('allows ordinary text, including multi-line', () => {
    expect(hasControlChars('Acme Corp — 2026')).toBe(false);
    expect(hasControlChars('line one\nline two\ttabbed\r\n')).toBe(false);
    expect(hasControlChars('日本語 🎉')).toBe(false);
  });
});

describe('plainText', () => {
  it('keeps the length bounds and adds the control-character refusal', () => {
    const schema = plainText(1, 5);
    expect(schema.safeParse('ok').success).toBe(true);
    expect(schema.safeParse('').success).toBe(false);
    expect(schema.safeParse('toolong').success).toBe(false);
    expect(schema.safeParse(`ok${NUL}`).success).toBe(false);
  });
});

describe('every free-text sink refuses a NUL byte', () => {
  it('API key name', () => {
    expect(apiKeyCreateSchema.safeParse({ name: `ci${NUL}`, scopes: ['items:read'] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ name: 'ci', scopes: ['items:read'] }).success).toBe(true);
  });

  it('setup instance name and owner name', () => {
    const valid = {
      instanceName: 'Acme',
      owner: { email: 'a@b.io', name: 'Ann', password: 'correct horse battery' }
    };
    expect(setupRequestSchema.safeParse(valid).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...valid, instanceName: `Acme${NUL}` }).success).toBe(false);
    expect(
      setupRequestSchema.safeParse({ ...valid, owner: { ...valid.owner, name: `Ann${NUL}` } }).success
    ).toBe(false);
  });

  it('invitation accept name', () => {
    const valid = { token: 'x'.repeat(20), name: 'Ann', password: 'correct horse battery' };
    expect(invitationAcceptSchema.safeParse(valid).success).toBe(true);
    expect(invitationAcceptSchema.safeParse({ ...valid, name: `Ann${NUL}` }).success).toBe(false);
  });

  it('CLI key name', () => {
    const valid = { email: 'a@b.io', otp: '123456', keyName: 'laptop' };
    expect(cliAuthCompleteSchema.safeParse(valid).success).toBe(true);
    expect(cliAuthCompleteSchema.safeParse({ ...valid, keyName: `laptop${NUL}` }).success).toBe(false);
  });

  it('file upload name', () => {
    expect(fileUploadQuerySchema.safeParse({ name: 'report.pdf' }).success).toBe(true);
    expect(fileUploadQuerySchema.safeParse({ name: `report${NUL}.pdf` }).success).toBe(false);
  });
});
