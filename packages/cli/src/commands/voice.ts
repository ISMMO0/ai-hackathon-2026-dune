import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { VOICE_AUDIO_MAX_BYTES, VOICE_LANGUAGES, VOICE_TEXT_MAX, type VoiceLanguage } from '@app/contract';
import { CliUsageError, printJson, writeNoFollow, type CliIo } from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext } from '../cli.js';

/**
 * The voice, two top-level commands over Gradium (through the instance):
 *
 *  - `speak <text> [-o out.wav]` writes the wav and prints its path (default
 *    `speech.wav`). The path is the user's own choice, written through the
 *    kit's `writeNoFollow` (never through a symlink, mode 0644).
 *  - `transcribe <file.wav> [--language en|fr|de|es|pt|any]` prints the
 *    transcript. Without a language, Gradium detects it (`any`).
 *    An empty transcript prints NOTHING_HEARD to stderr, nothing on stdout,
 *    and exits 0.
 *
 * `--json` prints the wire shape (`{ audio, contentType }`, `{ text }`).
 * A refusal the command can know alone (an empty text, a missing file, a
 * file over 5 MiB, an unknown language) is a usage error, no request sent.
 */
/** What `transcribe` says, on stderr, when the transcript is empty. */
export const NOTHING_HEARD = 'Nothing was heard in the recording.';

export function registerVoiceCommands(program: Command, io: CliIo): void {
  program
    .command('speak <text>')
    .description('Speak a text with Gradium and write the wav file')
    .option('-o, --out <path>', 'where to write the wav (defaults to speech.wav)')
    .action(async (text: string, opts: { out?: string }, cmd: Command) => {
      if (text.trim() === '') throw new CliUsageError('Nothing to say: pass a text.');
      if (text.length > VOICE_TEXT_MAX) {
        throw new CliUsageError(`The text is over ${VOICE_TEXT_MAX} characters.`);
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const speech = await ctx.client.speak(text);
      if (ctx.json) return printJson(io, speech);
      const out = resolve(opts.out ?? 'speech.wav');
      const bytes = Buffer.from(speech.audio, 'base64');
      await writeNoFollow(out, bytes);
      io.out.write(`${out}\n`);
    });

  program
    .command('transcribe <file>')
    .description('Transcribe a wav file with Gradium and print the text')
    .option(
      '--language <language>',
      `the language spoken (choices: ${VOICE_LANGUAGES.join(', ')}); without one, Gradium detects it (any)`
    )
    .action(async (file: string, opts: { language?: string }, cmd: Command) => {
      if (opts.language !== undefined && !(VOICE_LANGUAGES as readonly string[]).includes(opts.language)) {
        throw new CliUsageError(
          `Unknown language ${opts.language}: use one of ${VOICE_LANGUAGES.join(', ')}.`
        );
      }
      let wav: Buffer;
      try {
        wav = await readFile(file);
      } catch {
        throw new CliUsageError(`Cannot read ${file}.`);
      }
      if (wav.length === 0) throw new CliUsageError(`${file} is empty.`);
      if (wav.length > VOICE_AUDIO_MAX_BYTES) {
        throw new CliUsageError(`${file} is over ${VOICE_AUDIO_MAX_BYTES / (1024 * 1024)} MiB.`);
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const transcript = await ctx.client.transcribe({
        audio: wav.toString('base64'),
        contentType: 'audio/wav',
        ...(opts.language ? { language: opts.language as VoiceLanguage } : {})
      });
      if (ctx.json) return printJson(io, transcript);
      if (transcript.text.trim() === '') {
        io.err.write(`${NOTHING_HEARD}\n`);
        return;
      }
      io.out.write(`${transcript.text}\n`);
    });
}
