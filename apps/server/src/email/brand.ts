import { IDENTITY } from '@app/contract';
import type { MailBrand } from '@antasphere/chassis-server/email';

/** The name and the footer line every mail of this tool is set under. */
export const MAIL_BRAND: MailBrand = {
  name: IDENTITY.displayName,
  tagline: 'A workspace for your team’s items. An Antasphere tool.'
};

/**
 * The account mails' words that are the tool's own: the tool definition's
 * `copy.mail` slot. The layout and every other sentence are the chassis's. A
 * mail of the tool's own domain goes beside this file and composes the same
 * shell and blocks (`makeShell(MAIL_BRAND)`, `para`, `button`, `facts`, …).
 */
export const MAIL_COPY = {
  tagline: MAIL_BRAND.tagline,
  invitePitch: 'Join to see the items the team keeps there, and to add your own.',
  invitePreheader: 'their items, and a place for yours.'
};
