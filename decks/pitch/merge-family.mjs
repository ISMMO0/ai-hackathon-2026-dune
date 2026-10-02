#!/usr/bin/env node
// Puts the family discovery scene (decks/pitch/family/) on the problem slide of the filled pitch deck.
// Run after every fill.mjs, which rewrites deck/index.html:  node decks/pitch/merge-family.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const deck = path.join(HERE, 'deck');
const file = path.join(deck, 'index.html');
let html = fs.readFileSync(file, 'utf8');
// Undo an earlier merge, so the script can run again after a change.
html = html
  .replace(/<style id="fam-style">[\s\S]*?<\/style>\n?/, '')
  .replace(/<script id="fam-script">[\s\S]*?<\/script>\n?/, '')
  .replace(/<figure class="fam-scene">[\s\S]*?<\/figure>/, '<canvas class="fig" data-fig="interference"></canvas>')
  .replace(' has-family', '');

for (const f of ['scene.jpg', 'clip-0.mp3', 'clip-1.mp3', 'clip-2.mp3']) {
  fs.copyFileSync(path.join(HERE, 'family', f), path.join(deck, 'assets', `family-${f}`));
}

// The hotspots sit on the drawn speech bubbles (percent of the picture).
const spots = [
  { clip: 0, who: 'Andy', style: 'left:10%;top:16%;width:26.5%;height:15.5%' },
  { clip: 1, who: 'Lisa', style: 'left:69.5%;top:11.5%;width:28%;height:17%' },
  { clip: 2, who: 'Andy', style: 'left:9%;top:51%;width:26%;height:14.5%' }
];
const scene =
  `<figure class="fam-scene"><img src="assets/family-scene.jpg" alt="Andy tells his mother Lisa he wants to go to Mars" decoding="async">` +
  spots
    .map((s) => `<button type="button" class="fam-spot" data-clip="${s.clip}" style="${s.style}"><b>${s.who}</b><span>Click to play</span></button>`)
    .join('') +
  spots.map((s) => `<audio data-clip="${s.clip}" preload="auto" src="assets/family-clip-${s.clip}.mp3"></audio>`).join('') +
  `<button type="button" class="fam-all">▶ Play the conversation · 14 s</button></figure>`;

const before = html;
html = html.replace(
  /(<section class="slide s-big)("[^>]*>)<canvas class="fig" data-fig="interference"><\/canvas>/,
  (_, a, b) => `${a} has-family${b}${scene}`
);
if (html === before) {
  console.error('problem slide not found: run fill.mjs first');
  process.exit(1);
}

const style = `<style id="fam-style">
.as-deck .s-big.has-family .stack { width: 470px; }
.as-deck .s-big.has-family h2 { font-size: 46px; max-width: none; }
.as-deck .s-big.has-family p { font-size: 24px; }
.fam-scene { position: absolute; left: 640px; right: 80px; top: 50%; transform: translateY(-50%); margin: 0; aspect-ratio: 1672 / 941; }
.fam-scene img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 10px; box-shadow: 0 1px 0 rgba(0,0,0,.06), 0 18px 40px -20px rgba(0,0,0,.25); }
.fam-spot { position: absolute; border: 0; background: transparent; border-radius: 14px; padding: 0 0 0 6.5%; cursor: pointer; color: #181614; text-align: left; font: inherit; display: flex; flex-direction: row; align-items: center; gap: 10px; white-space: nowrap; pointer-events: auto; }
.fam-spot b { font-size: 22px; font-weight: 600; }
.fam-spot span { font-size: 14px; color: #63615f; }
.fam-spot:hover { background: rgba(24,22,20,.05); }
.fam-spot:focus-visible, .fam-all:focus-visible { outline: 3px solid #181614; outline-offset: 2px; }
.fam-spot.playing { background: rgba(233,201,141,.35); }
.fam-all { position: absolute; right: 0; bottom: -58px; font: inherit; font-size: 16px; background: #181614; color: #f0efea; border: 0; border-radius: 6px; padding: 10px 16px; cursor: pointer; pointer-events: auto; }
</style>`;

const script = `<script id="fam-script">
(() => {
  const slide = document.querySelector('#stage .has-family');
  if (!slide) return;
  const clip = (n) => slide.querySelector('audio[data-clip="' + n + '"]');
  const spot = (n) => slide.querySelector('.fam-spot[data-clip="' + n + '"]');
  let queue = [];
  const stop = () => {
    queue = [];
    slide.querySelectorAll('audio').forEach((a) => { a.pause(); a.currentTime = 0; });
    slide.querySelectorAll('.fam-spot').forEach((b) => b.classList.remove('playing'));
  };
  const play = (n, rest) => {
    stop();
    queue = rest || [];
    const a = clip(n);
    spot(n).classList.add('playing');
    a.onended = () => {
      spot(n).classList.remove('playing');
      if (queue.length) play(queue[0], queue.slice(1));
    };
    a.play().catch(() => {});
  };
  slide.querySelectorAll('.fam-spot').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const n = b.dataset.clip;
    if (!clip(n).paused) stop(); else play(n);
  }));
  slide.querySelector('.fam-all').addEventListener('click', (e) => { e.stopPropagation(); play('0', ['1', '2']); });
  new MutationObserver(() => { if (!slide.classList.contains('is-current')) stop(); })
    .observe(slide, { attributes: true, attributeFilter: ['class'] });
})();
</script>`;

html = html.replace('</head>', `${style}\n</head>`).replace(/<\/body>(?![\s\S]*<\/body>)/, `${script}\n</body>`);
fs.writeFileSync(file, html);
console.log('merged the family scene into the problem slide');
