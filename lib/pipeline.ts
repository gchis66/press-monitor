/**
 * pipeline.ts — the whole product, in one function.
 *
 * previewLatestRelease(newsroomUrl) does what the production agent does on a
 * single site when it detects a change:
 *
 *   1. discover  — probe for an RSS feed (free tier) and record the outcome
 *   2. index     — scrape the newsroom page, extracting the release list
 *   3. select    — take the newest release
 *   4. article   — scrape that release's own page
 *   5. write     — model produces subject + 4-sentence summary
 *   6. GATE      — sentence count, verbatim headline, distinct link
 *   7. evidence  — real latency, real credits, real projected monthly cost
 *
 * In production, step 2 runs on a schedule with changeTracking and steps 3-6
 * fire only when the diff says something changed. The demo runs it on demand so
 * the client can watch it work on their own site.
 */

import {
  scrape,
  assertUsableContent,
  FirecrawlError,
  firecrawlAvailable,
} from "./firecrawl";
import {
  writeEmail,
  rewriteSummary,
  INDEX_JSON_SCHEMA,
  SUMMARY_MODEL,
  summarizerAvailable,
  SummarizeError,
  type ReleaseRef,
} from "./summarize";
import { discoverFeed, type FeedProbe, type Tier } from "./discover";
import {
  detectBotWall,
  countVolatileTokens,
  VOLATILE_TOKEN_LIMIT,
} from "./botwall";
import {
  checkSentenceCount,
  verifyHeadline,
  isDistinctArticleUrl,
  absolutize,
  normalizeWhitespace,
  type HeadlineVerdict,
} from "./verify";
import { computeCost, compareStrategies, USD_PER_SUMMARY } from "./cost";

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    /** Short machine code so the UI can pick the right illustration/copy. */
    readonly kind: string = "error",
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface EmailPreview {
  subject: string;
  body: string;
  link: string;
  publishedDate: string;
  sourceSite: string;
}

export interface GateReport {
  sentences: {
    ok: boolean;
    count: number;
    expected: number;
    retried: boolean;
  };
  headline: {
    verdict: HeadlineVerdict;
    coverage: number;
    message?: string;
  };
  link: { ok: boolean; message?: string };
  /** All gates passed with no cautions. */
  allClear: boolean;
}

export interface Evidence {
  feedFound: boolean;
  feedUrl: string | null;
  feedProbes: { url: string; status: number | "error"; isFeed: boolean; note: string }[];
  tier: Tier;
  seconds: { discover: number; index: number; article: number; summary: number; total: number };
  credits: { index: number; article: number; total: number };
  summaryUsd: number;
  model: string;
  releasesFound: number;
  articleChars: number;
}

export interface Projection {
  sites: number;
  intervalMinutes: number;
  assumedFeeds: number;
  tiered: ReturnType<typeof computeCost>;
  diffOnly: ReturnType<typeof computeCost>;
  naive: ReturnType<typeof computeCost>;
}

export interface PreviewResult {
  newsroomUrl: string;
  email: EmailPreview;
  gates: GateReport;
  evidence: Evidence;
  projection: Projection;
  /** Non-fatal cautions worth showing the reviewer. */
  warnings: string[];
  otherReleases: ReleaseRef[];
}

const INDEX_EXTRACT_PROMPT = `List the press releases / news items on this page, newest first.
Copy each headline VERBATIM. URLs must be absolute.
Return the date exactly as printed, or "" if none.
IGNORE navigation, cookie banners, privacy notices, share buttons, footers,
stock tickers, event calendars, and newsletter signups — that is page furniture,
not news. If there are no press releases, return an empty array.`;

export async function previewLatestRelease(
  rawUrl: string,
): Promise<PreviewResult> {
  if (!firecrawlAvailable()) {
    throw new PipelineError(
      "The scraping service is not configured on this demo.",
      503,
      "misconfigured",
    );
  }
  if (!summarizerAvailable()) {
    throw new PipelineError(
      "The summarisation service is not configured on this demo.",
      503,
      "misconfigured",
    );
  }

  const newsroomUrl = normalizeInputUrl(rawUrl);
  const warnings: string[] = [];
  const t0 = Date.now();

  /* ---------- 1. index scrape (also serves as the feed-probe HTML) -------- */

  let index;
  try {
    index = await scrape(newsroomUrl, {
      jsonSchema: INDEX_JSON_SCHEMA,
      jsonPrompt: INDEX_EXTRACT_PROMPT,
      onlyMainContent: true,
    });
  } catch (err) {
    throw toPipelineError(err);
  }

  try {
    assertUsableContent(index, newsroomUrl, 200);
  } catch (err) {
    // assertUsableContent throws FirecrawlError; without this it escapes the
    // route as an unhandled 500 instead of a readable 422. Caught live.
    throw toPipelineError(err);
  }

  // BOT WALL CHECK — must run before anything else looks at this markdown.
  // A CAPTCHA page is long enough to pass the length check, and its rotating
  // prompt text makes change tracking fire on every single check. Found by the
  // soak test on investor.starbucks.com. See lib/botwall.ts.
  const wall = detectBotWall(index.markdown);
  if (wall.blocked) {
    console.error(
      `[pipeline] bot wall (${wall.label}) at ${newsroomUrl}: ${wall.evidence ?? ""}`,
    );
    throw new PipelineError(
      `That page served a bot-protection challenge (${wall.label}) instead of its content. Sites like this need a per-site rule — their RSS feed, a residential proxy, or a slower interval — which is exactly the kind of thing site onboarding sorts out.`,
      422,
      "bot-wall",
    );
  }

  const indexSeconds = index.seconds;

  /* ---------- 2. feed discovery (runs against the fetched page) ----------- */

  const dt0 = Date.now();
  const discovery = await discoverFeed(newsroomUrl, index.markdown, 5);
  const discoverSeconds = Number(((Date.now() - dt0) / 1000).toFixed(2));

  /* ---------- 3. select the newest release -------------------------------- */

  const rawReleases = extractReleases(index.json, newsroomUrl);

  if (rawReleases.length === 0) {
    throw new PipelineError(
      "No press releases could be found on that page. It may be a general marketing page rather than a newsroom or press-release index.",
      422,
      "no-releases",
    );
  }

  const latest = rawReleases[0];

  if (!isDistinctArticleUrl(latest.url, newsroomUrl)) {
    throw new PipelineError(
      "The newest item on that page does not link to its own release page, so there is nothing to summarise. This usually means the releases are inline on the index page.",
      422,
      "no-article-link",
    );
  }

  /* ---------- 4. scrape the article itself -------------------------------- */

  let article;
  try {
    article = await scrape(latest.url, { onlyMainContent: true });
  } catch (err) {
    throw toPipelineError(err, "The release page itself could not be read.");
  }

  try {
    assertUsableContent(article, latest.url, 200);
  } catch (err) {
    throw toPipelineError(err, "The release page itself could not be read.");
  }

  const articleWall = detectBotWall(article.markdown);
  if (articleWall.blocked) {
    console.error(
      `[pipeline] bot wall (${articleWall.label}) at ${latest.url}`,
    );
    throw new PipelineError(
      `The release page served a bot-protection challenge (${articleWall.label}) instead of the article, so no alert was generated rather than sending you a summary of a CAPTCHA screen.`,
      422,
      "bot-wall",
    );
  }

  /* ---------- 5. write the email ------------------------------------------ */

  let draft;
  let summarySeconds = 0;
  let summaryCost = 0;
  try {
    const r = await writeEmail(latest.url, article.markdown, latest.headline);
    draft = r.draft;
    summarySeconds += r.seconds;
    summaryCost += r.usage.cost ?? USD_PER_SUMMARY;
  } catch (err) {
    throw toPipelineError(err);
  }

  if (!draft.is_press_release) {
    throw new PipelineError(
      "The newest item on that page does not appear to be a press release. In production this site would be flagged for review rather than emailing you something irrelevant.",
      422,
      "not-a-release",
    );
  }

  /* ---------- 6. GATES ---------------------------------------------------- */

  // Gate 1: exactly four sentences. One corrective retry, then report honestly.
  let sentenceCheck = checkSentenceCount(draft.summary, 4);
  let retried = false;

  if (!sentenceCheck.ok) {
    retried = true;
    try {
      const r = await rewriteSummary(
        latest.url,
        article.markdown,
        draft.summary,
        sentenceCheck.count,
      );
      const retryCheck = checkSentenceCount(r.draft.summary, 4);
      summarySeconds += r.seconds;
      summaryCost += r.usage.cost ?? USD_PER_SUMMARY;
      // Keep the retry only if it actually fixed the count.
      if (retryCheck.ok) {
        draft = r.draft;
        sentenceCheck = retryCheck;
      }
    } catch {
      // Retry is best-effort: fall through and report the original honestly.
    }
    if (!sentenceCheck.ok) {
      warnings.push(
        `Summary came back as ${sentenceCheck.count} sentences instead of 4. Flagged rather than silently sent.`,
      );
    }
  }

  // Gate 2 (zero tolerance): the subject must exist in the article.
  const headlineCheck = verifyHeadline(draft.subject, article.markdown);

  if (headlineCheck.fatal) {
    // Suppress rather than send. A fabricated headline in a media-monitoring
    // product is the fireable error — it gets forwarded to an executive.
    throw new PipelineError(
      "The generated subject line could not be verified against the article text, so this alert was suppressed. The system never sends a headline it cannot find in the source.",
      422,
      "headline-unverified",
    );
  }

  if (headlineCheck.verdict === "composed") {
    warnings.push(
      "Subject matches the article's wording but not as one contiguous string — usually a truncated listing headline.",
    );
  }
  if (headlineCheck.verdict === "too-short") {
    warnings.push("Headline was too short to verify strictly against the article.");
  }

  // Gate 3: the link must go to the release, not back to the index.
  const linkOk = isDistinctArticleUrl(latest.url, newsroomUrl);

  // Diff-stability check. Rotating single-use URLs (cache busters, nonces,
  // CAPTCHA payloads) make a page diff against itself, which would produce a
  // false "new release" alert on every check. Surfacing it means the site gets
  // a per-site rule at onboarding instead of spamming the client.
  const volatileTokens = countVolatileTokens(index.markdown);
  if (volatileTokens > VOLATILE_TOKEN_LIMIT) {
    warnings.push(
      `This page contains ${volatileTokens} single-use URLs that change on every load, so plain change detection would fire constantly. In production this site gets pinned to its feed or a narrowed page region.`,
    );
  }

  const gates: GateReport = {
    sentences: {
      ok: sentenceCheck.ok,
      count: sentenceCheck.count,
      expected: 4,
      retried,
    },
    headline: {
      verdict: headlineCheck.verdict,
      coverage: headlineCheck.coverage,
      message: headlineCheck.message,
    },
    link: {
      ok: linkOk,
      message: linkOk ? undefined : "Link points back at the index page.",
    },
    allClear:
      sentenceCheck.ok && headlineCheck.verdict === "exact" && linkOk,
  };

  /* ---------- 7. evidence + projection ------------------------------------ */

  const totalSeconds = Number(((Date.now() - t0) / 1000).toFixed(2));

  const evidence: Evidence = {
    feedFound: Boolean(discovery.feedUrl),
    feedUrl: discovery.feedUrl,
    feedProbes: discovery.probes.map((p) => ({
      url: p.url,
      status: p.status,
      isFeed: p.isFeed,
      note: describeProbe(p),
    })),
    tier: discovery.tier,
    seconds: {
      discover: discoverSeconds,
      index: indexSeconds,
      article: article.seconds,
      summary: summarySeconds,
      total: totalSeconds,
    },
    credits: {
      index: index.credits,
      article: article.credits,
      total: index.credits + article.credits,
    },
    summaryUsd: Number(summaryCost.toFixed(5)),
    model: SUMMARY_MODEL,
    releasesFound: rawReleases.length,
    articleChars: article.markdown.length,
  };

  // Default projection uses the client's literal spec (55 sites / 20 min) and
  // the measured feed hit rate as the feed assumption.
  const projection = buildProjection(55, 20, discovery.feedUrl ? 20 : 20);

  return {
    newsroomUrl,
    email: {
      subject: normalizeWhitespace(draft.subject),
      body: normalizeWhitespace(draft.summary),
      link: latest.url,
      publishedDate: draft.published_date || latest.date || "",
      sourceSite: safeHostname(newsroomUrl),
    },
    gates,
    evidence,
    projection,
    warnings,
    otherReleases: rawReleases.slice(1, 6),
  };
}

export function buildProjection(
  sites: number,
  intervalMinutes: number,
  assumedFeeds: number,
): Projection {
  const input = {
    sites,
    intervalMinutes,
    sitesWithFeed: assumedFeeds,
    releasesPerSitePerMonth: 4,
    judging: true,
  };
  const all = compareStrategies(input);
  return {
    sites,
    intervalMinutes,
    assumedFeeds,
    tiered: all.tiered,
    diffOnly: all.diffOnly,
    naive: all.naive,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Pull the release list out of Firecrawl's json payload, defensively. */
function extractReleases(
  json: Record<string, unknown> | undefined,
  baseUrl: string,
): ReleaseRef[] {
  if (!json) return [];
  const raw = (json as { releases?: unknown }).releases;
  if (!Array.isArray(raw)) return [];

  const out: ReleaseRef[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const headline = typeof rec.headline === "string" ? rec.headline.trim() : "";
    const hrefRaw = typeof rec.url === "string" ? rec.url.trim() : "";
    const date = typeof rec.date === "string" ? rec.date.trim() : "";
    if (!headline || !hrefRaw) continue;

    // The model is told to return absolute URLs, but resolve anyway — a
    // relative href would otherwise become an unfetchable link in the email.
    const abs = absolutize(hrefRaw, baseUrl);
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    out.push({ headline: normalizeWhitespace(headline), url: abs, date });
  }

  return out;
}

function describeProbe(p: FeedProbe): string {
  if (p.isFeed) return `Working feed — ${p.sampleTitles.length} items read`;
  if (p.status === "error") return p.error ?? "Could not connect";
  if (p.error === "Feed contained no readable items") return "Feed had no readable items";
  if (p.status === 200) {
    // The measured jnj.com trap: 200 + .xml URL + HTML body.
    return p.contentType.includes("html")
      ? "Returned HTML, not a feed (fake feed)"
      : "Not a feed";
  }
  return `HTTP ${p.status}`;
}

function normalizeInputUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new PipelineError("Please enter a newsroom URL.", 400, "empty");
  }
  if (trimmed.length > 2000) {
    throw new PipelineError("That URL is too long.", 400, "bad-url");
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new PipelineError(
      "That does not look like a valid URL. Try something like example.com/news.",
      400,
      "bad-url",
    );
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new PipelineError("Only http and https URLs are supported.", 400, "bad-url");
  }
  if (!u.hostname.includes(".")) {
    throw new PipelineError(
      "That does not look like a valid domain. Try something like example.com/news.",
      400,
      "bad-url",
    );
  }
  // Block obvious SSRF targets: this endpoint is public.
  if (isPrivateHost(u.hostname)) {
    throw new PipelineError("That host is not reachable from this demo.", 400, "bad-url");
  }

  return u.toString();
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function toPipelineError(err: unknown, prefix?: string): PipelineError {
  if (err instanceof PipelineError) return err;
  if (err instanceof FirecrawlError) {
    return new PipelineError(
      prefix ? `${prefix} ${err.message}` : err.message,
      err.status,
      err.code === "SCRAPE_DNS_RESOLUTION_ERROR" ? "dns" : "scrape",
    );
  }
  if (err instanceof SummarizeError) {
    return new PipelineError(err.message, err.status, "summarize");
  }
  console.error(`[pipeline] unexpected: ${String(err)}`);
  return new PipelineError("Something went wrong processing that site.", 502, "error");
}
