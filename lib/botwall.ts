/**
 * botwall.ts — detect CAPTCHA / bot-wall / interstitial pages.
 *
 * FOUND BY THE SOAK TEST, 2026-08-01. The single most valuable thing the soak
 * caught, and it would have been catastrophic in production.
 *
 * investor.starbucks.com intermittently serves a Google reCAPTCHA challenge
 * instead of the newsroom. Two separate failures result:
 *
 *   1. FALSE POSITIVES FOREVER. The CAPTCHA prompt text rotates on every render
 *      ("Select all squares with motorcycles" -> "...with stairs") and the image
 *      payload URLs are randomised. Change tracking therefore reports "changed"
 *      on EVERY check. At the client's 20-minute interval that is 72 junk emails
 *      a day from one site, which is how a monitoring product gets switched off
 *      in week one.
 *
 *   2. GARBAGE CONTENT ACCEPTED AS REAL. The CAPTCHA page is long (14,816 chars
 *      measured), so a naive length check passes it, and an LLM asked to find
 *      press releases on it will either invent them or return nothing.
 *
 * Firecrawl's own diff is deliberately resistant to iframe randomisation, but
 * this text lives in the rendered markdown, so it defeats that protection.
 *
 * The fix is to detect the wall and fail LOUDLY. A site behind an intermittent
 * bot wall needs a per-site remedy (stealth proxy, its RSS feed, or a longer
 * interval) — it must never be silently treated as "no news" or "new news".
 */

/**
 * Signals that a page is a challenge/interstitial rather than content.
 * Deliberately specific: matching the mere word "captcha" would false-positive
 * on a privacy policy that mentions reCAPTCHA in passing.
 */
const BOT_WALL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /select all (squares|images) with/i, label: "reCAPTCHA image challenge" },
  { pattern: /if there are none, click skip/i, label: "reCAPTCHA image challenge" },
  { pattern: /recaptcha\/api2\/payload/i, label: "reCAPTCHA payload frames" },
  { pattern: /\bi'?m not a robot\b/i, label: "reCAPTCHA checkbox" },
  { pattern: /verify (you are|you're) (a )?human/i, label: "human verification" },
  { pattern: /checking if the site connection is secure/i, label: "Cloudflare interstitial" },
  { pattern: /enable javascript and cookies to continue/i, label: "Cloudflare interstitial" },
  { pattern: /(please )?complete the security check/i, label: "security check" },
  { pattern: /ddos protection by/i, label: "DDoS interstitial" },
  { pattern: /request unsuccessful\.?\s*incapsula/i, label: "Imperva/Incapsula block" },
  { pattern: /pardon our interruption/i, label: "Distil/Imperva block" },
  { pattern: /access denied.{0,40}reference (id|number)/i, label: "WAF access denied" },
  { pattern: /unusual traffic from your computer network/i, label: "traffic block" },
  { pattern: /press (and hold|&amp; hold)|hold to confirm you('re| are) human/i, label: "press-and-hold challenge" },
];

export interface BotWallCheck {
  blocked: boolean;
  label?: string;
  /** The matched excerpt, for logs — never shown to the end user. */
  evidence?: string;
}

/**
 * Detect whether scraped markdown is a bot wall rather than page content.
 *
 * Checks the whole document, not just the head: Starbucks' CAPTCHA appeared
 * ~180 lines in, below otherwise-normal-looking page furniture.
 */
export function detectBotWall(markdown: string): BotWallCheck {
  if (!markdown) return { blocked: false };

  for (const { pattern, label } of BOT_WALL_PATTERNS) {
    const m = markdown.match(pattern);
    if (m) {
      const idx = m.index ?? 0;
      return {
        blocked: true,
        label,
        evidence: markdown.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, " "),
      };
    }
  }

  return { blocked: false };
}

/**
 * Heuristic for "this content is volatile and will diff against itself".
 *
 * Rotating CAPTCHA payload URLs are the measured case, but the same reasoning
 * covers cache-buster query strings and nonce-stamped asset URLs. A page whose
 * markdown carries many single-use URLs cannot be diffed reliably, so it needs
 * a per-site rule (feed, stealth proxy, or narrowed selector) rather than being
 * trusted.
 */
export function countVolatileTokens(markdown: string): number {
  const patterns = [
    /recaptcha\/api2\/payload\?p=[\w-]{20,}/gi,
    /[?&](?:cb|cachebust|nonce|_t|ts|rand|r)=[\w-]{8,}/gi,
    /\bnonce="[\w+/=-]{16,}"/gi,
  ];
  let n = 0;
  for (const p of patterns) n += (markdown.match(p) ?? []).length;
  return n;
}

/** Volatile-token count above which diffing is considered unreliable. */
export const VOLATILE_TOKEN_LIMIT = 3;
