import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** Tutor Studio moved to its own full-screen app. */
export const load: PageLoad = () => {
  redirect(307, '/studio');
};
