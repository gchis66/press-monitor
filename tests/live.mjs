/**
 * live.mjs — live end-to-end verification against a running instance.
 *
 * Usage:
 *   node tests/live.mjs                          # localhost:3000
 *   BASE_URL=https://x.vercel.app node tests/live.mjs
 *
 * Takes BASE_URL so the SAME suite runs against localhost and the deployed URL.
 * Local passes do not transfer: the serverless body cap, env-var wiring, cold
 * starts, and function timeouts only exist in production. Any number quoted to
 * a client must come from the URL the client will actually click.
 *
 * Exits non-zero on any hard failure.
 */

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TIMEOUT_MS = 150_000;

/** Sites measured working during the pre-spec probe (2026-07-31).
 *  Starbucks removed 2026-08-01: soak proved it serves a rotating reCAPTCHA. */
const SITES = [
  { name: "Tesla IR", url: "https://ir.tesla.com/press" },
  { name: "CrowdStrike IR", url: "https://ir.crowdstrike.com/news-releases" },
  { name: "Caterpillar", url: "https://www.caterpillar.com/en/news.html" },
  { name: "Delta News", url: "https://news.delta.com/" },
];

/** Inputs that MUST fail with a readable message and no stack trace. */
const ERROR_CASES = [
  {
    name: "non-resolving domain (the DNS trap)",
    url: "https://investors.chipotle.com/news/default.aspx",
    expectKind: ["dns", "scrape"],
  },
  { name: "empty input", url: "", expectKind: ["empty", "bad-request"] },
  { name: "malformed URL", url: "not a url at all", expectKind: ["bad-url", "dns", "scrape"] },
  { name: "non-http scheme", url: "ftp://example.com/news", expectKind: ["bad-url"] },
  { name: "localhost SSRF attempt", url: "http://localhost:3000/api/preview", expectKind: ["bad-url"] },
  { name: "internal IP SSRF attempt", url: "http://169.254.169.254/latest/meta-data", expectKind: ["bad-url"] },
  {
    name: "valid page with no press releases",
    url: "https://example.com",
    expectKind: ["no-releases", "no-article-link", "not-a-release", "scrape", "error"],
    // Must be a handled 4xx, never an unhandled 500. A thin page previously
    // escaped as a 500 because assertUsableContent threw outside the try block.
    maxStatus: 499,
  },
  {
    name: "bot-walled site (Starbucks reCAPTCHA)",
    url: "https://investor.starbucks.com/news/press-releases/default.aspx",
    // Soak-proven: rotating reCAPTCHA prompt fired 'changed' on 11/11 checks,
    // 8 distinct prompt variants. MUST be refused, never summarised as content.
    // optional: Starbucks sometimes serves the real page, and a 200 is fine.
    expectKind: ["bot-wall", "no-releases", "not-a-release", "scrape"],
    maxStatus: 499,
    optional: true,
  },
];

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`    ✅ ${label}`);
  } else {
    failed++;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`    ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function post(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave null so the caller can assert on it */
    }
    return { status: res.status, json, raw: text, seconds: (Date.now() - started) / 1000 };
  } finally {
    clearTimeout(timer);
  }
}

/** Count sentences the same way the server does, to cross-check independently. */
function countSentencesLoose(text) {
  const abbrev = /\b(inc|corp|co|ltd|llc|mr|mrs|ms|dr|prof|jr|sr|vs|etc|approx|u\.s|u\.k|a\.m|p\.m|no|vol|st)\.$/i;
  const parts = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    cur += text[i];
    if (!".!?".includes(text[i])) continue;
    const next = text[i + 1];
    if (next && next !== " " && !`"')]`.includes(next)) continue;
    if (text[i] === "." && abbrev.test(cur.trim())) continue;
    if (text[i] === "." && /\d\.$/.test(cur) && /^\d/.test((text.slice(i + 1) || "").trim())) continue;
    const rest = text.slice(i + 1).trimStart();
    if (rest && !/^["'“‘(]?[A-Z0-9]/.test(rest)) continue;
    parts.push(cur.trim());
    cur = "";
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((s) => /[a-z0-9]/i.test(s)).length;
}

console.log(`\n${"═".repeat(70)}`);
console.log(`  LIVE E2E — ${BASE_URL}`);
console.log(`${"═".repeat(70)}`);

const measured = [];

/* ---------------------- happy paths ---------------------- */

for (const site of SITES) {
  console.log(`\n  ▸ ${site.name}`);
  let r;
  try {
    r = await post(site.url);
  } catch (err) {
    ok(false, `${site.name} responded`, String(err).slice(0, 120));
    continue;
  }

  if (r.status !== 200) {
    ok(
      false,
      `${site.name} returned 200`,
      `got ${r.status}: ${(r.json?.error ?? r.raw ?? "").slice(0, 160)}`,
    );
    continue;
  }
  ok(true, `HTTP 200 in ${r.seconds.toFixed(1)}s`);

  const d = r.json;
  const email = d?.email ?? {};
  const gates = d?.gates ?? {};
  const ev = d?.evidence ?? {};

  ok(
    typeof email.subject === "string" && email.subject.trim().length > 10,
    "subject line is present and substantive",
    JSON.stringify(email.subject ?? null).slice(0, 120),
  );

  ok(
    !/^(re:|fwd:|subject:|press release:)/i.test(email.subject ?? ""),
    "subject has no boilerplate prefix",
  );

  // GATE 1 — exactly four sentences, verified independently of the server.
  const serverCount = gates?.sentences?.count;
  const independent = countSentencesLoose(email.body ?? "");
  ok(
    gates?.sentences?.ok === true && serverCount === 4,
    `GATE 1: exactly 4 sentences (server says ${serverCount})`,
    (email.body ?? "").slice(0, 200),
  );
  ok(
    independent === 4,
    `GATE 1 cross-check: independent count is 4 (got ${independent})`,
    (email.body ?? "").slice(0, 200),
  );

  // GATE 2 — headline verified against the article, never fabricated.
  ok(
    gates?.headline?.verdict === "exact" || gates?.headline?.verdict === "composed",
    `GATE 2: headline verified (${gates?.headline?.verdict})`,
    gates?.headline?.message,
  );

  // GATE 3 — link goes to the release and actually resolves.
  ok(gates?.link?.ok === true, "GATE 3: link distinct from index page");

  let linkStatus = 0;
  try {
    const head = await fetch(email.link, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    linkStatus = head.status;
  } catch {
    linkStatus = 0;
  }
  // Some newsrooms 403 a bare fetch even for a valid article; that is not a
  // broken link, so accept 200 or 403 and only fail on 404/5xx/unreachable.
  ok(
    linkStatus === 200 || linkStatus === 403,
    `link resolves (HTTP ${linkStatus})`,
    email.link,
  );

  ok(
    !(email.body ?? "").includes("\n") && !/^[-*•]/m.test(email.body ?? ""),
    "body is prose, not bullet points",
  );

  ok(
    !/thrilled|excited|game-chang|revolutionary|best-in-class/i.test(email.body ?? ""),
    "body is free of marketing language",
  );

  ok(
    typeof ev?.credits?.total === "number" && ev.credits.total > 0,
    `evidence reports credits (${ev?.credits?.total})`,
  );
  ok(
    typeof ev?.tier?.tier === "number",
    `tier assigned (tier ${ev?.tier?.tier}, feed=${ev?.feedFound})`,
  );

  // No leaked upstream detail anywhere in the payload.
  const blob = JSON.stringify(d);
  ok(
    !/sk-or-|fc-[a-f0-9]{16}|Bearer /i.test(blob),
    "no credentials leaked in the response",
  );

  measured.push({
    site: site.name,
    seconds: r.seconds,
    credits: ev?.credits?.total,
    usd: ev?.summaryUsd,
    feed: ev?.feedFound ? ev.feedUrl : null,
    tier: ev?.tier?.tier,
    verdict: gates?.headline?.verdict,
    subject: email.subject,
  });
}

/* ---------------------- error paths ---------------------- */

console.log(`\n  ▸ Error handling`);

for (const c of ERROR_CASES) {
  let r;
  try {
    r = await post(c.url);
  } catch (err) {
    ok(false, `${c.name} responded`, String(err).slice(0, 120));
    continue;
  }

  // An `optional` case is allowed to succeed: the site may serve real content
  // on this run. What must NEVER happen is a 5xx or a leaked stack trace.
  if (c.optional && r.status === 200) {
    ok(true, `${c.name}: served real content this run (acceptable)`);
    continue;
  }

  ok(
    r.status >= 400 && r.status <= (c.maxStatus ?? 599),
    `${c.name}: rejected with ${r.status}${c.maxStatus ? ` (must be <=${c.maxStatus})` : ""}`,
  );
  ok(
    typeof r.json?.error === "string" && r.json.error.length > 15,
    `${c.name}: readable error message`,
    JSON.stringify(r.json?.error ?? r.raw?.slice(0, 100)),
  );
  ok(
    !/stack|at Object\.|node_modules|TypeError|ReferenceError|undefined is not/i.test(
      r.raw ?? "",
    ),
    `${c.name}: no stack trace leaked`,
  );
  ok(
    !/sk-or-|fc-[a-f0-9]{16}/i.test(r.raw ?? ""),
    `${c.name}: no credentials leaked`,
  );
  if (c.expectKind && r.json?.kind) {
    ok(
      c.expectKind.includes(r.json.kind),
      `${c.name}: kind is one of ${c.expectKind.join("|")} (got "${r.json.kind}")`,
    );
  }
}

/* ---------------------- summary ---------------------- */

console.log(`\n${"─".repeat(70)}`);
if (measured.length) {
  console.log("  MEASURED (report these, not estimates):\n");
  for (const m of measured) {
    console.log(`   ${m.site}`);
    console.log(`     "${(m.subject ?? "").slice(0, 66)}"`);
    console.log(
      `     ${m.seconds.toFixed(1)}s · ${m.credits} credits · $${m.usd} · tier ${m.tier} · headline=${m.verdict}`,
    );
    if (m.feed) console.log(`     feed: ${m.feed}`);
  }
  const avg = measured.reduce((a, m) => a + m.seconds, 0) / measured.length;
  console.log(`\n   mean latency ${avg.toFixed(1)}s over ${measured.length} sites`);
  console.log(`   environment: ${BASE_URL}`);
}

console.log(`\n${"─".repeat(70)}`);
if (failed === 0) {
  console.log(`  ✅  ${passed} live assertions passed against ${BASE_URL}`);
} else {
  console.log(`  ❌  ${failed} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log(`   • ${f}`);
}
console.log(`${"─".repeat(70)}\n`);

process.exit(failed > 0 ? 1 : 0);
