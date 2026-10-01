import { IDENTITY, type Scope } from '@app/contract';
import { createScopeAllowlist, type ScopeRule } from '@antasphere/chassis-server/middleware';

/**
 * The tool's half of the fail-closed endpoint allowlist for machine
 * principals. The mechanism and the rules of the generic endpoints (`/me`,
 * `/files`, `DELETE /cli/auth/key`, `/workspace/export`) live in
 * `@antasphere/chassis-server/middleware`; this file owns the scope NAMES and
 * the item rules, and exports the composed `requiredScopeFor` — chassis rules
 * first, then the rules below, `null` (403) when nothing matched.
 */
export type { Scope };

/** The three scope names, spelled ONCE in the tool's identity (`packages/contract/src/identity.ts`). */
const { read: READ, write: WRITE, dataExport: DATA_EXPORT } = IDENTITY.scopes;

/**
 * Products rename items:read / items:write to their domain's scopes in the
 * tool's identity, and in the consent page copy.
 */
export const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  READ,
  WRITE,
  // Full-workspace export download — a deliberate opt-in, never implied by
  // items:read (see the chassis allowlist rules).
  DATA_EXPORT
] as const;

/** The CLI key's fixed grant — the agent surface, never data:export. */
export const CLI_KEY_SCOPES = [READ, WRITE] as const;

const itemRules: ReadonlyArray<ScopeRule<Scope>> = [
  // The item domain: the primary agent surface. Covers the whole /items
  // tree. Reads → items:read, mutations → items:write. (Per-route
  // authorization still applies on top: the scope opens the door, the
  // handler's own checks rule.)
  (path, _method, isRead) => {
    if (path === '/api/v1/items' || path.startsWith('/api/v1/items/')) {
      return isRead ? READ : WRITE;
    }
    return null;
  },
  // The starter's integrations report (`GET /integrations`): a read, and
  // nothing else on that path.
  (path, _method, isRead) => {
    if (path === '/api/v1/integrations') return isRead ? READ : null;
    return null;
  },
  // The voice (`POST /voice/speak`, `POST /voice/transcribe`): writes, since
  // each spends the workspace's Gradium credits. No read on the tree.
  (path, _method, isRead) => {
    if (path.startsWith('/api/v1/voice/')) return isRead ? null : WRITE;
    return null;
  },
  // The runs (H): reads under the read scope, the create under the write one.
  (path, _method, isRead) => {
    if (path === '/api/v1/runs' || path.startsWith('/api/v1/runs/')) return isRead ? READ : WRITE;
    return null;
  }
  // Anything NOT listed here or beside the chassis rules is fail-closed (403)
  // for keys and tokens: a new surface stays shut to machine credentials until
  // it is opened by a rule. (The generic unlisted surfaces — /sso/logout,
  // POST /workspaces, /me/onboarding/dismiss — are recorded beside the chassis
  // rules.)
];

export const requiredScopeFor = createScopeAllowlist<Scope>({
  read: READ,
  write: WRITE,
  dataExport: DATA_EXPORT,
  rules: itemRules
});
