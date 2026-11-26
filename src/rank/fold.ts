/**
 * Bundle folding for skill lists.
 *
 * skills.sh counts installs per repository: installing a repo records one install for
 * every skill in it, so the skills of one repo move almost in lockstep (week-over-week
 * correlation 0.98 within a repo, 0.00 across repos, measured 2026-11-26) and a single
 * repo could fill a third of a Top 100. A list folds those skills into one row: the
 * best-ranked one stands for the bundle, and the rest ride along as `group_members`.
 *
 * Only skills whose last-week installs are within FOLD_TOLERANCE of the bundle's lead
 * fold: a skill people install on its own (its weekly count clearly apart) keeps its
 * own row even when it shares the repo.
 */

export const FOLD_TOLERANCE = 0.1;

export interface FoldKey {
  /** Repository the counts come from (skills.sh `owner/repo`); undefined never folds. */
  repo?: string;
  /** Installs in the most recent week; undefined or 0 never folds. */
  weekly?: number;
}

export interface Bundle<T> {
  lead: T;
  /** Folded skills, best-ranked first; the lead is not included. */
  members: T[];
}

/**
 * Groups `items` (already in list order) into bundles. Each item joins the first
 * earlier bundle of the same repo whose lead's weekly count is within the tolerance;
 * comparing against the lead, not the last member, keeps a bundle from drifting.
 * Bundles keep the order of their leads.
 */
export function foldBundles<T>(items: readonly T[], keyOf: (item: T) => FoldKey, tolerance = FOLD_TOLERANCE): Bundle<T>[] {
  const bundles: Array<Bundle<T> & { repo?: string; weekly?: number }> = [];
  const byRepo = new Map<string, Array<Bundle<T> & { weekly: number }>>();
  for (const item of items) {
    const { repo, weekly } = keyOf(item);
    const foldable = repo !== undefined && weekly !== undefined && weekly > 0;
    if (foldable) {
      const r = repo.toLowerCase();
      const host = byRepo.get(r)?.find((b) => Math.abs(weekly - b.weekly) <= tolerance * b.weekly);
      if (host) {
        host.members.push(item);
        continue;
      }
      const b = { lead: item, members: [] as T[], weekly };
      bundles.push(b);
      byRepo.set(r, [...(byRepo.get(r) ?? []), b]);
    } else {
      bundles.push({ lead: item, members: [] });
    }
  }
  return bundles.map(({ lead, members }) => ({ lead, members }));
}
