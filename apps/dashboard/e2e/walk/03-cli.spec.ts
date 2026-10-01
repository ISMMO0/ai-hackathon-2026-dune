import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ENV, IDENTITY, MIA, OWNER, failures, kept, step, terminalCard } from './lib';

/**
 * Chapter 3, the CLI: every command of the binary run once against the
 * instance the owner chapter left, with the key it minted (read and write,
 * no export). Discovery and identity, the profiles in a config home of the
 * walk's own (never the machine's), the workspaces, the items, the projects
 * (a project of the chapter's own for the members, the owner chapter's
 * project for the item links), the teams (a team of the chapter's own for the
 * seats), the files, the export (refused to the key, then with the owner's
 * key when one is handed over), the demo links (as the owner, never a key),
 * the sign-in over email OTP read from Mailpit, completion and config clear.
 * Each card is one step: the commands as a terminal shows them, the keys and
 * the demo secrets replaced by an ellipsis, and the assertions that matter.
 * The chapter leaves the owner chapter's people, team and project as it found
 * them; what it made and could not delete (a project, archived nowhere) stays.
 */

const CH = 'cli';
const P = IDENTITY.envPrefix;
const XDG = join(ENV.out, 'xdg');
const FILES = join(ENV.out, 'cli-files');
const DL = join(ENV.out, 'dl');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

interface Run {
  args: string[];
  code: number;
  out: string;
}
interface Card {
  cmd: string;
  out: string;
}
type Mode = 'key' | 'url' | 'profile';

let context: BrowserContext;
let page: Page;
let cliKey = '';
let workspaceId = '';
let projectId = '';
let teamId = '';
let miaUserId = '';
let teamSlug = '';
let workspaceName = '';
let otherWorkspaceName = '';
const ran: { cmd: string; code: number }[] = [];
const secrets: string[] = [];

/** Every key and every demo secret out of what a card shows. */
function redact(text: string): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join('…');
  return t.replace(/pass=[^&\s"]+/g, 'pass=…');
}

/** The environment of one run: the walk's own config home, nothing of the operator's tool variables. */
function envFor(mode: Mode, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith(`${P}_`)) env[k] = v;
  env.XDG_CONFIG_HOME = XDG;
  // The runner sets FORCE_COLOR for its own output; the CLI's cards are plain text.
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  if (mode !== 'profile') env[`${P}_URL`] = ENV.base;
  if (mode === 'key') env[`${P}_API_KEY`] = cliKey;
  return { ...env, ...extra };
}

function cli(
  card: Card[],
  args: string[],
  opts: { mode?: Mode; env?: Record<string, string>; stdin?: string; show?: string } = {}
): Run {
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [ENV.cli, ...args], {
      env: envFor(opts.mode ?? 'key', opts.env),
      encoding: 'utf8',
      input: opts.stdin ?? '',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const cmd =
    opts.show ?? [IDENTITY.bin, ...args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(' ');
  ran.push({ cmd: redact(cmd), code });
  card.push({ cmd: redact(cmd), out: redact(out) + (code ? `\n[exit ${code}]` : '') });
  return { args, code, out };
}

/** The sign-in throttle (three per ten seconds per address) waited out once. */
async function cliThrottled(
  card: Card[],
  args: string[],
  opts: Parameters<typeof cli>[2] = {}
): Promise<Run> {
  const r = cli(card, args, opts);
  if (r.code !== 0 && /too many attempts/i.test(r.out)) {
    await new Promise((res) => setTimeout(res, 12_000));
    return cli(card, args, opts);
  }
  return r;
}

const ok = (r: Run, contains?: string | RegExp) => {
  expect(r.code, `${IDENTITY.bin} ${r.args.join(' ')}: ${r.out}`).toBe(0);
  if (contains) expect(r.out).toMatch(typeof contains === 'string' ? new RegExp(esc(contains)) : contains);
  return r.out;
};
const refused = (r: Run, contains: string) => {
  expect(r.code, `${IDENTITY.bin} ${r.args.join(' ')} should be refused: ${r.out}`).not.toBe(0);
  expect(r.out).toContain(contains);
  return r.out;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idOf = (out: string) => {
  const id = UUID.exec(out)?.[0];
  expect(id, `no id in: ${out}`).toBeTruthy();
  return id as string;
};

/** One step = one card: the commands run, the card is drawn whatever happened, then the step's page is shot. */
async function card(title: string, fn: (c: Card[]) => Promise<string | void> | string | void) {
  await step(CH, page, title, async () => {
    const c: Card[] = [];
    try {
      return await fn(c);
    } finally {
      await terminalCard(page, title, c);
    }
  });
}

/** The newest mail to an address that was not there before. */
async function newMail(to: string, before: Set<string>): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${ENV.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages?: { ID: string }[] };
      const fresh = (messages ?? []).find((m) => !before.has(m.ID));
      if (fresh) {
        const full = (await (await fetch(`${ENV.mailpit}/api/v1/message/${fresh.ID}`)).json()) as {
          Text?: string;
        };
        return full.Text ?? '';
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no new mail to ${to}`);
}
async function mailIds(to: string): Promise<Set<string>> {
  const res = await fetch(`${ENV.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  if (!res.ok) return new Set();
  const { messages } = (await res.json()) as { messages?: { ID: string }[] };
  return new Set((messages ?? []).map((m) => m.ID));
}

test.describe.configure({ mode: 'serial' });

test.describe('The CLI runs every command once', () => {
  test.beforeAll(async ({ browser }) => {
    const k = kept('cli');
    cliKey = k.key;
    workspaceId = k.workspaceId;
    projectId = k.projectId;
    teamId = k.teamId;
    miaUserId = k.miaUserId;
    secrets.push(cliKey, ENV.ownerKey);
    rmSync(XDG, { recursive: true, force: true });
    mkdirSync(XDG, { recursive: true, mode: 0o700 });
    mkdirSync(FILES, { recursive: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    page = await context.newPage();
  });
  test.afterAll(async () => {
    writeFileSync(join(ENV.out, 'cli-commands.json'), JSON.stringify(ran, null, 2) + '\n');
    await context?.close();
  });

  let itemId = '';
  let projectItemId = '';
  let newProjectId = '';
  let fileId = '';

  test('discovery, identity, profiles, workspaces', async () => {
    await card('CLI: discovery and identity', (c) => {
      ok(cli(c, ['instance'], { mode: 'url' }), '(oss)');
      ok(cli(c, ['whoami']), OWNER.email);
      ok(cli(c, ['verify']), /^ok/);
      ok(cli(c, ['--version']), /^\d+\.\d+\.\d+/);
      const help = ok(cli(c, ['--help']), `Usage: ${IDENTITY.bin}`);
      expect(help).toContain(`${P}_URL`);
      const who = cli(c, ['whoami', '--json']);
      ok(who);
      const me = JSON.parse(who.out) as { workspace?: { id: string; name: string } };
      expect(me.workspace?.id).toBe(workspaceId);
      workspaceName = me.workspace?.name ?? '';
      return `whoami --json names workspace ${workspaceName}`;
    });

    await card('CLI: profiles, the key on stdin and redacted', (c) => {
      ok(
        cli(c, ['login', '--api-url', ENV.base, '--api-key-stdin'], {
          mode: 'profile',
          stdin: `${cliKey}\n`,
          show: `printf '%s\\n' "$${P}_API_KEY" | ${IDENTITY.bin} login --api-url ${ENV.base} --api-key-stdin`
        }),
        'saved to profile "default"'
      );
      const profiles = ok(cli(c, ['profiles'], { mode: 'profile' }), 'default');
      expect(profiles).not.toContain(cliKey);
      expect(profiles).toContain('…');
      ok(cli(c, ['use', 'default'], { mode: 'profile' }), 'Active profile: default');
      const shown = ok(
        cli(c, ['config', 'show'], { mode: 'profile' }),
        join('antasphere', 'tools', `${IDENTITY.slug}.json`)
      );
      expect(shown).not.toContain(cliKey);
      expect(existsSync(join(XDG, 'antasphere', 'tools', `${IDENTITY.slug}.json`))).toBe(true);
      ok(cli(c, ['whoami'], { mode: 'profile' }), OWNER.email);
    });

    await card('CLI: workspaces, the selection and the default', (c) => {
      const list = ok(cli(c, ['workspaces'], { mode: 'profile' }), workspaceId);
      const other = list
        .split('\n')
        .map((l) => /^[* ] ([0-9a-f-]{36})\s+\S+\s+(.+?)\s*(\(default\))?$/.exec(l))
        .find((m) => m && m[1] !== workspaceId);
      otherWorkspaceName = other?.[2] ?? workspaceName;
      ok(
        cli(c, ['workspace', 'use', otherWorkspaceName], { mode: 'profile' }),
        `now runs in "${otherWorkspaceName}"`
      );
      ok(cli(c, ['whoami'], { mode: 'profile' }), 'chosen by: profile "default"');
      ok(cli(c, ['workspace', 'use', '--clear'], { mode: 'profile' }), 'selects no workspace');
      ok(
        cli(c, ['workspace', 'default', '--clear'], { mode: 'profile' }),
        'No default workspace is chosen: a command naming none runs in the workspace you joined first.'
      );
      ok(
        cli(c, ['workspace', 'default', workspaceName], { mode: 'profile' }),
        `"${workspaceName}" (${workspaceId}) is now your default workspace`
      );
      ok(cli(c, ['workspaces'], { mode: 'profile' }), /\(default\)/);
      return `second workspace: ${otherWorkspaceName}`;
    });

    await card('CLI: logout, then the environment alone', (c) => {
      ok(cli(c, ['logout'], { mode: 'profile' }), 'Logged out of profile "default"');
      refused(cli(c, ['whoami'], { mode: 'profile' }), 'An API key is required');
      ok(cli(c, ['whoami']), OWNER.email);
      const teams = cli(c, ['teams', 'list', '--json']);
      ok(teams);
      const parsed = JSON.parse(teams.out) as { teams: { id: string; slug: string }[] };
      teamSlug = parsed.teams.find((t) => t.id === teamId)?.slug ?? '';
      expect(teamSlug, 'the owner chapter team is listed').not.toBe('');
      return `the owner chapter team is ${teamSlug}`;
    });
  });

  test('items and projects', async () => {
    await card('CLI: items, created, listed, shown, edited', (c) => {
      itemId = idOf(
        ok(
          cli(c, ['items', 'create', '--name', 'CLI item', '--note', 'made by the walk']),
          'Created CLI item'
        )
      );
      ok(cli(c, ['items', 'list']), 'CLI item');
      const json = cli(c, ['items', 'list', '--json']);
      ok(json);
      const items = (JSON.parse(json.out) as { items: { id: string }[] }).items;
      expect(items.map((i) => i.id)).toContain(itemId);
      c[c.length - 1].out = `${c[c.length - 1].out.slice(0, 300)}\n… (${items.length} items)`;
      ok(cli(c, ['items', 'show', itemId]), 'made by the walk');
      ok(cli(c, ['items', 'update', itemId, '--note', 'edited']));
      refused(
        cli(c, ['items', 'update', itemId]),
        'Nothing to change: pass --name <name> and/or --note <note>.'
      );
    });

    await card('CLI: an item created in a project, the list filtered', (c) => {
      projectItemId = idOf(
        ok(cli(c, ['items', 'create', '--name', 'CLI in project', '--project', projectId]))
      );
      const listed = ok(cli(c, ['items', 'list', '--project', projectId]), 'CLI in project');
      expect(listed).not.toContain('CLI item\n');
      ok(cli(c, ['items', 'show', projectItemId]), /projects:/);
      ok(cli(c, ['projects', 'list']), projectId);
      ok(cli(c, ['projects', 'get', projectId]), 'your role:');
      refused(
        cli(c, ['projects', 'get', '00000000-0000-0000-0000-000000000000']),
        'No such project, or it is not yours to read.'
      );
    });

    await card('CLI: a project created, renamed, its description cleared', (c) => {
      const made = cli(c, ['projects', 'create', 'CLI project', '--description', 'd', '--json']);
      ok(made);
      newProjectId = (JSON.parse(made.out) as { id: string }).id;
      expect(newProjectId).toMatch(UUID);
      ok(cli(c, ['projects', 'update', newProjectId, '--name', 'CLI project 2']), 'CLI project 2');
      ok(cli(c, ['projects', 'update', newProjectId, '--clear-description']));
      const got = cli(c, ['projects', 'get', newProjectId, '--json']);
      ok(got);
      const p = JSON.parse(got.out) as { name: string; description: string | null };
      expect(p.name).toBe('CLI project 2');
      expect(p.description ?? '').toBe('');
    });

    await card('CLI: project members, a person and a team', (c) => {
      ok(cli(c, ['projects', 'members', 'add', newProjectId, MIA.email, '--role', 'editor']));
      ok(cli(c, ['projects', 'members', 'role', newProjectId, miaUserId, 'viewer']));
      ok(cli(c, ['projects', 'members', 'add', newProjectId, '--team', teamSlug, '--role', 'editor']));
      ok(cli(c, ['projects', 'members', 'role', newProjectId, teamSlug, 'manager', '--team']));
      const list = ok(cli(c, ['projects', 'members', 'list', newProjectId]), MIA.email);
      expect(list).toMatch(new RegExp(`team\\s+${esc(teamSlug)}\\s+manager`));
      expect(list).toMatch(new RegExp(`person\\s+${esc(miaUserId)}\\s+viewer`));
      ok(cli(c, ['projects', 'members', 'remove', newProjectId, miaUserId]));
      ok(cli(c, ['projects', 'members', 'remove', newProjectId, teamSlug, '--team']));
      const after = ok(cli(c, ['projects', 'members', 'list', newProjectId]));
      expect(after).not.toContain(MIA.email);
      expect(after).not.toMatch(/^team/m);
    });

    await card('CLI: archive and unarchive, an item linked and unlinked', (c) => {
      ok(cli(c, ['projects', 'archive', newProjectId]), 'Archived');
      const live = ok(cli(c, ['projects', 'list']));
      expect(live).not.toContain(newProjectId);
      ok(cli(c, ['projects', 'list', '--archived', 'all']), newProjectId);
      ok(cli(c, ['projects', 'unarchive', newProjectId]));
      ok(cli(c, ['projects', 'link', projectId, itemId]));
      ok(cli(c, ['items', 'list', '--project', projectId]), 'CLI item');
      ok(cli(c, ['projects', 'unlink', projectId, itemId]));
    });
  });

  test('teams, files, export', async () => {
    await card('CLI: teams, one made, seated, renamed, deleted', (c) => {
      ok(cli(c, ['teams', 'list']), teamSlug);
      ok(cli(c, ['teams', 'get', teamSlug]), teamId);
      ok(cli(c, ['teams', 'members', teamSlug]));
      ok(cli(c, ['teams', 'create', 'CLI team']), 'cli-team');
      ok(cli(c, ['teams', 'rename', 'cli-team', '--name', 'CLI team 2']), 'CLI team 2');
      ok(cli(c, ['teams', 'add', 'cli-team', MIA.email]));
      ok(cli(c, ['teams', 'members', 'cli-team']), MIA.email);
      ok(cli(c, ['teams', 'remove', 'cli-team', MIA.email]));
      ok(cli(c, ['teams', 'delete', 'cli-team', '--yes']));
    });

    await card('CLI: files uploaded, listed, downloaded twice, refused over the cap, deleted', (c) => {
      const small = join(FILES, 'walk-cli-note.txt');
      const big = join(FILES, 'walk-cli-too-big.bin');
      writeFileSync(small, 'a note the CLI uploaded\n');
      writeFileSync(big, Buffer.alloc(1_100_000, 7));
      rmSync(DL, { recursive: true, force: true });
      mkdirSync(DL, { recursive: true });
      fileId = idOf(ok(cli(c, ['files', 'upload', small])));
      ok(cli(c, ['files', 'list']), 'walk-cli-note.txt');
      const all = cli(c, ['files', 'list', '--all', '--json']);
      ok(all);
      expect((JSON.parse(all.out) as { files: { id: string }[] }).files.map((f) => f.id)).toContain(fileId);
      c[c.length - 1].out = `${c[c.length - 1].out.slice(0, 300)}\n…`;
      ok(cli(c, ['files', 'download', fileId, '--dir', DL]));
      expect(readFileSync(join(DL, 'walk-cli-note.txt'), 'utf8')).toBe('a note the CLI uploaded\n');
      ok(cli(c, ['files', 'download', fileId, '--out', join(DL, 'exact.txt')]));
      expect(readFileSync(join(DL, 'exact.txt'), 'utf8')).toBe('a note the CLI uploaded\n');
      refused(cli(c, ['files', 'upload', big]), 'file exceeds MAX_FILE_SIZE_MB (1MB)');
      ok(cli(c, ['files', 'rm', fileId]));
    });

    await card('CLI: the export, refused to the key, then the owner key', (c) => {
      const zip = join(ENV.out, 'cli-export.zip');
      rmSync(zip, { force: true });
      const no = refused(cli(c, ['export', '-o', zip]), IDENTITY.exportScope);
      if (!ENV.ownerKey) return `refused: ${no.trim()}; no WALK_OWNER_API_KEY, the owner leg skipped`;
      ok(cli(c, ['export', '-o', zip], { env: { [`${P}_API_KEY`]: ENV.ownerKey } }));
      expect(readFileSync(zip).subarray(0, 2).toString('latin1')).toBe('PK');
      return `refused: ${no.trim()}`;
    });
  });

  test('demo links, the OTP sign-in, completion', async () => {
    const owner = { [`${P}_OWNER_EMAIL`]: OWNER.email, [`${P}_OWNER_PASSWORD`]: OWNER.password };

    await card('CLI: demo links, as the owner, never a key', async (c) => {
      const link = await cliThrottled(
        c,
        ['demo', 'link', '--email', MIA.email, '--path', '/items', '--hours', '1'],
        {
          mode: 'url',
          env: owner
        }
      );
      ok(link, MIA.email);
      // The page rides in the link's fragment beside the pass, encoded: `#pass=…&to=%2Fitems`.
      expect(link.out).toContain(`to=${encodeURIComponent('/items')}`);
      for (const m of link.out.matchAll(/pass=([^&\s"]+)/g)) secrets.push(m[1]);
      ok(await cliThrottled(c, ['demo', 'list'], { mode: 'url', env: owner }), MIA.email);
      const listed = await cliThrottled(c, ['demo', 'list', '--json'], { mode: 'url', env: owner });
      ok(listed);
      const passes = (
        JSON.parse(listed.out) as { passes: { id: string; email?: string; revokedAt?: string | null }[] }
      ).passes;
      c[c.length - 1].out = `(${passes.length} passes)`;
      const live = passes.find((p) => !p.revokedAt);
      expect(live, 'a live pass').toBeTruthy();
      ok(await cliThrottled(c, ['demo', 'revoke', live!.id], { mode: 'url', env: owner }));
      refused(cli(c, ['demo', 'list']), 'never with an API key');
    });

    await card('CLI: the email OTP sign-in, the code from Mailpit, logout', async (c) => {
      const before = await mailIds(OWNER.email);
      ok(await cliThrottled(c, ['auth', 'login-request', '--email', OWNER.email], { mode: 'url' }));
      const text = await newMail(OWNER.email, before);
      const code = /\b(\d{6})\b/.exec(text)?.[1];
      expect(code, `a 6-digit code in: ${text.slice(0, 200)}`).toBeTruthy();
      const done = await cliThrottled(
        c,
        ['auth', 'login-complete', '--email', OWNER.email, '--code', code!, '--key-name', 'walk-otp'],
        { mode: 'url' }
      );
      ok(done);
      const cfg = JSON.parse(
        readFileSync(join(XDG, 'antasphere', 'tools', `${IDENTITY.slug}.json`), 'utf8')
      ) as {
        activeProfile: string;
        profiles: Record<string, { apiKey?: string }>;
      };
      const otpKey = cfg.profiles[cfg.activeProfile]?.apiKey ?? '';
      secrets.push(otpKey);
      expect(otpKey.startsWith(`${IDENTITY.apiKeyPrefix}_`)).toBe(true);
      ok(cli(c, ['whoami'], { mode: 'profile' }), OWNER.email);
      ok(cli(c, ['logout'], { mode: 'profile' }), /Logged out|revoked|forgotten/);
      refused(cli(c, ['whoami'], { mode: 'profile' }), 'An API key is required');
      // The docs say a self-hosted logout forgets the key and the dashboard revokes it:
      // the walk revokes it itself so it leaves no live key behind.
      const still = cli(c, ['verify'], {
        env: { [`${P}_API_KEY`]: otpKey },
        show: `${P}_API_KEY=<the walk-otp key> ${IDENTITY.bin} verify`
      });
      const res = await fetch(`${ENV.base}/api/v1/cli/auth/key`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${otpKey}` }
      });
      c.push({
        cmd: 'curl -X DELETE $URL/api/v1/cli/auth/key -H "authorization: Bearer <the walk-otp key>"',
        out: `HTTP ${res.status}`
      });
      expect(res.status).toBe(200);
      return `after logout the walk-otp key still verifies: ${still.code === 0}; self-revoke answered ${res.status}`;
    });

    await card('CLI: completion and config clear', (c) => {
      const comp = ok(cli(c, ['completion', 'bash'], { mode: 'profile' }), IDENTITY.bin);
      expect(comp.trim().length).toBeGreaterThan(0);
      c[c.length - 1].out = comp.split('\n').slice(0, 6).join('\n') + '\n…';
      ok(cli(c, ['config', 'clear'], { mode: 'profile' }), 'Config cleared.');
      ok(cli(c, ['items', 'rm', itemId]), 'Deleted CLI item');
      ok(cli(c, ['items', 'rm', projectItemId]), 'Deleted CLI in project');
      return `${ran.length} commands run`;
    });
  });

  test('the CLI chapter recorded no failed step', () => {
    expect(failures).toEqual([]);
  });
});
