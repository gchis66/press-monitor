/**
 * verify.ts — deterministic correctness gates.
 *
 * TWO-LAYER DEFENCE. The prompt asks the model for exactly 4 sentences and a
 * verbatim headline. Prompts are probabilistic; these checks are not. Anything
 * we promise the client is enforced HERE, in code, not in a prompt.
 *
 * The two gates:
 *
 *   1. FOUR SENTENCES — the client asked for a "4 sentence summary". If we ship
 *      3 or 6, the deliverable is visibly wrong on the one spec detail they
 *      wrote down explicitly.
 *
 *   2. VERBATIM HEADLINE (the zero-tolerance gate) — the email subject must be
 *      real text from the release. In media monitoring, a fabricated or garbled
 *      headline is the fireable error: the client forwards it to an executive
 *      and it does not match reality. Same principle as the excerpt gate on the
 *      legal build, new domain.
 *
 * Gate 2 grades rather than passing/failing outright, because on real pages
 * extraction artifacts (index-page truncation with "...", non-breaking spaces,
 * typographic quotes, page furniture) produce false accusations. A false
 * accusation trains the reviewer to ignore the warning, which destroys its
 * value on the real cases.
 */

/* ------------------------------------------------------------------ *
 * Sentence counting
 * ------------------------------------------------------------------ */

/**
 * Abbreviations whose trailing period does NOT end a sentence. Press releases
 * are dense with these ("Acme Corp. announced", "the U.S. market", "$4.2M in
 * Q3", "Dr. Chen", "approx. 400 staff"), and a naive /[.!?]/ split miscounts
 * almost every real release.
 */
const ABBREVIATIONS = [
  "inc", "corp", "co", "ltd", "llc", "llp", "plc", "gmbh", "sa", "nv", "ag",
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "rev", "hon",
  "gen", "col", "lt", "sgt", "capt", "adm", "gov", "sen", "rep", "pres",
  "vs", "etc", "eg", "ie", "cf", "al", "approx", "est", "no", "vol", "fig",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "u.s", "u.k", "u.n", "e.u", "d.c", "ph.d", "m.d", "b.a", "m.a", "a.m", "p.m",
];

const ABBREV_SET = new Set(ABBREVIATIONS);

/**
 * Split prose into sentences, tolerating the abbreviations and decimals that
 * saturate corporate press releases.
 */
export function splitSentences(text: string): string[] {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];

  const out: string[] = [];
  let current = "";

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    current += ch;

    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Consume any run of terminators and closing quotes/brackets.
    while (i + 1 < clean.length && /[.!?"'’”\)\]]/.test(clean[i + 1])) {
      current += clean[++i];
    }

    const next = clean[i + 1];
    // End of input, or followed by whitespace -> candidate boundary.
    if (next !== undefined && next !== " ") continue;

    if (ch === "." && !isSentenceEnd(current, clean, i)) continue;

    out.push(current.trim());
    current = "";
  }

  if (current.trim()) out.push(current.trim());
  return out.filter((s) => hasLetterOrDigit(s));
}

/** Decide whether a period at `idx` genuinely closes a sentence. */
function isSentenceEnd(soFar: string, full: string, idx: number): boolean {
  // Decimal or thousands separator: "4.2 million", "1,250.00"
  const prev = full[idx - 1];
  const next2 = full[idx + 2];
  if (/\d/.test(prev ?? "") && /\d/.test(next2 ?? "")) return false;

  // Trailing token before the period.
  const m = soFar.match(/([A-Za-z][A-Za-z.]*)\.[.!?"'’”\)\]]*$/);
  if (m) {
    const token = m[1].toLowerCase().replace(/\.$/, "");
    if (ABBREV_SET.has(token)) return false;
    // Single initial: "J. Smith", "Ronald A. Fisher"
    if (token.length === 1) return false;
    // Dotted acronym: "U.S.A.", "N.A.S.A."
    if (/^([a-z]\.)+[a-z]$/.test(token)) return false;
  }

  // A real sentence must be followed by something that looks like a new one:
  // capital letter, digit, or quote. Lowercase means we mis-split.
  const rest = full.slice(idx + 1).trimStart();
  if (rest && !/^["'“‘(\[]?[A-Z0-9]/.test(rest)) return false;

  return true;
}

export function countSentences(text: string): number {
  return splitSentences(text).length;
}

export interface SentenceCheck {
  ok: boolean;
  count: number;
  expected: number;
  sentences: string[];
  message?: string;
}

/** Gate 1: the client asked for exactly 4 sentences. */
export function checkSentenceCount(text: string, expected = 4): SentenceCheck {
  const sentences = splitSentences(text);
  const count = sentences.length;
  if (count === expected) return { ok: true, count, expected, sentences };
  return {
    ok: false,
    count,
    expected,
    sentences,
    message: `Summary has ${count} sentence${count === 1 ? "" : "s"}, expected ${expected}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Verbatim headline verification (zero-tolerance gate)
 * ------------------------------------------------------------------ */

export type HeadlineVerdict = "exact" | "composed" | "too-short" | "missing";

export interface HeadlineCheck {
  verdict: HeadlineVerdict;
  /** Blocks the email. Only "missing" does. */
  fatal: boolean;
  /** Fraction of headline words found in the source (0-1). */
  coverage: number;
  message?: string;
}

/**
 * Normalise for comparison only — never for display. Collapses the specific
 * artifacts that cause false hallucination reports:
 *   - typographic quotes/dashes -> ASCII
 *   - non-breaking + narrow-no-break spaces (rife in press releases: "Q2 2026"
 *     is frequently U+202F) -> plain space
 *   - soft hyphens and zero-width characters -> removed
 *   - line-break hyphenation ("announ-\ncement") -> rejoined
 */
export function normalizeForCompare(s: string): string {
  return s
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2007\u2009\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u2009\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Gate 2: does the subject line actually appear in the article?
 *
 * Verdicts:
 *   exact      — the headline appears as a contiguous string. Ship it.
 *   composed   — every significant word appears, but not contiguously. Real
 *                cause: index pages truncate ("Caterpillar Invest in the
 *                Future of Manufacturing...") while the article says
 *                "Caterpillar Invests in the Future of Manufacturing Talent
 *                in Illinois". Amber caution, still ships.
 *   too-short  — headline is too short to verify meaningfully. Amber.
 *   missing    — significant words are absent from the source. FATAL: the model
 *                invented a headline. Suppress the email.
 */
export function verifyHeadline(
  headline: string,
  sourceText: string,
): HeadlineCheck {
  const h = normalizeForCompare(headline);
  const src = normalizeForCompare(sourceText);

  if (!h) {
    return {
      verdict: "missing",
      fatal: true,
      coverage: 0,
      message: "No headline was produced.",
    };
  }

  if (src.includes(h)) {
    return { verdict: "exact", fatal: false, coverage: 1 };
  }

  // Compare on significant words only. Stopwords and punctuation differ
  // harmlessly between an index listing and the article's own <h1>.
  const words = significantWords(h);

  if (words.length < 3) {
    return {
      verdict: "too-short",
      fatal: false,
      coverage: 0,
      message: "Headline too short to verify against the article text.",
    };
  }

  const found = words.filter((w) => src.includes(w));
  const coverage = found.length / words.length;

  // 0.8 chosen deliberately: a truncated index headline loses its tail (a word
  // or two of eight), landing ~0.85. A fabricated headline shares only generic
  // corporate vocabulary and lands well below.
  if (coverage >= 0.8) {
    return {
      verdict: "composed",
      fatal: false,
      coverage,
      message:
        "Headline matches the article's wording but not as one contiguous string (usually a truncated listing).",
    };
  }

  return {
    verdict: "missing",
    fatal: true,
    coverage,
    message: `Headline could not be found in the article text (${Math.round(
      coverage * 100,
    )}% of its words matched). Email suppressed.`,
  };
}

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "of",
  "on", "or", "the", "to", "with", "its", "it", "that", "this", "will", "has",
  "have", "are", "was", "were", "new", "s",
]);

export function significantWords(normalized: string): string[] {
  return normalized
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function hasLetterOrDigit(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/* ------------------------------------------------------------------ *
 * Link verification
 * ------------------------------------------------------------------ */

/**
 * Gate 3: the link must point at a release, not back at the index page. A
 * "read the full release" link that returns to the listing is the second most
 * embarrassing failure after a wrong headline.
 */
export function isDistinctArticleUrl(
  articleUrl: string,
  indexUrl: string,
): boolean {
  const a = canonicalUrl(articleUrl);
  const i = canonicalUrl(indexUrl);
  if (!a) return false;
  if (!i) return true;
  return a !== i;
}

export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Trailing slash is not a meaningful difference.
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Resolve a possibly-relative href against the page it was found on. */
export function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
