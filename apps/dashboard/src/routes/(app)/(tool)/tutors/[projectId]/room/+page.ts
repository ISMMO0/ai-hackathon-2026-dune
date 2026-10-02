import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** The Tutor Room moved into the full-screen Tutor Studio. */
export const load: PageLoad = ({ params }) => {
  redirect(307, `/studio/tutors/${params.projectId}/room`);
};
