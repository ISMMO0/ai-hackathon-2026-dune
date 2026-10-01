/**
 * The product's ONE motion (PRDCT-2308): a duration and an easing for every
 * popover, menu and fold. CSS cannot import a constant, so the two values
 * are MIRRORED where they are used: `apps/dashboard/src/lib/tokens.css`
 * (`--motion-duration`, `--motion-ease`). A surface rendered outside the
 * dashboard mirrors them the same way. A unit test on each side pins its
 * mirror against this file, so a change here that is not carried over goes
 * red instead of drifting. Reduced-motion preferences zero the duration on
 * every surface.
 */
export const MOTION_DURATION_MS = 160;
export const MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
