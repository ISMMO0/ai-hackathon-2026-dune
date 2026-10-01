#!/usr/bin/env node
// Make a tool out of this template: write the tool's name where no runtime can read it.
//
//   pnpm instantiate <slug> --name "<Display name>" [--domain <host>] [--cli-package <npm name>]
//                    [--dry-run] [--no-install]
//   node scripts/instantiate.mjs --current            prints the identity the tree carries today
//   node scripts/instantiate.mjs --survivors <slug>   lists the lines where <slug> still stands, exit 1 when any
//
// The script rewrites FROM the identity the repository carries today (read from the
// tree, never written here) TO the one asked for, so it works on the template whatever
// its own name is, and again on a tool already made (a rename). It is idempotent: asked
// for the identity the tree already has, it changes nothing. It refuses a dirty tree, it
// writes only the files of WRITES below (never through a symbolic link), and it prints
// every file it changed.
//
// A name must be a word the tree does not already use. The template's sample data says
// "Acme" and "Beta": a tool named acme could never be renamed, because a later run cannot
// tell `ORG_ACME` the sample from `acmeTool` the name. So a new slug or display name that
// already stands anywhere in the tracked tree, in any casing, is refused before anything is
// written, with the first places it stands. That makes a rename as safe as a first run.
//
// Everything the script may touch is in the four tables that follow. A name that appears
// in a file outside them fails `--survivors`, which is the point: either the file belongs
// in WRITES, or (better) the name should be read from the one identity definition.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Table 1: the files the script writes ──────────────────────────────────────────────
// Git pathspecs (glob magic), resolved against TRACKED files only. Every rule of RULES
// applies to every file matched. A row leaves this table the day its files read the
// identity definition instead of spelling the name. The workspace scope (`@app/*`) and the
// Postgres role and database (`app`) are generic in the template, so no row is about them.
export const WRITES = [
  {
    paths: ['package.json', 'apps/server/package.json', 'packages/cli/package.json'],
    why: 'the repository name, the published CLI package and its command'
  },
  {
    paths: ['apps/dashboard/**', 'apps/server/**', 'packages/cli/**'],
    why: 'the identity the tool half still spells: the product name in static pages, mails and tests, the CLI command, the env prefix'
  },
  {
    paths: ['packages/contract/src/**', 'packages/db/test/**'],
    why: 'comments and test samples that name the product'
  },
  {
    paths: ['Dockerfile', 'docker-compose*.yml', '.env.example', 'install.sh', 'update.sh'],
    why: 'the image reference and labels, the install path, the sender of dev mail'
  },
  { paths: ['deploy/**'], why: 'the self-hosting template and its static pages' },
  {
    paths: ['scripts/*.sh', 'scripts/*.mjs', 'scripts/lib/**'],
    why: 'operator scripts that run where no package file can be read'
  },
  {
    paths: ['.github/workflows/*.yml'],
    why: 'the image reference, the dispatch event type, the CLI package filter'
  },
  { paths: ['docs/**'], why: 'public pages: the CLI command name, the env prefix, the domain' },
  {
    paths: ['README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE'],
    why: 'root documents that name the product'
  }
];

// ── Table 2: the files the script never writes, whatever WRITES matches ───────────────
// A file here may keep the old name. `--survivors` skips exactly these and nothing else.
export const NEVER = [
  {
    paths: ['packages/chassis-*/**'],
    why: 'copies held byte for byte by scripts/check-chassis-copies.mjs. NOT harmless: some hold live values (the product name in mails, the MCP server name), which a tool keeps until the chassis source reads the identity; every run counts and reports them'
  },
  { paths: ['chassis-source.json'], why: 'records which repository the chassis copies came from' },
  { paths: ['pnpm-lock.yaml'], why: 'written again by pnpm install at the end of the run' },
  { paths: ['packages/db/drizzle/**'], why: 'applied migrations are history and are never edited' },
  { paths: ['LESSONS.md', 'TEMPLATE-FEEDBACK.md'], why: 'the record of what happened upstream, by name' },
  { paths: ['scripts/instantiate.mjs', 'scripts/instantiate.test.mjs'], why: 'this script and its tests' },
  { paths: ['plugin/**'], why: 'the skills name the first tool made this way as their worked example' }
];

// ── Table 3: what only the template carries, removed from a tool ──────────────────────
// Whole files, and blocks between a line holding TEMPLATE_ONLY_BEGIN and the next line
// holding TEMPLATE_ONLY_END (both lines included) in the files listed.
export const TEMPLATE_ONLY_FILES = ['docs/getting-started/make-a-tool.md'];
export const TEMPLATE_ONLY_BLOCKS = ['README.md', 'docs/nav.yml', '.github/workflows/ci.yml'];
export const TEMPLATE_ONLY_BEGIN = 'template-only:begin';
export const TEMPLATE_ONLY_END = 'template-only:end';

// ── Table 4: where the current identity is read from ──────────────────────────────────
// The definition wins when it exists (packages/contract/src/identity.ts, PRDCT-2531);
// until then the slug is the root package name and the display name the docs product.
export const IDENTITY_SOURCES = {
  definition: 'packages/contract/src/identity.ts',
  slug: { file: 'package.json', read: (text) => JSON.parse(text).name },
  displayName: { file: 'docs/nav.yml', read: (text) => /^product:\s*(.+?)\s*$/m.exec(text)?.[1] }
};

// What a run records, at the root of the tool: the identity it wrote. The domain and the CLI
// package cannot be read back from anywhere else, and a rename needs them.
export const STATE_FILE = '.instantiate.json';
export const CHASSIS_COPIES = 'packages/chassis-*/**';

// A slug is one lower-case word: it is also an env prefix (ACME_URL), a CLI command and a
// part of identifiers (acmeTool), and a hyphen is wrong in at least one of those.
const SLUG = /^[a-z][a-z0-9]{2,30}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NPM_NAME = /^(?=.{1,214}$)(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// Words the tree uses for other things: as a slug they would make a later rename rewrite half the code.
const RESERVED = [
  'tool',
  'tools',
  'app',
  'apps',
  'chassis',
  'hub',
  'antasphere',
  'platform',
  'server',
  'dashboard',
  'items',
  'item',
  'docs',
  'test',
  'tests',
  'api',
  'cli',
  'sdk',
  'mcp',
  'contract',
  'template'
];

const root = process.env.INSTANTIATE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tracked(paths) {
  const specs = paths.map((p) => `:(glob)${p}`);
  return git(['ls-files', '-z', '--', ...specs])
    .split('\0')
    .filter(Boolean);
}

export function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readCurrentIdentity() {
  const read = (source) => source.read(readFileSync(join(root, source.file), 'utf8'));
  const identity = { slug: read(IDENTITY_SOURCES.slug), displayName: read(IDENTITY_SOURCES.displayName) };
  const definition = join(root, IDENTITY_SOURCES.definition);
  if (existsSync(definition)) {
    const text = readFileSync(definition, 'utf8');
    const field = (name) => new RegExp(`\\b${name}:\\s*['"]([^'"]+)['"]`).exec(text)?.[1];
    identity.slug = field('slug') ?? identity.slug;
    identity.displayName = field('displayName') ?? identity.displayName;
  }
  // A tool already made recorded the two values the tree cannot give back, and its verdict on a rename.
  const state = join(root, STATE_FILE);
  if (existsSync(state)) {
    let recorded;
    try {
      recorded = JSON.parse(readFileSync(state, 'utf8'));
    } catch (error) {
      throw new Error(
        `${STATE_FILE} is not valid JSON (${error.message}): restore it from git, it is written by this script only`
      );
    }
    // Held to the same grammar as the flags: the file is tracked and a hand can edit it.
    if (recorded.domain !== undefined && !DOMAIN.test(recorded.domain))
      throw new Error(`${STATE_FILE}: "domain" is not a lower-case DNS hostname: restore the file from git`);
    if (recorded.cliPackage !== undefined && !NPM_NAME.test(recorded.cliPackage))
      throw new Error(`${STATE_FILE}: "cliPackage" is not an npm package name: restore the file from git`);
    identity.domain = recorded.domain;
    identity.cliPackage = recorded.cliPackage;
    // Whether the person CHOSE the value or the script derived it from the slug.
    // A value recorded WITHOUT its flag is read as chosen: keeping what somebody may have
    // chosen is the safe side, losing it silently is not.
    identity.domainGiven = recorded.domain !== undefined && recorded.domainGiven !== false;
    identity.cliPackageGiven = recorded.cliPackage !== undefined && recorded.cliPackageGiven !== false;
  }
  if (!identity.slug || !identity.displayName) {
    throw new Error(
      'cannot read the current identity: see IDENTITY_SOURCES at the top of scripts/instantiate.mjs'
    );
  }
  return identity;
}

// The rules, in the order that keeps a special value from being rewritten by the plain
// slug rule. Each is [pattern, replacement]; the patterns are built from the CURRENT identity.
export function buildRules(from, to) {
  const slug = escapeRegExp(from.slug);
  const Slug = escapeRegExp(capitalize(from.slug));
  const SLUG_UPPER = escapeRegExp(from.slug.toUpperCase());
  const rules = [
    // A digest-pinned image belongs to a release of the previous name: the new tool has none
    // yet. `:unreleased` is the one unpinned form the self-hosting template accepts, and its
    // test refuses anything else (`:latest` included) until a release pins a digest.
    [
      `ghcr\\.io/antasphere/${slug}:[0-9][^@\\s'"]*@sha256:[a-f0-9]{64}`,
      `ghcr.io/antasphere/${to.slug}:unreleased`
    ],
    [escapeRegExp(from.domain ?? `${from.slug}.antasphere.com`), to.domain],
    [`${escapeRegExp(from.cliPackage ?? `@antasphere/${from.slug}`)}(?![a-z0-9-])`, to.cliPackage]
  ];
  // The display name, when it is more than the capitalised slug (a tool already made).
  // A formatter may have put a line break between its words, so any white space matches.
  if (from.displayName !== capitalize(from.slug)) {
    rules.push([from.displayName.split(/\s+/).map(escapeRegExp).join('\\s+'), to.displayName]);
  }
  rules.push(
    [SLUG_UPPER, to.slug.toUpperCase()],
    // Inside an identifier the capitalised word stays one word; on its own it is the display name.
    [`${Slug}(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])${Slug}`, capitalize(to.slug)],
    [Slug, to.displayName],
    [slug, to.slug]
  );
  return rules;
}

// ONE pass over the text: at each position the first rule that matches wins, so a special
// value (the domain, the display name taken whole) is never cut up by the plain slug rule.
// The replacement is a function, so a `$&` or `$1` in a name is written as it is.
export function rewrite(text, rules) {
  const pattern = new RegExp(rules.map(([source], i) => `(?<r${i}>${source})`).join('|'), 'g');
  return text.replace(pattern, (...match) => {
    const groups = match.at(-1);
    const hit = rules.findIndex((_, i) => groups[`r${i}`] !== undefined);
    return rules[hit][1];
  });
}

export function stripTemplateOnly(text) {
  const lines = text.split('\n');
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.includes(TEMPLATE_ONLY_BEGIN)) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line.includes(TEMPLATE_ONLY_END)) inside = false;
      continue;
    }
    kept.push(line);
  }
  if (inside) throw new Error(`a ${TEMPLATE_ONLY_BEGIN} line has no ${TEMPLATE_ONLY_END} line after it`);
  return kept.join('\n');
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function parseArgs(argv) {
  const args = { positional: [] };
  const valued = ['--name', '--domain', '--cli-package', '--survivors'];
  const flags = ['--dry-run', '--no-install', '--current'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      args[a] = argv[++i];
    } else if (flags.includes(a)) args[a] = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else args.positional.push(a);
  }
  return args;
}

const USAGE =
  'usage: pnpm instantiate <slug> --name "<Display name>" [--domain <host>] [--cli-package <npm name>] [--dry-run] [--no-install]';

// Where a word already stands in what the tool will keep: every tracked text file outside
// NEVER, without the template-only files and blocks (they leave with the run).
function standing(pattern) {
  const never = new Set(tracked(NEVER.flatMap((row) => row.paths)));
  const hits = [];
  for (const file of tracked(['**'])) {
    if (never.has(file) || TEMPLATE_ONLY_FILES.includes(file) || file === STATE_FILE) continue;
    const abs = join(root, file);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
    const buffer = readFileSync(abs);
    if (isBinary(buffer)) continue;
    let text = buffer.toString('utf8');
    if (TEMPLATE_ONLY_BLOCKS.includes(file)) text = stripTemplateOnly(text);
    // Over the whole text, not line by line: the rewrite matches a display name across a
    // line break, so the check must see it there too. The line is the one the match starts on.
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
      hits.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
    }
  }
  return hits;
}

function grepCount(word, pathspecs) {
  try {
    return git(['grep', '-i', '-c', '-e', word, '--', ...pathspecs])
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(':') + 1)), 0);
  } catch (error) {
    if (error.status === 1) return 0;
    throw error;
  }
}

// What the tree's CURRENT identity spells is not a survivor of an older one: a new slug that
// contains the old one ("zephyrtwo" after "zephyr"), or a domain the person chose to keep.
function ownStrings(identity) {
  const parts = [identity.domain, identity.cliPackage, identity.displayName, identity.slug]
    .filter(Boolean)
    .map((part) => part.split(/\s+/).map(escapeRegExp).join('\\s+'));
  return new RegExp(parts.join('|'), 'gi');
}

function survivors(slug, current = readCurrentIdentity()) {
  if (!SLUG.test(slug)) throw new Error(`--survivors takes a slug, got "${slug}"`);
  const excludes = NEVER.flatMap((row) => row.paths).map((p) => `:(glob,exclude)${p}`);
  let out = '';
  try {
    // No -I: a file git calls binary is reported too, as a 'Binary file ... matches' line. Ignored files are not read.
    out = git(['grep', '-n', '-i', '--untracked', '-e', slug, '--', '.', ...excludes]);
  } catch (error) {
    if (error.status !== 1) throw error; // 1 is git grep's "nothing found"
  }
  const own = current.slug.toLowerCase() === slug.toLowerCase() ? null : ownStrings(current);
  const word = new RegExp(escapeRegExp(slug), 'i');
  const lines = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const text = /^[^:]*:\d+:(.*)$/s.exec(line)?.[1];
      // A "Binary file x matches" line has no text to look into: it stays a survivor.
      return text === undefined || own === null || word.test(text.replace(own, ''));
    });
  const inCopies = grepCount(slug, [`:(glob)${CHASSIS_COPIES}`]);
  if (inCopies > 0) {
    console.log(
      `WARNING: ${inCopies} line(s) inside packages/chassis-* still name "${slug}". The script never writes those copies. Most are comments, some are live values (the product name in every mail, the MCP server name, the API page title, the telemetry service name): the tool keeps them until the chassis source reads the tool's identity. List them: git grep -in ${slug} -- 'packages/chassis-*'`
    );
  }
  if (lines.length === 0) {
    console.log(`no line names "${slug}" outside the ${NEVER.length} rows of NEVER`);
    return 0;
  }
  for (const line of lines) console.log(line);
  console.error(
    `\n${lines.length} line(s) still name "${slug}". For a text file: add it to WRITES in scripts/instantiate.mjs, or make it read the identity definition. For a "Binary file" line: the script never rewrites a binary, replace or regenerate that file by hand.`
  );
  return 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['--current']) {
    console.log(JSON.stringify(readCurrentIdentity()));
    return 0;
  }
  if (args['--survivors'] !== undefined) return survivors(args['--survivors']);

  const [slug, ...rest] = args.positional;
  if (!slug || rest.length > 0 || !args['--name']) throw new Error(USAGE);
  if (!SLUG.test(slug))
    throw new Error(
      `"${slug}" is not a slug: one lower-case word, letters and digits, 3 to 31 characters, no hyphen (it is also an env prefix, a CLI command and a part of identifiers)`
    );
  if (RESERVED.includes(slug))
    throw new Error(
      `"${slug}" is a word the code uses for something else: pick a name only this tool carries`
    );
  const displayName = args['--name'].trim();
  if (!displayName || /[\n\r"'`\\<>]/.test(displayName))
    throw new Error('--name is one line of plain text, without quotes, backslashes or angle brackets');

  const domainArg = args['--domain'];
  if (domainArg !== undefined && !DOMAIN.test(domainArg))
    throw new Error(`--domain is a lower-case DNS hostname without scheme, port or path, got "${domainArg}"`);
  const cliArg = args['--cli-package'];
  if (cliArg !== undefined && !NPM_NAME.test(cliArg))
    throw new Error(
      `--cli-package is an npm package name (@scope/name or name, lower case), got "${cliArg}"`
    );

  if (git(['status', '--porcelain']).trim() !== '') {
    throw new Error(
      'the working tree is not clean: commit or remove your changes first, so that the diff of this run is the instantiation and nothing else'
    );
  }

  const from = readCurrentIdentity();
  const to = {
    slug,
    displayName,
    // A rename keeps a domain the person CHOSE (a domain is final, grants derive from it). A
    // domain the script derived from the old slug was never chosen: it follows the new slug.
    domain: domainArg ?? (from.domainGiven ? from.domain : `${slug}.antasphere.com`),
    cliPackage: cliArg ?? (from.cliPackageGiven ? from.cliPackage : `@antasphere/${slug}`),
    domainGiven: domainArg !== undefined || Boolean(from.domainGiven),
    cliPackageGiven: cliArg !== undefined || Boolean(from.cliPackageGiven)
  };
  const dryRun = Boolean(args['--dry-run']);
  // Asked for the identity it already has, the tree is left alone. Rewriting it onto itself
  // is not harmless: a word of the new name that the tree already used for something else
  // (sample data named "Acme Corp") would be taken for the tool's name on the second pass.
  const sameNames = from.slug === to.slug && from.displayName === to.displayName;
  const sameRecord =
    to.domain === (from.domain ?? to.domain) && to.cliPackage === (from.cliPackage ?? to.cliPackage);
  if (sameNames && sameRecord) {
    console.log(
      `nothing to change: the tree already carries this identity (${to.slug}, "${to.displayName}")`
    );
    return 0;
  }
  // The law of a name: a word the tree does not use. Checked before anything is written.
  const words = [];
  if (to.slug !== from.slug) words.push([to.slug, new RegExp(escapeRegExp(to.slug), 'i')]);
  if (to.displayName !== from.displayName && to.displayName.toLowerCase() !== to.slug)
    words.push([to.displayName, new RegExp(to.displayName.split(/\s+/).map(escapeRegExp).join('\\s+'), 'i')]);
  for (const [word, pattern] of words) {
    const hits = standing(pattern);
    if (hits.length === 0) continue;
    const where = `${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', ...' : ''}`;
    throw new Error(
      `"${word}" already stands on ${hits.length} line(s) of this tree (${where}). The tool's name would merge with them, and no later run could tell them apart. Pick a word the tree does not use.`
    );
  }
  const rules = buildRules(from, to);
  const never = new Set(tracked(NEVER.flatMap((row) => row.paths)));
  const files = [...new Set(WRITES.flatMap((row) => tracked(row.paths)))]
    .filter((file) => !never.has(file))
    .sort();

  const changed = [];
  const removed = [];
  const skipped = [];
  for (const file of TEMPLATE_ONLY_FILES) {
    if (!existsSync(join(root, file))) continue;
    removed.push(file);
    if (!dryRun) rmSync(join(root, file));
  }
  for (const file of files) {
    if (removed.includes(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    // Never through a symbolic link: what it points at may be outside the tables, or outside the repository.
    if (lstatSync(abs).isSymbolicLink()) {
      skipped.push(file);
      continue;
    }
    const buffer = readFileSync(abs);
    if (isBinary(buffer)) continue;
    const before = buffer.toString('utf8');
    let after = rewrite(before, rules);
    if (TEMPLATE_ONLY_BLOCKS.includes(file)) after = stripTemplateOnly(after);
    if (after === before) continue;
    changed.push(file);
    if (!dryRun) writeFileSync(abs, after);
  }

  const record = `${JSON.stringify({ slug: to.slug, displayName: to.displayName, domain: to.domain, domainGiven: to.domainGiven, cliPackage: to.cliPackage, cliPackageGiven: to.cliPackageGiven }, null, 2)}\n`;
  const stateAbs = join(root, STATE_FILE);
  if (!existsSync(stateAbs) || readFileSync(stateAbs, 'utf8') !== record) {
    changed.push(STATE_FILE);
    if (!dryRun) writeFileSync(stateAbs, record);
  }
  changed.sort();

  console.log(
    `${from.slug} ("${from.displayName}") -> ${to.slug} ("${to.displayName}"), domain ${to.domain}, CLI package ${to.cliPackage}`
  );
  for (const file of removed) console.log(`  removed  ${file}`);
  for (const file of changed) console.log(`  changed  ${file}`);
  for (const file of skipped)
    console.log(`  skipped  ${file} (a symbolic link: the script never writes through one)`);
  console.log(
    `${changed.length} file(s) changed, ${removed.length} removed${dryRun ? ' (dry run: nothing was written)' : ''}`
  );

  if (!dryRun && !args['--no-install']) {
    console.log('pnpm install (writes pnpm-lock.yaml again for the new package names)');
    execFileSync('pnpm', ['install', '--no-frozen-lockfile'], { cwd: root, stdio: 'inherit' });
    // A longer or shorter name moves line breaks and table columns: format what was changed, nothing else.
    console.log('prettier on the changed files');
    execFileSync(
      'pnpm',
      ['exec', 'prettier', '--write', '--ignore-unknown', '--log-level', 'warn', ...changed],
      { cwd: root, stdio: 'inherit' }
    );
  }
  if (dryRun) return 0;
  if (to.slug === from.slug) {
    console.log('\nthe slug did not change, so there is no old slug to look for');
    return 0;
  }
  // The run ends on its own proof: the name it replaced stands nowhere outside NEVER.
  console.log(`\nwhere "${from.slug}" still stands:`);
  if (to.domainGiven && to.domain.includes(from.slug) && to.slug !== from.slug) {
    console.log(
      `note: the domain stays ${to.domain}, as it was chosen. It holds the old slug "${from.slug}": pass --domain to change it.`
    );
  }
  const left = survivors(from.slug, to);
  console.log(
    `then the gate: pnpm turbo lint typecheck test build && pnpm format:check && pnpm --filter @app/server drift:check && node scripts/check-chassis-copies.mjs`
  );
  return left;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`instantiate: ${error.message}`);
    process.exit(2);
  }
}
