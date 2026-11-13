"use client";

import { useState } from "react";

/* ------------------------------------------------------------------ *
 * Types (mirrors lib/pipeline.ts PreviewResult)
 * ------------------------------------------------------------------ */

interface Plan {
  name: string;
  credits: number;
  monthlyUsd: number;
}
interface CostResult {
  checksPerMonth: number;
  billableSites: number;
  totalCredits: number;
  plan: Plan;
  exceedsSelfServe: boolean;
  firecrawlUsd: number;
}
interface PreviewResult {
  newsroomUrl: string;
  email: {
    subject: string;
    body: string;
    link: string;
    publishedDate: string;
    sourceSite: string;
  };
  gates: {
    sentences: { ok: boolean; count: number; expected: number; retried: boolean };
    headline: { verdict: string; coverage: number; message?: string };
    link: { ok: boolean; message?: string };
    allClear: boolean;
  };
  evidence: {
    feedFound: boolean;
    feedUrl: string | null;
    feedProbes: { url: string; status: number | "error"; isFeed: boolean; note: string }[];
    tier: { tier: number; label: string; creditsPerCheck: number; rationale: string };
    seconds: { discover: number; index: number; article: number; summary: number; total: number };
    credits: { index: number; article: number; total: number };
    summaryUsd: number;
    model: string;
    releasesFound: number;
    articleChars: number;
  };
  projection: {
    sites: number;
    intervalMinutes: number;
    assumedFeeds: number;
    tiered: CostResult;
    diffOnly: CostResult;
    naive: CostResult;
  };
  warnings: string[];
  otherReleases: { headline: string; url: string; date: string }[];
}

/**
 * Sample sites, all verified working end-to-end.
 *
 * investor.starbucks.com was REMOVED after the soak test: it intermittently
 * serves a Google reCAPTCHA whose prompt text rotates every render, which fired
 * changeStatus:"changed" on 11 of 11 consecutive checks. It is a genuinely
 * useful site to discuss with the client, but a reviewer clicking it sees an
 * error rather than an inbox, so it is not a sample. Delta replaces it.
 */
const SAMPLES = [
  { label: "Tesla IR", url: "https://ir.tesla.com/press" },
  { label: "CrowdStrike IR", url: "https://ir.crowdstrike.com/news-releases" },
  { label: "Caterpillar", url: "https://www.caterpillar.com/en/news.html" },
  { label: "Delta News", url: "https://news.delta.com/" },
];

/* ------------------------------------------------------------------ *
 * Client-side cost model (mirrors lib/cost.ts so the slider is instant)
 * ------------------------------------------------------------------ */

const PLANS: Plan[] = [
  { name: "Free", credits: 1_000, monthlyUsd: 0 },
  { name: "Hobby", credits: 5_000, monthlyUsd: 19 },
  { name: "Standard", credits: 100_000, monthlyUsd: 99 },
  { name: "Growth", credits: 500_000, monthlyUsd: 399 },
  { name: "Scale", credits: 1_000_000, monthlyUsd: 749 },
];

function planFor(credits: number) {
  for (const p of PLANS) if (credits <= p.credits) return { plan: p, exceeds: false };
  return { plan: PLANS[PLANS.length - 1], exceeds: true };
}

function computeLocal(
  sites: number,
  intervalMinutes: number,
  feeds: number,
  strategy: "naive" | "diffOnly" | "tiered",
) {
  const checks = Math.round((60 / intervalMinutes) * 24 * 30.44);
  const billable = strategy === "tiered" ? Math.max(0, sites - feeds) : sites;
  const releases = billable * 4;
  let credits: number;
  if (strategy === "naive") {
    credits = billable * checks * 5;
  } else {
    credits = billable * checks * 1 + releases * 5 + releases * 1 + releases * 1;
  }
  credits = Math.round(credits);
  const { plan, exceeds } = planFor(credits);
  return { checks, billable, credits, plan, exceeds };
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<{ message: string; kind: string } | null>(null);

  // Calculator state. Defaults to the client's literal ask (55 sites / 20 min)
  // so the real number is what they see first.
  const [calcSites, setCalcSites] = useState(55);
  const [calcInterval, setCalcInterval] = useState(20);
  const [calcFeeds, setCalcFeeds] = useState(20);

  async function run(target: string) {
    const trimmed = target.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    const stages = [
      "Checking for an RSS feed…",
      "Reading the newsroom page…",
      "Finding the newest release…",
      "Reading the full release…",
      "Writing the email…",
      "Verifying the headline against the source…",
    ];
    let i = 0;
    setStage(stages[0]);
    const ticker = setInterval(() => {
      i = Math.min(i + 1, stages.length - 1);
      setStage(stages[i]);
    }, 2600);

    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error ?? "Something went wrong.", kind: data.kind ?? "error" });
      } else {
        setResult(data as PreviewResult);
        setCalcFeeds(data.evidence?.feedFound ? 20 : 20);
      }
    } catch {
      setError({
        message: "Could not reach the server. Check your connection and try again.",
        kind: "network",
      });
    } finally {
      clearInterval(ticker);
      setLoading(false);
      setStage("");
    }
  }

  const tiered = computeLocal(calcSites, calcInterval, calcFeeds, "tiered");
  const naive = computeLocal(calcSites, calcInterval, calcFeeds, "naive");
  const diffOnly = computeLocal(calcSites, calcInterval, calcFeeds, "diffOnly");

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
      {/* ---------------- Header ---------------- */}
      <header className="mb-9">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-white">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Live demo
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Press Release Monitor
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600">
          Enter any company newsroom URL. This runs the same pipeline the
          production agent runs when it detects a new release: find the newest
          release, read it, and write the alert email — subject line is the
          headline, body is a four-sentence summary, plus the link.
        </p>
      </header>

      {/* ---------------- Input ---------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <label
          htmlFor="url"
          className="mb-2 block text-sm font-medium text-slate-700"
        >
          Newsroom or press-release page
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run(url);
            }}
            placeholder="company.com/news  or  ir.company.com/press-releases"
            disabled={loading}
            className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2.5 text-[15px] text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 disabled:bg-slate-50"
          />
          <button
            onClick={() => run(url)}
            disabled={loading || !url.trim()}
            className="rounded-lg bg-slate-900 px-5 py-2.5 text-[15px] font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? "Working…" : "Preview the alert"}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">
            Or try a real one:
          </span>
          {SAMPLES.map((s) => (
            <button
              key={s.url}
              onClick={() => {
                setUrl(s.url);
                run(s.url);
              }}
              disabled={loading}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {/* ---------------- Loading ---------------- */}
      {loading && (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <Spinner />
            <div>
              <p className="text-sm font-medium text-slate-800">{stage}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Live scrape and summarisation — usually 7–20 seconds.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ---------------- Error ---------------- */}
      {error && !loading && <ErrorPanel message={error.message} kind={error.kind} />}

      {/* ---------------- Result ---------------- */}
      {result && !loading && (
        <>
          <Inbox result={result} />
          <Gates result={result} />
          <Evidence result={result} />
        </>
      )}

      {/* ---------------- Cost calculator ---------------- */}
      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          What this costs to run at your scale
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
          Monitoring 55 sites every 20 minutes means <strong>118,800 page
          checks a month</strong>. That is a real recurring infrastructure cost,
          and how the agent is built changes it by <strong>7×</strong>. Move the
          sliders.
        </p>

        <div className="mt-5 grid gap-5 sm:grid-cols-3">
          <Slider
            label="Sites monitored"
            value={calcSites}
            min={1}
            max={200}
            step={1}
            onChange={setCalcSites}
            display={`${calcSites}`}
          />
          <Slider
            label="Check interval"
            value={calcInterval}
            min={5}
            max={240}
            step={5}
            onChange={setCalcInterval}
            display={
              calcInterval >= 60
                ? `${(calcInterval / 60).toFixed(calcInterval % 60 === 0 ? 0 : 1)} hr`
                : `${calcInterval} min`
            }
          />
          <Slider
            label="Sites with an RSS feed (free)"
            value={calcFeeds}
            min={0}
            max={calcSites}
            step={1}
            onChange={setCalcFeeds}
            display={`${Math.min(calcFeeds, calcSites)}`}
          />
        </div>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 pr-3 font-medium">Approach</th>
                <th className="pb-2 pr-3 font-medium">Credits / mo</th>
                <th className="pb-2 pr-3 font-medium">Plan</th>
                <th className="pb-2 font-medium">Cost / mo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <CostRow
                label="Naive — extract every site, every check"
                sub="What a first pass does. Pays the AI-extraction surcharge 2,192 times a month per site."
                r={naive}
                tone="bad"
              />
              <CostRow
                label="Scrape + free change tracking"
                sub="Only summarise when the page actually changes."
                r={diffOnly}
                tone="mid"
              />
              <CostRow
                label="Tiered — RSS first, then scrape + diff"
                sub="What I build. Feed sites cost nothing, forever."
                r={tiered}
                tone="good"
              />
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          Firecrawl plan pricing as published on 2026-07-31. Add email delivery
          (free up to 3,000/mo) and AI summarisation, which is genuinely
          negligible — measured{" "}
          <strong>${(0.001 * calcSites * 4).toFixed(2)}/mo</strong> at{" "}
          {calcSites} sites and ~4 releases each. The build fee is one-time; this
          is the recurring line, billed to your own accounts so you own the keys.
        </p>
      </section>

      <footer className="mt-8 border-t border-slate-200 pt-5 text-xs leading-relaxed text-slate-500">
        <p>
          Demo runs live against real sites. Nothing is stored; every request is
          processed in memory. Rate-limited per visitor to bound API spend.
        </p>
      </footer>
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Inbox mockup — the money shot
 * ------------------------------------------------------------------ */

function Inbox({ result }: { result: PreviewResult }) {
  const { email, evidence } = result;
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <section className="mt-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-900">
          The email you would have received
        </h2>
        <span className="text-xs text-slate-500">
          {evidence.seconds.total}s after detection
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
        {/* Mail client chrome */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </div>
          <span className="ml-2 text-xs font-medium text-slate-500">Inbox</span>
          <span className="ml-auto rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            1 new
          </span>
        </div>

        {/* Subject = headline, verbatim */}
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-[17px] font-semibold leading-snug text-slate-900">
            {email.subject}
          </h3>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white">
              PM
            </span>
            <span className="font-medium text-slate-700">Press Monitor</span>
            <span className="text-slate-400">
              &lt;alerts@pressmonitor.app&gt;
            </span>
            <span className="ml-auto">{time}</span>
          </div>
        </div>

        {/* Body = 4 sentences */}
        <div className="px-5 py-4">
          <p className="text-[15px] leading-relaxed text-slate-800">
            {email.body}
          </p>

          <a
            href={email.link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-700"
          >
            Read the full release
            <span aria-hidden>→</span>
          </a>

          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
            <span>
              Source: <strong className="text-slate-700">{email.sourceSite}</strong>
            </span>
            {email.publishedDate && <span>Published {email.publishedDate}</span>}
            <span>
              {evidence.feedFound ? "via RSS feed" : "via page monitoring"}
            </span>
          </div>
        </div>
      </div>

      {result.otherReleases.length > 0 && (
        <details className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            Also detected on that page ({result.otherReleases.length} older
            releases) — these would have been sent when they were published
          </summary>
          <ul className="mt-2.5 space-y-1.5">
            {result.otherReleases.map((r) => (
              <li key={r.url} className="text-xs leading-snug text-slate-600">
                <span className="text-slate-400">{r.date || "—"}</span>{" "}
                {r.headline}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Verification gates
 * ------------------------------------------------------------------ */

function Gates({ result }: { result: PreviewResult }) {
  const { gates, warnings } = result;

  const headlineOk = gates.headline.verdict === "exact";
  const headlineAmber =
    gates.headline.verdict === "composed" || gates.headline.verdict === "too-short";

  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">
        Automatic checks before anything is sent
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        These run in code on every alert, not as a prompt instruction. A failed
        headline check suppresses the email entirely.
      </p>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <GateCard
          state={gates.sentences.ok ? "pass" : "fail"}
          title="Exactly 4 sentences"
          detail={
            gates.sentences.ok
              ? `Counted ${gates.sentences.count}${gates.sentences.retried ? " (after one rewrite)" : ""}`
              : `Counted ${gates.sentences.count}, expected 4 — flagged`
          }
        />
        <GateCard
          state={headlineOk ? "pass" : headlineAmber ? "warn" : "fail"}
          title="Headline is verbatim"
          detail={
            headlineOk
              ? "Found word-for-word in the release"
              : gates.headline.message ?? "Could not verify"
          }
        />
        <GateCard
          state={gates.link.ok ? "pass" : "fail"}
          title="Link goes to the release"
          detail={
            gates.link.ok
              ? "Distinct from the index page"
              : gates.link.message ?? "Points back at the index"
          }
        />
      </div>

      {warnings.length > 0 && (
        <ul className="mt-4 space-y-1.5 rounded-lg bg-amber-50 p-3">
          {warnings.map((w, i) => (
            <li key={i} className="text-xs leading-relaxed text-amber-900">
              {w}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
        <strong className="text-slate-800">Why the headline check matters:</strong>{" "}
        you forward these to colleagues. A subject line the AI invented or
        garbled is the one failure that cannot be tolerated, so the subject is
        matched against the release text and the alert is suppressed if it is not
        found.
      </p>
    </section>
  );
}

function GateCard({
  state,
  title,
  detail,
}: {
  state: "pass" | "warn" | "fail";
  title: string;
  detail: string;
}) {
  const styles = {
    pass: "border-emerald-200 bg-emerald-50",
    warn: "border-amber-200 bg-amber-50",
    fail: "border-red-200 bg-red-50",
  }[state];
  const icon = { pass: "✓", warn: "!", fail: "✕" }[state];
  const iconStyle = {
    pass: "bg-emerald-600",
    warn: "bg-amber-500",
    fail: "bg-red-600",
  }[state];

  return (
    <div className={`rounded-lg border p-3 ${styles}`}>
      <div className="flex items-center gap-2">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${iconStyle}`}
        >
          {icon}
        </span>
        <span className="text-xs font-semibold text-slate-800">{title}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">{detail}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Evidence panel
 * ------------------------------------------------------------------ */

function Evidence({ result }: { result: PreviewResult }) {
  const { evidence } = result;

  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">
        How this site would be monitored
      </h2>

      <div className="mt-4 flex flex-wrap gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            evidence.tier.tier === 1
              ? "bg-emerald-100 text-emerald-900"
              : "bg-blue-100 text-blue-900"
          }`}
        >
          Tier {evidence.tier.tier}: {evidence.tier.label}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
          {evidence.tier.creditsPerCheck === 0
            ? "0 credits per check"
            : `${evidence.tier.creditsPerCheck} credit per check`}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
          {evidence.releasesFound} releases detected
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        {evidence.tier.rationale}
      </p>

      {evidence.feedUrl && (
        <p className="mt-2 break-all rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-900">
          Feed found: <code>{evidence.feedUrl}</code>
        </p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            This run, measured
          </h3>
          <dl className="mt-2 space-y-1 text-xs">
            <Row k="Feed probe" v={`${evidence.seconds.discover}s`} />
            <Row k="Index page" v={`${evidence.seconds.index}s`} />
            <Row k="Release page" v={`${evidence.seconds.article}s`} />
            <Row k="Writing the email" v={`${evidence.seconds.summary}s`} />
            <Row k="Total" v={`${evidence.seconds.total}s`} strong />
          </dl>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Cost of this run
          </h3>
          <dl className="mt-2 space-y-1 text-xs">
            <Row k="Scraping credits" v={`${evidence.credits.total}`} />
            <Row k="AI summary" v={`$${evidence.summaryUsd.toFixed(5)}`} />
            <Row k="Model" v={evidence.model} />
            <Row k="Release length" v={`${evidence.articleChars.toLocaleString()} chars`} />
          </dl>
        </div>
      </div>

      {evidence.feedProbes.length > 0 && (
        <details className="mt-4 rounded-lg border border-slate-200 px-3.5 py-2.5">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            Feed detection detail ({evidence.feedProbes.length} addresses checked)
          </summary>
          <ul className="mt-2 space-y-1">
            {evidence.feedProbes.map((p) => (
              <li key={p.url} className="flex gap-2 text-[11px] leading-snug">
                <span className={p.isFeed ? "text-emerald-700" : "text-slate-400"}>
                  {p.isFeed ? "✓" : "·"}
                </span>
                <span className="min-w-0 flex-1 break-all text-slate-600">
                  {p.url.replace(/^https?:\/\//, "")}
                </span>
                <span className="shrink-0 text-slate-500">{p.note}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            A feed is only accepted if real items parse out of it. Some sites
            return a normal web page from a <code>.xml</code> address — treating
            that as a feed would mean silently never detecting their news.
          </p>
        </details>
      )}
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{k}</dt>
      <dd
        className={`text-right ${strong ? "font-semibold text-slate-900" : "text-slate-700"}`}
      >
        {v}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cost calculator pieces
 * ------------------------------------------------------------------ */

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  display: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-slate-600">{label}</label>
        <span className="text-sm font-semibold text-slate-900">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(value, max)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-slate-900"
      />
    </div>
  );
}

function CostRow({
  label,
  sub,
  r,
  tone,
}: {
  label: string;
  sub: string;
  r: { credits: number; plan: Plan; exceeds: boolean; billable: number };
  tone: "bad" | "mid" | "good";
}) {
  const badge = {
    bad: "bg-red-50 text-red-800",
    mid: "bg-amber-50 text-amber-900",
    good: "bg-emerald-50 text-emerald-900",
  }[tone];

  return (
    <tr>
      <td className="py-3 pr-3 align-top">
        <div className="text-[13px] font-medium text-slate-800">{label}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{sub}</div>
      </td>
      <td className="py-3 pr-3 align-top text-[13px] tabular-nums text-slate-700">
        {r.credits.toLocaleString()}
      </td>
      <td className="py-3 pr-3 align-top text-[13px] text-slate-700">
        {r.exceeds ? "Enterprise" : r.plan.name}
      </td>
      <td className="py-3 align-top">
        <span className={`rounded px-2 py-1 text-[13px] font-semibold ${badge}`}>
          {r.exceeds ? "Custom" : r.plan.monthlyUsd === 0 ? "$0" : `$${r.plan.monthlyUsd}`}
        </span>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ *
 * Error panel
 * ------------------------------------------------------------------ */

function ErrorPanel({ message, kind }: { message: string; kind: string }) {
  const hint: Record<string, string> = {
    dns: "Check the address for a typo. If the site has moved, the production monitor flags dead URLs instead of silently going quiet.",
    "no-releases":
      "Try the page that lists press releases directly — often /news, /press-releases, or an investor-relations newsroom.",
    "not-a-release":
      "This is the check working: rather than emailing you something irrelevant, the site gets flagged for review.",
    "headline-unverified":
      "This is the safety gate working. The subject line could not be matched to the release text, so nothing was sent.",
    "rate-limited": "This is a public demo, so API spend is capped per visitor.",
    "no-article-link":
      "The releases appear to be written inline on the index page rather than linking to their own pages. That is supported in production with a per-site rule.",
  };

  return (
    <section className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-5">
      <div className="flex gap-3">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">
          !
        </span>
        <div>
          <p className="text-sm font-medium leading-relaxed text-amber-950">
            {message}
          </p>
          {hint[kind] && (
            <p className="mt-2 text-xs leading-relaxed text-amber-900">
              {hint[kind]}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
  );
}
