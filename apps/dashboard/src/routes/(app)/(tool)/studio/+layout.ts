import { requireMember } from '$lib/member-guard';
import type { LayoutLoad } from './$types';

/**
 * Tutor Studio is a full-screen app of its own: `+layout@.svelte` resets past
 * the dashboard shell, so the studio calls the same member guard the shell does.
 */
export const load: LayoutLoad = async ({ parent, url }) => {
  return { me: requireMember(await parent(), url) };
};
