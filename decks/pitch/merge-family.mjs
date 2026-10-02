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
  .replace(' has-family', '')
  .replace(/<video class="demo-video"[^>]*><\/video>/,'<img src="assets/demo.jpg" alt="Live demo" decoding="async">')
  .replace(/<div class="biz">[\s\S]*?<!--\/biz--><\/div>/, '<canvas class="fig diagram" data-fig="bricks"></canvas>');

// What it costs: the business model (from the team's HTML pitch, slide 8) in place of the brick drawing.
const biz =
  `<div class="biz"><span class="over">Business model · illustrative</span>` +
  `<div class="biz-row"><span class="n">01</span><div><b>Direct-to-user app</b><em>€9.90 / child / month</em></div></div>` +
  `<div class="biz-row"><span class="n">02</span><div><b>Skill / API for AI agents</b><em>€0.05 / learning interaction</em></div></div>` +
  `<table><thead><tr><th>Revenue forecast · assumptions only</th><th>Year 1</th><th>Year 2</th><th>Year 3</th></tr></thead><tbody>` +
  `<tr><td>Paid app subscribers</td><td>1k</td><td>5k</td><td>15k</td></tr>` +
  `<tr><td>API interactions</td><td>0.2M</td><td>1M</td><td>5M</td></tr>` +
  `<tr class="tot"><td>Total revenue</td><td>€0.13M</td><td>€0.64M</td><td>€2.03M</td></tr></tbody></table><!--/biz--></div>`;
html = html.replace(/(class="slide s-date s-stake"[^>]*>[\s\S]*?)<canvas class="fig diagram" data-fig="bricks"><\/canvas>/, `$1${biz}`);

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

fs.copyFileSync(path.join(HERE, 'media', 'videodune.mp4'), path.join(deck, 'assets', 'demo-video.mp4'));
// The live demo slide: the team's recorded demo in place of the screenshot.
html = html.replace(
  /(data-cat="Live demo"><figure class="plate ">)<img src="assets\/demo.jpg" alt="Live demo" decoding="async">/,
  '$1<video class="demo-video" src="assets/demo-video.mp4#t=0.1" controls playsinline preload="auto"></video>'
);

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
.biz { position: absolute; left: 860px; right: 110px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 18px; background: rgba(255,255,255,.55); border: 1px solid rgba(24,22,20,.12); border-radius: 12px; padding: 30px 34px; }
.biz-row { display: flex; gap: 18px; align-items: baseline; }
.biz-row .n { font-size: 16px; letter-spacing: .1em; opacity: .55; }
.biz-row b { display: block; font-size: 24px; font-weight: 500; }
.biz-row em { display: block; font-style: italic; font-size: 30px; margin-top: 2px; }
.biz table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin-top: 6px; }
.biz th { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; font-weight: 400; opacity: .6; text-align: right; padding: 6px 8px; border-bottom: 1px solid rgba(24,22,20,.18); }
.biz th:first-child, .biz td:first-child { text-align: left; }
.biz td { font-size: 19px; text-align: right; padding: 8px; border-bottom: 1px solid rgba(24,22,20,.1); }
.biz tr.tot td { font-size: 21px; font-weight: 600; border-bottom: 0; }
.demo-video { display: block; width: 100%; height: 100%; object-fit: contain; background: #111; pointer-events: auto; }
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
  document.querySelectorAll('.demo-video').forEach((v) => {
    v.addEventListener('click', (e) => e.stopPropagation());
    const host = v.closest('.slide');
    new MutationObserver(() => { if (!host.classList.contains('is-current')) v.pause(); })
      .observe(host, { attributes: true, attributeFilter: ['class'] });
  });
  slide.querySelector('.fam-all').addEventListener('click', (e) => { e.stopPropagation(); play('0', ['1', '2']); });
  new MutationObserver(() => { if (!slide.classList.contains('is-current')) stop(); })
    .observe(slide, { attributes: true, attributeFilter: ['class'] });
})();
</script>`;

html = html.replace('</head>', `${style}\n</head>`).replace(/<\/body>(?![\s\S]*<\/body>)/, `${script}\n</body>`);
fs.writeFileSync(file, html);
console.log('merged the family scene into the problem slide');
