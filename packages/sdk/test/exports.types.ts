/**
 * The TYPE half of the public surface of `@app/sdk` (PRDCT-2530,
 * verifier F-5): every exported type, imported BY NAME, so that a name dropped
 * from `src/index.ts` (its own interfaces, or the re-export list over
 * `@antasphere/chassis-sdk`) fails `typecheck` with TS2305. No test runs this
 * file; `tsconfig.test.json` compiles it. The runtime names are pinned by
 * `exports.test.ts`.
 */
import type {
  AuditListParams,
  AuditListResponse,
  ClientOptions,
  FileUploaded,
  IdempotentRequestOptions,
  InvitationAccepted,
  ListParams,
  PlatformApiError,
  PlatformClient
} from '../src/index.js';

/** One use per name: an unused import would be dropped by a formatter pass. */
export type SdkPublicTypes = [
  AuditListParams,
  AuditListResponse,
  ClientOptions,
  FileUploaded,
  IdempotentRequestOptions,
  InvitationAccepted,
  ListParams,
  PlatformApiError,
  PlatformClient
];
