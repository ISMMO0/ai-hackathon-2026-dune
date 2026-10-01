import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { cli, saveConfig } from '../src/cli.js';
import { routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * `speak` and `transcribe` through the routed harness: a fake instance
 * answering the two voice routes. Pinned: the request, the file written, the
 * human and `--json` outputs, the refusals sent with no request.
 */

const URL = 'http://x';
const KEY = `${cli.identity.keyPrefix}_k_secret`;
const WAV = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt fake', 'latin1');

const routes: Route[] = [
  {
    method: 'POST',
    path: /^\/api\/v1\/voice\/speak$/,
    reply: () => ({ body: { audio: WAV.toString('base64'), contentType: 'audio/wav' } })
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/voice\/transcribe$/,
    reply: () => ({ body: { text: 'Bonjour. Ceci est un test' } })
  }
];

async function harness(extra: Route[] = []) {
  const env = await tempConfigEnv();
  saveConfig(env, { activeProfile: 'work', profiles: { work: { apiKey: KEY, baseUrl: URL } } });
  return routedHarness([...extra, ...routes], env);
}

const tempDir = () => mkdtemp(join(tmpdir(), 'starter-voice-'));

describe('speak', () => {
  it('POSTs the text, writes the wav to --out and prints its path', async () => {
    const h = await harness();
    const out = join(await tempDir(), 'hello.wav');
    expect(await run(['speak', 'Bonjour', '-o', out], h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/v1/voice/speak', body: { text: 'Bonjour' } }]);
    expect(await readFile(out)).toEqual(WAV);
    expect((await stat(out)).mode & 0o777).toBe(0o644);
    expect(h.out()).toBe(`${out}\n`);
    expect(h.err()).toBe('');
  });

  it('--json prints the wire shape and writes nothing', async () => {
    const h = await harness();
    expect(await run(['speak', 'Bonjour', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ audio: WAV.toString('base64'), contentType: 'audio/wav' });
  });

  it('refuses to write through a symlink at the target', async () => {
    const dir = await tempDir();
    const target = join(dir, 'elsewhere.txt');
    await writeFile(target, 'keep me');
    const link = join(dir, 'speech.wav');
    await symlink(target, link);
    const h = await harness();
    expect(await run(['speak', 'Bonjour', '-o', link], h.io)).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('keep me');
  });

  it('an empty text is refused before any request', async () => {
    const h = await harness();
    expect(await run(['speak', '  '], h.io)).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('the 503 of an instance without the key ends on the sentence that names it', async () => {
    const h = await harness([
      {
        method: 'POST',
        path: /^\/api\/v1\/voice\/speak$/,
        reply: () => ({
          status: 503,
          body: {
            error: {
              code: 'integration_not_configured',
              message:
                'Gradium is not configured: set GRADIUM_API_KEY in the .env file and restart the server',
              details: { integration: 'gradium', envKey: 'GRADIUM_API_KEY' }
            }
          }
        })
      }
    ]);
    expect(await run(['speak', 'Bonjour'], h.io)).toBe(1);
    expect(h.err()).toContain('GRADIUM_API_KEY');
  });
});

describe('transcribe', () => {
  it('sends the file base64 encoded with the language, and prints the text', async () => {
    const dir = await tempDir();
    const file = join(dir, 'speech.wav');
    await writeFile(file, WAV);
    const h = await harness();
    expect(await run(['transcribe', file, '--language', 'fr'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/voice/transcribe',
        body: { audio: WAV.toString('base64'), contentType: 'audio/wav', language: 'fr' }
      }
    ]);
    expect(h.out()).toBe('Bonjour. Ceci est un test\n');
  });

  it('--json prints the wire shape; no --language sends none', async () => {
    const dir = await tempDir();
    const file = join(dir, 'speech.wav');
    await writeFile(file, WAV);
    const h = await harness();
    expect(await run(['transcribe', file, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ text: 'Bonjour. Ceci est un test' });
    expect(h.calls[0]!.body).toEqual({ audio: WAV.toString('base64'), contentType: 'audio/wav' });
  });

  it('refuses a missing file and an unknown language before any request', async () => {
    const h = await harness();
    expect(await run(['transcribe', '/nonexistent/speech.wav'], h.io)).not.toBe(0);
    const dir = await tempDir();
    const file = join(dir, 'speech.wav');
    await writeFile(file, WAV);
    expect(await run(['transcribe', file, '--language', 'it'], h.io)).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('an empty transcript: the sentence on stderr, nothing on stdout, exit 0; --json keeps the wire shape', async () => {
    const dir = await tempDir();
    const file = join(dir, 'speech.wav');
    await writeFile(file, WAV);
    const empty: Route[] = [
      { method: 'POST', path: /^\/api\/v1\/voice\/transcribe$/, reply: () => ({ body: { text: '' } }) }
    ];
    const h = await harness(empty);
    expect(await run(['transcribe', file], h.io)).toBe(0);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('Nothing was heard in the recording.\n');
    const j = await harness(empty);
    expect(await run(['transcribe', file, '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toEqual({ text: '' });
    expect(j.err()).toBe('');
  });

  it('prints a transcript full of terminal control characters clean', async () => {
    const dir = await tempDir();
    const file = join(dir, 'speech.wav');
    await writeFile(file, WAV);
    const h = await harness([
      {
        method: 'POST',
        path: /^\/api\/v1\/voice\/transcribe$/,
        reply: () => ({ body: { text: 'hello\u001b[31m red\u0007' } })
      }
    ]);
    expect(await run(['transcribe', file], h.io)).toBe(0);
    expect(h.out()).not.toContain('\u001b');
    expect(h.out()).not.toContain('\u0007');
  });
});
