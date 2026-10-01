// node --test scripts/check-shell-copies.test.mjs
//
// The guard is proven on scratch repositories built here, never on this checkout: a
// small tree with the identity definition, the boundary test that names the tool's
// paths, three shell files that spell the identity and carry comments, one file of
// the tool's half and one file outside `src`. A second tree is the source, in
// Slideless's words. The fixture identity is fixturetool, never the template's own: the
// instantiate script rewrites the template's identity words in every scripts/*.mjs, and a
// fixture spelling them would break in every tool born from the template (found by the
// verifier of lane E1, 29 September 2026).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { normalize } from './check-shell-copies.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-shell-copies.mjs');
const SHA = 'a'.repeat(40);
const DOCS = 'apps/dashboard/src/lib/docs.ts';
const MEMBERS = 'apps/dashboard/src/routes/(app)/members/+page.svelte';
const REGEX = 'apps/dashboard/src/lib/regex.ts';
const BOUNDARY = 'apps/dashboard/src/lib/boundary.test.ts';
const TOOL = 'apps/dashboard/src/lib/tool/index.ts';
const E2E = 'apps/dashboard/e2e/x.ts';
const IDENTITY = 'packages/contract/src/identity.ts';

const identityFile = (slug, displayName, prefix, read) =>
  `export const IDENTITY = {\n  slug: '${slug}',\n  displayName: '${displayName}',\n  apiKeyPrefix: '${prefix}',\n  scopes: { read: '${read}', write: 'x:write' }\n};\n`;

const FIXTURE = {
  [IDENTITY]: identityFile('fixturetool', 'Fixture Tool', 'ftk', 'items:read'),
  [BOUNDARY]: "const TOOL_PATHS = ['lib/tool/', 'routes/(app)/(tool)/'];\n",
  [DOCS]:
    "// the docs of Fixture Tool\nexport const DOCS_URL = 'https://docs.antasphere.com/fixturetool';\nexport const KEY = 'ftk_';\nexport const SCOPE = 'items:read';\nexport const API = '@app/sdk';\nexport const LIST = [\n  'a'\n].filter(\n  (x) => x\n);\n",
  [MEMBERS]:
    '<!-- the members of Fixture Tool -->\n<script lang="ts">\n  /* block: read the url */\n  const url = import.meta.env.FIXTURETOOL_URL;\n  const glob = \'$lib/tool/**/*.ts\';\n</script>\n\n<h1>Members of Fixture Tool</h1>\n<a href="/items">Fixturetool items</a>\n',
  [REGEX]: 'const RE = /\\/\\*[\\s\\S]*?\\*\\//gm; export const after = 1;\n',
  [TOOL]: "export const tool = 'fixturetool';\n",
  [E2E]: "export const e2e = 'fixturetool';\n"
};

// The same shell in Slideless's words, with its own spellings of what is not identity,
// and one file changed in its code.
const SOURCE = {
  ...FIXTURE,
  [IDENTITY]: identityFile('slideless', 'Slideless', 'slk', 'presentations:read'),
  [DOCS]:
    "// the docs of Slideless\nexport const DOCS_URL = 'https://docs.antasphere.com/slideless';\nexport const KEY = 'slk_';\nexport const SCOPE = 'presentations:read';\nexport const API = '@slideless/sdk';\nexport const LIST = [\n  'a'\n].filter(\n  (x) => x\n);\n",
  [MEMBERS]: FIXTURE[MEMBERS].replaceAll('Fixture Tool', 'Slideless')
    .replace('FIXTURETOOL', 'SLIDELESS')
    .replace('Fixturetool', 'Slideless')
    .replace('/items', '/decks'),
  [REGEX]: FIXTURE[REGEX].replace('after = 1', 'after = 3'),
  [TOOL]: "export const tool = 'slideless';\n"
};

const scratch = [];

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-guard-'));
  scratch.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture'],
    { cwd: dir }
  );
  return dir;
}

let repo;
let source;

function run(...args) {
  return spawnSync('node', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, SHELL_GUARD_ROOT: repo }
  });
}
const read = (file) => readFileSync(join(repo, file), 'utf8');
const write = (file, text) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};
const record = () => JSON.parse(read('shell-source.json'));
const edit = (file, from, to) => write(file, read(file).replace(from, to));

before(() => {
  repo = makeRepo(FIXTURE);
  source = makeRepo(SOURCE);
});
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('the guard', () => {
  test('--write records exactly the shell files', () => {
    const out = run('--write', '--repo', 'antasphere/slideless', '--sha', SHA);
    assert.equal(out.status, 0, `--write failed: ${out.stderr}`);
    assert.deepEqual(
      Object.keys(record().files),
      [BOUNDARY, DOCS, REGEX, MEMBERS].sort(),
      'the record holds the shell files (the boundary test is one), not the tool file nor the e2e file'
    );
    assert.deepEqual(record().differs, [], 'no --source, so nothing differs');
  });

  test('the check passes right after the write', () => {
    const out = run();
    assert.equal(out.status, 0, `the check failed: ${out.stderr}`);
    assert.match(
      out.stdout,
      /4 files match antasphere\/slideless@a{40} after normalisation/,
      'the success line'
    );
  });

  test('an edit to the code of a shell file fails the check', () => {
    const before = read(REGEX);
    edit(REGEX, 'after = 1', 'after = 2');
    const out = run();
    write(REGEX, before);
    assert.equal(out.status, 1, 'a code edit exits 1');
    assert.match(
      out.stderr,
      /changed {3}apps\/dashboard\/src\/lib\/regex\.ts/,
      'stderr names the changed file'
    );
    assert.match(out.stderr, /never edited here/, 'stderr says the shell is never edited here');
  });

  test('an edit to comments only passes', () => {
    const docs = read(DOCS);
    const members = read(MEMBERS);
    edit(DOCS, 'the docs of Fixture Tool', 'where the documentation lives');
    edit(MEMBERS, 'the members of Fixture Tool', 'who is in the workspace');
    edit(MEMBERS, 'block: read the url', 'the address the CLI reads');
    const out = run();
    write(DOCS, docs);
    write(MEMBERS, members);
    assert.equal(out.status, 0, `a comment edit must pass: ${out.stderr}`);
  });

  test('the identity renamed everywhere, then reformatted, passes', () => {
    const saved = Object.fromEntries([IDENTITY, DOCS, MEMBERS, REGEX].map((f) => [f, read(f)]));
    for (const file of Object.keys(saved)) {
      write(
        file,
        read(file)
          .replaceAll('Fixture Tool', 'Othertool')
          .replaceAll('FIXTURETOOL', 'OTHERTOOL')
          .replaceAll('Fixturetool', 'Othertool')
          .replaceAll('fixturetool', 'othertool')
      );
    }
    try {
      let out = run();
      assert.equal(out.status, 0, `a rename must pass: ${out.stderr}`);
      edit(DOCS, ";\nexport const KEY = 'ftk_';", "; export const KEY = 'ftk_';");
      edit(MEMBERS, '\n<h1>', '\n\n    <h1>');
      edit(MEMBERS, '<a href', '\n  <a\n    href');
      edit(DOCS, '].filter(\n  (x) => x\n);', '].filter((x) => x);');
      out = run();
      assert.equal(out.status, 0, `a rename reformatted must pass: ${out.stderr}`);
    } finally {
      for (const [file, text] of Object.entries(saved)) write(file, text);
    }
  });

  test('a shell file added or deleted fails; the tool file and the e2e file do not count', () => {
    write('apps/dashboard/src/lib/new.ts', 'export const x = 1;\n');
    let out = run();
    rmSync(join(repo, 'apps/dashboard/src/lib/new.ts'));
    assert.equal(out.status, 1, 'an added shell file exits 1');
    assert.match(out.stderr, /added {5}apps\/dashboard\/src\/lib\/new\.ts/, 'stderr names the added file');

    const docs = read(DOCS);
    rmSync(join(repo, DOCS));
    out = run();
    write(DOCS, docs);
    assert.equal(out.status, 1, 'a deleted shell file exits 1');
    assert.match(
      out.stderr,
      /missing {3}apps\/dashboard\/src\/lib\/docs\.ts/,
      'stderr names the missing file'
    );

    edit(TOOL, "'fixturetool'", "'something else'");
    edit(E2E, "'fixturetool'", "'something else'");
    out = run();
    assert.equal(out.status, 0, `the tool's half and the e2e folder are not the shell: ${out.stderr}`);
  });
});

describe('normalize', () => {
  const identity = {
    slug: 'fixturetool',
    displayName: 'Fixture Tool',
    apiKeyPrefix: 'ftk',
    resource: 'items'
  };

  test('a regular expression that looks like a comment keeps the code after it', () => {
    const out = normalize(FIXTURE[REGEX], identity);
    assert.match(out, /after = 1/, `the code after the regex survives: ${out}`);
  });

  test('a glob in a string is not a comment', () => {
    const out = normalize(FIXTURE[MEMBERS], identity);
    assert.match(out, /\*\*\/\*\.ts/, `the glob survives: ${out}`);
    assert.match(out, /<h1>Members of §NAME§<\/h1>/, `the markup after the glob survives: ${out}`);
  });

  test('a display name broken over lines is one placeholder', () => {
    assert.equal(
      normalize('Fixture\n  Tool', identity),
      '§NAME§',
      'the words of the name, any white space between'
    );
  });

  test('every identity word has its placeholder', () => {
    assert.equal(
      normalize('FIXTURETOOL Fixturetool fixturetool ftk_ items: // not stripped mid-line', identity),
      '§SLUG§ §NAME§ §slug§ §key§_ §res§: // not stripped mid-line',
      'the six rules, and a trailing // kept'
    );
  });
});

describe('the source', () => {
  test('--diff names each file against the source', () => {
    const out = run('--diff', '--source', source);
    assert.equal(out.status, 0, `--diff always exits 0: ${out.stderr}`);
    assert.match(
      out.stdout,
      new RegExp(`^same +${DOCS.replaceAll('.', '\\.')}$`, 'm'),
      'docs.ts is the same'
    );
    assert.match(
      out.stdout,
      /^same +apps\/dashboard\/src\/routes\/\(app\)\/members\/\+page\.svelte$/m,
      'the page is the same'
    );
    assert.match(out.stdout, /^differs +apps\/dashboard\/src\/lib\/regex\.ts$/m, 'regex.ts differs');
    assert.match(out.stdout, /3 same, 1 differs, 0 only here, 0 only there/, 'the summary counts');
  });

  test('--diff lists the files only the source has', () => {
    const extra = join(source, 'apps/dashboard/src/lib/extra.ts');
    writeFileSync(extra, 'export const extra = 1;\n');
    const out = run('--diff', '--source', source);
    rmSync(extra);
    assert.match(out.stdout, /^only there apps\/dashboard\/src\/lib\/extra\.ts$/m, 'the source-only file');
    assert.match(out.stdout, /3 same, 1 differs, 0 only here, 1 only there/, 'the summary counts');
  });

  test('--write --source records the one differing path', () => {
    const out = run('--write', '--repo', 'antasphere/slideless', '--sha', SHA, '--source', source);
    assert.equal(out.status, 0, `--write --source failed: ${out.stderr}`);
    assert.deepEqual(record().differs, [REGEX], 'exactly regex.ts differs');
    assert.deepEqual(
      record().source.rewrite,
      { '@slideless/': '@app/', 'presentations:': 'items:', '/decks': '/items' },
      'the rewrite is kept in the record'
    );
  });
});
