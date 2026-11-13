/**
 * discover.ts — feed detection and tier assignment.
 *
 * THIS MODULE IS THE $300/MONTH DECISION.
 *
 * The client wants 55 sites checked every 20 minutes. Firecrawl bills 1 credit
 * per page per check, so 55 paid sites = 118,800 credits/month = the $399
 * Growth plan. Every site that publishes an RSS/Atom feed can be polled for
 * FREE and forever, and each one permanently removes 2,191 credits/month from
 * the bill. Twenty feeds is the difference between $399/mo and $99/mo.
 *
 * MEASURED (2026-07-31, 8 real newsrooms):
 *   working feeds .... 2   ir.crowdstrike.com/rss/news-releases.xml
 *                          news.microsoft.com/feed/
 *   403 .............. 2   ir.tesla.com/*
 *   404 .............. 3
 *   FAKE FEED ........ 1   jnj.com/rss/press-releases.xml -> 200 text/html
 *
 * That last one is the trap this module exists to defeat. A URL ending in .xml
 * that returns HTTP 200 is NOT a feed. Trusting it would silently route a site
 * into the free tier where it can never detect a release, and the client would
 * never be told — they would simply stop hearing about that company. Worse than
 * a crash, because it fails quietly. So: sniff the BODY, never the extension.
 *
 * Q4 Inc / Nasdaq IR platforms host a large share of any US corporate list and
 * commonly expose /rss/news-releases.xml, so a realistic 55-site list should
 * yield roughly 15-25 feeds. That is an expectation to VERIFY per site at
 * onboarding, never an assumption to bill against.
 */

export interface FeedProbe {
  url: string;
  status: number | "error";
  contentType: string;
  isFeed: boolean;
  /** Item titles parsed from the feed, newest first. Proof it actually works. */
  sampleTitles: string[];
  error?: string;
}

export interface Tier {
  tier: 1 | 2;
  label: string;
  creditsPerCheck: number;
  rationale: string;
}

/* ------------------------------------------------------------------ *
 * Feed sniffing
 * ------------------------------------------------------------------ */

/**
 * Decide whether a response body is genuinely a feed.
 *
 * Rules, in order:
 *   1. An HTML doctype or <html> root disqualifies it outright, regardless of
 *      content-type or URL extension. This is the jnj.com case.
 *   2. A feed root element must appear near the START of the document, not
 *      merely somewhere inside it (an HTML page can mention <rss> in body text
 *      or in a link tag).
 *   3. Content-type is corroborating evidence only — some real feeds are served
 *      as text/plain or application/octet-stream.
 */
export function looksLikeFeed(body: string, contentType: string): boolean {
  if (!body || !body.trim()) return false;

  const head = body.slice(0, 2000);
  const lower = head.toLowerCase();

  // Rule 1: HTML disqualifies. Checked before anything else.
  if (/<!doctype\s+html/i.test(lower)) return false;
  if (/<html[\s>]/i.test(lower)) return false;

  // Rule 2: feed root near the top of the document.
  const withoutDecl = lower
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/g, "")
    .trimStart();

  if (/^<(rss|feed|rdf:rdf)[\s>]/.test(withoutDecl)) return true;

  // Some feeds open with a stylesheet PI or stray whitespace before <rss>.
  const firstTag = withoutDecl.match(/<([a-z:]+)[\s>]/);
  if (firstTag && ["rss", "feed", "rdf:rdf"].includes(firstTag[1])) return true;

  // Rule 3: a declared feed content-type plus a <channel>/<entry> element.
  const ct = contentType.toLowerCase();
  const declaresFeed =
    ct.includes("rss") || ct.includes("atom") || ct.includes("xml");
  if (declaresFeed && /<(channel|entry)[\s>]/.test(lower)) return true;

  return false;
}

/** Extract item titles from an RSS or Atom body, in document order. */
export function parseFeedTitles(body: string, limit = 5): string[] {
  const titles: string[] = [];

  // Match <item>/<entry> blocks, then the first <title> inside each. Taking
  // titles globally would capture the CHANNEL title as item #1 -- which is
  // exactly what the raw probe did (it returned "Stories" for Microsoft).
  const blocks = body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];

  for (const block of blocks) {
    const m = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) continue;
    const title = decodeXmlText(m[1]);
    if (title) titles.push(title);
    if (titles.length >= limit) break;
  }

  return titles;
}

/** Extract item links from a feed, aligned with parseFeedTitles order. */
export function parseFeedLinks(body: string, limit = 5): string[] {
  const links: string[] = [];
  const blocks = body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];

  for (const block of blocks) {
    // RSS: <link>url</link>. Atom: <link href="url"/>, possibly rel="alternate".
    let url = "";
    const atom = block.match(
      /<link[^>]*\shref=["']([^"']+)["'][^>]*\/?>/i,
    );
    const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (rss && rss[1].trim()) url = decodeXmlText(rss[1]);
    else if (atom) url = decodeXmlText(atom[1]);

    if (url) links.push(url);
    if (links.length >= limit) break;
  }

  return links;
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * Candidate feed URLs
 * ------------------------------------------------------------------ */

/**
 * Conventional feed paths, ordered by observed hit rate on corporate
 * newsrooms. `/rss/news-releases.xml` is first because it is the Q4 Inc IR
 * platform default and Q4 hosts a large share of US public-company IR sites.
 */
const FEED_PATHS = [
  "/rss/news-releases.xml",
  "/rss/pressreleases.xml",
  "/feed/",
  "/rss",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/news/rss",
];

/**
 * Build a bounded, de-duplicated candidate list for a newsroom URL.
 * Tries paths relative to the page's own directory first (a newsroom often
 * lives under /investors/ or /news/), then at the domain root.
 */
export function pickFeedCandidates(pageUrl: string, max = 10): string[] {
  let u: URL;
  try {
    u = new URL(pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  } catch {
    return [];
  }

  const out: string[] = [];
  const push = (candidate: string) => {
    if (out.length >= max) return;
    if (!out.includes(candidate)) out.push(candidate);
  };

  // Directory of the page itself, e.g. https://host/investors/
  const dir = u.pathname.replace(/\/[^/]*$/, "");

  for (const p of FEED_PATHS) {
    push(new URL(p, `${u.origin}${dir || "/"}/`.replace(/\/+$/, "/")).toString());
  }
  for (const p of FEED_PATHS) {
    push(new URL(p, u.origin).toString());
  }

  return out.slice(0, max);
}

/**
 * Discover <link rel="alternate" type="application/rss+xml"> declarations in a
 * page's HTML. Far more reliable than guessing paths when it is present, so
 * callers should try this FIRST and fall back to pickFeedCandidates.
 */
export function extractDeclaredFeeds(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of linkTags) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (!href) continue;
    try {
      const abs = new URL(href[1], baseUrl).toString();
      if (!out.includes(abs)) out.push(abs);
    } catch {
      /* skip unresolvable href */
    }
  }

  return out.slice(0, 5);
}

/* ------------------------------------------------------------------ *
 * Tier assignment
 * ------------------------------------------------------------------ */

/**
 * TIER 1 — a verified feed. Zero credits, forever, and lower latency than a
 *          browser render. Verified means we parsed real item titles out of it,
 *          not merely that the URL returned 200.
 * TIER 2 — Firecrawl scrape + changeTracking. 1 credit/check, free diff.
 *
 * Tier 3 (extract + summarise + email) is not a polling tier: it fires only in
 * response to a detected change, so it has no per-check cost.
 */
export function assignTier(site: { feedUrl: string | null }): Tier {
  if (site.feedUrl) {
    return {
      tier: 1,
      label: "RSS feed",
      creditsPerCheck: 0,
      rationale:
        "This site publishes a working feed, so checks are free and instant — no scraping credits, forever.",
    };
  }
  return {
    tier: 2,
    label: "Scrape + change tracking",
    creditsPerCheck: 1,
    rationale:
      "No usable feed, so this site is scraped and diffed. Firecrawl's change tracking is free; only the page fetch is billed.",
  };
}

/* ------------------------------------------------------------------ *
 * Live probing
 * ------------------------------------------------------------------ */

const FEED_TIMEOUT_MS = 8_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Fetch one candidate and decide whether it is a real, working feed.
 * Never throws — a probe failure is data, not an exception.
 */
export async function probeFeed(url: string): Promise<FeedProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    const contentType = res.headers.get("content-type") ?? "";
    // Read a bounded prefix: enough to sniff and grab a few titles.
    const body = (await res.text()).slice(0, 60_000);

    if (!res.ok) {
      return {
        url,
        status: res.status,
        contentType,
        isFeed: false,
        sampleTitles: [],
        error: `HTTP ${res.status}`,
      };
    }

    const isFeed = looksLikeFeed(body, contentType);
    const sampleTitles = isFeed ? parseFeedTitles(body) : [];

    // A feed with zero parseable items is not usable for change detection --
    // treat it as no feed rather than routing the site into a silent free tier.
    if (isFeed && sampleTitles.length === 0) {
      return {
        url,
        status: res.status,
        contentType,
        isFeed: false,
        sampleTitles: [],
        error: "Feed contained no readable items",
      };
    }

    return { url, status: res.status, contentType, isFeed, sampleTitles };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      url,
      status: "error",
      contentType: "",
      isFeed: false,
      sampleTitles: [],
      error: aborted ? "Timed out" : "Could not connect",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DiscoveryResult {
  feedUrl: string | null;
  tier: Tier;
  probes: FeedProbe[];
  sampleTitles: string[];
}

/**
 * Find a usable feed for a newsroom page, bounded in both time and requests.
 *
 * @param pageUrl   the newsroom / press-release index URL
 * @param pageHtml  optional already-fetched HTML, to read <link rel=alternate>
 * @param maxProbes cap on network requests. Keep small: this runs inside a
 *                  request handler and the answer only needs to be good enough
 *                  to choose a tier.
 */
export async function discoverFeed(
  pageUrl: string,
  pageHtml?: string,
  maxProbes = 5,
): Promise<DiscoveryResult> {
  const probes: FeedProbe[] = [];

  const declared = pageHtml ? extractDeclaredFeeds(pageHtml, pageUrl) : [];
  const guessed = pickFeedCandidates(pageUrl);

  // Declared feeds first — they are authoritative when present.
  const candidates: string[] = [];
  for (const c of [...declared, ...guessed]) {
    if (!candidates.includes(c)) candidates.push(c);
    if (candidates.length >= maxProbes) break;
  }

  // Probe in parallel; first genuine feed in PRIORITY order wins (not the
  // first to respond, which would make tier assignment non-deterministic).
  const results = await Promise.all(candidates.map(probeFeed));
  probes.push(...results);

  const hit = results.find((r) => r.isFeed && r.sampleTitles.length > 0);
  const feedUrl = hit ? hit.url : null;

  return {
    feedUrl,
    tier: assignTier({ feedUrl }),
    probes,
    sampleTitles: hit ? hit.sampleTitles : [],
  };
}
