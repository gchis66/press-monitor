/**
 * firecrawl.ts — Firecrawl v2 client.
 *
 * THE TRAP THIS MODULE EXISTS TO CLOSE (found during the pre-spec probe):
 *
 * A mistyped hostname returned a response my first harness read as success with
 * an empty markdown string, because it only looked at `data.markdown`. The real
 * body was:
 *
 *   { "success": false, "code": "SCRAPE_DNS_RESOLUTION_ERROR",
 *     "error": "DNS resolution failed for hostname ..." }
 *
 * HTTP 200 with `success: false`. Any client that reads `data.markdown` without
 * checking `success` will silently treat a dead site as a site with no news --
 * forever. For a monitoring product that is the worst possible failure: the
 * client stops hearing about a company and is never told why. So every response
 * goes through assertOk() and every empty result is an explicit error.
 *
 * MEASURED (2026-07-31): 8/8 real newsrooms scraped successfully on default
 * settings, including 2 that returned HTTP 403 to a plain browser-UA fetch
 * (ir.tesla.com, caterpillar.com) and 4 JS-rendered Q4 Inc IR platforms
 * (Nike, Starbucks, Chipotle, Delta). No waitFor or stealth proxy needed.
 * Median latency 0.55s.
 */

const API_BASE = "https://api.firecrawl.dev/v2";
const SCRAPE_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export class FirecrawlError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    /** Firecrawl's machine-readable code, when it supplied one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "FirecrawlError";
  }
}

export function firecrawlAvailable(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

export interface ScrapeResult {
  markdown: string;
  json?: Record<string, unknown>;
  changeStatus?: "new" | "same" | "changed" | "removed";
  previousScrapeAt?: string | null;
  statusCode?: number;
  title?: string;
  /** Wall-clock seconds for this call — shown in the demo's evidence panel. */
  seconds: number;
  /** Credits this call consumed, per Firecrawl's published pricing. */
  credits: number;
}

interface FirecrawlEnvelope {
  success?: boolean;
  error?: string;
  code?: string;
  warning?: string;
  data?: {
    markdown?: string;
    json?: Record<string, unknown>;
    changeTracking?: {
      changeStatus?: "new" | "same" | "changed" | "removed";
      previousScrapeAt?: string | null;
    };
    metadata?: {
      statusCode?: number;
      title?: string;
      error?: string;
    };
  };
}

export interface ScrapeOptions {
  /** JSON-schema extraction. Costs +4 credits/page, so use only when needed. */
  jsonSchema?: Record<string, unknown>;
  jsonPrompt?: string;
  /** Enable changeTracking. Basic mode and git-diff are FREE. */
  trackChanges?: boolean;
  /** Separate change-tracking history, e.g. per monitoring interval. */
  trackingTag?: string;
  onlyMainContent?: boolean;
  /** Extra client-side wait for JS rendering. Measured unnecessary on 8/8. */
  waitForMs?: number;
}

/**
 * Translate a Firecrawl envelope into either data or a loud, readable error.
 * This is the single choke point that makes silent failure impossible.
 */
function assertOk(json: FirecrawlEnvelope, url: string): void {
  if (json.success === false || json.error) {
    const code = json.code ?? "";
    const raw = json.error ?? "Unknown error";

    // Log the upstream body server-side: a 4xx from a scrape API is usually a
    // request-shape bug on our side, and the friendly message hides that.
    console.error(`[firecrawl] ${code || "error"} for ${url}: ${raw.slice(0, 300)}`);

    if (code === "SCRAPE_DNS_RESOLUTION_ERROR") {
      throw new FirecrawlError(
        "That domain could not be found. Check the URL for typos — the site may have moved or the address may be misspelled.",
        400,
        code,
      );
    }
    if (code.includes("TIMEOUT")) {
      throw new FirecrawlError(
        "The site took too long to respond. It may be slow or temporarily down.",
        504,
        code,
      );
    }
    if (/robots|forbidden|blocked/i.test(raw)) {
      throw new FirecrawlError(
        "This site blocks automated access. In production we'd route it through a stealth proxy or use its RSS feed instead.",
        403,
        code,
      );
    }
    throw new FirecrawlError(
      "That page could not be read. It may be down, blocked, or not a public page.",
      502,
      code,
    );
  }
}

/** Scrape one URL. Retries only on transient upstream failures. */
export async function scrape(
  url: string,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new FirecrawlError("FIRECRAWL_API_KEY is not configured.", 500);
  }

  const formats: unknown[] = ["markdown"];
  let credits = 1;

  if (options.jsonSchema) {
    formats.push({
      type: "json",
      schema: options.jsonSchema,
      ...(options.jsonPrompt ? { prompt: options.jsonPrompt } : {}),
    });
    credits += 4; // measured against published pricing 2026-07-31
  }

  if (options.trackChanges) {
    // changeTracking is FREE in basic and git-diff modes. Only `json` mode
    // costs extra, and we deliberately do not use it: our own extraction step
    // is cheaper and we control the schema.
    formats.push({
      type: "changeTracking",
      ...(options.trackingTag ? { tag: options.trackingTag } : {}),
    });
  }

  const body: Record<string, unknown> = {
    url,
    formats,
    onlyMainContent: options.onlyMainContent ?? true,
  };
  if (options.waitForMs) body.waitFor = options.waitForMs;

  let lastTransient = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
    const started = Date.now();

    try {
      const res = await fetch(`${API_BASE}/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Retry only transient classes. A 400 is our bug and will not improve.
      if (res.status === 429 || res.status >= 500) {
        lastTransient = `upstream ${res.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(700 * 2 ** (attempt - 1));
          continue;
        }
        throw new FirecrawlError(
          "The scraping service is busy. Try again in a moment.",
          503,
        );
      }

      const text = await res.text();
      let json: FirecrawlEnvelope;
      try {
        json = JSON.parse(text) as FirecrawlEnvelope;
      } catch {
        // Non-JSON body: usually a platform-level error page, not Firecrawl.
        console.error(`[firecrawl] non-JSON ${res.status}: ${text.slice(0, 200)}`);
        throw new FirecrawlError("The scraping service returned an unreadable response.", 502);
      }

      if (res.status === 401 || res.status === 403) {
        console.error(`[firecrawl] auth ${res.status}: ${text.slice(0, 200)}`);
        throw new FirecrawlError(
          "The scraping service rejected our credentials. Please contact the site owner.",
          502,
        );
      }
      // Out-of-credit detection MUST be scoped to the error field, never the
      // whole body. Every SUCCESSFUL response contains `"creditsUsed":N` in its
      // metadata, so testing /credit/ against the raw text turns every working
      // 200 into a fake "out of credit" 502. That bug survived unit tests and
      // was only caught by the live suite.
      const errText = typeof json.error === "string" ? json.error : "";
      if (res.status === 402 || (json.success === false && /credit|quota|payment|insufficient/i.test(errText))) {
        throw new FirecrawlError(
          "The scraping service is out of credit. Please contact the site owner.",
          502,
        );
      }

      // Runs for non-ok statuses AND for HTTP 200 + success:false.
      assertOk(json, url);

      if (!res.ok) {
        throw new FirecrawlError("That page could not be read.", 502);
      }

      const seconds = Number(((Date.now() - started) / 1000).toFixed(2));
      const data = json.data ?? {};
      const markdown = data.markdown ?? "";

      if (json.warning) {
        console.warn(`[firecrawl] warning for ${url}: ${json.warning}`);
      }

      return {
        markdown,
        json: data.json,
        changeStatus: data.changeTracking?.changeStatus,
        previousScrapeAt: data.changeTracking?.previousScrapeAt ?? null,
        statusCode: data.metadata?.statusCode,
        title: data.metadata?.title,
        seconds,
        credits,
      };
    } catch (err) {
      if (err instanceof FirecrawlError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < MAX_ATTEMPTS) {
          lastTransient = "timeout";
          continue;
        }
        throw new FirecrawlError(
          "The site took too long to respond. It may be slow or temporarily down.",
          504,
        );
      }
      if (attempt < MAX_ATTEMPTS) {
        lastTransient = "network";
        await sleep(700 * 2 ** (attempt - 1));
        continue;
      }
      console.error(`[firecrawl] network failure for ${url}: ${String(err)}`);
      throw new FirecrawlError("Could not reach the scraping service.", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new FirecrawlError(
    `The scraping service did not respond (${lastTransient}).`,
    502,
  );
}

/**
 * Assert a scrape produced enough content to be usable.
 *
 * A page that renders to almost nothing is a JS shell or a soft-404. Measured:
 * jnj.com returned HTTP 200 with 156 characters of text to a plain fetch. At
 * onboarding this must fail loudly so the site gets fixed rather than silently
 * never reporting news.
 */
export function assertUsableContent(
  result: ScrapeResult,
  url: string,
  minChars = 400,
): void {
  const len = result.markdown.trim().length;
  if (len >= minChars) return;
  console.error(`[firecrawl] thin content for ${url}: ${len} chars`);
  throw new FirecrawlError(
    len === 0
      ? "That page returned no readable content. It may require a login, or it may not be a public press-release page."
      : `That page returned very little content (${len} characters), which usually means it needs JavaScript rendering or a login.`,
    422,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
