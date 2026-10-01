import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The item dialog reports a failed save through `toastApiError`, so a billing
 * refusal (402 entitlement_denied, 403 plan_required) is its card with the
 * hub's link, as the files page shows it. Before 29 September 2026 the dialog
 * put the server's sentence, raw URL included, in a plain error toast (lane E2
 * of the 0.13.0 wave, the cloud walk's first finding).
 */
describe('ItemDialog', () => {
  const source = readFileSync(new URL('./ItemDialog.svelte', import.meta.url), 'utf8');

  it('reports a failed save through the billing-aware toast', () => {
    expect(source).toContain("import { toastApiError } from '$lib/billing-refusal';");
    expect(source).toMatch(/toastApiError\(e, t\(item \? 'common\.updateFailed' : 'items\.createFailed'\)\)/);
  });

  it('never puts a bare error sentence in a toast', () => {
    expect(source).not.toMatch(/toast\.error\(errorMessage\(/);
    expect(source).not.toMatch(/import \{[^}]*errorMessage[^}]*\} from '\$lib\/api'/);
  });
});
