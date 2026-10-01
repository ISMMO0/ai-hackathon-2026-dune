// node --test scripts/instantiate.test.mjs
//
// The script is proven on a scratch repository built here, never on this checkout: a
// small tree that holds one file of each kind the tables name (a package file, a compose
// file, a chassis copy, a migration, a file BOTH tables match, a file outside every table,
// the template-only page, sample data that says "Acme" and "Beta", a symbolic link).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import {
  buildRules,
  rewrite,
  stripTemplateOnly,
  STATE_FILE,
  TEMPLATE_ONLY_BEGIN,
  TEMPLATE_ONLY_END
} from './instantiate.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'instantiate.mjs');
const DIGEST = 'a'.repeat(64);

const FIXTURE = {
  'package.json': JSON.stringify({ name: 'slideless', description: 'Self-hosted Slideless' }, null, 2) + '\n',
  'apps/server/package.json':
    JSON.stringify(
      {
        name: '@app/server',
        description: 'The Slideless server',
        dependencies: { '@app/db': 'workspace:*' }
      },
      null,
      2
    ) + '\n',
  'apps/server/src/tool.ts':
    "import { db } from '@app/db';\nexport const slidelessTool = {};\nexport type SlidelessBootResult = {};\n// SLIDELESS_URL is read by the CLI\n",
  // Sample data that says Acme and Beta, as the real tree does.
  'apps/server/test/sample.test.ts':
    "const ORG_ACME = '1';\nconst ORG_BETA = '2';\nconst workspaceName = 'Acme Corp';\nconst other = 'Beta Board';\n",
  'packages/cli/package.json':
    JSON.stringify({ name: '@antasphere/slideless', bin: { slideless: 'dist/bin.js' } }, null, 2) + '\n',
  'packages/chassis-server/src/email.ts': "export const PRODUCT_NAME = 'Slideless';\n",
  'packages/db/drizzle/0001_init.sql': '-- slideless history\n',
  'chassis-source.json': '{ "source": { "repo": "antasphere/slideless" } }\n',
  'pnpm-lock.yaml': "'@antasphere/slideless':\n",
  'LESSONS.md': 'Slideless hit this trap.\n',
  // BOTH tables match this one (WRITES `scripts/*.mjs`, NEVER `scripts/instantiate.mjs`): NEVER wins.
  'scripts/instantiate.mjs': '// a stand-in that names Slideless and must never be rewritten\n',
  'scripts/backup.sh': 'PRODUCT_SLUG="slideless"\n',
  'docker-compose.yml': 'image: ${APP_IMAGE:-ghcr.io/antasphere/slideless:latest}\n- POSTGRES_USER=app\n',
  'deploy/hostinger/docker-compose.yml': `image: ghcr.io/antasphere/slideless:0.4.1@sha256:${DIGEST}\nSLIDELESS_DOMAIN: \${SLIDELESS_DOMAIN:-}\n`,
  'docs/nav.yml': `product: Slideless\ngroups:\n  - title: Start\n    pages:\n      - getting-started/install\n      # ${TEMPLATE_ONLY_BEGIN}\n      - getting-started/make-a-tool\n      # ${TEMPLATE_ONLY_END}\n`,
  'docs/getting-started/install.md':
    '# Install\n\nSlideless cloud is at https://slideless.antasphere.com. Run `npm i -g @antasphere/slideless`, then `slideless login`.\n',
  'docs/getting-started/make-a-tool.md':
    '# Make a tool\n\nOnly the template carries this page. Its example is Example Notes.\n',
  'README.md': `# Slideless\n\n<!-- ${TEMPLATE_ONLY_BEGIN} -->\n## Make a tool from this template\npnpm instantiate examplenotes --name "Example Notes"\n<!-- ${TEMPLATE_ONLY_END} -->\n\n## Run it\n`,
  'notes/outside.txt': 'slideless is named here, in a file no table lists\n',
  'apps/dashboard/static/logo.bin': Buffer.from([
    0x89, 0x00, 0x73, 0x6c, 0x69, 0x64, 0x65, 0x6c, 0x65, 0x73, 0x73
  ])
};

const NEW = ['examplenotes', '--name', 'Example Notes', '--domain', 'notes.example.org', '--no-install'];

// What the symbolic link points at, outside the repository. It holds a word nothing in the tree uses.
const OUTSIDE = 'Slideless and outsideword, in a file outside the repository\n';

let repo;
let outside;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}
function run(...args) {
  return spawnSync('node', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, INSTANTIATE_ROOT: repo }
  });
}
function read(file) {
  return readFileSync(join(repo, file), 'utf8');
}
function commit(message) {
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
}
function makeRepo() {
  repo = mkdtempSync(join(tmpdir(), 'instantiate-'));
  outside = mkdtempSync(join(tmpdir(), 'instantiate-outside-'));
  writeFileSync(join(outside, 'target.md'), OUTSIDE);
  for (const [file, content] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  // A tracked symbolic link inside a WRITES path, pointing out of the repository.
  symlinkSync(join(outside, 'target.md'), join(repo, 'docs/link.md'));
  git('init', '-q', '-b', 'main');
  commit('fixture');
}

describe('the rules', () => {
  const rules = buildRules(
    { slug: 'slideless', displayName: 'Slideless' },
    {
      slug: 'examplenotes',
      displayName: 'Example Notes',
      domain: 'notes.example.org',
      cliPackage: '@antasphere/examplenotes'
    }
  );
  test('each casing goes to its own form, and an identifier stays one word', () => {
    assert.equal(
      rewrite('slideless Slideless SLIDELESS_URL', rules),
      'examplenotes Example Notes EXAMPLENOTES_URL'
    );
    assert.equal(
      rewrite('slidelessTool SlidelessBootResult createSlideless', rules),
      'examplenotesTool ExamplenotesBootResult createExamplenotes'
    );
    // The workspace scope is generic and is nobody's name.
    assert.equal(rewrite("from '@app/db'", rules), "from '@app/db'");
  });
  test('a pinned image becomes :unreleased, because the digest belongs to the previous name', () => {
    assert.equal(
      rewrite(`ghcr.io/antasphere/slideless:0.4.1@sha256:${DIGEST}`, rules),
      'ghcr.io/antasphere/examplenotes:unreleased'
    );
    // The two unpinned forms keep their tag: only the name changes.
    assert.equal(
      rewrite('ghcr.io/antasphere/slideless:unreleased', rules),
      'ghcr.io/antasphere/examplenotes:unreleased'
    );
    assert.equal(
      rewrite('ghcr.io/antasphere/slideless:latest', rules),
      'ghcr.io/antasphere/examplenotes:latest'
    );
  });
  test('the domain and the CLI package take their inputs before the slug rule sees them', () => {
    assert.equal(
      rewrite('https://deploy.slideless.antasphere.com/x', rules),
      'https://deploy.notes.example.org/x'
    );
  });
  test('what a rule wrote is never read by a later rule', () => {
    // The new CLI package holds the OLD slug. Rules applied one after the other would hand
    // "@memo/notes-cli" to the slug rule and write "@memo/memo-cli".
    const tricky = buildRules(
      { slug: 'notes', displayName: 'Notes' },
      { slug: 'memo', displayName: 'Memo', domain: 'memo.example.org', cliPackage: '@memo/notes-cli' }
    );
    assert.equal(rewrite('npm i -g @antasphere/notes', tricky), 'npm i -g @memo/notes-cli');
  });
  test('a replacement is literal: a dollar sign in a name is not a group reference', () => {
    const odd = buildRules(
      { slug: 'slideless', displayName: 'Slideless' },
      { slug: 'memo', displayName: 'Memo $& Co', domain: 'memo.example.org', cliPackage: '@antasphere/memo' }
    );
    assert.equal(rewrite('Slideless', odd), 'Memo $& Co');
  });
  test('a display name that a formatter broke over two lines is still one name', () => {
    const again = buildRules(
      { slug: 'examplenotes', displayName: 'Example Notes' },
      { slug: 'memo', displayName: 'Memo Board', domain: 'memo.example.org', cliPackage: '@antasphere/memo' }
    );
    assert.equal(
      rewrite('open Example\n  Notes, then ExamplenotesBootResult', again),
      'open Memo Board, then MemoBootResult'
    );
  });
  test('a template-only block leaves with both of its marker lines', () => {
    assert.equal(stripTemplateOnly(`a\n# ${TEMPLATE_ONLY_BEGIN}\nb\n# ${TEMPLATE_ONLY_END}\nc`), 'a\nc');
    assert.throws(() => stripTemplateOnly(`a\n# ${TEMPLATE_ONLY_BEGIN}\nb`), /has no/);
  });
});

describe('a run on a scratch repository', () => {
  before(makeRepo);
  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('it reads the current identity from the tree', () => {
    assert.deepEqual(JSON.parse(run('--current').stdout), { slug: 'slideless', displayName: 'Slideless' });
  });

  test('it refuses a slug that is not one plain word, a reserved word, and a missing name', () => {
    for (const bad of ['Memo', 'memo-notes', 'me', '9lives', 'tool', 'items']) {
      assert.equal(run(bad, '--name', 'Memo Notes', '--no-install').status, 2, bad);
    }
    assert.equal(run('memo', '--no-install').status, 2);
    assert.equal(run('memo', '--name', 'Memo "Notes"', '--no-install').status, 2);
    assert.equal(git('status', '--porcelain'), '');
  });

  test('it refuses a domain or a CLI package that is not one, before it writes anything', () => {
    const badPackage = run('memo', '--name', 'Memo', '--cli-package', 'bad"name', '--no-install');
    assert.equal(badPackage.status, 2);
    assert.match(badPackage.stderr, /--cli-package is an npm package name/);
    const injected = run(
      'memo',
      '--name',
      'Memo',
      '--cli-package',
      'evil", "scripts": {"preinstall": "x"}, "x": "',
      '--no-install'
    );
    assert.equal(injected.status, 2);
    for (const bad of [
      'https://memo.example.org',
      'memo.example.org/path',
      'MEMO.example.org',
      '$&evil.com'
    ]) {
      const result = run('memo', '--name', 'Memo', '--domain', bad, '--no-install');
      assert.equal(result.status, 2, bad);
      assert.match(result.stderr, /--domain is a lower-case DNS hostname/);
    }
    assert.equal(git('status', '--porcelain'), '');
    JSON.parse(read('packages/cli/package.json'));
  });

  test('it refuses a name the tree already uses, in any casing, and says where', () => {
    // The sample data says ORG_ACME and 'Acme Corp': a tool named acme could never be told from them.
    const slug = run('acme', '--name', 'Example Notes', '--no-install');
    assert.equal(slug.status, 2);
    assert.match(
      slug.stderr,
      /"acme" already stands on 2 line\(s\) of this tree \(apps\/server\/test\/sample\.test\.ts:1, /
    );
    // The display name is held to the same law.
    const name = run('examplenotes', '--name', 'beta board', '--no-install');
    assert.equal(name.status, 2);
    assert.match(name.stderr, /"beta board" already stands on 1 line/);
    // A word that stands only behind a symbolic link is not in the tree: the check never reads through one.
    assert.equal(run('outsideword', '--name', 'Outside Word', '--no-install', '--dry-run').status, 0);
    // A word that stands only in what leaves with the run (the template-only page and blocks) is free.
    assert.equal(run(...NEW, '--dry-run').status, 0);
    assert.equal(git('status', '--porcelain'), '');
  });

  test('it refuses a dirty tree and writes nothing', () => {
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    const result = run(...NEW);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not clean/);
    assert.equal(git('status', '--porcelain').trim(), '?? untracked.txt');
    rmSync(join(repo, 'untracked.txt'));
  });

  test('a dry run prints the files and writes nothing', () => {
    const result = run(...NEW, '--dry-run');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /changed {2}package\.json/);
    assert.match(result.stdout, /nothing was written/);
    assert.equal(git('status', '--porcelain'), '');
  });

  test('it writes the files of its tables and only those', () => {
    const result = run(...NEW);
    // The run ends on its own survivors check, and this tree holds one file no table lists.
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^notes\/outside\.txt:1:/m);
    const touched = git('status', '--porcelain')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3))
      .sort();
    assert.deepEqual(touched, [
      STATE_FILE,
      'README.md',
      'apps/server/package.json',
      'apps/server/src/tool.ts',
      'deploy/hostinger/docker-compose.yml',
      'docker-compose.yml',
      'docs/getting-started/install.md',
      'docs/getting-started/make-a-tool.md',
      'docs/nav.yml',
      'package.json',
      'packages/cli/package.json',
      'scripts/backup.sh'
    ]);
    // What it printed is what it did.
    const printed = [...result.stdout.matchAll(/^ {2}(?:changed|removed) {2}(.+)$/gm)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(printed, touched);

    assert.equal(JSON.parse(read('package.json')).name, 'examplenotes');
    assert.equal(JSON.parse(read('packages/cli/package.json')).name, '@antasphere/examplenotes');
    assert.deepEqual(JSON.parse(read('packages/cli/package.json')).bin, { examplenotes: 'dist/bin.js' });
    assert.match(
      read('apps/server/src/tool.ts'),
      /from '@app\/db'.*examplenotesTool.*ExamplenotesBootResult.*EXAMPLENOTES_URL/s
    );
    assert.equal(
      read('docker-compose.yml'),
      'image: ${APP_IMAGE:-ghcr.io/antasphere/examplenotes:latest}\n- POSTGRES_USER=app\n'
    );
    assert.equal(
      read('deploy/hostinger/docker-compose.yml'),
      'image: ghcr.io/antasphere/examplenotes:unreleased\nEXAMPLENOTES_DOMAIN: ${EXAMPLENOTES_DOMAIN:-}\n'
    );
    assert.match(
      read('docs/getting-started/install.md'),
      /Example Notes cloud is at https:\/\/notes\.example\.org\. Run `npm i -g @antasphere\/examplenotes`, then `examplenotes login`/
    );
    // The record of the run: the two values the tree cannot give back.
    assert.deepEqual(JSON.parse(read(STATE_FILE)), {
      slug: 'examplenotes',
      displayName: 'Example Notes',
      domain: 'notes.example.org',
      domainGiven: true,
      cliPackage: '@antasphere/examplenotes',
      cliPackageGiven: false
    });
    // The template-only page, its nav line and its README section are gone.
    assert.equal(existsSync(join(repo, 'docs/getting-started/make-a-tool.md')), false);
    assert.equal(
      read('docs/nav.yml'),
      'product: Example Notes\ngroups:\n  - title: Start\n    pages:\n      - getting-started/install\n'
    );
    assert.equal(read('README.md'), '# Example Notes\n\n\n## Run it\n');
    // The rows of NEVER (the one BOTH tables match included), the file outside every table,
    // the sample data and the binary file are byte for byte what they were.
    for (const file of [
      'packages/chassis-server/src/email.ts',
      'packages/db/drizzle/0001_init.sql',
      'chassis-source.json',
      'pnpm-lock.yaml',
      'LESSONS.md',
      'scripts/instantiate.mjs',
      'notes/outside.txt',
      'apps/server/test/sample.test.ts'
    ]) {
      assert.equal(read(file), FIXTURE[file], file);
    }
    assert.deepEqual(
      readFileSync(join(repo, 'apps/dashboard/static/logo.bin')),
      FIXTURE['apps/dashboard/static/logo.bin']
    );
    // Never through a symbolic link: the file outside the repository is untouched, and the run said so.
    assert.equal(readFileSync(join(outside, 'target.md'), 'utf8'), OUTSIDE);
    assert.match(result.stdout, /^ {2}skipped {2}docs\/link\.md \(a symbolic link/m);
    // The closing check says what the chassis copies still name: it is never silent about them.
    assert.match(result.stdout, /WARNING: 1 line\(s\) inside packages\/chassis-\* still name "slideless"/);
    commit('examplenotes');
  });

  test('the same run again changes nothing', () => {
    const result = run(...NEW);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to change/);
    assert.equal(git('status', '--porcelain'), '');
    assert.deepEqual(JSON.parse(run('--current').stdout), {
      slug: 'examplenotes',
      displayName: 'Example Notes',
      domain: 'notes.example.org',
      cliPackage: '@antasphere/examplenotes',
      domainGiven: true,
      cliPackageGiven: false
    });
  });

  test('the survivors check finds the old slug in a file no table lists and in a binary, and passes once they are gone', () => {
    const found = run('--survivors', 'slideless');
    assert.equal(found.status, 1);
    assert.match(found.stdout, /^notes\/outside\.txt:1:/m);
    // The binary file names it too. The script never rewrites a binary, so the check must say so.
    const lines = found.stdout.split('\n').filter((line) => line && !line.startsWith('WARNING'));
    assert.deepEqual(lines.sort(), [
      'Binary file apps/dashboard/static/logo.bin matches',
      'notes/outside.txt:1:slideless is named here, in a file no table lists'
    ]);
    rmSync(join(repo, 'notes/outside.txt'));
    rmSync(join(repo, 'apps/dashboard/static/logo.bin'));
    commit('the two survivors gone');
    assert.equal(run('--survivors', 'slideless').status, 0);
  });

  test('the survivors check also sees an untracked file, any casing, and a file git calls binary', () => {
    writeFileSync(join(repo, 'new.txt'), 'SlideLess\n');
    assert.equal(run('--survivors', 'slideless').status, 1);
    rmSync(join(repo, 'new.txt'));
    writeFileSync(join(repo, 'blob.dat'), Buffer.from('slideless is here\0binary\n'));
    const binary = run('--survivors', 'slideless');
    assert.equal(binary.status, 1);
    assert.match(binary.stdout, /blob\.dat/);
    rmSync(join(repo, 'blob.dat'));
  });

  test('a tool already made can be renamed, and keeps the domain it recorded', () => {
    // Onto a word the sample data uses: refused like a first run, nothing written.
    const collides = run('beta', '--name', 'Memo Board', '--no-install');
    assert.equal(collides.status, 2);
    assert.match(collides.stderr, /"beta" already stands/);
    assert.equal(git('status', '--porcelain'), '');

    const result = run('memo', '--name', 'Memo Board', '--no-install');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(read('package.json')).name, 'memo');
    // No --domain was given: a domain is final, the recorded one stays.
    assert.match(
      read('docs/getting-started/install.md'),
      /^Memo Board cloud is at https:\/\/notes\.example\.org\. Run `npm i -g @antasphere\/memo`, then `memo login`/m
    );
    assert.match(read('apps/server/src/tool.ts'), /memoTool.*MemoBootResult.*MEMO_URL/s);
    assert.equal(JSON.parse(read(STATE_FILE)).domain, 'notes.example.org');
    // The sample data never merged with a name, so it is still what it was.
    assert.equal(read('apps/server/test/sample.test.ts'), FIXTURE['apps/server/test/sample.test.ts']);
    commit('memo');

    // And back: the round trip restores the tree of the first tool, byte for byte.
    const back = run(...NEW);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(git('diff', '--stat', 'HEAD~1', '--', '.'), '');
  });
});

// Each of these needs a tree of its own: a tool made WITHOUT --domain, a hand-edited record.
describe('what a rename carries over, on small trees of their own', () => {
  const trees = [];
  function tree(extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'instantiate-small-'));
    trees.push(dir);
    const files = {
      'package.json': '{ "name": "slideless" }\n',
      'docs/nav.yml': 'product: Slideless\n',
      'docs/index.md':
        'Slideless cloud is at https://slideless.antasphere.com, the CLI is @antasphere/slideless.\n',
      ...extra
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const save = (message) => {
      g('add', '-A');
      g('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
    };
    const go = (...args) =>
      spawnSync('node', [script, ...args, '--no-install'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, INSTANTIATE_ROOT: dir }
      });
    g('init', '-q', '-b', 'main');
    save('fixture');
    return { dir, g, save, go, read: (file) => readFileSync(join(dir, file), 'utf8') };
  }
  after(() => trees.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  test('a domain the script derived follows the new slug, and the rename ends clean', () => {
    const t = tree();
    assert.equal(t.go('zephyr', '--name', 'Zephyr Tool').status, 0);
    assert.equal(JSON.parse(t.read(STATE_FILE)).domainGiven, false);
    t.save('zephyr');
    const renamed = t.go('nimbus', '--name', 'Nimbus Tool');
    assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
    assert.match(renamed.stdout, /no line names "zephyr"/);
    assert.equal(
      t.read('docs/index.md'),
      'Nimbus Tool cloud is at https://nimbus.antasphere.com, the CLI is @antasphere/nimbus.\n'
    );
    assert.equal(JSON.parse(t.read(STATE_FILE)).domain, 'nimbus.antasphere.com');
  });

  test('a domain the person chose stays, even when it holds the old slug, and the check says so instead of failing', () => {
    const t = tree();
    assert.equal(t.go('zephyr', '--name', 'Zephyr Tool', '--domain', 'zephyr.example.org').status, 0);
    t.save('zephyr');
    const renamed = t.go('nimbus', '--name', 'Nimbus Tool');
    assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
    assert.match(
      renamed.stdout,
      /note: the domain stays zephyr\.example\.org, as it was chosen\. It holds the old slug "zephyr": pass --domain/
    );
    assert.match(t.read('docs/index.md'), /^Nimbus Tool cloud is at https:\/\/zephyr\.example\.org,/);
    // A line that names the old slug OUTSIDE the kept domain is still a survivor.
    writeFileSync(join(t.dir, 'left.md'), 'see zephyr.example.org and also zephyr alone\n');
    assert.equal(t.go('--survivors', 'zephyr').status, 1);
  });

  test('a new slug that contains the old one is not a survivor of it', () => {
    const t = tree();
    assert.equal(t.go('zephyr', '--name', 'Zephyr Tool').status, 0);
    t.save('zephyr');
    const renamed = t.go('zephyrtwo', '--name', 'Zephyr Two');
    assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
    assert.equal(JSON.parse(t.read('package.json')).name, 'zephyrtwo');
    // A real leftover is still found beside the new name.
    writeFileSync(join(t.dir, 'left.md'), 'zephyrtwo is fine, Zephyr Tool is not\n');
    const found = t.go('--survivors', 'zephyr');
    assert.equal(found.status, 1);
    assert.match(found.stdout, /^left\.md:1:/m);
  });

  test('a display name that stands across a line break is seen by the check, as the rewrite would see it', () => {
    const t = tree({ 'docs/prose.md': 'unrelated prose: Zephyr\nBoard is a thing here\n' });
    const refused = t.go('zephyrboard', '--name', 'Zephyr Board');
    assert.equal(refused.status, 2);
    assert.match(
      refused.stderr,
      /"Zephyr Board" already stands on 1 line\(s\) of this tree \(docs\/prose\.md:1\)/
    );
    assert.equal(t.g('status', '--porcelain'), '');
  });

  test('a record edited by hand is held to the grammar of the flags, and named when it cannot be read', () => {
    const t = tree();
    assert.equal(t.go('zephyr', '--name', 'Zephyr Tool').status, 0);
    t.save('zephyr');
    const good = t.read(STATE_FILE);
    for (const [bad, message] of [
      ['not json{', /\.instantiate\.json is not valid JSON/],
      [
        good.replace('zephyr.antasphere.com', 'https://evil.example.org/x'),
        /\.instantiate\.json: "domain" is not/
      ],
      [good.replace('@antasphere/zephyr', 'evil\\", \\"scripts'), /\.instantiate\.json: "cliPackage" is not/]
    ]) {
      writeFileSync(join(t.dir, STATE_FILE), bad);
      t.save('edited');
      const result = t.go('nimbus', '--name', 'Nimbus Tool');
      assert.equal(result.status, 2, bad);
      assert.match(result.stderr, message);
      assert.equal(t.g('status', '--porcelain'), '');
    }
  });

  test('a domain recorded without its flag is kept as chosen, never lost silently', () => {
    const t = tree();
    assert.equal(t.go('zephyr', '--name', 'Zephyr Tool', '--domain', 'notes.example.org').status, 0);
    const record = JSON.parse(t.read(STATE_FILE));
    delete record.domainGiven;
    delete record.cliPackageGiven;
    writeFileSync(join(t.dir, STATE_FILE), `${JSON.stringify(record, null, 2)}\n`);
    t.save('a record from before the flags');
    const renamed = t.go('nimbus', '--name', 'Nimbus Tool');
    assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
    assert.equal(JSON.parse(t.read(STATE_FILE)).domain, 'notes.example.org');
    assert.match(t.read('docs/index.md'), /https:\/\/notes\.example\.org,/);
  });

  test('the same names with another domain is a change, not a no-op', () => {
    const t = tree();
    assert.equal(t.go('zephyr', '--name', 'Zephyr Tool').status, 0);
    t.save('zephyr');
    const moved = t.go('zephyr', '--name', 'Zephyr Tool', '--domain', 'notes.example.org');
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    assert.match(t.read('docs/index.md'), /https:\/\/notes\.example\.org,/);
    assert.equal(JSON.parse(t.read(STATE_FILE)).domainGiven, true);
  });
});
