import { describe, expect, it } from 'vitest';
import { WAV_HEADER_BYTES, downsample, encodeWav, fromBase64, mergeChunks, toBase64 } from './wav';

const text = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

describe('encodeWav', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const wav = encodeWav(samples, 16000);
  const view = new DataView(wav.buffer);

  it('writes the RIFF / WAVE / fmt / data header', () => {
    expect(text(wav, 0, 4)).toBe('RIFF');
    expect(text(wav, 8, 12)).toBe('WAVE');
    expect(text(wav, 12, 16)).toBe('fmt ');
    expect(text(wav, 36, 40)).toBe('data');
  });

  it('says 16-bit PCM, mono, at the sample rate', () => {
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('is 44 bytes plus two per sample, and the sizes say so', () => {
    expect(wav.length).toBe(WAV_HEADER_BYTES + samples.length * 2);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('writes the samples little endian, clipped to the 16-bit range', () => {
    const at = (i: number) => view.getInt16(WAV_HEADER_BYTES + i * 2, true);
    expect([at(0), at(1), at(2), at(3), at(4), at(5), at(6)]).toEqual([
      0, 16384, -16384, 32767, -32768, 32767, -32768
    ]);
  });

  it('keeps another sample rate', () => {
    const v = new DataView(encodeWav(new Float32Array(1), 48000).buffer);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000);
  });
});

describe('mergeChunks and base64', () => {
  it('merges the chunks in order', () => {
    expect([...mergeChunks([new Float32Array([1, 2]), new Float32Array([3])])]).toEqual([1, 2, 3]);
  });

  it('round-trips bytes through base64, a long buffer included', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const encoded = toBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect([...fromBase64(encoded)]).toEqual([...bytes]);
  });
});

describe('downsample', () => {
  it('averages each window: 48 kHz to 16 kHz is a third of the samples', () => {
    const out = downsample(new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6]), 48000, 16000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(-0.6);
  });

  it('keeps a rate already at or below the target', () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(downsample(samples, 16000, 16000)).toBe(samples);
  });
});
