#!/usr/bin/env node
// The chassis packages are COPIES. `packages/chassis-*` is the same source as
// the repository named in `chassis-source.json`, carried as folders until the
// packages are published, and never edited here: a change the tool needs
// inside one of them is a chassis change, made at the source and copied again.
//
//   node scripts/check-chassis-copies.mjs          fails when a copy differs from the manifest
//   node scripts/check-chassis-copies.mjs --write --repo <owner/name> --sha <sha>
//                                                  records a fresh copy (run right after copying)
//
// The manifest holds one sha256 per file. The file list comes from git (tracked
// plus untracked-and-not-ignored), so build output never counts and a file
// ADDED to a copy is caught like a file changed or removed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'chassis-source.json');
const PATHSPEC = 'packages/chassis-*';

function listFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', PATHSPEC],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  );
  // A tracked file deleted from disk is still listed by --cached: it is reported as missing below.
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

function hashFiles() {
  const files = {};
  for (const file of listFiles()) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    files[file] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  return files;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv.includes('--write')) {
  const repo = arg('--repo');
  const sha = arg('--sha');
  if (!repo || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
    console.error(
      'usage: check-chassis-copies.mjs --write --repo <owner/name> --sha <full 40-character sha>'
    );
    process.exit(2);
  }
  const files = hashFiles();
  writeFileSync(manifestPath, JSON.stringify({ source: { repo, sha }, files }, null, 2) + '\n');
  console.log(`chassis-source.json: ${Object.keys(files).length} files recorded from ${repo}@${sha}`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error('chassis-source.json is missing: the chassis copies have no recorded source.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const actual = hashFiles();
const problems = [];
for (const [file, hash] of Object.entries(manifest.files)) {
  if (!(file in actual)) problems.push(`missing   ${file}`);
  else if (actual[file] !== hash) problems.push(`changed   ${file}`);
}
for (const file of Object.keys(actual)) {
  if (!(file in manifest.files)) problems.push(`added     ${file}`);
}

const { repo, sha } = manifest.source;
if (problems.length > 0) {
  console.error(`The chassis copies differ from ${repo}@${sha}:`);
  for (const line of problems) console.error(`  ${line}`);
  console.error(
    '\npackages/chassis-* is never edited here. Make the change in the chassis source, copy the folders\n' +
      'again, then record the copy: node scripts/check-chassis-copies.mjs --write --repo <owner/name> --sha <sha>'
  );
  process.exit(1);
}
console.log(`chassis copies: ${Object.keys(actual).length} files identical to ${repo}@${sha}`);
