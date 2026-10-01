import { describe, expect, it } from 'vitest';
import { tint } from './tint';

const joined = (code: string, language: 'html' | 'shell' | 'text') =>
  tint(code, language)
    .map((p) => p.text)
    .join('');

describe('code tinting never changes the code', () => {
  // Two snippets of the kind a page hands out to be pasted: a script with its mount, an iframe.
  const url = `https://app.example.com/v/${'a'.repeat(64)}/`;
  const snippets = {
    script: `<script src="https://app.example.com/embed.js" async></script>\n<div data-embed="${url}"></div>`,
    iframe: `<iframe src="${url}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" allow="fullscreen" style="width:100%;aspect-ratio:16/9;border:0"></iframe>`
  };

  it('gives back a pasted snippet byte for byte', () => {
    expect(joined(snippets.script, 'html')).toBe(snippets.script);
    expect(joined(snippets.iframe, 'html')).toBe(snippets.iframe);
  });

  it('survives what is not well formed', () => {
    for (const code of ['<', '<<a b="c', 'a < b > c', "<div data-x='1' hidden/>text</div", '', '"<>"']) {
      expect(joined(code, 'html')).toBe(code);
    }
  });

  it('names the pieces of a tag', () => {
    expect(tint('<a href="x">hi</a>', 'html')).toEqual([
      { kind: 'punct', text: '<' },
      { kind: 'tag', text: 'a' },
      { kind: 'plain', text: ' ' },
      { kind: 'attr', text: 'href' },
      { kind: 'punct', text: '=' },
      { kind: 'value', text: '"x"' },
      { kind: 'punct', text: '>' },
      { kind: 'plain', text: 'hi' },
      { kind: 'punct', text: '</' },
      { kind: 'tag', text: 'a' },
      { kind: 'punct', text: '>' }
    ]);
  });

  it('tints a command: the binary, then its flags', () => {
    const code = 'starter login --api-url https://x --api-key ytk_…\nstarter files upload ./notes.txt';
    expect(joined(code, 'shell')).toBe(code);
    const kinds = tint('starter files upload --force ./notes.txt', 'shell').filter((p) => p.kind !== 'plain');
    expect(kinds).toEqual([
      { kind: 'tag', text: 'starter' },
      { kind: 'flag', text: '--force' }
    ]);
  });
});
