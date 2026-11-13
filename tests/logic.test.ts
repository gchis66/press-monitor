/**
 * logic.test.ts — dependency-free assertions for pure logic.
 *
 * Run: npm test  (bundled with esbuild, executed on node)
 * No network, no API keys, no fixtures. Fast enough to run on every change.
 */

import {
  splitSentences,
  countSentences,
  checkSentenceCount,
  verifyHeadline,
  normalizeForCompare,
  significantWords,
  isDistinctArticleUrl,
  canonicalUrl,
  absolutize,
} from "../lib/verify";
import {
  computeCost,
  compareStrategies,
  checksPerMonth,
  planFor,
  summaryUsdPerMonth,
  formatUsd,
} from "../lib/cost";
import { looksLikeFeed, pickFeedCandidates, assignTier } from "../lib/discover";
import {
  detectBotWall,
  countVolatileTokens,
  VOLATILE_TOKEN_LIMIT,
} from "../lib/botwall";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(detail ? `${label}\n      ${detail}` : label);
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  ok(
    actual === expected,
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function section(name: string) {
  console.log(`\n  ${name}`);
}

/* ================================================================== *
 * Sentence splitting — the abbreviation minefield
 * ================================================================== */

section("splitSentences: real press-release prose");

// Measured output from the live probe (Tesla, 2026-07-31). Must be 4.
eq(
  countSentences(
    "Tesla has released its financial results for the second quarter of 2026. " +
      "The update is available on the company's Investor Relations website. " +
      "Tesla management will host a live company update and Q&A webcast to discuss the results and outlook. " +
      "The webcast is scheduled for Wednesday, July 22, 2026, at 4:30 p.m. Central Time.",
  ),
  4,
  "Tesla release: 4 sentences (trailing 'p.m.' must not split)",
);

// Measured output from the live probe (CrowdStrike, 2026-07-31).
eq(
  countSentences(
    "CrowdStrike and Schwarz Digits announced an expansion of their strategic partnership, " +
      "launching a multi-year roadmap to bring the AI-native Falcon platform to European enterprises on STACKIT, " +
      "Schwarz Digits' sovereign cloud. " +
      "CrowdStrike has signed a definitive agreement to acquire the intellectual property of XM Cyber, a Schwarz Digits company. " +
      "XM Cyber customers will have the opportunity to adopt the Falcon platform through Falcon Flex. " +
      "The transaction is expected to close in the second half of CrowdStrike's fiscal year 2027.",
  ),
  4,
  "CrowdStrike release: 4 sentences",
);

// Measured output from the live probe (Caterpillar, 2026-07-31).
eq(
  countSentences(
    "Caterpillar Inc. announced a new investment in Illinois as part of its five-year, $100 million Building the Future Workforce Initiative. " +
      "Up to $10 million will be allocated to prepare workers across Illinois for modern manufacturing and industry technician jobs. " +
      "This effort will focus on reducing barriers to training, defining in-demand skills, and connecting individuals to careers. " +
      "The initiative will extend across multiple Illinois communities where Caterpillar has a manufacturing footprint.",
  ),
  4,
  "Caterpillar release: 4 sentences ('Caterpillar Inc.' must not split)",
);

eq(
  countSentences("Acme Corp. announced results. Revenue rose 12%."),
  2,
  "'Corp.' mid-sentence does not split",
);
eq(
  countSentences("Revenue grew to $4.2 million this quarter. Margins held."),
  2,
  "decimal in '$4.2 million' does not split",
);
eq(
  countSentences("The U.S. market expanded. Europe followed."),
  2,
  "'U.S.' does not split",
);
eq(
  countSentences("Dr. Chen joined the board. She starts in Q3."),
  2,
  "'Dr.' does not split",
);
eq(
  countSentences("Ronald A. Fisher was named CFO. He begins Monday."),
  2,
  "single initial 'A.' does not split",
);
eq(
  countSentences("Is this real? Yes! It shipped."),
  3,
  "'?' and '!' terminate sentences",
);
eq(
  countSentences('She said "we are pleased." The deal closed.'),
  2,
  "period inside closing quote",
);
eq(countSentences(""), 0, "empty string -> 0 sentences");
eq(countSentences("   \n  "), 0, "whitespace only -> 0 sentences");
eq(countSentences("No terminal punctuation"), 1, "unterminated text counts as 1");

section("checkSentenceCount: gate 1");
ok(checkSentenceCount("One. Two. Three. Four.").ok, "exactly 4 passes");
ok(!checkSentenceCount("One. Two. Three.").ok, "3 sentences fails");
ok(!checkSentenceCount("One. Two. Three. Four. Five.").ok, "5 sentences fails");
eq(checkSentenceCount("One. Two. Three.").count, 3, "reports actual count");
ok(
  (checkSentenceCount("One. Two.").message ?? "").includes("expected 4"),
  "failure message names the expectation",
);

/* ================================================================== *
 * Headline verification — the zero-tolerance gate
 * ================================================================== */

section("verifyHeadline: gate 2");

const CAT_ARTICLE =
  "Caterpillar Invests in the Future of Manufacturing Talent in Illinois. " +
  "PEORIA, Ill. — Caterpillar Inc. today announced up to $10 million to prepare workers " +
  "across Illinois for modern manufacturing and industry technician jobs.";

eq(
  verifyHeadline(
    "Caterpillar Invests in the Future of Manufacturing Talent in Illinois",
    CAT_ARTICLE,
  ).verdict,
  "exact",
  "contiguous headline -> exact",
);

// The REAL case measured on 2026-07-31: the index page truncated the headline
// AND used "Invest" where the article says "Invests".
const truncated = verifyHeadline(
  "Caterpillar Invest in the Future of Manufacturing...",
  CAT_ARTICLE,
);
ok(
  truncated.verdict === "composed" && !truncated.fatal,
  "truncated index headline -> composed, not fatal",
  `got verdict=${truncated.verdict} coverage=${truncated.coverage.toFixed(2)}`,
);

const fabricated = verifyHeadline(
  "Microsoft Acquires Nintendo in Record Gaming Deal",
  CAT_ARTICLE,
);
ok(
  fabricated.verdict === "missing" && fabricated.fatal,
  "fabricated headline -> missing AND fatal",
  `got verdict=${fabricated.verdict} coverage=${fabricated.coverage.toFixed(2)}`,
);

ok(verifyHeadline("", CAT_ARTICLE).fatal, "empty headline is fatal");
eq(
  verifyHeadline("Q2 Results", "Q2 Results were strong").verdict,
  "exact",
  "short but contiguous -> exact",
);
eq(
  verifyHeadline("Zebra Xylophone", "Completely unrelated body text").verdict,
  "too-short",
  "under 3 significant words -> too-short, not a hallucination claim",
);

// U+202F narrow no-break space, which Tesla's live page actually uses.
eq(
  verifyHeadline(
    "Tesla Releases Second Quarter\u202F2026 Financial Results",
    "Tesla Releases Second Quarter 2026 Financial Results — AUSTIN, Texas",
  ).verdict,
  "exact",
  "narrow-no-break space normalises to a plain space",
);

// Typographic apostrophe vs ASCII.
eq(
  verifyHeadline(
    "CrowdStrike\u2019s Falcon Platform Expands",
    "CrowdStrike's Falcon Platform Expands Across Europe",
  ).verdict,
  "exact",
  "typographic apostrophe normalises",
);

// Line-break hyphenation, a real PDF/HTML extraction artifact.
eq(
  verifyHeadline(
    "Company Announces Restructuring",
    "Company Announces Restruc-\nturing of its European division",
  ).verdict,
  "exact",
  "hyphenated line break rejoins",
);

section("normalizeForCompare / significantWords");
eq(
  normalizeForCompare("  Q2\u00A02026 \u201CResults\u201D  "),
  'q2 2026 "results"',
  "normalises nbsp, curly quotes, case, edge whitespace",
);
ok(
  !significantWords("the future of manufacturing in illinois").includes("the"),
  "stopwords dropped",
);
ok(
  significantWords("the future of manufacturing in illinois").includes("manufacturing"),
  "content words kept",
);

/* ================================================================== *
 * URL handling — gate 3
 * ================================================================== */

section("URL handling: gate 3");
ok(
  isDistinctArticleUrl(
    "https://ir.tesla.com/press-release/q2-2026",
    "https://ir.tesla.com/press",
  ),
  "article URL distinct from index",
);
ok(
  !isDistinctArticleUrl("https://ir.tesla.com/press", "https://ir.tesla.com/press"),
  "identical URL rejected",
);
ok(
  !isDistinctArticleUrl(
    "https://ir.tesla.com/press/",
    "https://ir.tesla.com/press",
  ),
  "trailing slash is not a real difference",
);
ok(
  !isDistinctArticleUrl(
    "https://ir.tesla.com/press#top",
    "https://ir.tesla.com/press",
  ),
  "fragment-only difference rejected",
);
ok(!isDistinctArticleUrl("not-a-url", "https://x.com/news"), "malformed URL rejected");
ok(
  !isDistinctArticleUrl("javascript:alert(1)", "https://x.com/news"),
  "non-http scheme rejected",
);
eq(
  canonicalUrl("https://WWW.Example.com/News/"),
  "example.com/News",
  "canonical strips www, lowercases host, keeps path case",
);
eq(
  absolutize("/press-release/abc", "https://ir.tesla.com/press"),
  "https://ir.tesla.com/press-release/abc",
  "relative href resolved against base",
);
eq(absolutize("bad url", "also bad"), null, "unresolvable href -> null");

/* ================================================================== *
 * Cost model — the proposal's centrepiece
 * ================================================================== */

section("cost model");
eq(checksPerMonth(20), 2192, "20-minute interval -> 2192 checks/month");
eq(checksPerMonth(60), 731, "hourly -> 731 checks/month");
eq(checksPerMonth(0), 0, "zero interval guarded");

const client = { sites: 55, intervalMinutes: 20, sitesWithFeed: 20, releasesPerSitePerMonth: 4 };
const cmp = compareStrategies(client);

// The headline finding from SPEC §4: naive blows past every plan boundary.
eq(cmp.naive.totalCredits, 602_800, "naive: 55 sites x 2192 checks x 5 credits");
eq(cmp.naive.plan.name, "Scale", "naive requires the Scale plan");
eq(cmp.naive.firecrawlUsd, 749, "naive costs $749/mo");

eq(cmp.diffOnly.plan.name, "Growth", "diffOnly fits Growth");
eq(cmp.diffOnly.firecrawlUsd, 399, "diffOnly costs $399/mo");

eq(cmp.tiered.plan.name, "Standard", "tiered fits Standard");
eq(cmp.tiered.firecrawlUsd, 99, "tiered costs $99/mo");
eq(cmp.tiered.billableSites, 35, "tiered bills only the 35 feedless sites");

ok(
  cmp.tiered.totalCredits < cmp.diffOnly.totalCredits &&
    cmp.diffOnly.totalCredits < cmp.naive.totalCredits,
  "tiered < diffOnly < naive",
  `${cmp.tiered.totalCredits} / ${cmp.diffOnly.totalCredits} / ${cmp.naive.totalCredits}`,
);

// Interval is a genuine cost lever — the secondary question to the client.
const hourly = computeCost({ ...client, intervalMinutes: 60 }, "tiered");
ok(
  hourly.totalCredits < cmp.tiered.totalCredits,
  "hourly is cheaper than every-20-minutes",
  `${hourly.totalCredits} vs ${cmp.tiered.totalCredits}`,
);

// Feeds are free: more feeds must never cost more.
const allFeeds = computeCost({ ...client, sitesWithFeed: 55 }, "tiered");
eq(allFeeds.monitoringCredits, 0, "all-RSS costs zero monitoring credits");

// Guards
eq(
  computeCost({ ...client, sitesWithFeed: 99 }, "tiered").billableSites,
  0,
  "sitesWithFeed clamped to site count",
);
eq(planFor(1_000_000_000).plan.name, "Scale", "absurd volume returns largest plan");
ok(planFor(1_000_000_000).exceeds, "absurd volume flags exceedsSelfServe");
ok(!planFor(500).exceeds, "small volume fits Free without flagging");

// Judging adds cost but only per changed page, so it must stay small.
const judged = computeCost({ ...client, judging: true }, "tiered");
ok(
  judged.totalCredits > cmp.tiered.totalCredits &&
    judged.totalCredits - cmp.tiered.totalCredits === 140,
  "judging adds 1 credit per release (35 sites x 4)",
  `delta ${judged.totalCredits - cmp.tiered.totalCredits}`,
);

// LLM cost must stay negligible — this is a real claim in the proposal.
ok(
  summaryUsdPerMonth(55, 4) < 1,
  "LLM summarisation under $1/mo at 55 sites",
  `${summaryUsdPerMonth(55, 4)}`,
);
eq(formatUsd(0), "$0", "formatUsd zero");
eq(formatUsd(0.22), "$0.22", "formatUsd sub-dollar");
eq(formatUsd(99), "$99", "formatUsd whole");

/* ================================================================== *
 * Feed discovery
 * ================================================================== */

section("feed discovery");
ok(
  looksLikeFeed(
    '<?xml version="1.0"?><rss version="2.0"><channel><title>News</title></channel></rss>',
    "application/rss+xml",
  ),
  "real RSS detected",
);
ok(
  looksLikeFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>N</title></feed>', "application/atom+xml"),
  "real Atom detected",
);

// THE MEASURED TRAP: jnj.com/rss/press-releases.xml returns text/html with an
// HTML body. Trusting the .xml extension or a 200 would corrupt the free tier.
ok(
  !looksLikeFeed(
    "<!DOCTYPE html><html><head><title>Press Releases</title></head><body>...</body></html>",
    "text/html",
  ),
  "HTML masquerading as a .xml feed is rejected",
);
ok(
  !looksLikeFeed("", "application/rss+xml"),
  "empty body rejected even with a feed content-type",
);
ok(
  !looksLikeFeed("<html><body><rss>not really</rss></body></html>", "text/html"),
  "HTML mentioning <rss> inside body is rejected",
);
ok(
  looksLikeFeed('<?xml version="1.0"?><rss><channel><item/></channel></rss>', ""),
  "missing content-type still detected via body sniff",
);

section("feed candidates");
const cands = pickFeedCandidates("https://ir.crowdstrike.com/news-releases");
ok(
  cands.includes("https://ir.crowdstrike.com/rss/news-releases.xml"),
  "includes the Q4-platform path that measured working",
  cands.slice(0, 4).join(", "),
);
ok(cands.length <= 10, "candidate list stays bounded", `${cands.length}`);
ok(
  new Set(cands).size === cands.length,
  "candidate list has no duplicates",
);
eq(pickFeedCandidates("not a url").length, 0, "malformed input yields no candidates");

section("tier assignment");
eq(assignTier({ feedUrl: "https://x.com/rss.xml" }).tier, 1, "feed -> tier 1 (free)");
eq(assignTier({ feedUrl: null }).tier, 2, "no feed -> tier 2 (scrape + diff)");
eq(assignTier({ feedUrl: "https://x.com/rss.xml" }).creditsPerCheck, 0, "tier 1 is free");
eq(assignTier({ feedUrl: null }).creditsPerCheck, 1, "tier 2 costs 1 credit/check");

section("bot-wall detection (all 8 prompts captured from the live soak)");

// These are the EXACT strings the soak test recorded from
// investor.starbucks.com over 11 consecutive checks, 2026-08-01. Each one
// triggered changeStatus:"changed", i.e. one false alert every 5 minutes.
const REAL_CAPTCHA_PROMPTS = [
  "Select all images with **a fire hydrant** Click verify once there are none left.",
  "Select all images with **bicycles** Click verify once there are none left",
  "Select all images with **cars** Click verify once there are none left",
  "Select all images with **crosswalks** Click verify once there are none left.",
  "Select all images with a **bus** Click verify once there are none left.",
  "Select all squares with **bicycles** If there are none, click skip",
  "Select all squares with **motorcycles** If there are none, click skip",
  "Select all squares with **stairs** If there are none, click skip",
];

for (const prompt of REAL_CAPTCHA_PROMPTS) {
  const md = `# Investor Relations\n\nSome nav links here\n\nreCAPTCHA\n\n${prompt}\n\n| a | b |`;
  const r = detectBotWall(md);
  ok(
    r.blocked,
    `blocks real CAPTCHA: "${prompt.slice(0, 46)}…"`,
    `verdict=${JSON.stringify(r)}`,
  );
}

ok(
  detectBotWall(
    "text\n\n![](https://www.google.com/recaptcha/api2/payload?p=06AFcWeA461a5v-VZ5&k=6LcKf8wZ)\n",
  ).blocked,
  "blocks reCAPTCHA payload image URLs",
);
ok(detectBotWall("Please verify you are human to continue").blocked, "blocks human-verification wall");
ok(detectBotWall("Checking if the site connection is secure").blocked, "blocks Cloudflare interstitial");
ok(detectBotWall("I'm not a robot").blocked, "blocks reCAPTCHA checkbox");
ok(detectBotWall("Pardon Our Interruption").blocked, "blocks Imperva/Distil block page");

// MUST NOT false-positive. A newsroom that merely mentions reCAPTCHA in its
// privacy notice is not a bot wall -- rejecting it would silently drop a real
// site from monitoring, which is the failure this whole module exists to stop.
ok(
  !detectBotWall(
    "Privacy Notice: this site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.",
  ).blocked,
  "does NOT block a privacy notice mentioning reCAPTCHA",
);
ok(
  !detectBotWall(
    "Caterpillar Invests in the Future of Manufacturing Talent in Illinois. PEORIA, Ill. — Caterpillar Inc. today announced up to $10 million.",
  ).blocked,
  "does NOT block a real press release",
);
ok(!detectBotWall("").blocked, "empty markdown is not a bot wall");
eq(
  detectBotWall("Select all squares with **stairs** If there are none, click skip").label,
  "reCAPTCHA image challenge",
  "labels the wall type for the operator log",
);

section("volatile-token detection (diff instability)");
const captchaMd = Array.from(
  { length: 6 },
  (_, i) =>
    `![](https://www.google.com/recaptcha/api2/payload?p=06AFcWeA${i}xLongTokenHere123456&k=6LcKf8wZ)`,
).join("\n");
ok(
  countVolatileTokens(captchaMd) > VOLATILE_TOKEN_LIMIT,
  "rotating CAPTCHA payload URLs exceed the volatility limit",
  `counted ${countVolatileTokens(captchaMd)}`,
);
ok(
  countVolatileTokens("https://ir.tesla.com/press-release/q2-2026-results") === 0,
  "a clean newsroom URL has no volatile tokens",
);
ok(
  countVolatileTokens("<img src='/a.png?cb=8f3a91c2d4e5'>") > 0,
  "cache-buster query params counted as volatile",
);

/* ================================================================== */

console.log(`\n${"─".repeat(64)}`);
if (failed === 0) {
  console.log(`  ✅  ${passed} assertions passed`);
} else {
  console.log(`  ❌  ${failed} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log(`   • ${f}`);
}
console.log(`${"─".repeat(64)}\n`);

if (failed > 0) process.exit(1);
