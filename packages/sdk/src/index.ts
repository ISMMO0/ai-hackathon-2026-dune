import { ChassisClient, type ListParams } from '@antasphere/chassis-sdk';
import type {
  Integrations,
  Item,
  ItemCreate,
  ItemCreated,
  ItemsList,
  ItemUpdate,
  Run,
  RunCreate,
  RunCreated,
  RunsList,
  Scope,
  VoiceSpeech,
  VoiceTranscribeRequest,
  VoiceTranscript
} from '@app/contract';

/**
 * The generic half of the client (errors, options, the list and audit params,
 * the idempotency options, the deadlines) lives in `@antasphere/chassis-sdk`.
 * This explicit list keeps the public surface of `@app/sdk` exactly what
 * it was before the split (PRDCT-2530); it is the only re-export of the change.
 */
export {
  PlatformApiError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  type ClientOptions,
  type ListParams,
  type AuditListResponse,
  type AuditListParams,
  type InvitationAccepted,
  type FileUploaded,
  type IdempotentRequestOptions
} from '@antasphere/chassis-sdk';

/** Params of {@link PlatformClient.items}: the page, and the project the list is kept to. */
export interface ItemListParams extends ListParams {
  /** Keeps only the items linked to this project. A project the caller cannot read answers 404. */
  project?: string;
}

/**
 * Thin typed client over /api/v1: the generic calls come from the chassis client,
 * instantiated with the tool's scopes; the tool's own calls are declared here.
 */
export class PlatformClient extends ChassisClient<Scope> {
  // ── Items ─────────────────────────────────────────────────────────────────
  // One method per contract route, typed by the contract's own types: the
  // route-coverage test fails on a contract route that has no method here.

  items(params: ItemListParams = {}): Promise<ItemsList> {
    return this.request('GET', this.pathWithQuery('/items', params, { project: params.project }));
  }

  createItem(req: ItemCreate): Promise<ItemCreated> {
    return this.request('POST', '/items', req);
  }

  item(id: string): Promise<Item> {
    return this.request('GET', `/items/${encodeURIComponent(id)}`);
  }

  updateItem(id: string, patch: ItemUpdate): Promise<Item> {
    return this.request('PATCH', `/items/${encodeURIComponent(id)}`, patch);
  }

  /** Answers the deleted item's final snapshot, like every delete of the API. */
  deleteItem(id: string): Promise<Item> {
    return this.request('DELETE', `/items/${encodeURIComponent(id)}`);
  }

  // ── Items in projects ─────────────────────────────────────────────────────
  // The chassis client carries the projects themselves (`projects()`,
  // `createProject()`, the members); these two are the item's side of them.

  /** Put an item in a project: the editor role or more on a live project. */
  linkItemProject(id: string, projectId: string): Promise<Item> {
    return this.request('PUT', `/items/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`);
  }

  /** Take an item out of a project: the same gate as the link. */
  unlinkItemProject(id: string, projectId: string): Promise<Item> {
    return this.request(
      'DELETE',
      `/items/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`
    );
  }

  // ── Integrations ──────────────────────────────────────────────────────────

  /** Whether Gradium and H are configured; `check` makes one cheap live call to each. */
  integrations(options: { check?: boolean } = {}): Promise<Integrations> {
    return this.request('GET', options.check ? '/integrations?check=true' : '/integrations');
  }

  // ── Voice ─────────────────────────────────────────────────────────────────

  /** Speak a text: the wav, base64 encoded. */
  speak(text: string): Promise<VoiceSpeech> {
    return this.request('POST', '/voice/speak', { text });
  }

  /** Transcribe a wav (base64, at most 5 MiB decoded). */
  transcribe(req: VoiceTranscribeRequest): Promise<VoiceTranscript> {
    return this.request('POST', '/voice/transcribe', req);
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  /** Start a run: H carries out the instruction in a cloud browser. Answers at once, `running`. */
  createRun(req: RunCreate): Promise<RunCreated> {
    return this.request('POST', '/runs', req);
  }

  /** The runs of the workspace, newest first, as last seen. */
  listRuns(params: ListParams = {}): Promise<RunsList> {
    return this.request('GET', this.pathWithQuery('/runs', params));
  }

  /** One run, refreshed from H while it is running: poll it until `state` is not `running`. */
  getRun(id: string): Promise<Run> {
    return this.request('GET', `/runs/${encodeURIComponent(id)}`);
  }
}
