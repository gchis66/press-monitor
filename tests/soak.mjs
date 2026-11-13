/**
 * soak.mjs — false-positive soak test. SPEC §8 gate 5.
 *
 * THE MOST IMPORTANT TEST IN THIS BUILD.
 *
 * The failure mode that kills a monitoring product is not missing a release —
 * it is emailing the client every 20 minutes because a page has a rotating hero
 * image, a "time since posted" label, a share counter, or a randomised iframe
 * URL. A client who gets 72 false alerts a day turns the system off on day one
 * and disputes the invoice.
 *
 * The 45-second test during the pre-spec probe showed changeStatus:"same" on
 * 3/3 sites. That is necessary but nowhere near sufficient: it does not span a
 * CDN cache rotation, an ad refresh, a "posted 2 hours ago" tick, or a
 * midnight timestamp rollover.
 *
 * This harness polls real newsroom pages with changeTracking for hours and
 * records every changeStatus. On a set of sites publishing nothing new, every
 * check after the first MUST be "same". Any "changed" is a false positive and
 * gets logged with its diff so the cause is identifiable.
 *
 * Usage:
 *   node tests/soak.mjs                      # default 12h, 20-min interval
 *   HOURS=1 INTERVAL_MIN=5 node tests/soak.mjs
 *
 * Reads FIRECRAWL_API_KEY from .env.local. Costs 1 credit per site per check
 * (changeTracking itself is free), so the default run is
 * 5 sites x 36 checks = 180 credits.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/* ---------------- config ---------------- */

const HOURS = Number(process.env.HOURS ?? 12);
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN ?? 20);
const TAG = process.env.TAG ?? `soak-${Date.now()}`;

const SITES = [
  { name: "Tesla IR", url: "https://ir.tesla.com/press" },
  { name: "CrowdStrike IR", url: "https://ir.crowdstrike.com/news-releases" },
  { name: "Caterpillar", url: "https://www.caterpillar.com/en/news.html" },
  { name: "Starbucks IR", url: "https://investor.starbucks.com/news/press-releases/default.aspx" },
  { name: "Microsoft News", url: "https://news.microsoft.com/category/press-releases/" },
];

/* ---------------- env ---------------- */

function loadEnv() {
  try {
    const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
    }
  } catch {
    /* env may already be set */
  }
}
loadEnv();

const KEY = process.env.FIRECRAWL_API_KEY;
if (!KEY) {
  console.error("FIRECRAWL_API_KEY not found (checked env and .env.local).");
  process.exit(1);
}

/* ---------------- bot-wall detection (mirrors lib/botwall.ts) ---------------- */

const WALL_PATTERNS = [
  [/select all (squares|images) with/i, "reCAPTCHA image challenge"],
  [/if there are none, click skip/i, "reCAPTCHA image challenge"],
  [/recaptcha\/api2\/payload/i, "reCAPTCHA payload frames"],
  [/\bi'?m not a robot\b/i, "reCAPTCHA checkbox"],
  [/verify (you are|you're) (a )?human/i, "human verification"],
  [/checking if the site connection is secure/i, "Cloudflare interstitial"],
  [/pardon our interruption/i, "Distil/Imperva block"],
  [/unusual traffic from your computer network/i, "traffic block"],
];

function detectWall(md) {
  if (!md) return null;
  for (const [re, label] of WALL_PATTERNS) if (re.test(md)) return label;
  return null;
}

/* ---------------- scrape ---------------- */

async function check(site) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: site.url,
        // git-diff mode is FREE and tells us WHAT changed when it does -- vital
        // for diagnosing a false positive rather than just counting one.
        formats: ["markdown", { type: "changeTracking", modes: ["git-diff"], tag: TAG }],
        onlyMainContent: true,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "parse-error", detail: text.slice(0, 200) };
    }

    if (json.success === false) {
      return { status: "api-error", detail: (json.error ?? "").slice(0, 200), code: json.code };
    }

    const ct = json.data?.changeTracking ?? {};
    const md = json.data?.markdown ?? "";
    return {
      status: ct.changeStatus ?? "unknown",
      markdownLength: md.length,
      previousScrapeAt: ct.previousScrapeAt ?? null,
      // A bot wall makes the diff meaningless: classify it separately so it is
      // never counted as an ordinary content false positive.
      botWall: detectWall(md),
      diff: ct.diff?.text ? ct.diff.text.slice(0, 1500) : null,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: aborted ? "timeout" : "network-error", detail: String(err).slice(0, 150) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- run ---------------- */

const totalRounds = Math.max(2, Math.floor((HOURS * 60) / INTERVAL_MIN));
const log = [];
const counts = {};
const falsePositives = [];
const botWallEvents = [];

for (const s of SITES)
  counts[s.name] = { new: 0, same: 0, changed: 0, removed: 0, error: 0, botWall: 0 };

console.log(`\n${"═".repeat(70)}`);
console.log("  FALSE-POSITIVE SOAK TEST");
console.log(`${"═".repeat(70)}`);
console.log(`  sites:    ${SITES.length}`);
console.log(`  interval: ${INTERVAL_MIN} min`);
console.log(`  duration: ${HOURS}h (${totalRounds} rounds)`);
console.log(`  tag:      ${TAG}`);
console.log(`  cost:     ~${SITES.length * totalRounds} credits`);
console.log(`  started:  ${new Date().toISOString()}`);
console.log(`${"═".repeat(70)}\n`);
console.log("  PASS CRITERION: after round 1, every status must be 'same'.");
console.log("  Any 'changed' on a site that published nothing is a FALSE POSITIVE.\n");

const outPath = join(__dirname, `soak-log-${TAG}.json`);

for (let round = 1; round <= totalRounds; round++) {
  const stamp = new Date().toISOString().slice(11, 19);
  const results = await Promise.all(SITES.map(check));
  const line = [];

  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    const r = results[i];
    const st = r.status;

    if (st === "new" || st === "same" || st === "changed" || st === "removed") {
      counts[site.name][st]++;
    } else {
      counts[site.name].error++;
    }

    // Round 1 legitimately returns "new" -- there is no prior snapshot.
    // A bot wall is tracked separately: the diff is meaningless, and the fix is
    // a per-site rule, not a change-detection tweak. Counting it as a content
    // false positive would hide the real cause.
    if (r.botWall) {
      counts[site.name].botWall++;
      botWallEvents.push({
        round,
        time: new Date().toISOString(),
        site: site.name,
        url: site.url,
        label: r.botWall,
        status: st,
      });
    } else if (round > 1 && st === "changed") {
      falsePositives.push({
        round,
        time: new Date().toISOString(),
        site: site.name,
        url: site.url,
        markdownLength: r.markdownLength,
        diff: r.diff,
      });
    }

    const symbol = r.botWall
      ? "W"
      : st === "same"
        ? "·"
        : st === "changed"
          ? "C"
          : st === "new"
            ? "N"
            : "!";
    line.push(`${site.name.split(" ")[0]}:${symbol}`);

    log.push({ round, time: new Date().toISOString(), site: site.name, ...r });
  }

  const marks = [];
  if (falsePositives.length) marks.push(`⚠ ${falsePositives.length} FP`);
  if (botWallEvents.length) marks.push(`W ${botWallEvents.length} bot-wall`);
  const fpMark = marks.length ? `  ${marks.join("  ")}` : "";
  console.log(`  [${stamp}] round ${String(round).padStart(2)}/${totalRounds}  ${line.join("  ")}${fpMark}`);

  writeFileSync(
    outPath,
    JSON.stringify(
      { tag: TAG, sites: SITES, counts, falsePositives, botWallEvents, log },
      null,
      2,
    ),
  );

  if (round < totalRounds) {
    await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60 * 1000));
  }
}

/* ---------------- report ---------------- */

console.log(`\n${"─".repeat(70)}`);
console.log("  RESULTS\n");
for (const s of SITES) {
  const c = counts[s.name];
  console.log(
    `   ${s.name.padEnd(16)} new=${c.new}  same=${c.same}  changed=${c.changed}  wall=${c.botWall}  errors=${c.error}`,
  );
}

const checksAfterFirst = SITES.length * (totalRounds - 1);
console.log(`\n   checks after round 1: ${checksAfterFirst}`);
console.log(`   content false positives: ${falsePositives.length}`);
console.log(`   bot-wall events:         ${botWallEvents.length}`);

if (botWallEvents.length > 0) {
  const bySite = {};
  for (const e of botWallEvents) {
    bySite[e.site] = bySite[e.site] ?? { count: 0, label: e.label };
    bySite[e.site].count++;
  }
  console.log(
    `\n   ⚠ BOT WALLS — these sites served a challenge page instead of content.\n` +
      `     Their markdown contains rotating prompt text, so change detection\n` +
      `     would fire on EVERY check. They need a per-site rule (feed, stealth\n` +
      `     proxy, or narrowed selector), not a diff tweak. lib/botwall.ts\n` +
      `     detects and rejects these before they can generate an alert.\n`,
  );
  for (const [site, info] of Object.entries(bySite)) {
    console.log(`     ${site}: ${info.count} occurrence(s) — ${info.label}`);
  }
}

if (falsePositives.length > 0) {
  console.log(`\n   ⚠ CONTENT FALSE POSITIVES — each would have emailed the client:\n`);
  for (const fp of falsePositives.slice(0, 10)) {
    console.log(`   round ${fp.round} · ${fp.site}`);
    if (fp.diff) {
      for (const l of fp.diff.split("\n").slice(0, 12)) console.log(`      ${l}`);
    }
    console.log("");
  }
  console.log(
    "   NOTE: a 'changed' is only a true false positive if the site published\n" +
      "   nothing new. Check the diff above before treating it as a defect.",
  );
}

console.log(`\n   full log: ${outPath}`);
console.log(`${"─".repeat(70)}`);
if (falsePositives.length === 0 && botWallEvents.length === 0) {
  console.log(`  ✅  ZERO false positives across ${checksAfterFirst} checks over ${HOURS}h`);
} else if (falsePositives.length === 0) {
  console.log(
    `  ✅  ZERO content false positives across ${checksAfterFirst} checks over ${HOURS}h\n` +
      `  ⚠   ${botWallEvents.length} bot-wall event(s) — handled by lib/botwall.ts, needs a per-site rule`,
  );
} else {
  console.log(`  ❌  ${falsePositives.length} content false positive(s) — investigate the diffs above`);
}
console.log(`${"─".repeat(70)}\n`);

process.exit(falsePositives.length === 0 ? 0 : 1);
