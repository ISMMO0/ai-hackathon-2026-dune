import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The ENTRY LIST of the template's workspace export, by literal and in order,
 * through the real boot (ported from Slideless's test of the same name,
 * PRDCT-2543, with the tool's two entries). `items-export.test.ts` proves the
 * tool's entries; this file proves the WHOLE bundle: the chassis sections, the
 * tool's `items.json` and `item_projects.json` after `files.json`, the live
 * blobs, the skip list. It turns red the day an entry appears, disappears or
 * moves, a chassis re-copy included. The second test pins the key set of every
 * JSON entry, so a field that appears or disappears is a change of the bundle
 * someone decided.
 */

const OWNER = { email: 'owner@entries.test', name: 'Entries Owner', password: 'entries-owner-password-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let liveId: string;

const json = (method: string, body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method,
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

async function upload(name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: ownerCookie },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

async function post(path: string, body: unknown, method = 'POST'): Promise<Record<string, unknown>> {
  const res = await app.app.request(`/api/v1${path}`, json(method, body, { cookie: ownerCookie }));
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return readJson(res);
}

async function exportBundle(): Promise<AdmZip> {
  const res = await app.app.request('/api/v1/workspace/export', {
    headers: { cookie: ownerCookie, 'x-forwarded-for': '10.9.0.1' }
  });
  expect(res.status).toBe(200);
  return new AdmZip(Buffer.from(await res.arrayBuffer()));
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'export_entries'));
  await app.app.request(
    '/api/v1/setup',
    json('POST', { setupToken: 'integration-test-setup-token', instanceName: 'Entries', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json('POST', { email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': '10.9.0.1' })
  );
  ownerCookie = extractCookie(signIn);

  // One row in every section: a live blob and a deleted one (the skip list),
  // a pending invitation, a key PINNED to the workspace (the only kind the
  // section lists), a project with its creator's grant, a team seating the
  // owner and holding a place on the project, an item linked into it.
  liveId = await upload('kept.bin', 'a blob that stays');
  const trashedId = await upload('trashed.txt', 'a blob that goes');
  const deleted = await app.app.request(`/api/v1/files/${trashedId}`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie }
  });
  expect(deleted.status).toBe(200);

  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  await post('/invitations', { email: 'invited@entries.test', role: 'member' });
  await post('/api-keys', { name: 'pinned', scopes: ['items:read'], workspaceId: me.workspace.id });
  const project = await post('/projects', { name: 'Entries project' });
  const team = await post('/teams', { name: 'Entries team' });
  await post(`/teams/${team.id as string}/members`, { email: OWNER.email });
  await post(`/projects/${project.id as string}/members`, { teamId: team.id, role: 'viewer' });
  await post('/items', { name: 'Entries item', projectIds: [project.id] });
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('GET /workspace/export, the entry list of the template bundle', () => {
  it('is the chassis sections, the tool’s three entries after files.json, the live blobs, then the skip list: exactly, in this order', async () => {
    const zip = await exportBundle();
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      'manifest.json',
      'workspace.json',
      'members.json',
      'invitations.json',
      'api-keys.json',
      'projects.json',
      'project_members.json',
      'teams.json',
      'team_members.json',
      'project_teams.json',
      'audit-log.ndjson',
      'files.json',
      'items.json',
      'item_projects.json',
      'runs.json',
      `files/${liveId}-kept.bin`,
      'skipped-blobs.json'
    ]);
    // The manifest names no entry and counts none: a tool's entries never move it.
    expect(Object.keys(JSON.parse(zip.readAsText('manifest.json')))).toEqual([
      'formatVersion',
      'exportedAt',
      'instance',
      'workspaceId'
    ]);
  });

  it('each entry has exactly these keys: a field that appears or disappears is a change of the bundle', async () => {
    const zip = await exportBundle();
    const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
    const firstRow = (entry: string) => {
      const rows = JSON.parse(zip.readAsText(entry)) as unknown[];
      expect(rows.length, entry).toBeGreaterThan(0);
      return rows[0];
    };

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(keysOf(manifest)).toEqual(['exportedAt', 'formatVersion', 'instance', 'workspaceId']);
    expect(keysOf(manifest.instance)).toEqual(['edition', 'instanceId', 'name', 'version']);
    expect(keysOf(JSON.parse(zip.readAsText('workspace.json')))).toEqual(['createdAt', 'id', 'name']);
    expect(keysOf(firstRow('members.json'))).toEqual([
      'createdAt',
      'email',
      'id',
      'isActive',
      'lastSeenAt',
      'name',
      'role',
      'userId'
    ]);
    const invitation = firstRow('invitations.json');
    expect(keysOf(invitation)).toEqual([
      'acceptedAt',
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedBy',
      'revokedAt',
      'role'
    ]);
    const apiKey = firstRow('api-keys.json');
    expect(keysOf(apiKey)).toEqual([
      'createdAt',
      'createdBy',
      'expiresAt',
      'id',
      'keyId',
      'lastUsedAt',
      'name',
      'revokedAt',
      'scopes'
    ]);
    expect(keysOf(firstRow('projects.json'))).toEqual([
      'archivedAt',
      'createdAt',
      'createdBy',
      'description',
      'id',
      'metadata',
      'name',
      'updatedAt'
    ]);
    expect(keysOf(firstRow('project_members.json'))).toEqual([
      'addedBy',
      'createdAt',
      'id',
      'memberId',
      'projectId',
      'role',
      'userId'
    ]);
    expect(keysOf(firstRow('teams.json'))).toEqual([
      'createdAt',
      'createdBy',
      'hubTeamId',
      'id',
      'name',
      'slug',
      'updatedAt'
    ]);
    expect(keysOf(firstRow('team_members.json'))).toEqual([
      'addedBy',
      'createdAt',
      'id',
      'memberId',
      'teamId',
      'userId'
    ]);
    expect(keysOf(firstRow('project_teams.json'))).toEqual([
      'addedBy',
      'createdAt',
      'id',
      'projectId',
      'role',
      'teamId'
    ]);
    expect(keysOf(firstRow('files.json'))).toEqual([
      'contentType',
      'createdAt',
      'createdBy',
      'deletedAt',
      'id',
      'originalName',
      'sha256',
      'sizeBytes'
    ]);
    expect(keysOf(firstRow('items.json'))).toEqual([
      'createdAt',
      'createdBy',
      'id',
      'name',
      'note',
      'updatedAt',
      'workspaceId'
    ]);
    expect(keysOf(firstRow('item_projects.json'))).toEqual([
      'addedBy',
      'createdAt',
      'itemId',
      'projectId',
      'workspaceId'
    ]);
    const auditLines = zip.readAsText('audit-log.ndjson').split('\n').filter(Boolean);
    expect(auditLines.length).toBeGreaterThan(0);
    expect(keysOf(JSON.parse(auditLines[0]!))).toEqual([
      'action',
      'actorUserId',
      'actorVia',
      'apiKeyId',
      'createdAt',
      'id',
      'ip',
      'metadata',
      'requestId',
      'resourceId',
      'resourceType',
      'workspaceId'
    ]);
    expect(keysOf(firstRow('skipped-blobs.json'))).toEqual(['fileId', 'reason', 'sha256']);
    // No secret anywhere in the JSON sections, whatever the key it would hide under.
    for (const entry of ['invitations.json', 'api-keys.json']) {
      expect(zip.readAsText(entry)).not.toMatch(/tokenHash|secretHash|token_hash|secret_hash/);
    }
  });
});
