#!/usr/bin/env node
// The dashboard shell is a COPY. `apps/dashboard/src/**`, outside the tool's own
// half, is Slideless's dashboard shell with the identity words changed, and it is
// never edited here: a change the tool needs in the shell is made in Slideless's
// dashboard shell and copied again.
//
//   node scripts/check-shell-copies.mjs          fails when a shell file differs from the record
//   node scripts/check-shell-copies.mjs --write --repo <owner/name> --sha <sha> [--source <dir>]
//                                                records a fresh copy (run right after copying)
//   node scripts/check-shell-copies.mjs --diff --source <dir>
//                                                compares the shell with a source checkout, file by file
//
// The shell cannot be held byte for byte like the chassis: its identity words are
// the tool's own, the instantiate script rewrites them in every tool born from the
// template, and the formatter that runs after it may reflow a line. So the record
// holds one sha256 per file of a NORMALISED form: the comments stripped, the
// identity words replaced by placeholders, every run of white space collapsed.
// The tool's half is left out, read from TOOL_PATHS in the shell's own boundary test.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.SHELL_GUARD_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = join(root, 'shell-source.json');
const SHELL = 'apps/dashboard/src/';
const BOUNDARY = 'apps/dashboard/src/lib/boundary.test.ts';
const IDENTITY_FILE = 'packages/contract/src/identity.ts';
// What the source spells where the template spells something else that is not
// identity. Applied to the SOURCE side only, before its identity is normalised.
const DEFAULT_REWRITE = { '@slideless/': '@app/', 'presentations:': 'items:', '/decks': '/items' };
const NORMALIZATION =
  'comments stripped, identity words replaced, whitespace collapsed and dropped beside brackets and separators (scripts/check-shell-copies.mjs)';

function fail(message) {
  console.error(message);
  process.exit(2);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The tool paths, as the boundary test states them. The guard never keeps a second list.
export function toolPaths(dir = root) {
  const file = join(dir, BOUNDARY);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const list = /const TOOL_PATHS\s*=\s*\[([^\]]*)\]/.exec(text)?.[1];
  const paths = list ? [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];
  if (paths.length === 0) fail(`cannot read TOOL_PATHS from ${BOUNDARY} in ${dir}`);
  return paths;
}

export function readIdentity(dir = root) {
  const file = join(dir, IDENTITY_FILE);
  if (!existsSync(file)) fail(`cannot read the identity: ${IDENTITY_FILE} is missing in ${dir}`);
  const text = readFileSync(file, 'utf8');
  const field = (name) => new RegExp(`\\b${name}:\\s*['"]([^'"]+)['"]`).exec(text)?.[1];
  const identity = {
    slug: field('slug'),
    displayName: field('displayName'),
    apiKeyPrefix: field('apiKeyPrefix'),
    resource: field('read')?.split(':')[0]
  };
  for (const [key, value] of Object.entries(identity)) {
    if (!value) fail(`cannot read the identity: no ${key} in ${join(dir, IDENTITY_FILE)}`);
  }
  return identity;
}

// The shell files, from git (tracked plus untracked-and-not-ignored), minus the tool's half.
export function listFiles(dir = root) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `${SHELL}**`],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const tool = toolPaths(dir);
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((file) => !tool.some((p) => file.slice(SHELL.length).startsWith(p)))
    .sort();
}

// ONE pass, first match wins, as `rewrite` in scripts/instantiate.mjs does.
function replaceAll(text, rules) {
  const pattern = new RegExp(rules.map(([source], i) => `(?<r${i}>${source})`).join('|'), 'g');
  return text.replace(pattern, (...match) => {
    const groups = match.at(-1);
    return rules[rules.findIndex((_, i) => groups[`r${i}`] !== undefined)][1];
  });
}

// Block comments, found by a scanner that knows strings: a `/*` inside a quoted
// string (a glob like '**/*.ts') is not a comment, and a backslash escapes the next
// character, so `\/\*` in a regular expression literal is not one either. A quote
// that is not closed on its line (an apostrophe in markup) ends at the line's end,
// and a comment it hides is kept, which can only make the guard stricter. The rest
// of a line after `//` is copied as it stands, so a quote in a line comment opens nothing.
function stripBlockComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      out += c + (text[i + 1] ?? '');
      i++;
    } else if (quote) {
      out += c;
      if (c === quote || (c === '\n' && quote !== '`')) quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      out += c;
      quote = c;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      out += text.slice(i, end === -1 ? text.length : end);
      i = (end === -1 ? text.length : end) - 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}

export function normalize(text, identity) {
  const { slug, displayName, apiKeyPrefix, resource } = identity;
  const stripped = stripBlockComments(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Whole-line `//` comments only: a trailing `//` after code may be a URL.
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const Slug = slug.charAt(0).toUpperCase() + slug.slice(1);
  const words = replaceAll(stripped, [
    [displayName.split(/\s+/).map(escapeRegExp).join('\\s+'), '§NAME§'],
    [escapeRegExp(slug.toUpperCase()), '§SLUG§'],
    // One placeholder with the display name: the instantiate script writes a standalone
    // capitalised slug as the display name, and a tool's display name is often exactly that.
    [escapeRegExp(Slug), '§NAME§'],
    [escapeRegExp(slug), '§slug§'],
    [`${escapeRegExp(apiKeyPrefix)}_`, '§key§_'],
    [`${escapeRegExp(resource)}:`, '§res§:']
  ]);
  // A formatter that joins or breaks a line moves white space next to a bracket or a
  // separator (`.filter(\n  (p) =>` against `.filter((p) =>`), so that space is dropped.
  return words
    .replace(/\s+/g, ' ')
    .replace(/ ?([()[\]{},;<>]) ?/g, '$1')
    .trim();
}

function hash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashFiles(dir, files, identity, rewrite) {
  const hashes = {};
  for (const file of files) {
    const abs = join(dir, file);
    if (!existsSync(abs)) continue;
    let text = readFileSync(abs, 'utf8');
    if (rewrite)
      text = replaceAll(
        text,
        Object.entries(rewrite).map(([a, b]) => [escapeRegExp(a), b])
      );
    hashes[file] = hash(normalize(text, identity));
  }
  return hashes;
}

// The source's hashes for the template's own files. The rewrite has already turned
// the source's resource word into the template's, so the template's resource is the one to replace.
function sourceHashes(dir, files, rewrite) {
  const identity = { ...readIdentity(dir), resource: readIdentity(root).resource };
  return hashFiles(dir, files, identity, rewrite);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const identity = readIdentity();
  const files = listFiles();
  const ours = hashFiles(root, files, identity);

  if (process.argv.includes('--write')) {
    const repo = arg('--repo');
    const sha = arg('--sha');
    const source = arg('--source');
    if (!repo || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
      fail(
        'usage: check-shell-copies.mjs --write --repo <owner/name> --sha <full 40-character sha> [--source <dir>]'
      );
    }
    let differs = [];
    if (source) {
      const theirs = sourceHashes(resolve(source), Object.keys(ours), DEFAULT_REWRITE);
      differs = Object.keys(ours).filter((file) => theirs[file] !== ours[file]);
    }
    const record = {
      source: { repo, sha, rewrite: DEFAULT_REWRITE },
      normalization: NORMALIZATION,
      differs,
      files: Object.fromEntries(
        Object.keys(ours)
          .sort()
          .map((f) => [f, ours[f]])
      )
    };
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    console.log(
      `shell-source.json: ${Object.keys(ours).length} files recorded from ${repo}@${sha}, ${differs.length} differing from the source`
    );
    return 0;
  }

  if (process.argv.includes('--diff')) {
    const source = arg('--source');
    if (!source) fail('usage: check-shell-copies.mjs --diff --source <dir>');
    const dir = resolve(source);
    const rewrite = existsSync(recordPath)
      ? (JSON.parse(readFileSync(recordPath, 'utf8')).source?.rewrite ?? DEFAULT_REWRITE)
      : DEFAULT_REWRITE;
    const theirs = sourceHashes(dir, Object.keys(ours), rewrite);
    const counts = { same: 0, differs: 0, 'only here': 0, 'only there': 0 };
    for (const file of Object.keys(ours)) {
      const verdict = !(file in theirs) ? 'only here' : theirs[file] === ours[file] ? 'same' : 'differs';
      counts[verdict] += 1;
      console.log(`${verdict.padEnd(10)} ${file}`);
    }
    for (const file of listFiles(dir)) {
      if (file in ours) continue;
      counts['only there'] += 1;
      console.log(`only there ${file}`);
    }
    console.log(
      `\n${counts.same} same, ${counts.differs} differs, ${counts['only here']} only here, ${counts['only there']} only there`
    );
    return 0;
  }

  if (!existsSync(recordPath)) {
    console.error('shell-source.json is missing: the dashboard shell has no recorded source.');
    return 1;
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const problems = [];
  for (const [file, h] of Object.entries(record.files)) {
    if (!(file in ours)) problems.push(`missing   ${file}`);
    else if (ours[file] !== h) problems.push(`changed   ${file}`);
  }
  for (const file of Object.keys(ours)) {
    if (!(file in record.files)) problems.push(`added     ${file}`);
  }
  const { repo, sha } = record.source;
  if (problems.length > 0) {
    console.error(`The dashboard shell differs from ${repo}@${sha} after normalisation:`);
    for (const line of problems) console.error(`  ${line}`);
    console.error(
      "\nThe dashboard shell is never edited here. Make the change in Slideless's dashboard shell, copy it\n" +
        'again, then record the copy: node scripts/check-shell-copies.mjs --write --repo antasphere/slideless --sha <sha> [--source <slideless checkout>]'
    );
    return 1;
  }
  console.log(`dashboard shell: ${Object.keys(ours).length} files match ${repo}@${sha} after normalisation`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
