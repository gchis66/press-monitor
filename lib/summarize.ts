/**
 * summarize.ts — OpenRouter client that writes the email.
 *
 * Two model calls, both with strict JSON schemas:
 *   1. listReleases()  — newsroom index markdown -> ordered release list
 *   2. writeEmail()    — one release's article -> subject + 4-sentence body
 *
 * MODEL CHOICE: google/gemini-2.5-flash. Measured on 3 real releases
 * (2026-07-31): correct on 3/3, mean $0.001 per release, 1.3-1.7s. Frontier
 * models are not better at this and cost 20-50x more — the same finding as the
 * receipt-OCR benchmark.
 *
 * SCHEMA PORTABILITY: no type:["string","null"] unions and no nullable enums --
 * Anthropic rejects those outright. Bare type:"string" with "" for absent
 * values works across OpenAI, Anthropic, and Google, so the model can be
 * swapped without touching the schema.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "google/gemini-2.5-flash";

export class SummarizeError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = "SummarizeError";
  }
}

export function summarizerAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const RELEASE_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    releases: {
      type: "array",
      description: "Press releases found on the page, NEWEST FIRST.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string", description: "Headline, verbatim." },
          url: { type: "string", description: "Absolute URL to the release." },
          date: { type: "string", description: "Date as printed, or \"\"." },
        },
        required: ["headline", "url", "date"],
      },
    },
  },
  required: ["releases"],
} as const;

const EMAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: {
      type: "string",
      description: "The press release headline, copied VERBATIM from the article.",
    },
    summary: {
      type: "string",
      description: "EXACTLY four sentences of plain factual prose.",
    },
    published_date: {
      type: "string",
      description: "ISO YYYY-MM-DD, or \"\" if not stated.",
    },
    is_press_release: {
      type: "boolean",
      description: "False if this page is not actually a press release.",
    },
  },
  required: ["subject", "summary", "published_date", "is_press_release"],
} as const;

export const INDEX_JSON_SCHEMA = RELEASE_LIST_SCHEMA as unknown as Record<
  string,
  unknown
>;

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

const INDEX_PROMPT = `You are reading a company newsroom or investor-relations index page.

List the PRESS RELEASES / NEWS ITEMS on the page, newest first.

Rules:
- Copy each headline VERBATIM. Never rewrite, expand, or tidy it.
- URLs must be absolute. If a link is relative, resolve it against the page URL.
- Return the date exactly as printed on the page, or "" if none is shown.
- IGNORE navigation, breadcrumbs, cookie banners, privacy notices, share
  buttons, footers, "related links", stock tickers, event calendars, and
  newsletter signup blocks. These are page furniture, not news.
- If the page shows no press releases at all, return an empty array. Do NOT
  invent entries.`;

const EMAIL_SYSTEM_PROMPT = `You turn one press release into an email alert.

Output rules, all mandatory:

1. subject — the release's headline, copied VERBATIM from the article text.
   Do not rewrite it, do not add the company name, do not add a prefix. If the
   headline appears truncated in the source, use the article's own full headline.

2. summary — EXACTLY FOUR SENTENCES. Not three, not five. Plain factual prose.
   - Lead with what was announced and who announced it.
   - Include concrete specifics: figures, dates, names, locations, amounts.
   - No marketing language ("exciting", "thrilled", "game-changing", "leading
     provider"). Strip promotional adjectives even when the release uses them.
   - No bullet points, no headings, no line breaks. Four sentences of prose.
   - Never state a fact that is not in the source text.

3. published_date — ISO YYYY-MM-DD if determinable, otherwise "".

4. is_press_release — set FALSE if the page is not actually a single press
   release: a listing/index page, a 404, a login wall, a cookie notice, or a
   general marketing page. When false, still fill the other fields as best you
   can; the caller will suppress the email.`;

/* ------------------------------------------------------------------ *
 * Core call
 * ------------------------------------------------------------------ */

interface UsageInfo {
  cost?: number;
  total_tokens?: number;
}

async function callModel<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  schemaName: string,
  maxTokens = 2000,
): Promise<{ parsed: T; usage: UsageInfo; seconds: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new SummarizeError("OPENROUTER_API_KEY is not configured.", 500);
  }

  // Reasoning models (gpt-5*, o*) reject `max_tokens` and require
  // `max_completion_tokens`. Both return an instant 400 that looks like the
  // model being bad at the task rather than a request-shape bug.
  const isReasoning = /(^|\/)(gpt-5|o[1-9])/.test(SUMMARY_MODEL);
  const tokenLimit = isReasoning
    ? { max_completion_tokens: maxTokens * 2 }
    : { max_tokens: maxTokens };

  const body = {
    model: SUMMARY_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    ...tokenLimit,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
  };

  let lastTransient = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const started = Date.now();

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Press Release Monitor",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        lastTransient = `upstream ${res.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(800 * 2 ** (attempt - 1));
          continue;
        }
        throw new SummarizeError(
          "The summarisation service is busy. Try again in a moment.",
          503,
        );
      }

      const text = await res.text();

      if (!res.ok) {
        // Read the error body BEFORE mapping to a friendly message. A 400 from
        // an LLM API is almost always a request-shape bug (wrong token param,
        // unsupported schema construct), not a bad input.
        console.error(`[summarize] ${res.status}: ${text.slice(0, 400)}`);
        if (res.status === 401 || res.status === 403) {
          throw new SummarizeError(
            "The summarisation service rejected our credentials. Please contact the site owner.",
            502,
          );
        }
        if (res.status === 402) {
          throw new SummarizeError(
            "The summarisation service is out of credit. Please contact the site owner.",
            502,
          );
        }
        throw new SummarizeError("The summary could not be generated.", 502);
      }

      const json = JSON.parse(text) as {
        choices?: { message?: { content?: string } }[];
        usage?: UsageInfo;
      };

      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new SummarizeError("The summarisation service returned no content.", 502);
      }

      let parsed: T;
      try {
        parsed = JSON.parse(content) as T;
      } catch {
        console.error(`[summarize] unparseable JSON: ${content.slice(0, 300)}`);
        throw new SummarizeError("The summary came back in an unreadable format.", 502);
      }

      return {
        parsed,
        usage: json.usage ?? {},
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      };
    } catch (err) {
      if (err instanceof SummarizeError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < MAX_ATTEMPTS) {
          lastTransient = "timeout";
          continue;
        }
        throw new SummarizeError("The summary timed out.", 504);
      }
      if (attempt < MAX_ATTEMPTS) {
        lastTransient = "network";
        await sleep(800 * 2 ** (attempt - 1));
        continue;
      }
      console.error(`[summarize] network failure: ${String(err)}`);
      throw new SummarizeError("Could not reach the summarisation service.", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new SummarizeError(
    `The summarisation service did not respond (${lastTransient}).`,
    502,
  );
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface ReleaseRef {
  headline: string;
  url: string;
  date: string;
}

/**
 * Identify the press releases listed on an index page.
 *
 * Used as a FALLBACK. The primary path uses Firecrawl's own json format in the
 * same request as the scrape, which saves a round trip. This exists for the
 * feed path (where we already have titles and links) and for retries.
 */
export async function listReleases(
  indexUrl: string,
  markdown: string,
): Promise<{ releases: ReleaseRef[]; usage: UsageInfo; seconds: number }> {
  const { parsed, usage, seconds } = await callModel<{ releases: ReleaseRef[] }>(
    INDEX_PROMPT,
    `Page URL: ${indexUrl}\n\n${markdown.slice(0, 24_000)}`,
    RELEASE_LIST_SCHEMA as unknown as Record<string, unknown>,
    "release_list",
    3000,
  );
  return { releases: parsed.releases ?? [], usage, seconds };
}

export interface EmailDraft {
  subject: string;
  summary: string;
  published_date: string;
  is_press_release: boolean;
}

/** Write the alert email for one press release. */
export async function writeEmail(
  articleUrl: string,
  articleMarkdown: string,
  knownHeadline?: string,
): Promise<{ draft: EmailDraft; usage: UsageInfo; seconds: number }> {
  const hint = knownHeadline
    ? `\n\nThe listing page showed this headline (it may be truncated): ${knownHeadline}`
    : "";

  const { parsed, usage, seconds } = await callModel<EmailDraft>(
    EMAIL_SYSTEM_PROMPT,
    `URL: ${articleUrl}${hint}\n\nARTICLE TEXT:\n${articleMarkdown.slice(0, 20_000)}`,
    EMAIL_SCHEMA as unknown as Record<string, unknown>,
    "email_alert",
    1200,
  );

  return { draft: parsed, usage, seconds };
}

/**
 * One retry with explicit corrective feedback when the sentence-count gate
 * fails. Cheap ($0.001) and deterministic in its trigger, so it is worth it
 * before surfacing a visibly-wrong summary to the client.
 */
export async function rewriteSummary(
  articleUrl: string,
  articleMarkdown: string,
  previousSummary: string,
  actualCount: number,
): Promise<{ draft: EmailDraft; usage: UsageInfo; seconds: number }> {
  const corrective = `${EMAIL_SYSTEM_PROMPT}

CORRECTION: your previous attempt produced ${actualCount} sentences, not 4.
Previous attempt was:
"${previousSummary}"

Rewrite it as EXACTLY FOUR sentences. Count them before responding.`;

  const { parsed, usage, seconds } = await callModel<EmailDraft>(
    corrective,
    `URL: ${articleUrl}\n\nARTICLE TEXT:\n${articleMarkdown.slice(0, 20_000)}`,
    EMAIL_SCHEMA as unknown as Record<string, unknown>,
    "email_alert",
    1200,
  );

  return { draft: parsed, usage, seconds };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
