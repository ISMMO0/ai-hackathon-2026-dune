/**
 * The path shown in the bar beside the sidebar toggle once a page's own header
 * has scrolled away: `Files / Quarterly review`. The shell derives the first
 * crumb from the navigation model; a page that knows more (an object's name)
 * adds its own with `crumbs.set` from an effect and clears it on teardown.
 * Labels may be user-authored (a name someone typed): text interpolation only.
 */
export interface Crumb {
  label: string;
  href?: string;
}

class Crumbs {
  /** The crumbs a page added after the section's own, in order. */
  extra = $state<Crumb[]>([]);

  set(extra: Crumb[]): void {
    this.extra = extra;
  }
  clear(): void {
    this.extra = [];
  }
}

export const crumbs = new Crumbs();
