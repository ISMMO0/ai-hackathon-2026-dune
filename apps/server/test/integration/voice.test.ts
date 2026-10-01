import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GradiumClient } from '../../src/integrations/index.js';
import { IntegrationError } from '../../src/integrations/errors.js';
import {
  SETUP_TOKEN,
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The voice routes on the real boot, Gradium replaced by a recording fake
 * handed in through the boot overrides (no test calls Gradium): the wire
 * shapes, the 503 without a key, the 502 on a provider failure, the guest
 * refusal, the machine scopes, the audit rows (sizes, never the content).
 */

const OWNER = { email: 'owner@voice.test', name: 'Voice Owner', password: 'voice-owner-password-123' };
const GUEST = { email: 'guest@voice.test', name: 'Voice Guest', password: 'voice-guest-password-123' };
const WAV = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt fake', 'latin1');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let bare: TestApp;
let ownerCookie = '';
let workspaceId = '';
let bareCookie = '';

/** What the fake answers next, and what it was asked. */
const fake = {
  fail: null as IntegrationError | null,
  transcript: 'Bonjour. Ceci est un test',
  spoken: [] as string[],
  heard: [] as Array<{ bytes: number[]; language: string | undefined }>
};
const gradium: GradiumClient = {
  speak: async (text) => {
    if (fake.fail) throw fake.fail;
    fake.spoken.push(text);
    return WAV;
  },
  transcribe: async (wav, language) => {
    if (fake.fail) throw fake.fail;
    fake.heard.push({ bytes: [...wav], language });
    return fake.transcript;
  },
  credits: async () => ({ remaining: 1, allocated: 1 })
};

type Headers = Record<string, string>;
let ip = 0;
const send = (target: TestApp, method: string, path: string, headers: Headers, body?: unknown) =>
  target.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': `10.72.0.${(ip++ % 250) + 1}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  });

async function setUp(target: TestApp): Promise<{ cookie: string; workspaceId: string }> {
  const setup = await send(
    target,
    'POST',
    '/setup',
    {},
    { setupToken: SETUP_TOKEN, instanceName: 'Voice', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  const signIn = await send(
    target,
    'POST',
    '/auth/sign-in/email',
    {},
    { email: OWNER.email, password: OWNER.password }
  );
  expect(signIn.status).toBe(200);
  return { cookie: extractCookie(signIn), workspaceId: (await readJson(setup)).workspaceId };
}

async function mintKey(scopes: string[]): Promise<Headers> {
  const res = await send(
    app,
    'POST',
    '/api-keys',
    { cookie: ownerCookie },
    { name: scopes.join('+'), scopes }
  );
  expect(res.status).toBe(201);
  return { authorization: `Bearer ${(await readJson(res)).key as string}` };
}

async function auditRows(action: string) {
  const { rows } = await app.db.pool.query<{ resource_type: string; metadata: Record<string, unknown> }>(
    `SELECT resource_type, metadata FROM audit_log WHERE action = $1 ORDER BY id`,
    [action]
  );
  return rows;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'voice_routes'), {}, { tool: { gradium } });
  ({ cookie: ownerCookie, workspaceId } = await setUp(app));
  bare = await createTestApp(await createDatabase(container, 'voice_no_key'));
  ({ cookie: bareCookie } = await setUp(bare));
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await bare?.stop();
  await container?.stop();
});

describe('POST /voice/speak', () => {
  it('answers the wav base64 encoded, and audits the sizes only', async () => {
    fake.fail = null;
    const res = await send(app, 'POST', '/voice/speak', { cookie: ownerCookie }, { text: 'Bonjour à tous' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toEqual({ audio: WAV.toString('base64'), contentType: 'audio/wav' });
    expect(fake.spoken.at(-1)).toBe('Bonjour à tous');
    const rows = await auditRows('voice.speak');
    expect(rows.at(-1)).toEqual({ resource_type: 'voice', metadata: { characters: 14, bytes: WAV.length } });
    expect(JSON.stringify(rows)).not.toContain('Bonjour');
  });

  it('refuses an empty text and one over 2000 characters with a 400, and never calls Gradium', async () => {
    const before = fake.spoken.length;
    for (const text of ['', '   ', 'x'.repeat(2001)]) {
      const res = await send(app, 'POST', '/voice/speak', { cookie: ownerCookie }, { text });
      expect(res.status).toBe(400);
    }
    expect(fake.spoken.length).toBe(before);
  });

  it('a Gradium failure is a 502 integration_failed with the provider status', async () => {
    fake.fail = new IntegrationError('gradium', 'Gradium answered 402 (text to speech): no credits', 402);
    const res = await send(app, 'POST', '/voice/speak', { cookie: ownerCookie }, { text: 'Bonjour' });
    fake.fail = null;
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({
      error: {
        code: 'integration_failed',
        message: 'Gradium answered 402 (text to speech): no credits',
        details: { integration: 'gradium', status: 402 }
      }
    });
  });

  it('without the key: 503 integration_not_configured naming GRADIUM_API_KEY and the .env file', async () => {
    const res = await send(bare, 'POST', '/voice/speak', { cookie: bareCookie }, { text: 'Bonjour' });
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(body.error.code).toBe('integration_not_configured');
    expect(body.error.details).toEqual({ integration: 'gradium', envKey: 'GRADIUM_API_KEY' });
    expect(body.error.message).toContain('GRADIUM_API_KEY');
    expect(body.error.message).toContain('.env');
  });
});

describe('POST /voice/transcribe', () => {
  it('decodes the wav, passes the language, answers the transcript, and audits the size only', async () => {
    fake.fail = null;
    const res = await send(
      app,
      'POST',
      '/voice/transcribe',
      { cookie: ownerCookie },
      { audio: WAV.toString('base64'), contentType: 'audio/wav', language: 'fr' }
    );
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ text: 'Bonjour. Ceci est un test' });
    expect(fake.heard.at(-1)).toEqual({ bytes: [...WAV], language: 'fr' });
    const rows = await auditRows('voice.transcribe');
    expect(rows.at(-1)).toEqual({ resource_type: 'voice', metadata: { bytes: WAV.length, language: 'fr' } });
    expect(JSON.stringify(rows)).not.toContain('Bonjour');
  });

  it('without a language, none is passed on', async () => {
    const res = await send(
      app,
      'POST',
      '/voice/transcribe',
      { cookie: ownerCookie },
      { audio: WAV.toString('base64'), contentType: 'audio/wav' }
    );
    expect(res.status).toBe(200);
    expect(fake.heard.at(-1)!.language).toBeUndefined();
  });

  it('refuses what is not a base64 wav: another type, a bad language, not base64, over 5 MiB decoded', async () => {
    const before = fake.heard.length;
    const bodies = [
      { audio: WAV.toString('base64'), contentType: 'audio/mpeg' },
      { audio: WAV.toString('base64'), contentType: 'audio/wav', language: 'it' },
      { audio: 'not base64 at all!', contentType: 'audio/wav' },
      { audio: Buffer.alloc(5 * 1024 * 1024 + 3).toString('base64'), contentType: 'audio/wav' }
    ];
    for (const body of bodies) {
      const res = await send(app, 'POST', '/voice/transcribe', { cookie: ownerCookie }, body);
      expect(res.status).toBe(400);
    }
    expect(fake.heard.length).toBe(before);
  });
});

describe('who may speak and transcribe', () => {
  it('a guest is refused both with 403 guest_forbidden', async () => {
    const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [workspaceId, guestUserId]
    );
    const signIn = await send(
      app,
      'POST',
      '/auth/sign-in/email',
      {},
      { email: GUEST.email, password: GUEST.password }
    );
    const guest = { cookie: extractCookie(signIn) };
    const before = fake.spoken.length + fake.heard.length;
    const speak = await send(app, 'POST', '/voice/speak', guest, { text: 'Bonjour' });
    const transcribe = await send(app, 'POST', '/voice/transcribe', guest, {
      audio: WAV.toString('base64'),
      contentType: 'audio/wav'
    });
    for (const res of [speak, transcribe]) {
      expect(res.status).toBe(403);
      expect((await readJson(res)).error.code).toBe('guest_forbidden');
    }
    expect(fake.spoken.length + fake.heard.length).toBe(before);
  });

  it('a read key is refused (insufficient_scope), a write key speaks, the anonymous caller is 401', async () => {
    const read = await mintKey(['items:read']);
    const write = await mintKey(['items:read', 'items:write']);
    const refused = await send(app, 'POST', '/voice/speak', read, { text: 'Bonjour' });
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error.code).toBe('insufficient_scope');
    expect((await send(app, 'POST', '/voice/speak', write, { text: 'Bonjour' })).status).toBe(200);
    expect((await send(app, 'POST', '/voice/speak', {}, { text: 'Bonjour' })).status).toBe(401);
  });
});

describe('the MCP voice tools re-enter the voice routes', () => {
  let rpcId = 0;
  async function callTool(key: string, name: string, args: Record<string, unknown>) {
    const res = await app.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': `10.73.0.${(ip++ % 250) + 1}`,
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.error).toBeUndefined();
    return body.result as { isError?: boolean; content: Array<Record<string, string>> };
  }

  it('voice_speak answers the type and size line and the audio block; voice_transcribe the text; a read key is refused', async () => {
    fake.fail = null;
    const write = (await mintKey(['items:read', 'items:write'])).authorization!.slice('Bearer '.length);
    const read = (await mintKey(['items:read'])).authorization!.slice('Bearer '.length);

    const spoken = await callTool(write, 'starter_voice_speak', { text: 'Bonjour' });
    expect(spoken.isError).not.toBe(true);
    expect(spoken.content).toEqual([
      { type: 'text', text: `audio/wav, ${WAV.length} bytes` },
      { type: 'audio', data: WAV.toString('base64'), mimeType: 'audio/wav' }
    ]);

    const heard = await callTool(write, 'starter_voice_transcribe', {
      audio: WAV.toString('base64'),
      language: 'en'
    });
    expect(heard.isError).not.toBe(true);
    expect(JSON.parse(heard.content[0]!.text!)).toEqual({ text: 'Bonjour. Ceci est un test' });
    expect(fake.heard.at(-1)!.language).toBe('en');

    const before = fake.spoken.length;
    const refused = await callTool(read, 'starter_voice_speak', { text: 'Bonjour' });
    expect(refused.isError).toBe(true);
    expect(fake.spoken.length).toBe(before);
  });

  it('a 503 reaches the agent as an error sentence naming the key', async () => {
    const res = await send(
      bare,
      'POST',
      '/api-keys',
      { cookie: bareCookie },
      { name: 'rw', scopes: ['items:read', 'items:write'] }
    );
    const key = (await readJson(res)).key as string;
    const r = await bare.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': '10.74.0.1',
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'starter_voice_speak', arguments: { text: 'Bonjour' } }
      })
    });
    const result = (await readJson(r)).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GRADIUM_API_KEY');
  });
});
