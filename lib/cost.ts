/**
 * cost.ts — Firecrawl credit / plan arithmetic.
 *
 * WHY THIS IS A FIRST-CLASS MODULE AND NOT A FOOTNOTE
 *
 * The client asked for 55 sites every 20 minutes. That is 118,800 page-fetches
 * a month, and the naive implementation (JSON-extract on every check) costs
 * 594,000 Firecrawl credits — a $749/mo Scale plan. The gig pays $400 once.
 *
 * Every competing bidder will quote $400 and discover this later. Surfacing the
 * real number, with a slider the client can move, is the single strongest
 * differentiator in the proposal, so the arithmetic lives here, is unit-tested,
 * and drives the UI directly.
 *
 * Credit costs verified against firecrawl.dev/pricing on 2026-07-31:
 *   scrape ............................ 1 credit / page
 *   + JSON format ..................... +4 credits / page
 *   changeTracking (basic + git-diff) .. FREE
 *   monitor scrape .................... 1 credit / URL / check
 *   monitor judge ..................... +1 credit per CHANGED page judged
 */

export interface Plan {
  name: string;
  credits: number;
  monthlyUsd: number;
}

/** Firecrawl self-serve plans, ascending. */
export const PLANS: Plan[] = [
  { name: "Free", credits: 1_000, monthlyUsd: 0 },
  { name: "Hobby", credits: 5_000, monthlyUsd: 19 },
  { name: "Standard", credits: 100_000, monthlyUsd: 99 },
  { name: "Growth", credits: 500_000, monthlyUsd: 399 },
  { name: "Scale", credits: 1_000_000, monthlyUsd: 749 },
];

export const CREDITS = {
  scrape: 1,
  jsonAddOn: 4,
  judgePerChangedPage: 1,
} as const;

/** Average days per month — checks/month depends on it, so keep it honest. */
const DAYS_PER_MONTH = 30.44;

export type Strategy = "naive" | "diffOnly" | "tiered";

export interface CostInput {
  /** Total sites being monitored. */
  sites: number;
  /** Minutes between checks. */
  intervalMinutes: number;
  /**
   * Sites that expose a usable RSS/Atom feed. These cost ZERO credits because
   * we fetch the feed directly. Measured 2/8 on a sample probe; Q4 Inc IR
   * platforms commonly expose one, so 15-25 of 55 is a realistic expectation --
   * but it must be verified per site at onboarding, never assumed.
   */
  sitesWithFeed?: number;
  /** Expected NEW releases per site per month (drives tier-3 spend). */
  releasesPerSitePerMonth?: number;
  /** Monitor AI judging: +1 credit per changed page. Second false-positive defence. */
  judging?: boolean;
}

export interface CostResult {
  strategy: Strategy;
  checksPerMonth: number;
  /** Sites actually hitting the paid API each check. */
  billableSites: number;
  monitoringCredits: number;
  extractionCredits: number;
  judgeCredits: number;
  totalCredits: number;
  plan: Plan;
  /** True when even the largest self-serve plan is insufficient. */
  exceedsSelfServe: boolean;
  firecrawlUsd: number;
}

export function checksPerMonth(intervalMinutes: number): number {
  if (intervalMinutes <= 0) return 0;
  return Math.round((60 / intervalMinutes) * 24 * DAYS_PER_MONTH);
}

/** Smallest plan that covers `credits`. Returns the largest if none do. */
export function planFor(credits: number): { plan: Plan; exceeds: boolean } {
  for (const plan of PLANS) {
    if (credits <= plan.credits) return { plan, exceeds: false };
  }
  return { plan: PLANS[PLANS.length - 1], exceeds: true };
}

/**
 * Cost a monitoring strategy.
 *
 *  naive    — JSON-extract every site on every check. What a first-pass
 *             implementation does. Included to show the client the trap.
 *  diffOnly — markdown scrape + free changeTracking every check; extract only
 *             when something changed.
 *  tiered   — as diffOnly, but RSS sites are fetched free and never billed.
 *             This is what we recommend and build.
 */
export function computeCost(input: CostInput, strategy: Strategy): CostResult {
  const sites = Math.max(0, Math.floor(input.sites));
  const withFeed = clamp(Math.floor(input.sitesWithFeed ?? 0), 0, sites);
  const releasesPerSite = Math.max(0, input.releasesPerSitePerMonth ?? 4);
  const checks = checksPerMonth(input.intervalMinutes);

  // Only the tiered strategy exploits feeds; the others bill every site.
  const billableSites = strategy === "tiered" ? sites - withFeed : sites;

  let monitoringCredits: number;
  let extractionCredits: number;

  if (strategy === "naive") {
    // JSON add-on charged on every single check, whether anything changed or not.
    monitoringCredits = billableSites * checks * (CREDITS.scrape + CREDITS.jsonAddOn);
    extractionCredits = 0;
  } else {
    monitoringCredits = billableSites * checks * CREDITS.scrape;
    // Extraction fires only on an actual new release: one JSON-format index
    // scrape to identify it, plus one plain scrape of the article itself.
    const releaseEvents = billableSites * releasesPerSite;
    extractionCredits =
      releaseEvents * (CREDITS.scrape + CREDITS.jsonAddOn) +
      releaseEvents * CREDITS.scrape;
  }

  // Judging bills per changed page, not per check -- so it tracks releases.
  const judgeCredits =
    input.judging && strategy !== "naive"
      ? billableSites * releasesPerSite * CREDITS.judgePerChangedPage
      : 0;

  const totalCredits = Math.round(
    monitoringCredits + extractionCredits + judgeCredits,
  );
  const { plan, exceeds } = planFor(totalCredits);

  return {
    strategy,
    checksPerMonth: checks,
    billableSites,
    monitoringCredits: Math.round(monitoringCredits),
    extractionCredits: Math.round(extractionCredits),
    judgeCredits: Math.round(judgeCredits),
    totalCredits,
    plan,
    exceedsSelfServe: exceeds,
    firecrawlUsd: plan.monthlyUsd,
  };
}

/** All three strategies for the same inputs — powers the comparison table. */
export function compareStrategies(input: CostInput): Record<Strategy, CostResult> {
  return {
    naive: computeCost(input, "naive"),
    diffOnly: computeCost(input, "diffOnly"),
    tiered: computeCost(input, "tiered"),
  };
}

/**
 * LLM summarisation cost. Measured on real releases 2026-07-31 with
 * google/gemini-2.5-flash: $0.00050, $0.00111, $0.00150 per release
 * (mean ≈ $0.001). Only ever charged on a genuinely new release.
 */
export const USD_PER_SUMMARY = 0.001;

export function summaryUsdPerMonth(
  sites: number,
  releasesPerSitePerMonth = 4,
): number {
  return sites * releasesPerSitePerMonth * USD_PER_SUMMARY;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function formatCredits(n: number): string {
  return n.toLocaleString("en-US");
}
