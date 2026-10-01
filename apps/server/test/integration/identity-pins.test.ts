import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPlatform } from '@antasphere/chassis-server';
import { FakeHub, makeCreateTestApp } from '@antasphere/chassis-server/testing';
import type { EmailMessage } from '@antasphere/chassis-server/email';
import { theTool } from '../../src/tool.js';
import {
  SETUP_TOKEN,
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The tool's IDENTITY, pinned by literal bytes where the running product shows
 * it (PRDCT-2531). The identity lives in ONE definition
 * (`packages/contract/src/identity.ts`) that feeds the chassis packages; this
 * file is what judges a change of it: red if one byte of a visible value moves.
 *
 * The rule of this file (a suite that takes the identity from its host pins
 * nothing on its own): every expected value is SPELLED HERE. Nothing is
 * imported from the tool's constants, nothing is read from `IDENTITY`, a host
 * or a fixture, and every value is read off the real composition (`boot()`;
 * for the fallback page and the file-in-use sentence, the same tool definition
 * with ONE value swapped), never off a module:
 *
 *  - the API key prefix, on a minted key and on the bearer the API accepts;
 *  - the three scope names, as the vocabulary the key mint answers with;
 *  - the MCP server name, the server instructions, `starter_whoami`, the
 *    full tool list and every description that names a tool or the CLI, as
 *    `initialize` and `tools/list` answer them;
 *  - the five generic mails (invite, password reset, email-change confirm,
 *    email verify, sign-in code), CAPTURED from the real flows: the subject,
 *    the whole text part, and every place the HTML part carries the name;
 *  - the fallback page served when no dashboard build exists, and the
 *    instance name of an instance that is not set up;
 *  - the wire sentences of the `copy` slot (`guest_forbidden` from both of its
 *    sources, `guest_target`, `file_in_use`) and `cli_otp_disabled`;
 *  - the OpenAPI strings that spell a scope name or the tool's wording, and
 *    the document title;
 *  - the OTel service name, read off a span the instance EXPORTS.
 *
 * A tool that takes its own name rewrites the literals of this file with it.
 * The CLI's identity (binary, env prefix, config dir) is pinned by
 * `packages/cli/test/identity.test.ts`.
 *
 * Boot order is load-bearing: OpenTelemetry keeps the FIRST tracer provider a
 * process registers, so the boot that carries the OTLP endpoint comes first.
 */

const OWNER = { email: 'owner@pins.test', name: 'Pins Owner', password: 'pins-owner-password-1' };
const GUEST = { email: 'guest@pins.test', name: 'Pins Guest', password: 'pins-guest-password-1' };
const INVITEE = 'invitee@pins.test';
const OWNER_NEW_EMAIL = 'owner-next@pins.test';

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let collector: Server;
/** Every OTLP/HTTP JSON body the instance exported to the collector. */
const exported: string[] = [];
let app: TestApp;
let bare: TestApp;
let inUse: TestApp;
let cloud: TestApp;
let mail: RecordingEmailDriver;
let ownerCookie: string;
let guestCookie: string;
let guestRowId: string;

let ipCounter = 0;
const nextIp = () => `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const signIn = async (who: { email: string; password: string }) =>
  extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );

/** The link of a mail: the first url of its text part. */
const linkOf = (message: EmailMessage): string => /https?:\/\/\S+/.exec(message.text ?? '')![0];

/**
 * A mail's part with its two run-time values taken out (the link, and the
 * expiry as the mail shell's `fmtDate` writes it: "Thursday 22 January 2026,
 * 14:00 UTC"), so the rest compares as bytes.
 */
const fixed = (part: string | undefined, link: string): string =>
  (part ?? '')
    .split(link)
    .join('<LINK>')
    .replace(/\w+ \d{1,2} \w+ \d{4}, \d{2}:\d{2} UTC/g, '<DATE>');

/** An HTML part on one line: the templates wrap their sentences. */
const oneLine = (html: string): string => html.replace(/\s+/g, ' ');

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * Every tool description that names a tool of the set or the CLI, as
 * `tools/list` answers it. The keys are in the order of the list.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  get_me:
    'Who is connected: the user this MCP connection acts as, with all their organizations. ' +
    'Returns { user: { id, email, name }, workspace, role, via, scopes, workspaces }. ' +
    'Everything done through this server happens as this user. (Alias of starter_whoami.)',
  // The chassis's project and team tools name their siblings under the prefix (the chassis at 0.13.0).
  starter_list_project_members:
    "List a project's members and what each of them may do. Roles, each containing the one before it: " +
    '`viewer` reads the project and what is linked to it; `editor` may also write what is linked to it; ' +
    '`manager` may also rename the project, archive it, and manage its members. An organization owner or ' +
    'admin acts as a manager on every project. A member is a person or a team, told apart by `kind`: a ' +
    'person entry is { kind: "person", userId, email, name, role, addedBy, createdAt }, a team entry ' +
    '{ kind: "team", teamId, slug, name, membersCount, hubTeamId, role, addedBy, createdAt }, and every ' +
    'member of a team holds the team\u2019s role; a person\u2019s effective role is the highest of their own ' +
    'entry and their teams\u2019. Returns { members, nextCursor }; pass a person\u2019s `userId` to the tools ' +
    'that change or remove a member, a team\u2019s `teamId` to starter_set_project_team_role and ' +
    'starter_remove_project_team.',
  starter_add_project_member:
    'Put one of the organization\u2019s own members on a project, with a role \u2014 confirm with the user first. ' +
    'Needs the manager role on the project. Roles, each containing the one before it: `viewer` reads the ' +
    'project and what is linked to it; `editor` may also write what is linked to it; `manager` may also ' +
    'rename the project, archive it, and manage its members. An organization owner or admin acts as a ' +
    'manager on every project. Name the person by either `userId` or `email`, and it must be someone who ' +
    'is already an active member of the organization: this invites nobody and creates no account. Or a ' +
    'team by `teamId` (from starter_list_teams), which puts every member of the team on the project with ' +
    'that role. Exactly one of `userId`, `email` or `teamId`. Returns the new project member, a person or ' +
    'a team entry.',
  starter_list_teams:
    'List the teams of an organization, newest first. A team is a named group of the organization\u2019s own ' +
    'members (for example "Design" or "Sales"). A team can be put on a project with a role, and every ' +
    'member of the team then holds that role on the project. In an organization managed by the Antasphere ' +
    'account site, the teams come from there and are read-only here. Creating a team or adding people to ' +
    'one is done by a person on the People page, or on the Antasphere account site for an organization it ' +
    'manages, never through these tools. Returns { teams: [{ id, slug, name, membersCount, isMember, ' +
    'hubTeamId, createdAt, updatedAt }], nextCursor } \u2014 `isMember` says whether YOU are in the team, and ' +
    '`hubTeamId` is set when the team comes from the Antasphere account site. Pass a team `id` as `teamId` ' +
    'to starter_list_team_members or starter_add_project_member. When nextCursor is non-null, call again ' +
    'with cursor set to it.',
  // The starter's run tool points the agent at its follow-up read under the prefix.
  starter_run_start:
    'Start a run: H\u2019s agent carries out a web task in a cloud browser. `instruction` says what to ' +
    'do in plain words (1 to 2000 characters); `startUrl` (https) is where the browser starts. Answers ' +
    'at once with { run } in state running and its liveUrl (the live view of the browser); follow it ' +
    'with starter_run_get. Spends the organization\u2019s H credits. Always confirm with the user before ' +
    'calling.'
};

/** The argument descriptions that carry the name, the `workspace` argument apart (every tool has that one): none. */
const ARGUMENT_DESCRIPTIONS: Array<[tool: string, argument: string, description: string]> = [];

let rpcId = 0;
async function rpc(key: string, method: string, params: unknown = {}) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result;
}

beforeAll(async () => {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/traces') exported.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const otlp = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  [container, hub] = await Promise.all([startPostgres(), FakeHub.start({ clientId: 'tool-starter-cloud' })]);

  // FIRST boot (see the header): the real composition, exporting its spans.
  mail = new RecordingEmailDriver();
  app = await createTestApp(
    await createDatabase(container, 'identity_pins'),
    { OTEL_EXPORTER_OTLP_ENDPOINT: otlp },
    { email: mail }
  );
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: SETUP_TOKEN, instanceName: 'Identity Pins', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  ownerCookie = await signIn(OWNER);

  // The guest principal, SEEDED: an account plus a guest-origin membership of
  // the host workspace (the template ships no journey that mints one).
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  const guestUserId = (await app.auth.api.signUpEmail({ body: GUEST })).user.id;
  const seeded = await app.db.pool.query<{ id: string }>(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
     VALUES ($1, $2, 'member', 'guest', true) RETURNING id`,
    [me.workspace.id, guestUserId]
  );
  guestRowId = seeded.rows[0]!.id;
  guestCookie = await signIn(GUEST);

  // The real tool definition, with ONE value swapped: a dashboard
  // folder that holds no build, which is what makes the fallback page answer
  // (`apps/server/public` may or may not exist on the machine running this).
  // Never set up, so it also answers with the instance name of a fresh install.
  const emptyPublicDir = await mkdtemp(join(tmpdir(), 'identity-pins-public-'));
  const barePlatform = createPlatform({
    ...theTool,
    runtime: { ...theTool.runtime, publicDir: emptyPublicDir }
  });
  bare = await makeCreateTestApp(barePlatform.boot)(await createDatabase(container, 'identity_pins_bare'));

  // The same definition with ONE other value swapped: a file policy that says
  // every blob is in use. Items reference no blob, so the real composition
  // never sends `file_in_use`; this is what makes the sentence of the `copy`
  // slot observable on the wire.
  const inUsePlatform = createPlatform({
    ...theTool,
    api: {
      ...theTool.api,
      filePolicy: (tool) => ({ ...theTool.api.filePolicy(tool), blobInUse: async () => true })
    }
  });
  inUse = await makeCreateTestApp(inUsePlatform.boot)(
    await createDatabase(container, 'identity_pins_in_use')
  );

  cloud = await createTestApp(await createDatabase(container, 'identity_pins_cloud'), {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: 'tool-starter-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
  });
}, 300_000);

afterAll(async () => {
  await Promise.all([app?.stop(), bare?.stop(), inUse?.stop(), cloud?.stop()]);
  await Promise.all([container?.stop(), hub?.stop()]);
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

describe('the API key prefix and the scope vocabulary', () => {
  let key: string;

  beforeAll(async () => {
    const res = await app.app.request(
      '/api/v1/api-keys',
      json({ name: 'pins-read', scopes: ['items:read'] }, { cookie: ownerCookie })
    );
    expect(res.status).toBe(201);
    key = (await readJson(res)).key as string;
  });

  it('a key minted through the API starts with ytk_', () => {
    expect(key.slice(0, 4)).toBe('ytk_');
    expect(key).toMatch(/^ytk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,}$/);
  });

  it('the mint takes the three scope names and answers with them', async () => {
    const res = await app.app.request(
      '/api/v1/api-keys',
      json(
        { name: 'pins-all', scopes: ['items:read', 'items:write', 'data:export'] },
        { cookie: ownerCookie }
      )
    );
    expect(res.status).toBe(201);
    expect([...(await readJson(res)).apiKey.scopes].sort()).toEqual([
      'data:export',
      'items:read',
      'items:write'
    ]);
  });

  it('a scope name that differs by one byte is not in the vocabulary', async () => {
    for (const scope of ['item:read', 'items:writes', 'data:exports']) {
      const res = await app.app.request(
        '/api/v1/api-keys',
        json({ name: `pins-${scope}`, scopes: [scope] }, { cookie: ownerCookie })
      );
      expect(res.status, scope).toBe(400);
    }
  });

  it('a bearer ytk_ key is accepted on a real route, and the same key under another prefix is not', async () => {
    // The bearer is rebuilt around the literal, so the prefix this test
    // presents is the one spelled here, whatever the mint answered.
    const secret = key.slice(4);
    const accepted = await app.app.request('/api/v1/items', {
      headers: { authorization: `Bearer ytk_${secret}`, 'x-forwarded-for': nextIp() }
    });
    expect(accepted.status).toBe(200);

    const renamed = await app.app.request('/api/v1/items', {
      headers: { authorization: `Bearer slx_${secret}`, 'x-forwarded-for': nextIp() }
    });
    expect(renamed.status).toBe(401);
  });
});

describe('the MCP surface', () => {
  let key: string;

  interface ToolInfo {
    name: string;
    description: string;
    inputSchema: { properties: Record<string, { description?: string }> };
  }
  let tools: ToolInfo[];

  beforeAll(async () => {
    const res = await app.app.request(
      '/api/v1/api-keys',
      json({ name: 'pins-mcp', scopes: ['items:read'] }, { cookie: ownerCookie })
    );
    expect(res.status).toBe(201);
    key = (await readJson(res)).key as string;
    tools = (await rpc(key, 'tools/list')).tools as ToolInfo[];
  });

  it('initialize reports the server name and the instructions, byte for byte', async () => {
    const result = await rpc(key, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'identity-pins', version: '0.0.1' }
    });
    expect(result.serverInfo.name).toBe('starter');
    expect(result.instructions).toBe(
      'MCP endpoint of the "Identity Pins" instance. Every tool acts as the connected ' +
        'user, with the scopes granted on the consent screen (or on the API key). The credential ' +
        'is the USER; the organization (workspace) is a per-call parameter — every tool accepts ' +
        'an optional `workspace` id, defaulting to your default org. Start with starter_whoami ' +
        'to see who is connected and which organizations you can name; the items of an ' +
        'organization live behind the starter_ tools (list_items, get_item, create_item, ' +
        'update_item, delete_item), its projects behind the project tools (list_projects to ' +
        'remove_project_team), its teams behind list_teams and list_team_members, and an item ' +
        'goes in and out of a project with ' +
        'link_item_to_project and unlink_item_from_project. The voice (Gradium) is voice_speak and ' +
        'voice_transcribe; a web task in a cloud browser (H) is run_start, then run_get until it ' +
        'is done, and list_runs.'
    );
  });

  it('tools/list names the two chassis tools, then starter_whoami, then the chassis projects and teams, then the starter_ set, in this order', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'get_me',
      'list_files',
      'starter_whoami',
      // Projects and teams are chassis concepts, so the chassis registers
      // their eleven project tools and two team reads too, under this tool's
      // prefix, before its own set.
      'starter_list_projects',
      'starter_get_project',
      'starter_list_project_members',
      'starter_create_project',
      'starter_update_project',
      'starter_archive_project',
      'starter_add_project_member',
      'starter_set_project_member_role',
      'starter_remove_project_member',
      'starter_set_project_team_role',
      'starter_remove_project_team',
      'starter_list_teams',
      'starter_list_team_members',
      'starter_list_items',
      'starter_get_item',
      'starter_create_item',
      'starter_update_item',
      'starter_delete_item',
      // The item side of projects: the link is the item domain's, so it sits
      // in this set, not the chassis's.
      'starter_link_item_to_project',
      'starter_unlink_item_from_project',
      // The starter's demo: the voice (Gradium), then the runs (H).
      'starter_voice_speak',
      'starter_voice_transcribe',
      'starter_run_start',
      'starter_run_get',
      'starter_list_runs'
    ]);
  });

  it('every tool describes its workspace argument by pointing at starter_whoami', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.properties.workspace?.description, tool.name).toBe(
        'Target organization (workspace id). Omit to use your default org — see starter_whoami.'
      );
    }
  });

  it('every description that names a tool or the CLI is the one spelled here, and no other names one', () => {
    const naming = tools.filter((t) => /starter/i.test(t.description));
    expect(naming.map((t) => t.name)).toEqual(Object.keys(TOOL_DESCRIPTIONS));
    for (const tool of naming) {
      expect(tool.description, tool.name).toBe(TOOL_DESCRIPTIONS[tool.name]);
    }
  });

  it('every other argument description that carries the name is the one spelled here', () => {
    const found: Array<[string, string, string]> = [];
    for (const tool of tools) {
      for (const [argument, schema] of Object.entries(tool.inputSchema.properties)) {
        if (argument === 'workspace') continue;
        if (/starter/i.test(schema.description ?? '')) found.push([tool.name, argument, schema.description!]);
      }
    }
    expect(found).toEqual(ARGUMENT_DESCRIPTIONS);
  });
});

describe('the five generic mails, captured from the flows that send them', () => {
  /**
   * The three places the mail layout prints the name (its title, its header,
   * its footer), and the footer's line saying what the product is, which is
   * the tool's own (`copy.mail.tagline`).
   */
  const TITLE = '<title>Hackathon Starter</title>';
  const HEADER =
    `<td style="vertical-align:middle;font-family:'Sentient',Georgia,'Times New Roman',serif;` +
    `font-size:23px;font-weight:300;letter-spacing:-0.01em;color:#1c1915">Hackathon Starter</td>`;
  const FOOTER =
    `<p style="margin:0 0 3px;font-family:'Sentient',Georgia,'Times New Roman',serif;` +
    `font-size:15px;font-weight:400;color:#1c1915">Hackathon Starter</p>`;
  const TAGLINE = '>A workspace for your team’s items. An Antasphere tool.</p>';
  /** Every mail carries the layout's three names and the tagline. */
  const expectLayout = (html: string): void => {
    expect(html).toContain(TITLE);
    expect(html).toContain(HEADER);
    expect(html).toContain(FOOTER);
    expect(html).toContain(TAGLINE);
  };

  /** The mail a flow just sent: exactly one since `mail.sent` was emptied. */
  async function theOneMail(): Promise<EmailMessage> {
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
    return mail.sent[0]!;
  }

  it('the workspace invitation', async () => {
    mail.sent.length = 0;
    const res = await app.app.request(
      '/api/v1/invitations',
      json({ email: INVITEE, role: 'member' }, { cookie: ownerCookie })
    );
    expect(res.status).toBe(201);
    const message = await theOneMail();
    const link = linkOf(message);

    expect(message.subject).toBe('Pins Owner invited you to Identity Pins');
    expect(fixed(message.text, link)).toBe(
      'Pins Owner invited you to join Identity Pins on Hackathon Starter.\n\nJoin the workspace: <LINK>\n\n' +
        'The invitation stays open until <DATE>.'
    );
    const html = oneLine(message.html);
    // the layout's three, the inbox preview line, and the body
    expect(occurrences(html, 'Hackathon Starter')).toBe(5);
    expectLayout(html);
    expect(html).toContain(
      '>Join Identity Pins on Hackathon Starter: their items, and a place for yours.</div>'
    );
    expect(html).toContain(
      'You have been invited to <strong>Identity Pins</strong>, a workspace on Hackathon Starter. ' +
        'Join to see the items the team keeps there, and to add your own.</p>'
    );
    expect(html).toContain('This invitation was sent to invitee@pins.test and stays open until ');
  });

  it('the password reset', async () => {
    mail.sent.length = 0;
    const res = await app.app.request(
      '/api/v1/auth/request-password-reset',
      json({ email: OWNER.email, redirectTo: 'http://localhost:3000/reset-password' })
    );
    expect(res.status).toBe(200);
    const message = await theOneMail();
    const link = linkOf(message);

    expect(message.subject).toBe('Reset your Hackathon Starter password');
    expect(fixed(message.text, link)).toBe(
      'Reset your Hackathon Starter password: <LINK>\n\nThe link works until <DATE>. ' +
        'If you did not ask for this, ignore this email: your password stays as it is.'
    );
    const html = oneLine(message.html);
    expect(occurrences(html, 'Hackathon Starter')).toBe(4);
    expectLayout(html);
    expect(html).toContain(
      'Someone asked to reset the password of your Hackathon Starter account. If that was you, choose a new one here:</p>'
    );
  });

  it('the email-change confirmation (to the old address), then the email verification (to the new one)', async () => {
    mail.sent.length = 0;
    const res = await app.app.request(
      '/api/v1/auth/change-email',
      json({ newEmail: OWNER_NEW_EMAIL, callbackURL: '/account' }, { cookie: ownerCookie })
    );
    expect(res.status).toBe(200);
    const confirm = await theOneMail();
    const confirmLink = linkOf(confirm);

    expect(confirm.to).toBe(OWNER.email);
    expect(confirm.subject).toBe('Confirm your Hackathon Starter email change');
    expect(fixed(confirm.text, confirmLink)).toBe(
      'Confirm changing your Hackathon Starter email to owner-next@pins.test: <LINK>\n\n' +
        'The link works until <DATE>. If you did not ask for this, ignore this email: your address stays as it is.'
    );
    const confirmHtml = oneLine(confirm.html);
    expect(occurrences(confirmHtml, 'Hackathon Starter')).toBe(4);
    expectLayout(confirmHtml);
    expect(confirmHtml).toContain(
      'You asked to change the email of your Hackathon Starter account to <strong>owner-next@pins.test</strong>.'
    );

    // Consuming the confirmation sends the second leg; its link is left
    // unused, so the owner keeps the address the other tests sign in with.
    mail.sent.length = 0;
    const consumed = await app.app.request(confirmLink, { headers: { cookie: ownerCookie } });
    expect(consumed.status).toBeGreaterThanOrEqual(300);
    expect(consumed.status).toBeLessThan(400);
    const verify = await theOneMail();
    const verifyLink = linkOf(verify);

    expect(verify.to).toBe(OWNER_NEW_EMAIL);
    expect(verify.subject).toBe('Verify your Hackathon Starter email address');
    expect(fixed(verify.text, verifyLink)).toBe(
      'Verify your Hackathon Starter email address: <LINK>\n\n' +
        'The link works until <DATE>. If you did not ask for this, ignore this email.'
    );
    const verifyHtml = oneLine(verify.html);
    expect(occurrences(verifyHtml, 'Hackathon Starter')).toBe(4);
    expectLayout(verifyHtml);
    expect(verifyHtml).toContain(
      'One click confirms that this address belongs to you, and it becomes the email of your Hackathon Starter account.</p>'
    );
  });

  it('the sign-in code', async () => {
    mail.sent.length = 0;
    const res = await app.app.request(
      '/api/v1/auth/email-otp/send-verification-otp',
      json({ email: OWNER.email, type: 'sign-in' })
    );
    expect(res.status).toBe(200);
    const message = await theOneMail();
    const code = /code: (\d+)/.exec(message.text ?? '')![1]!;

    expect(code).toMatch(/^\d{6}$/);
    expect(message.subject).toBe(`${code} is your Hackathon Starter code`);
    expect(message.text).toBe(
      `Your Hackathon Starter code: ${code}\n\n` +
        'It works once and only for a few minutes. If you did not ask for it, ignore this email.'
    );
    const html = oneLine(message.html);
    expect(occurrences(html, 'Hackathon Starter')).toBe(4);
    expectLayout(html);
    expect(html).toContain('Type this into Hackathon Starter to continue:</p>');
  });
});

describe('an instance with no dashboard build, not set up', () => {
  it('serves the fallback page: the title and the heading carry the name', async () => {
    const res = await bare.app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '<!doctype html><title>Hackathon Starter</title><h1>Hackathon Starter API is running</h1>' +
        '<p>No dashboard build found. API health: <a href="/healthz">/healthz</a></p>'
    );
  });

  it('answers the discovery route with the default instance name', async () => {
    const info = await readJson(await bare.app.request('/api/v1/instance'));
    expect(info.setupRequired).toBe(true);
    expect(info.name).toBe('Hackathon Starter');
  });
});

describe('the wire sentences', () => {
  const errorOf = async (res: Response): Promise<{ code: string; message: string }> => {
    const { code, message } = (await readJson(res)).error;
    return { code, message };
  };

  it('guest_forbidden, from the guard in front of the workspace-level routes', async () => {
    const res = await app.app.request('/api/v1/files', { headers: { cookie: guestCookie } });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({
      code: 'guest_forbidden',
      message: 'Guest access is limited to what you were invited to'
    });
  });

  it('guest_forbidden, from the workspace creation refusal (the same sentence, a second source)', async () => {
    const res = await app.app.request(
      '/api/v1/workspaces',
      json({ name: 'Guest land' }, { cookie: guestCookie })
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({
      code: 'guest_forbidden',
      message: 'Guest access is limited to what you were invited to'
    });
  });

  it('guest_target, with its typographic apostrophe (U+2019) and its em dash', async () => {
    const res = await app.app.request(
      `/api/v1/members/${guestRowId}/reset-link`,
      json({}, { cookie: ownerCookie })
    );
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error).toEqual({
      code: 'guest_target',
      message: 'This member is an external guest — their account is not this workspace’s to recover'
    });
    expect(error.message).toContain('’');
    expect(error.message).toContain('—');
  });

  it('file_in_use, with its em dash (on the composition whose file policy says a blob is in use)', async () => {
    const owner = { email: 'owner@inuse.test', name: 'In Use Owner', password: 'in-use-owner-password-1' };
    const setup = await inUse.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'In Use', owner })
    );
    expect(setup.status).toBe(201);
    const cookie = extractCookie(
      await inUse.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: owner.email, password: owner.password })
      )
    );
    const uploaded = await inUse.app.request('/api/v1/files?name=pins.html', {
      method: 'POST',
      headers: { 'content-type': 'text/html', cookie, 'x-forwarded-for': nextIp() },
      body: '<!doctype html><html><body><h1>pins</h1></body></html>'
    });
    expect(uploaded.status).toBe(201);
    const blobId = (await readJson(uploaded)).file.id as string;
    const res = await inUse.app.request(`/api/v1/files/${blobId}`, {
      method: 'DELETE',
      headers: { cookie, 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error).toEqual({
      code: 'file_in_use',
      message: 'This file is referenced by a resource of the workspace — delete that resource first'
    });
    expect(error.message).toContain('—');
  });

  it('cli_otp_disabled, on both CLI mint routes of the cloud edition', async () => {
    const attempts: Array<[string, unknown]> = [
      ['/api/v1/cli/auth/request', { email: OWNER.email }],
      ['/api/v1/cli/auth/complete', { email: OWNER.email, otp: '123456' }]
    ];
    for (const [path, body] of attempts) {
      const res = await cloud.app.request(path, json(body));
      expect(res.status, path).toBe(403);
      expect(await errorOf(res), path).toEqual({
        code: 'cli_otp_disabled',
        message:
          'This instance signs in through the Antasphere hub — run `antasphere login` once; ' +
          'the Hackathon Starter CLI then connects automatically'
      });
    }
  });
});

describe('the OpenAPI document', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;

  beforeAll(async () => {
    const res = await app.app.request('/api/v1/openapi.json', { headers: { 'x-forwarded-for': nextIp() } });
    expect(res.status).toBe(200);
    doc = await readJson(res);
  });

  it('keeps its title', () => {
    expect(doc.info.title).toBe('Platform API');
  });

  it('spells the scope names in the two summaries that carry them', () => {
    expect(doc.paths['/cli/auth/complete'].post.summary).toBe(
      'Verify a sign-in code and mint an API key (shown once, items:read+write)'
    );
    expect(doc.paths['/workspace/export'].get.summary).toBe(
      'Full workspace export as a streamed zip (admin+; keys need data:export)'
    );
  });

  it('describes the file-in-use refusal in the tool’s words', () => {
    expect(doc.paths['/files/{id}'].delete.responses['409'].description).toBe(
      'file_in_use: referenced by a resource of the workspace'
    );
  });
});

// LAST on purpose: reading the export means shutting the tracer provider down.
describe('the OTel service name', () => {
  it('is the resource attribute of every exported span and the tracer name of the request spans', async () => {
    const res = await app.app.request('/healthz');
    expect(res.status).toBe(200);
    await app.otel.shutdown();

    // Better Auth traces under a tracer of its own; the instance's is the one
    // behind the request spans.
    const serviceNames = new Set<string>();
    const requestTracers = new Set<string>();
    for (const body of exported) {
      for (const resourceSpans of JSON.parse(body).resourceSpans) {
        for (const attribute of resourceSpans.resource.attributes) {
          if (attribute.key === 'service.name') serviceNames.add(attribute.value.stringValue);
        }
        for (const scopeSpans of resourceSpans.scopeSpans) {
          const names: string[] = scopeSpans.spans.map((span: { name: string }) => span.name);
          if (names.includes('GET /healthz')) requestTracers.add(scopeSpans.scope.name);
        }
      }
    }
    expect([...serviceNames]).toEqual(['starter']);
    expect([...requestTracers]).toEqual(['starter']);
  });
});
